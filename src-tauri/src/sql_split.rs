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

/// Split `sql` into non-empty, trimmed statements.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut state = State::Normal;
    let mut chars = sql.chars().peekable();
    let mut dollar_tag: Option<String> = None;

    while let Some(c) = chars.next() {
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
                    push_statement(&mut statements, &mut current);
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
    fn empty_input_yields_nothing() {
        assert!(split_statements("   ;;  ").is_empty());
    }
}
