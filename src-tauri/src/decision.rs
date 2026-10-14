//! Local decision-model client (Ollama's typed "system one" decisions).
//!
//! Ollama 0.35+ exposes `POST /v1/systemone`: send a block of text as `state`
//! plus a set of named questions and a model running on this machine answers
//! them all in one request — a `choice` among named criteria, a `noul` (a
//! yes/no probability) or a `score` across named criteria. Nothing leaves the
//! machine.
//!
//! The editor asks two of them at once, from the same request:
//!
//! - `candidate`, a `choice` over the tables the identifier under the cursor
//!   could still complete to: which one the SQL most likely means, so the list
//!   can be reordered around it.
//! - one graded `score` per statement a command would send — the statement the
//!   cursor is in, the statements of a selection, or the statements of a whole
//!   script — over a short scale of how far running a statement could go. So Run
//!   can say not only that a statement is dangerous but *what kind* of danger it
//!   is, and which statement of a script it is.
//!
//! The risk questions cost one question per statement, not one request more, and
//! that was measured against `nimble` rather than assumed. In a controlled probe
//! over states the model had not seen, the ranking alone took 257 ms, the pair
//! 437 ms, and the same `noul` on its own 251 ms — so an extra question is paid
//! for in prompt tokens, and in 3 output tokens either way, but never in a second
//! round trip. (Timing two requests against each other in a test does not show
//! this: Ollama reuses its prompt cache for a body it has already answered, so
//! the repeated ranking-only request drops to ~50 ms and the comparison measures
//! the cache.) Nine statements asked as nine `score` questions — the ignored
//! measurement test below — came back in 2.5 s in one request, the same ten as ten
//! `noul`s in 2.07 s in an earlier probe. The answers are read independently,
//! because a model may answer one question and not another.
//!
//! It is deliberately best-effort — when the model is not running the answer is
//! an empty ranking with a reason, never an error the UI has to handle, because
//! this runs on every keystroke.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Where the decision endpoint lives. `QUARRY_OLLAMA_URL` overrides it, so a
/// user can point the app at an Ollama on another host.
pub fn base_url() -> String {
    std::env::var("QUARRY_OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".to_string())
}

/// How long to wait before treating the model as unavailable.
///
/// Nothing the user looks at waits for this. The editor hands back the
/// language's own suggestions the moment they exist and applies a ranking if and
/// when it lands (`src/lib/smartComplete.ts`), so the budget decides only
/// whether a model that is *loading* is still heard — never how long a keystroke
/// takes.
///
/// It therefore has to outlast that load. Ollama drops a decision model from
/// memory after a few idle minutes, and `nimble` took 7.25 s to come back the
/// first time it was asked after that. The budget used to be 1.2 s, shorter than
/// the load, so the first question of a session — the one a user is most likely
/// to notice — was thrown away. Twenty seconds is roughly three times that load
/// and is still bounded: an endpoint that is not there at all is refused at once
/// rather than waited for.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Below this confidence the answer is treated as a guess and the list is left
/// alone. A decision model reports how sure it is next to its answer, and an
/// unsure answer is worse than none: it would reorder the suggestions on a coin
/// flip. A clear answer scores well above this (the models' own examples sit
/// near 0.9), while a genuinely split one falls far below it.
pub const MIN_CONFIDENCE: f64 = 0.15;

/// The wording of the ranking question, and the name it is asked under. The
/// name is also the key its answer comes back under.
const RANK_INSTRUCTION: &str =
    "Which of the listed tables is the SQL code being written most likely referring to?";
/// The same question about columns, asked when the cursor follows a qualifier
/// (`orders.ord`, `o.ord`). See `CandidateKind` for what the measurements say
/// about how well each of the two is answered.
const COLUMN_INSTRUCTION: &str =
    "Which of the listed columns is the SQL code being written most likely referring to?";
/// The wording of the repair question: a statement did not run, and the names to
/// choose between are the schema's own. `%BLOCK%` stands for the state block the
/// failing SQL is in, which the model has to tell apart from the error beside it.
///
/// Measured against `nimble` over seven failures — a mistyped column, table and
/// schema-qualified table across SQLite, MySQL and PostgreSQL, and two failures
/// nothing in the schema fits: the model named the intended one in six of them
/// (0.94 to 0.99), declined correctly on `no such column: profit_margin_eur`
/// (0.94), and on `SELECT * FROM order_number` — a column name in a table
/// position — answered `orders`, which is a repair a person might well make and
/// which the decline criterion does not cover. One answer is one answer: what the
/// feature needs is that the confident answers are right, and that a schema with
/// nothing close produces nothing.
const REPAIR_INSTRUCTION: &str = "The SQL in block %BLOCK% failed with the error in block \
     error. Which of the listed names is the one that SQL most likely meant, or none of the \
     listed names if none of them fits?";
/// The criterion that lets a repair answer mean "not one of these".
///
/// It is not a name from the schema, so an answer naming it is not a ranking:
/// the client turns it into an empty one, because a suggestion that picked a name
/// when the schema had none would send the user to a name their SQL never meant.
/// Measured: with it offered, `no such column: profit_margin_eur` against a schema
/// holding none of those words was answered with it (0.941).
const NO_NAME: &str = "none of the listed names is the one it meant";
/// The reason a declined repair comes back with, in the client's own words.
const NO_NAME_REASON: &str = "no listed name fits the error";
const RANK_NAME: &str = "candidate";

/// What the candidates are. It picks the wording of the question, and nothing
/// else: a `choice` answer is a name from the criteria either way.
///
/// Measured, and the two are not equally good. Asked which *table* a fragment
/// means, `nimble` answers correctly and confidently — 0.8 to 0.99 across the
/// cases the editor's own smoke test uses. Asked the same about a *column* it
/// does use the statement (`SELECT date_trunc('day', o.ord)` over
/// `order_number < ordered_at < order_status` answers `ordered_at`, 0.835), and
/// it tends to pass over a column the statement has already used — but its
/// answers are weaker and less stable. Three wordings of the column question
/// were tried on `SELECT * FROM orders o ORDER BY o.ord` and all three named
/// `order_number`, the same case answered between 0.03 and 0.20 as the state
/// around it changed, and a column the statement does not point at is sometimes
/// named. That is worth knowing because the cost is bounded: the editor only
/// ever reorders a list the language already produced, so a wrong pick costs the
/// reader one row, and an answer below the editor's threshold is not acted on at
/// all.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CandidateKind {
    /// Table names, as a completion at a `FROM` position asks.
    #[default]
    Table,
    /// Column names, as a completion after a `table.` or `alias.` asks.
    Column,
    /// The names behind a failure: the statement did not run, and the model is
    /// asked which of the schema's names the SQL most likely meant. This is the
    /// one kind whose question has a "none of these" answer — see `NO_NAME`.
    Repair,
}

impl CandidateKind {
    /// The question's wording, which is the only thing that differs between the
    /// three (all measured; see each constant). The repair wording is the one with
    /// a `%BLOCK%` in it, which the caller fills in with the block its statement
    /// went into.
    fn instruction(self) -> &'static str {
        match self {
            CandidateKind::Table => RANK_INSTRUCTION,
            CandidateKind::Column => COLUMN_INSTRUCTION,
            CandidateKind::Repair => REPAIR_INSTRUCTION,
        }
    }

    /// What one criterion is, so the model is told what it is choosing between.
    /// For a repair that is a name of unknown kind: the point of the question is
    /// that the statement did not say which it wanted.
    fn noun(self) -> &'static str {
        match self {
            CandidateKind::Table => "table",
            CandidateKind::Column => "column",
            CandidateKind::Repair => "name",
        }
    }
}

/// The graded risk question, and the scale it is answered on.
///
/// The wording and the scale were both chosen by measurement, because a real
/// model answers the literal reading of a question. Asking whether a statement
/// merely "modifies data" scores ~1.0 for a bounded `UPDATE ... WHERE id = 1`
/// exactly as for `DROP TABLE`, which is useless as a warning; an earlier
/// yes/no wording about *permanently removing or overwriting what is already
/// there* separated those two but said only *that* something was wrong. This
/// scale answers by *kind*, which is what lets the badge say "removes a table"
/// rather than only "may destroy data".
///
/// Over the nine statements the ignored measurement test asks about in one request
/// — `nimble`, this machine — the answers were ordered the way the steps are:
/// `SELECT ... WHERE id = 1` 0.01, `CREATE INDEX` 0.11, `ALTER TABLE ... ADD
/// COLUMN` 0.73, a bounded `UPDATE` 1.00, a one-row `DELETE` 1.00, `INSERT` 1.01,
/// `DELETE FROM orders` 1.87, `TRUNCATE` 1.98, `DROP TABLE` 3.00. That ordering is
/// the point: a position on a scale is a claim about degree, which a probability
/// for a single yes/no question cannot be, and the statements the warning exists
/// for sit at the top of it while an ordinary edit sits in the middle.
///
/// Two runs of that test, days apart, agreed on the ends and moved the middle:
/// `CREATE INDEX` read 0.54 in the first and 0.11 in the second, `ALTER ... ADD
/// COLUMN` 0.37 and 0.73. So what the test asserts of a real model is the *order*
/// — a `SELECT` at the bottom, the two statements that take everything away above
/// the warning step, `DROP TABLE` at the top — and never one statement's position.
///
/// Measured limits, kept rather than hidden: an `UPDATE` with no `WHERE` came
/// back at 1.06, i.e. as a bounded write, and the same statement under the old
/// yes/no wording read 0.13 — so neither shape catches an update that rewrites
/// every row, and a rule that wants to needs the statement's own syntax. A
/// `DELETE` with no `WHERE` did read 1.65, where it belongs.
///
/// The steps are the question's `criteria`, so the endpoint's own 2–26 wall
/// applies to them (measured on `score` as well as `choice`: 26 accepted, 27
/// refused with `HTTP 400 criteria must contain 2–26 candidates`).
const RISK_SCALE: [&str; 4] = [
    "reads existing data and changes nothing",
    "writes a bounded number of existing rows",
    "removes or rewrites every row of a table",
    "removes a table or its data permanently",
];

