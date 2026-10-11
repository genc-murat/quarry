//! Splits a SQL script into individual statements.
//!
//! This is a small lexical scanner rather than a full parser: it understands
//! string literals, identifiers, line comments (`--`, `#`) and block comments
//! (`/* */`) for the SQL dialect, plus PostgreSQL dollar quoting, so a `;`
//! inside a literal never splits a statement.

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
    DollarQuote,
}

/// Words that name a body-bearing object when they follow `CREATE`.
const BODY_KINDS: [&str; 4] = ["TRIGGER", "PROCEDURE", "FUNCTION", "EVENT"];
/// How many leading words of a statement are remembered to recognise its kind.
const HEAD_WORDS: usize = 8;

/// Tracks `BEGIN ... END` and `CASE ... END` nesting inside a trigger, procedure,
/// function or event definition, so a `;` inside its body does not end the
/// statement. Only statements that start with `CREATE` and name one of
/// [`BODY_KINDS`] are tracked; everywhere else `;` splits as before.
#[derive(Default)]
struct BlockTracker {
    head: Vec<String>,
    depth: usize,
    pending_end: bool,
}

impl BlockTracker {
    fn in_body_statement(&self) -> bool {
        self.head.first().map(String::as_str) == Some("CREATE")
            && self
                .head
                .iter()
                .any(|word| BODY_KINDS.contains(&word.as_str()))
    }

    /// Feed one upper-cased bare word (identifier or keyword) to the tracker.
    fn word(&mut self, word: &str) {
        if self.head.len() < HEAD_WORDS {
            self.head.push(word.to_string());
        }
        if !self.in_body_statement() {
            return;
        }
        if self.pending_end {
            self.pending_end = false;
            match word {
                // `END IF`, `END LOOP`, ... close constructs whose opener is
                // never counted, so they leave the depth alone.
                "IF" | "LOOP" | "WHILE" | "REPEAT" => return,
                // `END CASE` closes a counted CASE.
                "CASE" => {
                    self.depth = self.depth.saturating_sub(1);
                    return;
                }
                _ => self.depth = self.depth.saturating_sub(1),
            }
        }
        match word {
            "BEGIN" | "CASE" => self.depth += 1,
            "END" => self.pending_end = true,
            _ => {}
        }
    }

    /// An `END` directly before a `;` has no following word to inspect, so it
    /// closes its block now.
    fn finish_pending(&mut self) {
        if self.pending_end {
            self.pending_end = false;
            self.depth = self.depth.saturating_sub(1);
        }
    }
}

fn flush_word(word: &mut String, tracker: &mut BlockTracker) {
    if !word.is_empty() {
        tracker.word(word);
        word.clear();
    }
}

/// Split `sql` into non-empty, trimmed statements.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut state = State::Normal;
    let mut chars = sql.chars().peekable();
    let mut dollar_tag: Option<String> = None;
    let mut word = String::new();
    let mut tracker = BlockTracker::default();

    while let Some(c) = chars.next() {
        if state == State::Normal {
            if c.is_ascii_alphanumeric() || c == '_' {
                word.push(c.to_ascii_uppercase());
                current.push(c);
                continue;
            }
            flush_word(&mut word, &mut tracker);
        }
        match state {
            State::Normal => match c {
                '\'' => {
                    state = State::SingleQuote;
                    current.push(c);
                }
                '"' => {
                    state = State::DoubleQuote;
                    current.push(c);
                }
                '`' => {
                    state = State::Backtick;
                    current.push(c);
                }
                '#' => {
                    state = State::LineComment;
                    current.push(c);
                }
                '-' if chars.peek() == Some(&'-') => {
                    state = State::LineComment;
                    current.push('-');
                    current.push(chars.next().unwrap());
                }
                '$' => {
                    // Try to read a `$tag$` dollar quote opener.
                    if let Some(tag) = read_dollar_tag(&mut chars, &mut current) {
                        dollar_tag = Some(tag);
                        state = State::DollarQuote;
                    } else {
                        current.push(c);
                    }
                }
                '/' if chars.peek() == Some(&'*') => {
                    state = State::BlockComment;
                    current.push('/');
                    current.push(chars.next().unwrap());
                }
                ';' => {
                    tracker.finish_pending();
                    if tracker.depth == 0 {
                        push_statement(&mut statements, &mut current);
                        tracker = BlockTracker::default();
                    } else {
                        current.push(c);
                    }
                }
                _ => current.push(c),
            },
            State::SingleQuote => {
                current.push(c);
                match c {
                    '\\' => {
                        if let Some(escaped) = chars.next() {
                            current.push(escaped);
                        }
                    }
                    '\'' => {
                        if chars.peek() == Some(&'\'') {
                            current.push(chars.next().unwrap());
                        } else {
                            state = State::Normal;
                        }
                    }
                    _ => {}
                }
            }
            State::DoubleQuote => {
                current.push(c);
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        current.push(chars.next().unwrap());
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::Backtick => {
                current.push(c);
                if c == '`' {
                    state = State::Normal;
                }
            }
            State::LineComment => {
                current.push(c);
                if c == '\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment => {
                current.push(c);
                if c == '/' && current.ends_with("*/") {
                    state = State::Normal;
                }
            }
            State::DollarQuote => {
                current.push(c);
                if c == '$' {
                    if let Some(tag) = &dollar_tag {
                        if current.ends_with(tag.as_str()) {
                            state = State::Normal;
                            dollar_tag = None;
                        }
                    }
                }
            }
        }
    }

    flush_word(&mut word, &mut tracker);
    tracker.finish_pending();
    push_statement(&mut statements, &mut current);
    statements
}