/// The risk question's wording, with `%BLOCK%` standing for the name of the
/// state block it is about.
///
/// The block is named in the instruction so that one request can carry a
/// question per statement. That works rather than confusing the model: with ten
/// statements in the state and ten questions asked this way, each answer tracked
/// its own statement's risk instead of the request's most dangerous one —
/// `CREATE INDEX` answered 0.017 and `DROP TABLE` 0.998 in the same request.
const RISK_INSTRUCTION: &str = "How far could running the statement in block %BLOCK% go? \
     Answer with where it sits on the scale, from reading existing data and changing nothing \
     to removing a table or its data permanently.";
/// The question's name, suffixed with the statement's index: `risk_0`, `risk_1`, …
const RISK_NAME: &str = "risk";
/// The state block each statement is put in: `statement_0`, `statement_1`, …
const STATEMENT_BLOCK: &str = "statement";

/// A `choice` answer as `/v1/systemone` returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceAnswer {
    pub choice: String,
    pub confidence: f64,
    /// Every criterion with its probability, in the order the model reported.
    pub probabilities: Vec<(String, f64)>,
}

/// A `score` answer as `/v1/systemone` returns it.
///
/// `score` is a position on the scale the question described: measured, one step
/// per criterion, so `0.0` is the first step and `3.0` the last of a four-step
/// scale. The reply also carries a probability per step, which this client does
/// not use: a position is what the scale was asked for, and it is the answer that
/// stays comparable between statements of different kinds.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreAnswer {
    pub score: f64,
    pub confidence: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum DecisionError {
    #[error("the local model is unavailable: {0}")]
    Unavailable(String),
    #[error("the local model answered unexpectedly: {0}")]
    Malformed(String),
}

/// The most of a request this client will put on the wire — the last line of
/// defence in front of the model, not the policy.
///
/// The editor trims what it sends and knows why: the tail of the line
/// (`MAX_STATE_CHARS`), the head of the statement (`MAX_STATEMENT_CHARS`), at
/// most a dozen names (`MAX_RANK_CANDIDATES`) — all of them where the frontend
/// defines them (`src/lib/smartComplete.ts`, `src/lib/statementRisk.ts`,
/// `src/lib/completionRank.ts`), and all of them at or below these — the editor
/// cannot reach a bound it did not already trim to. Deliberately not the same
/// numbers: this side does not enforce the editor's policy, it bounds the work
/// one keystroke can ask of this machine. Anything at or below these is a question about a
/// line of SQL; anything above is a caller that is broken, or is not the editor
/// at all. Truncating rather than refusing keeps a request that is merely too
/// large answerable — which is what the editor itself does with a long line —
/// and nothing legitimate reaches these numbers, so nothing legitimate is ever
/// truncated by them.
///
/// The numbers are on the measured wall rather than chosen by taste. Against
/// `nimble` on this machine, one request costs ~620 ms for a typical keystroke (a
/// 30-character line, three names), ~3.4 s for the largest request the editor
/// itself can send (a 2 KB line, a 4 KB statement, 12 names) and ~5.2 s at these
/// bounds — so the backstop cannot make the machine do much more than the app
/// already asks of it, and it stays far from the client's own 20 s budget. The
/// endpoint has walls of its own just above the model, both measured: more than
/// 26 criteria is refused outright (`HTTP 400 criteria must contain 2–26
/// candidates`) and text past 64 KiB is refused as too big (`HTTP 413`). The
/// first is why `MAX_CANDIDATES` is 26 and no higher: a bound *above* the
/// endpoint's would turn a request that is merely too large into a hard failure
/// — "no model answered" — which is the one outcome this bound exists to avoid.
const MAX_STATE_CHARS: usize = 4 * 1024;
const MAX_STATEMENT_CHARS: usize = 4 * 1024;
/// How many names one question may put in front of the model. The endpoint's own
/// limit is 26 (`criteria must contain 2–26 candidates`), and this is that limit
/// rather than a smaller one, so a caller that sends more still has its question
/// answered.
const MAX_CANDIDATES: usize = 26;
/// How long a database error may be, as a state block.
///
/// A driver's message is a line or two; this only stops a caller from pasting a
/// stack trace into one. The head is kept, which is where the driver names the
/// identifier it could not find.
const MAX_ERROR_CHARS: usize = 1024;
/// How many statements one request may ask about.
///
/// There is no wall of the endpoint's here to sit under — measured, 40 questions
/// on one state were accepted — so this is the client's own bound, sized by the
/// one wall that does apply: the 64 KiB of text a request may carry. Twelve
/// statements at `MAX_STATEMENT_CHARS` each, plus the line, is 52 KiB, which
/// leaves the instruction text room and still stays under it. A script longer
/// than this is read in the order its statements appear; the editor asks about
/// the rest as they come up, and says how much of the script it has read.
const MAX_STATEMENTS: usize = 12;
/// How long a model name may be. Ollama's names are short; this only stops an
/// unbounded string from being copied into the body.
const MAX_MODEL_NAME_CHARS: usize = 128;

/// The endpoint's own walls, checked when this file is compiled rather than by a
/// test: a bound outside either of them would make an over-large request come
/// back refused instead of answered, which is the one outcome the bounds above
/// exist to prevent, so it is worth failing the build over.
const _: () = {
    assert!(
        MAX_CANDIDATES <= 26,
        "the endpoint refuses more than 26 criteria (measured: HTTP 400)"
    );
    assert!(
        RISK_SCALE.len() >= 2 && RISK_SCALE.len() <= 26,
        "the scale is a score question's criteria, so the 26 wall applies to it"
    );
    assert!(
        MAX_STATE_CHARS + MAX_STATEMENTS * MAX_STATEMENT_CHARS + MAX_ERROR_CHARS < 64 * 1024,
        "the endpoint refuses text past 64 KiB (measured: HTTP 413)"
    );
};

/// The last `limit` characters of `text`, or all of it when it is shorter. The
/// count is characters and the cut lands on a character boundary, so a string of
/// multi-byte characters cannot be split in half.
fn tail_of(text: &str, limit: usize) -> &str {
    if limit == 0 {
        return "";
    }
    match text.char_indices().rev().nth(limit - 1) {
        Some((index, _)) => &text[index..],
        None => text,
    }
}

/// The first `limit` characters of `text`, or all of it when it is shorter.
fn head_of(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// The request the editor sends: the line being typed, the table names it could
/// still complete to, and the statement it sits in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRequest {
    pub state: String,
    pub candidates: Vec<String>,
    pub model: String,
    /// What `candidates` are, which picks the wording of the ranking question.
    /// Defaults to tables, which is what an editor that does not say means.
    #[serde(default)]
    pub kind: CandidateKind,
    /// The statements a command would send, in the order they would be sent:
    /// the statement the cursor is in, the statements of a selection, or every
    /// statement of a script. Each one adds a risk question to this same
    /// request; an empty list asks the ranking alone.
    ///
    /// A list rather than one statement because the selection is what Run
    /// sends, and a selection can hold several statements — and because the
    /// question the editor has to answer before Run is pressed is about exactly
    /// the text being sent, not about where the cursor happens to sit.
    #[serde(default)]
    pub statements: Vec<String>,
    /// The database's own error for the statement a command failed on. It is the
    /// subject of the repair question — which name the SQL meant — and nothing
    /// else reads it.
    #[serde(default)]
    pub error: Option<String>,
}

/// The ranking, plus enough context to explain an empty one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankResponse {
    pub ranked: Vec<String>,
    pub choice: Option<String>,
    pub confidence: f64,
    /// True when a model answered the *ranking* question — including when its
    /// answer was too unsure to act on, which is a different thing from no model
    /// at all.
    pub available: bool,
    pub reason: Option<String>,
    /// One graded reading per statement the model answered about, each echoing
    /// the statement exactly as it was sent — trimmed and bounded — so a caller
    /// files the reading under the text the model was actually shown rather than
    /// the text it is holding. Empty when no statement was sent, and when none of
    /// the questions was answered: a statement with no reading has none, which is
    /// what keeps a model that said nothing from reading as "harmless".
    pub readings: Vec<RiskReading>,
}

impl RankResponse {
    /// The answer that leaves the editor's own order in place. Callers refine
    /// the fields they know more about with struct update syntax.
    fn unchanged(available: bool, reason: impl Into<String>) -> Self {
        Self {
            ranked: Vec::new(),
            choice: None,
            confidence: 0.0,
            available,
            reason: Some(reason.into()),
            readings: Vec::new(),
        }
    }
}

/// How far a statement could go, as the nearest step of `RISK_SCALE`.
///
/// The steps are ordered, so the reading is: the model answered with a position
/// on the scale and the position is rounded to the step whose words it was
/// choosing between. The client reports which step and the position it came
/// from; whether a step is worth warning about is the editor's policy, and it
/// lives in `src/lib/statementRisk.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskVerdict {
    /// Reads existing data and changes nothing.
    Safe,
    /// Writes a bounded number of existing rows — an ordinary edit.
    Bounded,
    /// Removes or rewrites every row of a table.
    Rows,
    /// Removes a table, or its data, permanently.
    Structure,
}

impl RiskVerdict {
    /// The step a position on the scale lands on: the nearest one, ties going to
    /// the lower step, because a reading that is half way between two steps has
    /// not earned the higher one's words.
    fn of_level(level: f64) -> Self {
        if level < 1.5 {
            if level < 0.5 {
                Self::Safe
            } else {
                Self::Bounded
            }
        } else if level < 2.5 {
            Self::Rows
        } else {
            Self::Structure
        }
    }
}

/// What the model read about one statement, and how sure it was.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskReading {
    /// The statement as it was sent. A reading only ever describes this text.
    pub statement: String,
    pub verdict: RiskVerdict,
    /// Where on the scale the model put it, in steps: 0 is the first step and
    /// `RISK_SCALE.len() - 1` the last. Kept beside the verdict so a reader that
    /// wants the number — a tooltip, a test — has it.
    pub level: f64,
    /// How sure the model was of that position, 0..1.
    pub confidence: f64,
}

/// One named question in a `/v1/systemone` request.
///
/// The endpoint answers every question it is given from the same `state` in one
/// round trip, so the set is worth building as a set: adding a question there is
/// what saves a request, and the request is the expensive half.
enum Question {
    /// Pick one of `criteria`; the answer names it. The criteria are an object
    /// map, each key the name being chosen between.
    Choice {
        name: String,
        /// What one criterion is, so the question can say it: the repair question's
        /// names are of unknown kind, which is the whole point of asking.
        kind: CandidateKind,
        /// The question as the endpoint wants it. Built where the question is
        /// built, because the wording names the state block its subject is in.
        instruction: String,
        criteria: Vec<String>,
    },
    /// A position on a scale; the answer is a number, not a pick. The criteria
    /// are the scale's steps, as an *array of descriptions* — the shape `score`
    /// insists on (measured: an object map is refused with `HTTP 400 question
    /// "…": score criteria must be an array of descriptions`), which is where
    /// the two question types differ on the wire while both cap out at 26.
    Score {
        name: String,
        instruction: String,
        criteria: Vec<String>,
    },
}

impl Question {
    /// The key the question is asked under, which is also the key its answer
    /// comes back under.
    fn name(&self) -> &str {
        match self {
            Question::Choice { name, .. } | Question::Score { name, .. } => name,
        }
    }

    /// The question as `/v1/systemone` wants it. A `choice` criterion's value is
    /// what that option means, so the candidate names themselves stay the keys
    /// and the answer's `choice` matches a candidate exactly.
    fn to_json(&self) -> Value {
        match self {
            Question::Choice {
                kind,
                instruction,
                criteria,
                ..
            } => {
                let noun = kind.noun();
                let options: serde_json::Map<String, Value> = criteria
                    .iter()
                    .map(|name| {
                        // The one criterion that is not a name from the schema is a
                        // sentence already, and `the none of the listed names is the
                        // one it meant name` would be nonsense.
                        let meaning = if name == NO_NAME {
                            name.clone()
                        } else {
                            format!("the {name} {noun}")
                        };
                        (name.clone(), Value::String(meaning))
                    })
                    .collect();
                json!({
                    "type": "choice",
                    "instructions": instruction,
                    "criteria": options,
                })
            }
            Question::Score {
                instruction,
                criteria,
                ..
            } => json!({
                "type": "score",
                "instructions": instruction,
                "criteria": criteria,
            }),
        }
    }
}

/// The body for `questions` over one `state`.
///
/// `state` is the named text the questions are about: the line being typed, and
/// — when the command would send them — one block per statement. Every question
/// sees every block, so a statement is context the ranking may use, its own
/// subject for the risk question that names it, and nothing else.
fn questions_request(model: &str, state: &Value, questions: &[Question]) -> Value {
    let asked: serde_json::Map<String, Value> = questions
        .iter()
        .map(|question| (question.name().to_string(), question.to_json()))
        .collect();
    json!({ "model": model, "state": state, "questions": asked })
}

/// Read the `score` answer `name` out of a `/v1/systemone` reply.
///
/// `None` covers both "the reply has no such answer" and "it is not a number":
/// the questions are independent, so a model that answered only one of them still
/// leaves the others usable.
///
/// `None` for a question the reply does not answer, and for a position that is
/// not a usable number — a reading nothing can be placed on the scale is not a
/// reading, and saying nothing is what the editor does with a statement it has no
/// reading for.
pub fn parse_score(body: &Value, name: &str) -> Option<ScoreAnswer> {
    let answer = body.get("answers")?.get(name)?;
    let score = answer.get("score")?.as_f64()?;
    if !score.is_finite() {
        return None;
    }
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Some(ScoreAnswer {
        score,
        confidence: if confidence.is_finite() {
            confidence
        } else {
            0.0
        },
    })
}

/// Read the `choice` answer `name` out of a `/v1/systemone` reply.
pub fn parse_choice(body: &Value, name: &str) -> Result<ChoiceAnswer, DecisionError> {
    let answer = body
        .get("answers")
        .and_then(|answers| answers.get(name))
        .ok_or_else(|| DecisionError::Malformed(format!("reply has no answers.{name}")))?;
    let choice = answer
        .get("choice")
        .and_then(Value::as_str)
        .ok_or_else(|| DecisionError::Malformed("answer has no choice".to_string()))?
        .to_string();
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let probabilities = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| value.as_f64().map(|p| (name.clone(), p)))
                .collect()
        })
        .unwrap_or_default();
    Ok(ChoiceAnswer {
        choice,
        confidence,
        probabilities,
    })
}

/// Turn a `choice` answer into a full ranking: the chosen option first, then
/// the rest by descending probability. Names the model invented are dropped.
pub fn order_by_answer(candidates: &[String], answer: &ChoiceAnswer) -> Vec<String> {
    let mut rest: Vec<(String, f64)> = candidates
        .iter()
        .filter(|candidate| candidate.as_str() != answer.choice)
        .map(|candidate| {
            let probability = answer
                .probabilities
                .iter()
                .find(|(name, _)| name == candidate)
                .map(|(_, value)| *value)
                .unwrap_or(0.0);
            (candidate.clone(), probability)
        })
        .collect();
    // Descending probability; `partial_cmp` keeps a NaN from panicking.
    rest.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut ranked = Vec::with_capacity(candidates.len());
    if candidates
        .iter()
        .any(|candidate| candidate == &answer.choice)
    {
        ranked.push(answer.choice.clone());
    }
    ranked.extend(rest.into_iter().map(|(name, _)| name));
    ranked
}

/// A client for the local `/v1/systemone` endpoint.
pub struct DecisionClient {
    http: reqwest::Client,
    base_url: String,
}

impl Default for DecisionClient {
    fn default() -> Self {
        Self::new()
    }
}

impl DecisionClient {
    pub fn new() -> Self {
        Self::with_base_url(base_url())
    }