fn read_dollar_tag(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    current: &mut String,
) -> Option<String> {
    let mut tag = String::from("$");
    let mut lookahead = chars.clone();
    // Tags are `$$` or `$name$` where name is alphanumeric/underscore.
    loop {
        match lookahead.next() {
            Some('$') => {
                tag.push('$');
                // Consume the tag characters we peeked at.
                for _ in 1..tag.len() {
                    chars.next();
                }
                current.push_str(&tag);
                return Some(tag);
            }
            Some(ch) if ch.is_ascii_alphanumeric() || ch == '_' => tag.push(ch),
            _ => return None,
        }
    }
}

fn push_statement(statements: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
    current.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple_statements() {
        let out = split_statements("SELECT 1; SELECT 2");
        assert_eq!(out, vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn ignores_semicolons_in_strings() {
        let out = split_statements("SELECT 'a;b'; SELECT 2");
        assert_eq!(out, vec!["SELECT 'a;b'", "SELECT 2"]);
    }

    #[test]
    fn ignores_semicolons_in_comments() {
        let out = split_statements("SELECT 1 -- hi; there\n; SELECT 2");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("SELECT 1"));
        assert_eq!(out[1], "SELECT 2");
    }

    #[test]
    fn handles_backticks_and_escapes() {
        let out = split_statements("SELECT `we;ird`, 'it\\'s' FROM t");
        assert_eq!(out, vec!["SELECT `we;ird`, 'it\\'s' FROM t"]);
    }

    #[test]
    fn handles_postgres_dollar_quotes() {
        let out = split_statements("CREATE FUNCTION f() AS $$ BEGIN; END; $$ LANGUAGE plpgsql;");
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("BEGIN; END;"));
    }

    #[test]
    fn keeps_sqlite_trigger_body_together() {
        let sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); UPDATE c SET x = CASE WHEN NEW.x > 0 THEN 1 ELSE 0 END; END; SELECT 2";
        let out = split_statements(sql);
        assert_eq!(out.len(), 2);
        assert!(out[0].starts_with("CREATE TRIGGER"));
        assert!(out[0].ends_with("END"));
        assert_eq!(out[1], "SELECT 2");
    }

    #[test]
    fn keeps_mysql_procedure_control_flow_together() {
        let sql = "CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; CASE WHEN 1 THEN SELECT 2; END CASE; END; SELECT 3";
        let out = split_statements(sql);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], "SELECT 3");
    }

    #[test]
    fn if_exists_inside_a_body_does_not_open_a_block() {
        let sql = "CREATE PROCEDURE p() BEGIN DROP TABLE IF EXISTS x; SELECT 1; END; SELECT 2";
        let out = split_statements(sql);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], "SELECT 2");
    }

    #[test]
    fn case_outside_a_body_statement_is_not_tracked() {
        let out = split_statements("SELECT CASE WHEN 1 THEN 2 END; SELECT 3");
        assert_eq!(out, vec!["SELECT CASE WHEN 1 THEN 2 END", "SELECT 3"]);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(split_statements("   ;;  ").is_empty());
    }
}