    /// Point the client at another origin. Tests use this instead of mutating
    /// the process environment.
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            http,
            base_url: base_url.into(),
        }
    }

    /// Put `questions` about `state` to the model and hand back its reply.
    async fn ask(
        &self,
        model: &str,
        state: &Value,
        questions: &[Question],
    ) -> Result<Value, DecisionError> {
        let url = format!("{}/v1/systemone", self.base_url.trim_end_matches('/'));
        let response = self
            .http
            .post(url)
            .json(&questions_request(model, state, questions))
            .send()
            .await
            .map_err(|error| DecisionError::Unavailable(error.to_string()))?;
        if !response.status().is_success() {
            return Err(DecisionError::Unavailable(format!(
                "HTTP {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| DecisionError::Malformed(error.to_string()))
    }

    /// Best-effort ranking for the autocomplete source. A model that is missing,
    /// slow, unsure or confused all leave the editor's own order in place; the
    /// difference is only in `available` and `reason`, which the editor reports.
    ///
    /// When the request names the statement under the cursor, both questions go
    /// out in this one call and both answers are read back. Neither half is
    /// allowed to spoil the other.
    pub async fn rank(&self, request: &RankRequest) -> RankResponse {
        // Everything the model is shown is read through these, so no request can
        // become a prompt of any size; see the `MAX_*` note above for why the
        // bounds are the ones the editor does *not* need.
        let state_text = tail_of(&request.state, MAX_STATE_CHARS);
        let model = head_of(&request.model, MAX_MODEL_NAME_CHARS);
        // The statements a command would send, in the order it would send them,
        // each trimmed and bounded here rather than trusted to the editor.
        // Duplicates are dropped: a reading belongs to the statement itself, so
        // asking about the same text twice would buy two questions' worth of
        // prompt for one question's worth of answer.
        let mut statements: Vec<String> = Vec::new();
        for text in request.statements.iter().take(MAX_STATEMENTS) {
            let bounded = head_of(text, MAX_STATEMENT_CHARS).trim();
            if bounded.is_empty() || statements.iter().any(|seen| seen.as_str() == bounded) {
                continue;
            }
            statements.push(bounded.to_string());
        }
        let repair = request.kind == CandidateKind::Repair;
        // What the model is asked to choose between. A repair question carries one
        // name fewer: its own "none of these" answer is a criterion too, and the
        // endpoint's wall counts criteria (measured: 26 accepted, 27 refused).
        let room = request
            .candidates
            .len()
            .min(MAX_CANDIDATES - usize::from(repair));
        let mut criteria = request.candidates[..room].to_vec();
        if repair {
            criteria.push(NO_NAME.to_string());
        }
        let error = request
            .error
            .as_deref()
            .map(|text| head_of(text, MAX_ERROR_CHARS))
            .map(str::trim)
            .filter(|text| !text.is_empty());
        // The repair question is about a failure, so it needs both halves of one:
        // the SQL that did not run and the error it gave. Either alone is a
        // different question, and not one worth a model call.
        if repair && (statements.is_empty() || error.is_none()) {
            return RankResponse::unchanged(
                false,
                "the repair question needs the failing SQL and its error",
            );
        }
        // A single candidate is no choice at all, and with nothing to read either
        // there is nothing here worth a model call. A statement on its own *is*
        // worth one: it is the whole subject of the risk question, and the editor
        // asks it that way when the cursor settles in a statement no ranking
        // request has carried.
        if criteria.len() < 2 && statements.is_empty() {
            return RankResponse::unchanged(false, "fewer than two candidates to choose from");
        }

        let ranked_question = criteria.len() >= 2;
        let mut questions = Vec::new();
        if ranked_question {
            questions.push(Question::Choice {
                name: RANK_NAME.to_string(),
                kind: request.kind,
                // The wording names the state block its subject is in: the line for
                // a completion, and the failing SQL (`statement_0` — a repair is
                // asked about exactly one statement) for a repair.
                instruction: request
                    .kind
                    .instruction()
                    .replace("%BLOCK%", &format!("{STATEMENT_BLOCK}_0")),
                criteria: criteria.clone(),
            });
        }
        // One graded question per statement, each naming the block it is about,
        // so one request can carry a whole script's worth of readings.
        for index in 0..statements.len() {
            questions.push(Question::Score {
                name: format!("{RISK_NAME}_{index}"),
                instruction: RISK_INSTRUCTION
                    .replace("%BLOCK%", &format!("{STATEMENT_BLOCK}_{index}")),
                criteria: RISK_SCALE.iter().map(|step| step.to_string()).collect(),
            });
        }

        let mut state = serde_json::Map::new();
        state.insert("editor".to_string(), Value::String(state_text.to_string()));
        for (index, statement) in statements.iter().enumerate() {
            state.insert(
                format!("{STATEMENT_BLOCK}_{index}"),
                Value::String(statement.clone()),
            );
        }
        if let Some(error) = error {
            state.insert("error".to_string(), Value::String(error.to_string()));
        }

        let answered = match self.ask(model, &Value::Object(state), &questions).await {
            Ok(answered) => answered,
            Err(error) => return RankResponse::unchanged(false, error.to_string()),
        };
        // Read before the ranking is judged, and independently of it: a model
        // that answered one question and not another still said something, and
        // each reading is filed under the statement it was asked about.
        let readings: Vec<RiskReading> = statements
            .iter()
            .enumerate()
            .filter_map(|(index, statement)| {
                let scored = parse_score(&answered, &format!("{RISK_NAME}_{index}"))?;
                Some(RiskReading {
                    statement: statement.clone(),
                    verdict: RiskVerdict::of_level(scored.score),
                    level: scored.score,
                    confidence: scored.confidence,
                })
            })
            .collect();

        // The ranking half, when it was asked at all. When it was not, its
        // absence is reported the way a missing answer always is — with
        // `available` false — so a reader can tell "no ranking" from "a ranking
        // of nothing".
        let answer = if ranked_question {
            parse_choice(&answered, RANK_NAME)
        } else {
            Err(DecisionError::Malformed(
                "fewer than two candidates to choose from".to_string(),
            ))
        };

        match answer {
            Ok(answer) => {
                // A repair answer that names the question's own "none of these" is
                // an answer, and not a ranking: naming a schema member anyway would
                // send the reader to a name their SQL never meant.
                let declined = answer.choice == NO_NAME;
                // A model that answered without conviction is not acted on, but it
                // did answer, so the editor can say so instead of blaming a missing
                // model.
                if answer.confidence < MIN_CONFIDENCE {
                    return RankResponse {
                        choice: (!declined).then(|| answer.choice.clone()),
                        confidence: answer.confidence,
                        readings,
                        ..RankResponse::unchanged(
                            true,
                            format!(
                                "the model was not sure enough ({:.2} below {MIN_CONFIDENCE})",
                                answer.confidence
                            ),
                        )
                    };
                }
                RankResponse {
                    ranked: if declined {
                        Vec::new()
                    } else {
                        order_by_answer(&request.candidates, &answer)
                    },
                    choice: (!declined).then(|| answer.choice.clone()),
                    confidence: answer.confidence,
                    available: true,
                    reason: declined.then(|| NO_NAME_REASON.to_string()),
                    readings,
                }
            }
            Err(error) => RankResponse {
                readings,
                ..RankResponse::unchanged(false, error.to_string())
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// A `choice` question as `rank` builds one: the wording for the kind, with the
    /// block its subject is in filled in.
    fn choice(kind: CandidateKind, criteria: Vec<String>) -> Question {
        Question::Choice {
            name: RANK_NAME.to_string(),
            kind,
            instruction: kind.instruction().replace("%BLOCK%", "statement_0"),
            criteria,
        }
    }

    /// The criteria a repair question carries: the schema's names, closest first,
    /// and the question's own "none of these" after them.
    fn repair_criteria(list: &[&str]) -> Vec<String> {
        let mut criteria = names(list);
        criteria.push(NO_NAME.to_string());
        criteria
    }

    #[test]
    fn the_request_names_every_candidate_as_a_criterion() {
        let candidates = names(&["orders", "order_items"]);
        let body = questions_request(
            "nimble",
            &json!({ "editor": "SELECT * FROM ord" }),
            &[choice(CandidateKind::Table, candidates.clone())],
        );
        assert_eq!(body["model"], "nimble");
        assert_eq!(body["state"]["editor"], "SELECT * FROM ord");
        assert_eq!(body["questions"]["candidate"]["type"], "choice");
        let criteria = body["questions"]["candidate"]["criteria"]
            .as_object()
            .expect("criteria is an object");
        assert_eq!(criteria.len(), 2);
        assert!(criteria.contains_key("orders"));
        assert!(criteria.contains_key("order_items"));
    }

    #[test]
    fn a_choice_answer_is_read_back() {
        let body = json!({
            "answers": {
                "candidate": {
                    "type": "choice",
                    "choice": "order_items",
                    "probabilities": { "orders": 0.2, "order_items": 0.8 },
                    "confidence": 0.61
                }
            }
        });
        let answer = parse_choice(&body, RANK_NAME).expect("parses");
        assert_eq!(answer.choice, "order_items");
        assert_eq!(answer.confidence, 0.61);
        assert_eq!(answer.probabilities.len(), 2);
    }

    #[test]
    fn an_unexpected_reply_is_reported_rather_than_panicking() {
        assert!(parse_choice(&json!({}), RANK_NAME).is_err());
        assert!(parse_choice(&json!({ "answers": { "candidate": {} } }), RANK_NAME).is_err());
    }

    #[test]
    fn a_reply_that_answers_only_the_ranking_still_ranks() {
        // The questions are independent: a reply that answers one of them still
        // says something, and a statement the reply is silent about is no reading
        // at all — never a zero the caller would read as "safe".
        let only_ranking = json!({
            "answers": { "candidate": { "type": "choice", "choice": "orders", "confidence": 0.9 } }
        });
        assert_eq!(
            parse_choice(&only_ranking, RANK_NAME)
                .expect("parses")
                .choice,
            "orders"
        );
        assert_eq!(parse_score(&only_ranking, "risk_0"), None);
        assert_eq!(parse_score(&json!({}), "risk_0"), None);
    }

    #[test]
    fn a_score_answer_becomes_a_step_of_the_scale() {
        // The reply `/v1/systemone` gives for a `score` question, carrying the
        // positions a real model put the measured statements at on this machine.
        let body = json!({
            "answers": {
                "risk_0": { "type": "score", "score": 2.988, "confidence": 0.963 },
                "risk_1": { "type": "score", "score": 1.646, "confidence": 0.352 },
                "risk_2": { "type": "score", "score": 1.0, "confidence": 0.912 },
                "risk_3": { "type": "score", "score": 0.018, "confidence": 0.948 },
            }
        });
        let verdict = |name: &str| {
            let scored = parse_score(&body, name).expect("the reply answered it");
            RiskVerdict::of_level(scored.score)
        };
        // The four statements those positions came from, in the same order:
        // `DROP TABLE`, `DELETE FROM orders`, a bounded `UPDATE ... WHERE id = 1`
        // and a `SELECT`. The position is what decides the step.
        assert_eq!(verdict("risk_0"), RiskVerdict::Structure);
        assert_eq!(verdict("risk_1"), RiskVerdict::Rows);
        assert_eq!(verdict("risk_2"), RiskVerdict::Bounded);
        assert_eq!(verdict("risk_3"), RiskVerdict::Safe);

        // A question the reply does not answer, a position that is not a number,
        // and a reply with no answers at all are each no reading.
        assert_eq!(parse_score(&body, "risk_9"), None);
        assert_eq!(
            parse_score(
                &json!({ "answers": { "risk_0": { "score": "high" } } }),
                "risk_0"
            ),
            None
        );
        assert_eq!(parse_score(&json!({}), "risk_0"), None);
    }

    #[test]
    fn the_kind_is_what_picks_the_wording() {
        let columns = names(&["order_number", "ordered_at"]);
        let question = |kind| {
            questions_request(
                "nimble",
                &json!({ "editor": "SELECT o.ord FROM orders o" }),
                &[choice(kind, columns.clone())],
            )
        };
        let as_tables = question(CandidateKind::Table);
        let as_columns = question(CandidateKind::Column);
        let asked = |body: &Value| {
            body["questions"][RANK_NAME]["instructions"]
                .as_str()
                .expect("the instruction is text")
                .to_string()
        };
        assert_ne!(
            asked(&as_tables),
            asked(&as_columns),
            "the two kinds ask the same question"
        );
        assert!(
            asked(&as_tables).contains("tables"),
            "{}",
            asked(&as_tables)
        );
        assert!(
            asked(&as_columns).contains("columns"),
            "{}",
            asked(&as_columns)
        );
        // The names are the criteria either way; only what they are called
        // changes, so the model is told what it is choosing between.
        assert_eq!(
            as_tables["questions"][RANK_NAME]["criteria"]["order_number"],
            "the order_number table"
        );
        assert_eq!(
            as_columns["questions"][RANK_NAME]["criteria"]["order_number"],
            "the order_number column"
        );
    }

    #[test]
    fn a_request_without_a_kind_asks_about_tables() {
        // The wire name the editor sends, and what it means when the editor says
        // nothing: a version that only ranks tables keeps working unchanged.
        let without = |value: Value| -> RankRequest {
            serde_json::from_value(value).expect("the request deserialises")
        };
        let bare = without(json!({
            "state": "SELECT * FROM ord",
            "candidates": ["orders", "order_items"],
            "model": "nimble"
        }));
        assert_eq!(bare.kind, CandidateKind::Table);
        // A request that names no statement asks the ranking alone, which is what
        // the editor's own plain question does.
        assert!(bare.statements.is_empty());

        let column = without(json!({
            "state": "SELECT o.ord FROM orders o",
            "candidates": ["order_number", "ordered_at"],
            "model": "nimble",
            "kind": "column"
        }));
        assert_eq!(column.kind, CandidateKind::Column);
    }

    /// The graded question about one statement, as `rank` builds it: the scale
    /// is the criteria, and the instruction names the block its subject is in.
    fn risk_question(index: usize) -> Question {
        Question::Score {
            name: format!("{RISK_NAME}_{index}"),
            instruction: RISK_INSTRUCTION.replace("%BLOCK%", &format!("{STATEMENT_BLOCK}_{index}")),
            criteria: RISK_SCALE.iter().map(|step| step.to_string()).collect(),
        }
    }

    #[test]
    fn both_questions_travel_in_one_request() {
        let questions = [
            choice(CandidateKind::Table, names(&["orders", "order_items"])),
            risk_question(0),
            risk_question(1),
        ];
        let body = questions_request(
            "nimble",
            &json!({
                "editor": "SELECT * FROM ord",
                "statement_0": "DELETE FROM orders",
                "statement_1": "DROP TABLE orders",
            }),
            &questions,
        );
        let asked = body["questions"]
            .as_object()
            .expect("questions is an object");
        assert_eq!(asked.len(), 3, "the questions did not travel together");
        assert_eq!(asked[RANK_NAME]["type"], "choice");
        assert_eq!(asked["risk_0"]["type"], "score");
        assert_eq!(asked["risk_1"]["type"], "score");
        // The scale is the question's criteria, and it goes out as an array of
        // descriptions — the shape `score` insists on.
        assert_eq!(asked["risk_0"]["criteria"], json!(RISK_SCALE));
        // Each question names the block it is about, which is what lets one
        // request carry a reading per statement without the statements running
        // together: the wording is the only thing that tells them apart.
        let instruction = |index: usize| {
            asked[&format!("risk_{index}")]["instructions"]
                .as_str()
                .expect("the instruction is text")
                .to_string()
        };
        assert!(instruction(0).contains("statement_0"), "{}", instruction(0));
        assert!(instruction(1).contains("statement_1"), "{}", instruction(1));
        // Every block of state reaches the model: the line the ranking is about
        // and one per statement the risk questions are about.
        assert_eq!(body["state"]["editor"], "SELECT * FROM ord");
        assert_eq!(body["state"]["statement_0"], "DELETE FROM orders");
        assert_eq!(body["state"]["statement_1"], "DROP TABLE orders");
    }

    #[test]
    fn the_chosen_option_leads_the_ranking() {
        let candidates = names(&["orders", "order_items", "orchards"]);
        let answer = ChoiceAnswer {
            choice: "orchards".to_string(),
            confidence: 0.4,
            probabilities: vec![
                ("orders".to_string(), 0.1),
                ("order_items".to_string(), 0.3),
                ("orchards".to_string(), 0.6),
            ],
        };
        assert_eq!(
            order_by_answer(&candidates, &answer),
            names(&["orchards", "order_items", "orders"])
        );
    }

    #[test]
    fn a_choice_outside_the_candidates_is_ignored() {
        let candidates = names(&["orders", "order_items"]);
        let answer = ChoiceAnswer {
            choice: "not_a_table".to_string(),
            confidence: 0.9,
            probabilities: Vec::new(),
        };
        // The invented name is dropped; the real ones are still ranked, with the
        // remaining names in their original order when no probabilities came back.
        assert_eq!(order_by_answer(&candidates, &answer), candidates);
    }

    #[tokio::test]
    async fn an_unreachable_model_is_unavailable_rather_than_an_error() {
        // Port 9 is the discard port; nothing listens there, so the request is
        // refused instead of hanging until the timeout.
        let client = DecisionClient::with_base_url("http://127.0.0.1:9");
        let response = client
            .rank(&RankRequest {
                state: "SELECT * FROM ord".to_string(),
                candidates: names(&["orders", "order_items"]),
                model: "nimble".to_string(),
                kind: CandidateKind::Table,
                statements: names(&["SELECT * FROM ord"]),
                error: None,
            })
            .await;
        assert!(!response.available);
        assert!(response.readings.is_empty(), "no model, no reading");
        assert!(response.ranked.is_empty());
        assert!(response.reason.is_some());
    }

    /// A one-shot stand-in for Ollama: it answers the single request the way
    /// `/v1/systemone` does, so the whole path — URL, request body, response
    /// parsing, ranking — is exercised without a real model. Returns its port.
    fn stub_model(body: &'static str) -> u16 {
        stub_model_after(Duration::ZERO, body)
    }

    /// The same stand-in, slow to answer: what Ollama looks like while it is
    /// loading a model that is not resident yet.
    fn stub_model_after(delay: Duration, body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept one request");
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        port
    }

    /// Read one whole HTTP request off `stream` and hand back its body. The
    /// announced `Content-Length` is followed rather than trusted one read: a
    /// request that reaches the bound is far bigger than one buffer.
    fn read_request_body(stream: &mut std::net::TcpStream) -> String {
        let mut received: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = stream.read(&mut buffer).expect("read the request");
            if read == 0 {
                return String::new();
            }
            received.extend_from_slice(&buffer[..read]);
            let header_end = received.windows(4).position(|window| window == b"\r\n\r\n");
            let Some(start) = header_end else { continue };
            let header = String::from_utf8_lossy(&received[..start]).to_lowercase();
            let length = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if received.len() >= start + 4 + length {
                return String::from_utf8_lossy(&received[start + 4..start + 4 + length])
                    .to_string();
            }
        }
    }

    /// A stand-in that also hands the request body back, so a test can read what
    /// actually went on the wire rather than what it hoped would.
    fn stub_model_capturing(body: &'static str, captured: std::sync::mpsc::Sender<String>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept one request");
            let received = read_request_body(&mut stream);
            let sent = captured.send(received);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            let _ = sent;
        });
        port
    }

    #[tokio::test]
    async fn a_request_larger_than_a_keystroke_reaches_the_model_bounded() {
        // The wire is where it matters. The editor trims its own input long
        // before this, so a request this size is not the app talking — it is a
        // caller that did not trim — and without the bound that caller would
        // decide how much work one keystroke asks of this machine. The answer
        // still has to come back ranked: a request that is merely too large is
        // truncated, not refused.
        let answer = r#"{"answers":{"candidate":{"type":"choice","choice":"orders","probabilities":{"orders":0.9,"table_002":0.1},"confidence":0.9}}}"#;
        let (sender, receiver) = std::sync::mpsc::channel();
        let port = stub_model_capturing(answer, sender);
        let client = DecisionClient::with_base_url(format!("http://127.0.0.1:{port}"));

        // `orders` first, so it is one of the names the bound keeps and the
        // answer naming it is a ranking rather than an invented name.
        let mut candidates = names(&["orders"]);
        candidates.extend((0..499).map(|index| format!("table_{index:03}")));
        // More statements than one request may carry, the first of them far
        // larger than one statement is allowed to be: how much work this is is
        // the bound's business, not the caller's.
        let mut statements = vec!["DELETE FROM orders;".repeat(20_000)];
        statements.extend((0..40).map(|index| format!("SELECT {index}")));
        let response = client
            .rank(&RankRequest {
                state: "SELECT * FROM ord;".repeat(20_000),
                candidates,
                model: "m".repeat(5_000),
                kind: CandidateKind::Table,
                statements,
                error: None,
            })
            .await;
        assert!(response.available, "reason: {:?}", response.reason);
        assert_eq!(
            response.ranked.first().map(String::as_str),
            Some("orders"),
            "a truncated request was not answered"
        );

        let body: Value = serde_json::from_str(
            &receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("the stub saw a request"),
        )
        .expect("the body is json");
        let state = body["state"]["editor"].as_str().expect("the line went out");
        assert_eq!(state.chars().count(), MAX_STATE_CHARS);
        assert!(
            state.ends_with("FROM ord;"),
            "the tail is kept, as the editor keeps it: {:?}",
            &state[state.len().saturating_sub(20)..]
        );
        let statement = body["state"]["statement_0"]
            .as_str()
            .expect("the statement went out");
        assert_eq!(statement.chars().count(), MAX_STATEMENT_CHARS);
        assert!(statement.starts_with("DELETE"), "the head is kept");
        // One question per statement, and no more statements than the bound:
        // the caller sent forty-one, so a request that carried them all would be
        // the caller deciding how much work one keystroke asks of this machine.
        let asked = body["questions"]
            .as_object()
            .expect("the questions went out");
        assert_eq!(
            asked.len(),
            MAX_STATEMENTS + 1,
            "one question per statement, plus the ranking"
        );
        assert!(
            asked.contains_key("risk_0")
                && asked.contains_key(&format!("risk_{}", MAX_STATEMENTS - 1))
        );
        let beyond = format!("statement_{MAX_STATEMENTS}");
        assert!(
            body["state"].get(beyond.as_str()).is_none(),
            "more statements went out than the bound allows"
        );
        // The endpoint's own wall is 64 KiB of text and schema, so that is what
        // the bound is measured against: everything this client would ever send
        // for one keystroke has to fit under it, or an over-large request comes
        // back refused rather than answered.
        let text: usize = state.chars().count()
            + (0..MAX_STATEMENTS)
                .map(|index| {
                    body["state"][&format!("statement_{index}")]
                        .as_str()
                        .expect("the statement went out")
                        .chars()
                        .count()
                })
                .sum::<usize>();
        let questions = asked.values().map(Value::to_string).collect::<String>();
        assert!(
            text + questions.chars().count() < 64 * 1024,
            "the request is over the endpoint's text wall: {text} + {}",
            questions.chars().count()
        );
        let criteria = body["questions"][RANK_NAME]["criteria"]
            .as_object()
            .expect("the question names its criteria");
        assert_eq!(criteria.len(), MAX_CANDIDATES);
        assert_eq!(
            body["model"]
                .as_str()
                .expect("a model name")
                .chars()
                .count(),
            MAX_MODEL_NAME_CHARS
        );
    }

    #[test]
    fn a_truncated_field_lands_on_a_character_boundary() {
        // The counts are characters, not bytes: a request full of multi-byte
        // characters has to be cut between them, not through one.
        let text = "éü🙂".repeat(100);
        let tail = tail_of(&text, 10);
        assert_eq!(tail.chars().count(), 10);
        assert!(text.ends_with(tail), "it is the text's own tail");
        let head = head_of(&text, 10);
        assert_eq!(head.chars().count(), 10);
        assert!(text.starts_with(head), "it is the text's own head");

        // A field shorter than its bound — every field the editor sends — is
        // returned untouched, which is what makes the bound a backstop rather
        // than a policy.
        assert_eq!(
            tail_of("SELECT * FROM ord", MAX_STATE_CHARS),
            "SELECT * FROM ord"
        );
        assert_eq!(
            head_of("SELECT * FROM ord", MAX_STATEMENT_CHARS),
            "SELECT * FROM ord"
        );
        assert_eq!(head_of(&text, 0), "");
        assert_eq!(tail_of(&text, 0), "");
    }

    /// The step the editor warns at and above (`isDestructive` in
    /// `src/lib/statementRisk.ts`). It is not the client's to decide, so the
    /// tests name it here rather than importing a policy the client does not own.
    const WARNING_STEP: RiskVerdict = RiskVerdict::Rows;

    /// The question every ranking test asks. It names the statement it sits in,
    /// so the batched form is the one the tests exercise.
    fn table_question() -> RankRequest {
        RankRequest {
            state: "SELECT * FROM ord".to_string(),
            candidates: names(&["orders", "order_items"]),
            model: "nimble".to_string(),
            kind: CandidateKind::Table,
            statements: names(&["SELECT * FROM ord"]),
            error: None,
        }
    }

    /// The same question without the statements: the ranking asked alone.
    fn ranking_only(request: &RankRequest) -> RankRequest {
        RankRequest {
            state: request.state.clone(),
            candidates: request.candidates.clone(),
            model: request.model.clone(),
            kind: CandidateKind::Table,
            statements: Vec::new(),
            error: None,
        }
    }

    #[tokio::test]
    async fn a_live_endpoint_is_asked_and_ranked() {
        let confident = r#"{"answers":{"candidate":{"type":"choice","choice":"order_items","probabilities":{"orders":0.2,"order_items":0.8},"confidence":0.7}}}"#;
        let client =
            DecisionClient::with_base_url(format!("http://127.0.0.1:{}", stub_model(confident)));
        let response = client.rank(&table_question()).await;
        assert!(response.available, "reason: {:?}", response.reason);
        assert_eq!(response.choice.as_deref(), Some("order_items"));
        assert_eq!(response.ranked, names(&["order_items", "orders"]));
        assert_eq!(response.confidence, 0.7);
        // The stub answered only the ranking question, so a statement it said
        // nothing about has no reading rather than an invented one.
        assert!(response.readings.is_empty());
    }

    #[tokio::test]
    async fn every_statement_gets_its_own_reading_from_one_reply() {
        // The point of batching: one reply, one reading per statement, each
        // usable without the others. This is the shape a real `/v1/systemone`
        // gives for a script's worth of them.
        let both = r#"{"answers":
            {"candidate":{"type":"choice","choice":"order_items","probabilities":{"orders":0.2,"order_items":0.8},"confidence":0.7},
             "risk_0":{"type":"score","score":0.018,"confidence":0.948},
             "risk_1":{"type":"score","score":2.988,"confidence":0.963}}}"#;
        let client =
            DecisionClient::with_base_url(format!("http://127.0.0.1:{}", stub_model(both)));
        let response = client
            .rank(&RankRequest {
                statements: names(&["SELECT * FROM ord WHERE id = 1", "DROP TABLE orders"]),
                ..table_question()
            })
            .await;
        assert!(response.available, "reason: {:?}", response.reason);
        assert_eq!(response.ranked, names(&["order_items", "orders"]));
        // Each reading echoes the statement it was asked about, in the order the
        // statements were sent, so the editor files it under the text the model
        // was actually shown rather than the text it happens to be holding.
        assert_eq!(
            response.readings,
            vec![
                RiskReading {
                    statement: "SELECT * FROM ord WHERE id = 1".to_string(),
                    verdict: RiskVerdict::Safe,
                    level: 0.018,
                    confidence: 0.948,
                },
                RiskReading {
                    statement: "DROP TABLE orders".to_string(),
                    verdict: RiskVerdict::Structure,
                    level: 2.988,
                    confidence: 0.963,
                },
            ]
        );
        assert!(response.readings[1].verdict >= WARNING_STEP);
    }

    #[tokio::test]
    async fn a_model_that_is_still_loading_is_waited_for() {
        // The question a session starts with is the one asked while Ollama is
        // still loading the model, which takes seconds rather than milliseconds.
        // Nothing on screen is waiting — the list is already shown — so the
        // client has to sit through the load instead of giving up inside it.
        // Two seconds is well past the 1.2 s the budget used to be, which is the
        // failure this pins; the live test measures the real 7.25 s load.
        let confident = r#"{"answers":{"candidate":{"type":"choice","choice":"order_items","probabilities":{"orders":0.2,"order_items":0.8},"confidence":0.7}}}"#;
        let client = DecisionClient::with_base_url(format!(
            "http://127.0.0.1:{}",
            stub_model_after(Duration::from_secs(2), confident)
        ));
        let response = client.rank(&table_question()).await;
        assert!(
            response.available,
            "a model that was still loading was treated as missing: {:?}",
            response.reason
        );
        assert_eq!(response.choice.as_deref(), Some("order_items"));
        assert_eq!(response.ranked, names(&["order_items", "orders"]));
    }

    #[tokio::test]
    async fn an_answer_the_model_is_unsure_of_is_not_acted_on() {
        // A near-tie between the two tables: the model answered, but barely.
        let unsure = r#"{"answers":{"candidate":{"type":"choice","choice":"orders","probabilities":{"orders":0.42,"order_items":0.38},"confidence":0.04}}}"#;
        let client =
            DecisionClient::with_base_url(format!("http://127.0.0.1:{}", stub_model(unsure)));
        let response = client.rank(&table_question()).await;
        // It answered — which is not the same as no model at all, so the editor
        // can say "unsure" rather than "unavailable".
        assert!(response.available);
        assert!(response.ranked.is_empty(), "the list is left alone");
        assert!((response.confidence - 0.04).abs() < f64::EPSILON);
        assert!(response
            .reason
            .expect("a reason")
            .contains("not sure enough"));
    }

    /// The whole ranking path against the model on this machine, and the one
    /// place its latency is measured. Needs Ollama running with a decision model
    /// pulled:
    ///
    /// ```bash
    /// QUARRY_TEST_OLLAMA=1 cargo test --manifest-path src-tauri/Cargo.toml \
    ///   -- --ignored --nocapture ranks_with_a_real_model
    /// ```
    ///
    /// `QUARRY_TEST_OLLAMA_MODEL` picks the model (default `nimble`) and
    /// `QUARRY_OLLAMA_URL` the origin.
    #[tokio::test]
    #[ignore = "needs a local Ollama with a decision model (see module docs)"]
    async fn ranks_with_a_real_model() {
        if std::env::var("QUARRY_TEST_OLLAMA").is_err() {
            eprintln!("skipping: QUARRY_TEST_OLLAMA is not set");
            return;
        }
        let model =
            std::env::var("QUARRY_TEST_OLLAMA_MODEL").unwrap_or_else(|_| "nimble".to_string());
        let request = RankRequest {
            state: "SELECT * FROM ord".to_string(),
            // Deliberately not in the order the model should answer in: the
            // table the prefix actually names sits last, so a ranking that
            // leads with it is a reordering rather than the list handed back
            // unchanged. This is also how the editor's own candidates arrive —
            // its completion scoring puts `orders` last for this prefix.
            candidates: names(&["orchards", "customers", "order_items", "orders"]),
            model,
            kind: CandidateKind::Table,
            // The statement the cursor is in: the risk question rides along with
            // the ranking, in this same request.
            statements: names(&["SELECT * FROM ord"]),
            error: None,
        };
        let client = DecisionClient::new();

        // The first call after Ollama has dropped the model from memory pays to
        // load it again — about seven seconds for `nimble`. That load is what the
        // client's budget is sized for, so the first question of a session is
        // answered rather than dropped; the retry loop is left for a slower disk,
        // which is still allowed to miss.
        let cold = std::time::Instant::now();
        let mut response = client.rank(&request).await;
        eprintln!(
            "first call after an idle model: {:?} -> {}",
            cold.elapsed(),
            response.choice.as_deref().unwrap_or("no model answered")
        );
        for attempt in 1..=6 {
            if response.available {
                break;
            }
            eprintln!(
                "attempt {attempt}: {}",
                response.reason.as_deref().unwrap_or("no answer")
            );
            tokio::time::sleep(Duration::from_secs(5)).await;
            response = client.rank(&request).await;
        }
        assert!(
            response.available,
            "no model answered: {:?}",
            response.reason
        );

        // What the editor acts on: a confident answer, ranked, with every
        // candidate accounted for exactly once.
        assert!(
            response.confidence >= MIN_CONFIDENCE,
            "an answer below the threshold was applied: {response:?}"
        );
        let mut ranked = response.ranked.clone();
        ranked.sort();
        let mut expected = request.candidates.clone();
        expected.sort();
        assert_eq!(ranked, expected, "the ranking is not the candidate set");

        // The SQL says `FROM ord`, so the pick has to be one of the tables that
        // prefix actually names — not an unrelated one that merely came up.
        let pick = response.ranked.first().expect("a ranking");
        assert!(
            pick == "orders" || pick == "order_items",
            "picked {pick}, which the typed prefix does not name"
        );
        eprintln!("ranked {pick} (confidence {:.3})", response.confidence);
        // The point of the whole module: a real model moved the table the SQL
        // names to the front of a list it did not start in front of. Without
        // this, "the ranking was applied" and "the list came back untouched"
        // look identical.
        assert_ne!(
            response.ranked, request.candidates,
            "the model returned the candidates in the order they were sent"
        );
        assert_eq!(
            response.ranked.first().map(String::as_str),
            Some(pick.as_str()),
            "the pick does not lead the ranking"
        );
        // The exact payload the editor reads over IPC. Printed so the case that
        // is hardest to stage — a real model applying a real ranking — can be
        // pinned in the frontend against the model's own answer rather than a
        // hand-written imitation of one.
        eprintln!(
            "wire: {}",
            serde_json::to_string(&response).expect("the response serialises")
        );

        // The risk question rode along in that same request, and `SELECT` is not
        // destructive: the reading sits at the bottom of the scale, below the
        // step the warning fires at.
        let read = response
            .readings
            .first()
            .expect("the batched reply carried no reading");
        assert_eq!(read.statement, "SELECT * FROM ord");
        assert!(
            read.verdict < WARNING_STEP,
            "a SELECT was read as {:?} at {}",
            read.verdict,
            read.level
        );
        eprintln!(
            "risk: {:?} at {:.3} ({:.3} sure)",
            read.verdict, read.level, read.confidence
        );

        // What the extra question costs is deliberately *not* timed here. The
        // two requests differ only in the trailing questions, and Ollama reuses
        // its prompt cache for a body it has already seen, so a repeated
        // ranking-only request comes back in ~50 ms while the paired one stays
        // near its real cost — a comparison that measures the cache rather than
        // the question. The cost is measured once, in the controlled probe the
        // module docs quote, against states the model had not seen.
        assert!(
            ranking_only(&request).statements.is_empty(),
            "the ranking-only form must not carry a statement"
        );

        // Warm latency: Ollama keeps the model resident, so this — not the cold
        // start — is what a keystroke actually pays.
        for round in 1..=3 {
            let started = std::time::Instant::now();
            let warm = client.rank(&request).await;
            let elapsed = started.elapsed();
            assert!(warm.available, "warm call {round} did not answer");
            eprintln!(
                "warm call {round}: {elapsed:?} -> {}",
                warm.choice.as_deref().unwrap_or("-")
            );
        }

        // The graded question over the statements the warning exists for, one
        // `score` per statement in a single request. This is where the numbers in
        // `RISK_SCALE`'s note come from, and what they have to show is an *order*:
        // the statements a warning is for above the ordinary edits, and the ones
        // that change nothing at the bottom. Which step any one statement lands
        // on is the model's business; the order is the feature, and a scale that
        // did not separate them would be no better than the yes/no question whose
        // numbers are in its note.
        let ladder = [
            "SELECT * FROM orders WHERE id = 1",
            "ALTER TABLE orders ADD COLUMN note TEXT",
            "CREATE INDEX idx_orders_id ON orders (id)",
            "UPDATE orders SET status = 'paid' WHERE id = 1",
            "INSERT INTO orders (id) VALUES (1)",
            "DELETE FROM orders WHERE id = 1",
            "DELETE FROM orders",
            "TRUNCATE TABLE orders",
            "DROP TABLE orders",
        ];
        let started = std::time::Instant::now();
        let graded = client
            .rank(&RankRequest {
                state: String::new(),
                candidates: Vec::new(),
                model: request.model.clone(),
                kind: CandidateKind::Table,
                statements: ladder.iter().map(|text| text.to_string()).collect(),
                error: None,
            })
            .await;
        eprintln!(
            "{} statements, one request: {:?}",
            ladder.len(),
            started.elapsed()
        );
        assert_eq!(
            graded.readings.len(),
            ladder.len(),
            "a statement went unread: {:?}",
            graded.reason
        );
        for reading in &graded.readings {
            eprintln!(
                "  {:>6.3} {:?}\t{}",
                reading.level, reading.verdict, reading.statement
            );
        }
        let at = |text: &str| {
            graded
                .readings
                .iter()
                .find(|reading| reading.statement == text)
                .unwrap_or_else(|| panic!("no reading for {text}"))
        };
        for statement in [
            "SELECT * FROM orders WHERE id = 1",
            "ALTER TABLE orders ADD COLUMN note TEXT",
        ] {
            assert!(
                at(statement).verdict < WARNING_STEP,
                "{statement} was read as {:?}",
                at(statement).verdict
            );
        }
        for statement in [
            "DELETE FROM orders",
            "TRUNCATE TABLE orders",
            "DROP TABLE orders",
        ] {
            assert!(
                at(statement).verdict >= WARNING_STEP,
                "{statement} was read as {:?} at {}",
                at(statement).verdict,
                at(statement).level
            );
        }
        assert!(
            at("DROP TABLE orders").verdict == RiskVerdict::Structure,
            "DROP TABLE was read as {:?}",
            at("DROP TABLE orders").verdict
        );

        // The four names above are a readable example; the number that matters
        // is the worst case a keystroke can actually present. The editor sends
        // at most `MAX_RANK_CANDIDATES` (12) names, and the hardest dozen is a
        // schema whose tables all start the same way, so that is what is timed
        // here. Every criterion is a token in the request, so a wider list is a
        // bigger prompt — this is where the timeout would start to bite.
        let crowded = RankRequest {
            state: "SELECT * FROM ord".to_string(),
            candidates: names(&[
                "order_items",
                "order_status",
                "orders",
                "order_audit",
                "order_discounts",
                "order_shipments",
                "order_returns",
                "order_events",
                "order_totals",
                "order_tags",
                "order_notes",
                "orders_archive",
            ]),
            model: request.model.clone(),
            kind: CandidateKind::Table,
            statements: names(&["SELECT * FROM ord"]),
            error: None,
        };
        for round in 1..=3 {
            let started = std::time::Instant::now();
            let wide = client.rank(&crowded).await;
            let elapsed = started.elapsed();
            // A warm call that could not answer within the client's timeout
            // would report unavailable — and would leave the editor's list
            // alone on every keystroke, which is the failure this measures.
            assert!(
                wide.available,
                "twelve candidates (round {round}) did not answer"
            );
            eprintln!(
                "12 candidates, same line: {elapsed:?} -> {}",
                wide.choice.as_deref().unwrap_or("-")
            );
        }

        // The other kind of question the editor asks: the same line, but about
        // the columns behind a qualifier. Only what the answer has to be is
        // asserted — it is a ranking of the names sent — because `CandidateKind`
        // records what was measured about how good those answers are, and this
        // is where that measurement comes from.
        let columns = RankRequest {
            state: "SELECT o.order_status FROM orders o WHERE o.ord".to_string(),
            candidates: names(&["order_number", "ordered_at", "order_status"]),
            model: request.model.clone(),
            kind: CandidateKind::Column,
            statements: names(&["SELECT o.order_status FROM orders o WHERE o.ord"]),
            error: None,
        };
        for round in 1..=2 {
            let started = std::time::Instant::now();
            let answered = client.rank(&columns).await;
            let elapsed = started.elapsed();
            assert!(
                answered.available,
                "the column question went unanswered: {:?}",
                answered.reason
            );
            let mut ranked = answered.ranked.clone();
            ranked.sort();
            let mut expected = columns.candidates.clone();
            expected.sort();
            assert_eq!(ranked, expected, "the ranking is not the candidate set");
            // What the wording produces, printed rather than asserted: a real
            // model is expected to name the column the statement already uses,
            // but not reliably enough for a test to insist on it.
            eprintln!(
                "columns (round {round}): {elapsed:?} -> {} ({:.3})",
                answered.choice.as_deref().unwrap_or("-"),
                answered.confidence
            );
        }
        // The same request asked as a table question, for contrast: the wording is
        // the only difference between them.
        let as_tables = RankRequest {
            state: columns.state.clone(),
            candidates: columns.candidates.clone(),
            model: columns.model.clone(),
            kind: CandidateKind::Table,
            statements: columns.statements.clone(),
            error: None,
        };
        let named_as_tables = client.rank(&as_tables).await;
        assert!(
            named_as_tables.available,
            "the table wording went unanswered"
        );
        eprintln!(
            "same names, table wording: {} ({:.3})",
            named_as_tables.choice.as_deref().unwrap_or("-"),
            named_as_tables.confidence
        );

        // The repair question: a statement that did not run, the database's own
        // error, and the schema's names to choose between. Its wording and its
        // decline criterion were both chosen by measurement, and this is where that
        // measurement lives — a name that is nearly there in each of the three
        // dialects, and a failure nothing in the schema fits, which has to come back
        // as a decline. A suggestion that names the wrong thing is worse than no
        // suggestion, which is the whole reason the question can say "none".
        let schema = names(&[
            "id",
            "order_number",
            "ordered_at",
            "total_cents",
            "quantity",
            "order_id",
            "order_items",
            "orders",
        ]);
        for (error, sql, wanted) in [
            (
                "no such column: ordred_at",
                "SELECT ordred_at FROM orders",
                Some("ordered_at"),
            ),
            (
                "Unknown column 'quanity' in 'field list'",
                "SELECT quanity FROM order_items",
                Some("quantity"),
            ),
            (
                "column \"oder_number\" does not exist",
                "SELECT oder_number FROM orders",
                Some("order_number"),
            ),
            (
                "no such column: profit_margin_eur",
                "SELECT profit_margin_eur FROM orders",
                None,
            ),
        ] {
            let started = std::time::Instant::now();
            let answered = client
                .rank(&RankRequest {
                    state: String::new(),
                    candidates: schema.clone(),
                    model: request.model.clone(),
                    kind: CandidateKind::Repair,
                    statements: names(&[sql]),
                    error: Some(error.to_string()),
                })
                .await;
            eprintln!(
                "repair ({error}) in {:?} -> {} ({})",
                started.elapsed(),
                answered.choice.as_deref().unwrap_or("declined"),
                answered.reason.as_deref().unwrap_or("-")
            );
            match wanted {
                Some(name) => assert_eq!(
                    answered.choice.as_deref(),
                    Some(name),
                    "the wrong name was suggested for {error}"
                ),
                None => assert!(
                    answered.ranked.is_empty(),
                    "a name was suggested for a failure the schema has nothing for: {:?}",
                    answered.choice
                ),
            }
        }

        // ...and what typing actually costs. Repeating one request measures the
        // model reusing its work on an identical prompt; a keystroke changes the
        // line, so every one of these is a prompt the model has not seen. This
        // is the number a user feels.
        //
        // Each pick is kept, because the editor answers a longer line from the
        // answer to a shorter one over the same choices (`src/lib/rankCache.ts`)
        // and is only right to do so while the model does not change its mind as
        // the identifier grows. This is that assumption, checked rather than
        // assumed.
        let mut picks: Vec<(&str, Option<String>, f64)> = Vec::new();
        for (index, typed) in ["o", "or", "ord", "orde", "order", "orders"]
            .iter()
            .enumerate()
        {
            let keystroke = RankRequest {
                state: format!("SELECT * FROM {typed}"),
                candidates: crowded.candidates.clone(),
                model: crowded.model.clone(),
                kind: CandidateKind::Table,
                statements: vec![format!("SELECT * FROM {typed}")],
                error: None,
            };
            let started = std::time::Instant::now();
            let answered = client.rank(&keystroke).await;
            let elapsed = started.elapsed();
            assert!(
                answered.available,
                "keystroke {index} (\"{typed}\") did not answer"
            );
            assert!(
                answered.confidence >= MIN_CONFIDENCE,
                "the model was unsure of \"{typed}\": {answered:?}"
            );
            eprintln!(
                "keystroke {} (\"{typed}\"): {elapsed:?} -> {}",
                index + 1,
                answered.choice.as_deref().unwrap_or("-")
            );
            picks.push((typed, answered.choice, answered.confidence));
        }
        for (typed, choice, confidence) in &picks {
            eprintln!(
                "over the same twelve choices, \"{typed}\" -> {} ({confidence:.3})",
                choice.as_deref().unwrap_or("-")
            );
        }
        assert!(
            picks.iter().all(|(_, choice, _)| choice == &picks[0].1),
            "the model changed its answer as the identifier grew, so answering a \
             longer line from a shorter one would put the wrong table first: {picks:?}"
        );
    }

    #[test]
    fn the_repair_question_names_both_blocks_and_offers_a_way_to_decline() {
        let body = questions_request(
            "nimble",
            &json!({
                "statement_0": "SELECT ordred_at FROM orders",
                "error": "no such column: ordred_at",
            }),
            &[choice(
                CandidateKind::Repair,
                repair_criteria(&["ordered_at", "order_number"]),
            )],
        );
        let asked = &body["questions"][RANK_NAME];
        let instruction = asked["instructions"].as_str().expect("the wording");
        // Both blocks are named, which is what tells the model which text is the
        // SQL and which is the error it produced.
        assert!(instruction.contains("statement_0"), "{instruction}");
        assert!(instruction.contains("block error"), "{instruction}");
        let criteria = asked["criteria"]
            .as_object()
            .expect("criteria is an object");
        assert_eq!(criteria.len(), 3);
        assert_eq!(criteria["ordered_at"], "the ordered_at name");
        // The one criterion that is not a schema name is a sentence already, rather
        // than being dressed up as `the … name`.
        assert_eq!(criteria[NO_NAME], NO_NAME);
    }

    #[tokio::test]
    async fn a_repair_that_declines_is_not_a_ranking() {
        // What the model answered when nothing in the schema fitted the error: the
        // question's own "none of these". A suggestion that named a schema member
        // anyway would send the reader to a name their SQL never meant.
        let declined = r#"{"answers":{"candidate":{"type":"choice","choice":"none of the listed names is the one it meant","probabilities":{"orders":0.06},"confidence":0.941}}}"#;
        let client =
            DecisionClient::with_base_url(format!("http://127.0.0.1:{}", stub_model(declined)));
        let response = client
            .rank(&RankRequest {
                state: String::new(),
                candidates: names(&["orders", "order_items"]),
                model: "nimble".to_string(),
                kind: CandidateKind::Repair,
                statements: names(&["SELECT profit_margin_eur FROM orders"]),
                error: Some("no such column: profit_margin_eur".to_string()),
            })
            .await;
        assert!(response.available, "reason: {:?}", response.reason);
        assert!(
            response.ranked.is_empty(),
            "a decline came back as a ranking"
        );
        assert_eq!(response.choice, None);
        assert!(response
            .reason
            .expect("a reason")
            .contains("fits the error"));
    }

    #[tokio::test]
    async fn a_repair_question_without_its_subject_is_not_asked() {
        // Half a failure is not a question: the SQL is what the names are read
        // against, and the error is what says which of them is missing.
        let client = DecisionClient::with_base_url("http://127.0.0.1:9");
        for (statements, error) in [
            (names(&["SELECT 1"]), None),
            (Vec::new(), Some("no such column: x".to_string())),
        ] {
            let response = client
                .rank(&RankRequest {
                    state: String::new(),
                    candidates: names(&["orders", "order_items"]),
                    model: "nimble".to_string(),
                    kind: CandidateKind::Repair,
                    statements,
                    error,
                })
                .await;
            assert!(!response.available);
            assert!(response
                .reason
                .expect("a reason")
                .contains("needs the failing SQL"));
        }
    }

    #[tokio::test]
    async fn a_repair_question_stays_inside_the_criteria_wall() {
        // The wall counts criteria, and the repair question's own "none of these" is
        // one of them — so a caller that sends the most names it can must not push
        // the question over it, which would come back refused rather than answered.
        let answer = r#"{"answers":{"candidate":{"type":"choice","choice":"ordered_at","probabilities":{"ordered_at":0.9},"confidence":0.9}}}"#;
        let (sender, receiver) = std::sync::mpsc::channel();
        let port = stub_model_capturing(answer, sender);
        let client = DecisionClient::with_base_url(format!("http://127.0.0.1:{port}"));
        let mut candidates = names(&["ordered_at"]);
        candidates.extend((0..499).map(|index| format!("name_{index:03}")));
        let response = client
            .rank(&RankRequest {
                state: String::new(),
                candidates,
                model: "nimble".to_string(),
                kind: CandidateKind::Repair,
                statements: names(&["SELECT ordred_at FROM orders"]),
                error: Some("no such column: ordred_at".to_string()),
            })
            .await;
        assert_eq!(
            response.ranked.first().map(String::as_str),
            Some("ordered_at")
        );
        let body: Value = serde_json::from_str(
            &receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("the stub saw a request"),
        )
        .expect("the body is json");
        let criteria = body["questions"][RANK_NAME]["criteria"]
            .as_object()
            .expect("the question names its criteria");
        assert_eq!(
            criteria.len(),
            MAX_CANDIDATES,
            "the decline criterion pushed the question over the wall"
        );
        assert!(criteria.contains_key(NO_NAME));
    }

    #[tokio::test]
    async fn a_single_candidate_is_not_sent_to_the_model() {
        let client = DecisionClient::with_base_url("http://127.0.0.1:9");
        let response = client
            .rank(&RankRequest {
                state: "SELECT * FROM ord".to_string(),
                candidates: names(&["orders"]),
                model: "nimble".to_string(),
                kind: CandidateKind::Table,
                statements: Vec::new(),
                error: None,
            })
            .await;
        assert!(!response.available);
        assert!(response
            .reason
            .expect("a reason")
            .contains("fewer than two"));
    }

    #[tokio::test]
    async fn a_statement_alone_is_still_worth_asking_about() {
        // What the editor asks when the cursor settles in a statement no ranking
        // request has carried: no candidates, so no ranking question — but the
        // risk question is the whole point of the call.
        let only_risk =
            r#"{"answers":{"risk_0":{"type":"score","score":2.988,"confidence":0.963}}}"#;
        let client =
            DecisionClient::with_base_url(format!("http://127.0.0.1:{}", stub_model(only_risk)));
        let response = client
            .rank(&RankRequest {
                state: String::new(),
                candidates: Vec::new(),
                model: "nimble".to_string(),
                kind: CandidateKind::Table,
                statements: names(&["DROP TABLE orders"]),
                error: None,
            })
            .await;
        assert_eq!(
            response.readings,
            vec![RiskReading {
                statement: "DROP TABLE orders".to_string(),
                verdict: RiskVerdict::Structure,
                level: 2.988,
                confidence: 0.963,
            }]
        );
        // No ranking was asked, so none is reported — which is not the same as a
        // ranking that came back empty.
        assert!(!response.available);
        assert!(response.ranked.is_empty());
        assert!(!response.reason.expect("a reason").is_empty());

        // A blank statement is nothing to ask about, so with no candidates
        // either the request still has no question in it.
        let empty = client
            .rank(&RankRequest {
                state: String::new(),
                candidates: Vec::new(),
                model: "nimble".to_string(),
                kind: CandidateKind::Table,
                statements: names(&["   "]),
                error: None,
            })
            .await;
        assert!(empty.readings.is_empty());
        assert!(empty.reason.expect("a reason").contains("fewer than two"));
    }
}
