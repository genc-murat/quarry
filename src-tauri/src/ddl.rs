//! Dialect-aware SQL generation for the object context menu.
//!
//! Everything here is pure string building so it can be unit tested without a
//! database. Identifiers are always quoted through [`Dialect::quote`] and
//! string literals through [`Dialect::string_literal`] — user supplied names
//! never reach the server unquoted.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::Value;

use crate::error::{DriverError, Result};
use crate::models::{
    ColumnDefinition, CreateTableRequest, IndexDefinition, IndexKind, MaintenanceKind,
    ObjectAction, ObjectActionRequest, ObjectKind, ObjectSchema, RowChangeKind, RowChangeRequest,
    RowValue,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Portable double-quote identifiers (PostgreSQL and the SQL standard).
    Ansi,
    Postgres,
    MySql,
    /// SQLite: double-quote identifiers, but a much smaller `ALTER TABLE` and
    /// no `AUTO_INCREMENT`/`ENGINE` clause.
    Sqlite,
    /// SQL Server: bracket-quoted identifiers, `IDENTITY` columns, and an
    /// `ALTER TABLE` that takes no `COLUMN` keyword and stores defaults as
    /// named constraints.
    SqlServer,
}

impl Dialect {
    /// Quote a single identifier, escaping the quote character by doubling it.
    pub fn quote(self, name: &str) -> String {
        match self {
            Dialect::MySql => format!("`{}`", name.replace('`', "``")),
            Dialect::SqlServer => format!("[{}]", name.replace(']', "]]")),
            Dialect::Ansi | Dialect::Postgres | Dialect::Sqlite => {
                format!("\"{}\"", name.replace('"', "\"\""))
            }
        }
    }

    /// Quote an optional qualifier plus the object name.
    pub fn quote_qualified(self, qualifier: Option<&str>, object: &str) -> String {
        match qualifier.filter(|value| !value.is_empty()) {
            Some(qualifier) => format!("{}.{}", self.quote(qualifier), self.quote(object)),
            None => self.quote(object),
        }
    }

    /// Quote a string literal by doubling embedded single quotes.
    ///
    /// PostgreSQL literals use the `E''` form and escape backslashes so the
    /// result stays a single literal even when a session sets
    /// `standard_conforming_strings = off`. With plain literals a value such as
    /// `\'; DROP ...` could otherwise end the literal early in that mode.
    pub fn string_literal(self, value: &str) -> String {
        match self {
            Dialect::Postgres => format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
            _ => format!("'{}'", value.replace('\'', "''")),
        }
    }

    /// The character used to quote identifiers, for UI templates.
    pub fn quote_char(self) -> &'static str {
        match self {
            Dialect::MySql => "`",
            Dialect::SqlServer => "[",
            _ => "\"",
        }
    }

    /// True when `CASCADE` (and other PostgreSQL-only DDL decorations) may be
    /// appended to a statement.
    fn supports_cascade(self) -> bool {
        matches!(self, Dialect::Ansi | Dialect::Postgres)
    }
}

fn qualified(request: &ObjectActionRequest, dialect: Dialect, object: &str) -> String {
    dialect.quote_qualified(request.namespace.as_deref(), object)
}

/// Build a `CREATE TABLE` statement from an introspected schema. Intended as
/// readable, copy-pasteable DDL rather than a byte-exact dump.
pub fn create_table(schema: &ObjectSchema, dialect: Dialect) -> String {
    let mut lines: Vec<String> = schema
        .columns
        .iter()
        .map(|column| {
            let definition = ColumnDefinition {
                name: column.name.clone(),
                data_type: column.data_type.clone(),
                nullable: column.nullable,
                default_value: column.default_value.clone(),
                is_primary_key: false,
                is_auto_increment: column.is_auto_increment,
                comment: column.comment.clone(),
                after: None,
            };
            format!("  {}", column_definition(&definition, dialect))
        })
        .collect();

    let primary: Vec<String> = schema
        .columns
        .iter()
        // SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` is already a complete
        // inline primary-key declaration; repeating it at table level is invalid.
        .filter(|column| {
            column.is_primary_key && !(dialect == Dialect::Sqlite && column.is_auto_increment)
        })
        .map(|column| dialect.quote(&column.name))
        .collect();
    if !primary.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", primary.join(", ")));
    }

    // SQLite cannot declare a non-primary index inline, and neither can SQL
    // Server; those are emitted as follow-up `CREATE INDEX` statements instead.
    let mut trailing: Vec<String> = Vec::new();
    for index in schema.indexes.iter().filter(|i| !i.primary) {
        let columns = index
            .columns
            .iter()
            .map(|c| dialect.quote(c))
            .collect::<Vec<_>>()
            .join(", ");
        if dialect == Dialect::Sqlite || dialect == Dialect::SqlServer {
            let unique = if index.unique { "UNIQUE " } else { "" };
            trailing.push(format!(
                "CREATE {unique}INDEX {} ON {} ({columns});",
                dialect.quote(&index.name),
                dialect.quote(&schema.name)
            ));
        } else {
            let keyword = if index.unique { "UNIQUE KEY" } else { "KEY" };
            lines.push(format!(
                "  {keyword} {} ({columns})",
                dialect.quote(&index.name)
            ));
        }
    }

    for fk in &schema.foreign_keys {
        let columns = fk
            .columns
            .iter()
            .map(|c| dialect.quote(c))
            .collect::<Vec<_>>()
            .join(", ");
        let referenced = fk
            .referenced_columns
            .iter()
            .map(|c| dialect.quote(c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {} ({referenced})",
            dialect.quote(&fk.name),
            dialect.quote(&fk.referenced_table)
        ));
    }

    let mut sql = format!(
        "CREATE TABLE {} (\n{}\n)",
        dialect.quote(&schema.name),
        lines.join(",\n")
    );
    if dialect == Dialect::MySql {
        sql.push_str(" ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }
    sql.push(';');
    for statement in trailing {
        sql.push('\n');
        sql.push_str(&statement);
    }
    sql
}

/// Render a single column definition, shared by CREATE and ADD/ALTER paths.
pub fn column_definition(column: &ColumnDefinition, dialect: Dialect) -> String {
    // SQLite has no `AUTO_INCREMENT`/identity clause: the only auto-assigning
    // column is a single `INTEGER PRIMARY KEY`, optionally declared
    // `AUTOINCREMENT`. Render that exact form; everything else follows the
    // shared path below.
    if dialect == Dialect::Sqlite && column.is_auto_increment {
        return format!(
            "{} INTEGER PRIMARY KEY AUTOINCREMENT",
            dialect.quote(&column.name)
        );
    }

    let mut sql = format!(
        "{} {}",
        dialect.quote(&column.name),
        column.data_type.trim()
    );
    if column.is_auto_increment {
        match dialect {
            Dialect::MySql => sql.push_str(" AUTO_INCREMENT"),
            Dialect::SqlServer => sql.push_str(" IDENTITY(1,1)"),
            Dialect::Postgres | Dialect::Ansi | Dialect::Sqlite => {
                sql.push_str(" GENERATED BY DEFAULT AS IDENTITY")
            }
        }
    }
    sql.push_str(if column.nullable {
        " NULL"
    } else {
        " NOT NULL"
    });
    if let Some(default) = column
        .default_value
        .as_deref()
        .filter(|d| !d.trim().is_empty())
    {
        // The default is a raw SQL expression (`0`, `CURRENT_TIMESTAMP`, `'x'`).
        sql.push_str(&format!(" DEFAULT {}", default.trim()));
    }
    if column.is_primary_key {
        sql.push_str(" PRIMARY KEY");
    }
    if dialect == Dialect::MySql {
        if let Some(comment) = column.comment.as_deref().filter(|c| !c.is_empty()) {
            sql.push_str(&format!(" COMMENT {}", dialect.string_literal(comment)));
        }
        // `AFTER` is MySQL-only; other engines ignore the hint.
        if let Some(after) = column.after.as_deref().filter(|a| !a.is_empty()) {
            sql.push_str(&format!(" AFTER {}", dialect.quote(after)));
        }
    }
    sql
}

fn default_index_name(object: &str, columns: &[String]) -> String {
    let mut name = format!("idx_{object}_{}", columns.join("_"));
    name.retain(|c| c.is_ascii_alphanumeric() || c == '_');
    if name.len() > 60 {
        name.truncate(60);
    }
    name
}

fn index_sql(request: &ObjectActionRequest, dialect: Dialect) -> Result<String> {
    let index: &IndexDefinition = request
        .index
        .as_ref()
        .ok_or_else(|| DriverError::Config("index definition is required".into()))?;
    if index.columns.is_empty() {
        return Err(DriverError::Config(
            "an index needs at least one column".into(),
        ));
    }

    let table = qualified(request, dialect, &request.object);
    let name = index
        .name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| default_index_name(&request.object, &index.columns));

    let columns = index
        .columns
        .iter()
        .zip(0..)
        .map(|(column, position)| {
            let mut sql = dialect.quote(column);
            if dialect == Dialect::MySql {
                if let Some(length) = index.prefix_lengths.get(position).filter(|l| **l > 0) {
                    sql.push_str(&format!("({length})"));
                }
            }
            sql
        })
        .collect::<Vec<_>>()
        .join(", ");

    match dialect {
        Dialect::MySql => {
            let keyword = match index.kind {
                IndexKind::FullText => "FULLTEXT INDEX",
                IndexKind::Hash => "INDEX",
                IndexKind::BTree if index.unique => "UNIQUE INDEX",
                IndexKind::BTree => "INDEX",
            };
            let using = if index.kind == IndexKind::Hash {
                " USING HASH"
            } else {
                ""
            };
            Ok(format!(
                "CREATE {keyword} {} ON {table} ({columns}){using};",
                dialect.quote(&name)
            ))
        }
        Dialect::Postgres | Dialect::Ansi => {
            if index.kind == IndexKind::FullText {
                return Err(DriverError::Unsupported(
                    "PostgreSQL full-text indexes need an expression; create one in SQL".into(),
                ));
            }
            let unique = if index.unique { "UNIQUE " } else { "" };
            let using = if index.kind == IndexKind::Hash {
                " USING hash"
            } else {
                ""
            };
            Ok(format!(
                "CREATE {unique}INDEX {} ON {table}{using} ({columns});",
                dialect.quote_qualified(request.namespace.as_deref(), &name)
            ))
        }
        Dialect::Sqlite => {
            if index.kind == IndexKind::FullText {
                return Err(DriverError::Unsupported(
                    "SQLite has no full-text index type; create an FTS5 table in SQL".into(),
                ));
            }
            let unique = if index.unique { "UNIQUE " } else { "" };
            Ok(format!(
                "CREATE {unique}INDEX {} ON {table} ({columns});",
                dialect.quote(&name)
            ))
        }
        Dialect::SqlServer => {
            if index.kind == IndexKind::FullText {
                return Err(DriverError::Unsupported(
                    "SQL Server full-text indexes are built on a catalog; create one in SQL".into(),
                ));
            }
            if index.kind == IndexKind::Hash {
                return Err(DriverError::Unsupported(
                    "SQL Server has no hash index type on a disk-based table".into(),
                ));
            }
            let unique = if index.unique { "UNIQUE " } else { "" };
            Ok(format!(
                "CREATE {unique}INDEX {} ON {table} ({columns});",
                dialect.quote(&name)
            ))
        }
    }
}

/// Turn an [`ObjectActionRequest`] into the SQL the driver should run.
pub fn action_sql(request: &ObjectActionRequest, dialect: Dialect) -> Result<String> {
    let table = qualified(request, dialect, &request.object);
    let kind = request.object_kind.unwrap_or(ObjectKind::Table);

    let sql = match request.action {
        ObjectAction::RenameObject => {
            let new_name = request
                .new_name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| DriverError::Config("a new name is required".into()))?;
            match dialect {
                Dialect::MySql => format!(
                    "RENAME TABLE {table} TO {};",
                    dialect.quote_qualified(request.namespace.as_deref(), new_name)
                ),
                Dialect::Sqlite => {
                    if kind == ObjectKind::Trigger {
                        return Err(DriverError::Unsupported(
                            "SQLite cannot rename a trigger; drop and recreate it".into(),
                        ));
                    }
                    if kind == ObjectKind::View {
                        return Err(DriverError::Unsupported(
                            "SQLite cannot rename a view; drop and recreate it".into(),
                        ));
                    }
                    format!("ALTER TABLE {table} RENAME TO {};", dialect.quote(new_name))
                }
                Dialect::SqlServer => {
                    // T-SQL has no `ALTER ... RENAME`; the system procedure
                    // takes the object's qualified name as a string literal.
                    format!(
                        "EXEC sp_rename {}, {};",
                        dialect.string_literal(&table),
                        dialect.string_literal(new_name)
                    )
                }
                _ => {
                    let keyword = if kind == ObjectKind::View {
                        "VIEW"
                    } else {
                        "TABLE"
                    };
                    format!(
                        "ALTER {keyword} {table} RENAME TO {};",
                        dialect.quote(new_name)
                    )
                }
            }
        }
        ObjectAction::DropObject => {
            let keyword = match kind {
                ObjectKind::View => "VIEW",
                ObjectKind::MaterializedView => "MATERIALIZED VIEW",
                ObjectKind::Trigger if dialect == Dialect::Sqlite => "TRIGGER",
                _ => "TABLE",
            };
            let if_exists = if request.if_exists.unwrap_or(true) {
                " IF EXISTS"
            } else {
                ""
            };
            let cascade = if dialect.supports_cascade() && request.cascade.unwrap_or(false) {
                " CASCADE"
            } else {
                ""
            };
            format!("DROP {keyword}{if_exists} {table}{cascade};")
        }
        action
            if dialect == Dialect::Sqlite
                && kind == ObjectKind::Trigger
                && action != ObjectAction::DropObject =>
        {
            return Err(DriverError::Unsupported(
                "SQLite triggers only support drop; edit other trigger properties in SQL".into(),
            ));
        }
        ObjectAction::Truncate => {
            if dialect == Dialect::Sqlite {
                // SQLite has no TRUNCATE statement; a plain delete is the
                // equivalent and keeps the (recreated) rowid behaviour.
                format!("DELETE FROM {table};")
            } else {
                let cascade = if dialect.supports_cascade() && request.cascade.unwrap_or(false) {
                    " CASCADE"
                } else {
                    ""
                };
                format!("TRUNCATE TABLE {table}{cascade};")
            }
        }
        ObjectAction::DuplicateObject => {
            let new_name = request
                .new_name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| DriverError::Config("a new name is required".into()))?;
            let target = dialect.quote_qualified(request.namespace.as_deref(), new_name);
            if request.with_data.unwrap_or(false) {
                match dialect {
                    Dialect::MySql | Dialect::Sqlite => {
                        format!("CREATE TABLE {target} AS SELECT * FROM {table};")
                    }
                    // T-SQL has no `CREATE TABLE AS SELECT`; `SELECT INTO`
                    // copies both the columns and the rows.
                    Dialect::SqlServer => format!("SELECT * INTO {target} FROM {table};"),
                    _ => format!("CREATE TABLE {target} AS TABLE {table};"),
                }
            } else {
                match dialect {
                    Dialect::MySql => format!("CREATE TABLE {target} LIKE {table};"),
                    // SQLite has no `CREATE TABLE LIKE` and T-SQL none at all;
                    // a filtered copy keeps the columns but not the constraints.
                    Dialect::Sqlite => {
                        format!("CREATE TABLE {target} AS SELECT * FROM {table} WHERE 0;")
                    }
                    Dialect::SqlServer => format!("SELECT * INTO {target} FROM {table} WHERE 0;"),
                    _ => format!("CREATE TABLE {target} (LIKE {table} INCLUDING ALL);"),
                }
            }
        }
        ObjectAction::Maintenance => {
            let kind = request
                .maintenance
                .ok_or_else(|| DriverError::Config("a maintenance kind is required".into()))?;
            match (dialect, kind) {
                (Dialect::MySql, MaintenanceKind::Optimize) => format!("OPTIMIZE TABLE {table};"),
                (Dialect::MySql, MaintenanceKind::Analyze) => format!("ANALYZE TABLE {table};"),
                (Dialect::MySql, MaintenanceKind::Vacuum) => {
                    return Err(DriverError::Unsupported("MySQL has no VACUUM".into()))
                }
                // SQLite's VACUUM rewrites the whole database and takes no
                // table argument; ANALYZE does accept one.
                (Dialect::Sqlite, MaintenanceKind::Vacuum) => "VACUUM;".to_string(),
                (Dialect::Sqlite, MaintenanceKind::Analyze) => format!("ANALYZE {table};"),
                (Dialect::Sqlite, MaintenanceKind::Optimize) => {
                    return Err(DriverError::Unsupported(
                        "SQLite has no OPTIMIZE TABLE".into(),
                    ))
                }
                (Dialect::SqlServer, MaintenanceKind::Analyze) => {
                    format!("UPDATE STATISTICS {table};")
                }
                (Dialect::SqlServer, MaintenanceKind::Vacuum) => {
                    return Err(DriverError::Unsupported("SQL Server has no VACUUM".into()))
                }
                (Dialect::SqlServer, MaintenanceKind::Optimize) => {
                    return Err(DriverError::Unsupported(
                        "SQL Server has no OPTIMIZE TABLE".into(),
                    ))
                }
                (_, MaintenanceKind::Vacuum) => format!("VACUUM {table};"),
                (_, MaintenanceKind::Analyze) => format!("ANALYZE {table};"),
                (_, MaintenanceKind::Optimize) => {
                    return Err(DriverError::Unsupported(
                        "this engine has no OPTIMIZE TABLE".into(),
                    ))
                }
            }
        }
        ObjectAction::Reindex => match dialect {
            Dialect::MySql => return Err(DriverError::Unsupported("MySQL has no REINDEX".into())),
            // SQLite REINDEX takes a table (or index) name without a keyword.
            Dialect::Sqlite => format!("REINDEX {table};"),
            // SQL Server rebuilds every index of the table instead.
            Dialect::SqlServer => format!("ALTER INDEX ALL ON {table} REBUILD;"),
            _ => format!("REINDEX TABLE {table};"),
        },
        ObjectAction::CreateIndex => index_sql(request, dialect)?,
        ObjectAction::DropIndex => {
            let name = request
                .index_name
                .as_deref()
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| DriverError::Config("an index name is required".into()))?;
            match dialect {
                Dialect::MySql => format!("DROP INDEX {} ON {table};", dialect.quote(name)),
                // SQL Server names the table the index belongs to; there is no
                // `IF EXISTS` on the index itself in the shared T-SQL form.
                Dialect::SqlServer => {
                    format!("DROP INDEX {} ON {table};", dialect.quote(name))
                }
                _ => {
                    let cascade = if dialect.supports_cascade() && request.cascade.unwrap_or(false)
                    {
                        " CASCADE"
                    } else {
                        ""
                    };
                    format!(
                        "DROP INDEX IF EXISTS {}{cascade};",
                        dialect.quote_qualified(request.namespace.as_deref(), name)
                    )
                }
            }
        }
        ObjectAction::AddColumn => {
            let column = request
                .column
                .as_ref()
                .ok_or_else(|| DriverError::Config("a column definition is required".into()))?;
            if dialect == Dialect::SqlServer {
                // T-SQL's `ALTER TABLE ADD` takes no `COLUMN` keyword.
                return Ok(format!(
                    "ALTER TABLE {table} ADD {};",
                    column_definition(column, dialect)
                ));
            }
            format!(
                "ALTER TABLE {table} ADD COLUMN {};",
                column_definition(column, dialect)
            )
        }
        ObjectAction::AlterColumn => {
            let column = request
                .column
                .as_ref()
                .ok_or_else(|| DriverError::Config("a column definition is required".into()))?;
            match dialect {
                Dialect::MySql => {
                    // CHANGE COLUMN takes the old name plus the full new definition.
                    let mut definition = column_definition(column, dialect);
                    // `AFTER` belongs outside the definition.
                    if let Some(after) = column.after.as_deref().filter(|a| !a.is_empty()) {
                        definition =
                            definition.replace(&format!(" AFTER {}", dialect.quote(after)), "");
                        return Ok(format!(
                            "ALTER TABLE {table} CHANGE COLUMN {} {definition} AFTER {};",
                            dialect.quote(&column.name),
                            dialect.quote(after)
                        ));
                    }
                    format!(
                        "ALTER TABLE {table} CHANGE COLUMN {} {definition};",
                        dialect.quote(&column.name)
                    )
                }
                Dialect::Sqlite => {
                    // SQLite can only rename a column in place; changing its
                    // type or constraints requires rebuilding the table.
                    match request
                        .rename_to
                        .as_deref()
                        .filter(|n| !n.trim().is_empty() && *n != column.name.as_str())
                    {
                        Some(rename_to) => format!(
                            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
                            dialect.quote(&column.name),
                            dialect.quote(rename_to)
                        ),
                        None => {
                            return Err(DriverError::Unsupported(
                                "SQLite cannot change a column's type or constraints in place; recreate the table to alter it".into(),
                            ))
                        }
                    }
                }
                Dialect::SqlServer => {
                    // T-SQL alters a type in place with `ALTER COLUMN`, renames
                    // through `sp_rename`, and stores a default as a named
                    // constraint whose server-generated name the editor does not
                    // know — so a default change is refused, not guessed at.
                    if column.default_value.is_some() {
                        return Err(DriverError::Unsupported(
                            "change a SQL Server column's default in SQL; it is a named \
                             constraint the editor cannot address"
                                .into(),
                        ));
                    }
                    let rename_to = request
                        .rename_to
                        .as_deref()
                        .filter(|n| !n.trim().is_empty() && *n != column.name.as_str());
                    let mut statements = Vec::new();
                    if let Some(new_name) = rename_to {
                        let full = format!("{table}.{}", dialect.quote(&column.name));
                        statements.push(format!(
                            "EXEC sp_rename {}, {}, 'COLUMN';",
                            dialect.string_literal(&full),
                            dialect.string_literal(new_name)
                        ));
                    }
                    let name = rename_to.unwrap_or(&column.name);
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN {} {} {}",
                        dialect.quote(name),
                        column.data_type.trim(),
                        if column.nullable { "NULL" } else { "NOT NULL" }
                    ));
                    format!("{};", statements.join("\n"))
                }
                _ => {
                    let mut statements = Vec::new();
                    if let Some(rename_to) = request
                        .rename_to
                        .as_deref()
                        .filter(|n| !n.trim().is_empty() && *n != column.name.as_str())
                    {
                        statements.push(format!(
                            "ALTER TABLE {table} RENAME COLUMN {} TO {}",
                            dialect.quote(&column.name),
                            dialect.quote(rename_to)
                        ));
                    }
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN {} TYPE {}",
                        dialect.quote(&column.name),
                        column.data_type.trim()
                    ));
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN {} {}",
                        dialect.quote(&column.name),
                        if column.nullable {
                            "DROP NOT NULL"
                        } else {
                            "SET NOT NULL"
                        }
                    ));
                    match column
                        .default_value
                        .as_deref()
                        .filter(|d| !d.trim().is_empty())
                    {
                        Some(default) => statements.push(format!(
                            "ALTER TABLE {table} ALTER COLUMN {} SET DEFAULT {}",
                            dialect.quote(&column.name),
                            default.trim()
                        )),
                        None => statements.push(format!(
                            "ALTER TABLE {table} ALTER COLUMN {} DROP DEFAULT",
                            dialect.quote(&column.name)
                        )),
                    }
                    format!("{};", statements.join(";\n"))
                }
            }
        }
        ObjectAction::DropColumn => {
            let column = request
                .column
                .as_ref()
                .map(|c| c.name.clone())
                .or_else(|| request.new_name.clone())
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| DriverError::Config("a column name is required".into()))?;
            let cascade = if dialect.supports_cascade() && request.cascade.unwrap_or(false) {
                " CASCADE"
            } else {
                ""
            };
            format!(
                "ALTER TABLE {table} DROP COLUMN {}{cascade};",
                dialect.quote(&column)
            )
        }
        other => {
            return Err(DriverError::Unsupported(format!(
                "{other:?} is not a write action"
            )))
        }
    };

    Ok(sql)
}

/// Build a `CREATE TABLE` from a wizard definition. Validation happens here (not
/// only in the UI) so a malformed request can never reach the server.
pub fn create_table_from_columns(request: &CreateTableRequest, dialect: Dialect) -> Result<String> {
    let table = request.table.trim();
    if table.is_empty() {
        return Err(DriverError::Config("a table name is required".into()));
    }
    if request.columns.is_empty() {
        return Err(DriverError::Config(
            "a table needs at least one column".into(),
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for column in &request.columns {
        let name = column.name.trim();
        if name.is_empty() {
            return Err(DriverError::Config("every column needs a name".into()));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(DriverError::Config(format!(
                "duplicate column name: {name}"
            )));
        }
    }

    let auto_increment: Vec<&ColumnDefinition> = request
        .columns
        .iter()
        .filter(|column| column.is_auto_increment)
        .collect();
    if auto_increment.len() > 1 {
        return Err(DriverError::Config(
            "only one column can be auto-increment".into(),
        ));
    }
    if let Some(column) = auto_increment.first() {
        if !column.is_primary_key {
            return Err(DriverError::Config(
                "an auto-increment column must be a primary key".into(),
            ));
        }
    }

    let composite = request.columns.iter().filter(|c| c.is_primary_key).count() > 1;
    if dialect == Dialect::Sqlite && composite && auto_increment.first().is_some() {
        return Err(DriverError::Config(
            "SQLite AUTOINCREMENT cannot be used with a composite primary key".into(),
        ));
    }
    // T-SQL has no `CREATE TABLE IF NOT EXISTS`; refusing beats a statement
    // that fails halfway through with "there is already an object named".
    if dialect == Dialect::SqlServer && request.if_not_exists.unwrap_or(false) {
        return Err(DriverError::Config(
            "SQL Server has no CREATE TABLE IF NOT EXISTS; clear the option or \
             check the name first"
                .into(),
        ));
    }
    let mut lines: Vec<String> = request
        .columns
        .iter()
        .map(|column| {
            // With a composite key the constraint is emitted once below, so the
            // inline `PRIMARY KEY` on each column is suppressed.
            let mut column = column.clone();
            if composite {
                column.is_primary_key = false;
            }
            format!("  {}", column_definition(&column, dialect))
        })
        .collect();

    if composite {
        let primary: Vec<String> = request
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| dialect.quote(c.name.trim()))
            .collect();
        lines.push(format!("  PRIMARY KEY ({})", primary.join(", ")));
    }

    let qualified = dialect.quote_qualified(request.namespace.as_deref(), table);
    let if_not_exists = if request.if_not_exists.unwrap_or(false) {
        " IF NOT EXISTS"
    } else {
        ""
    };
    let mut sql = format!(
        "CREATE TABLE{if_not_exists} {qualified} (\n{}\n)",
        lines.join(",\n")
    );
    if dialect == Dialect::MySql {
        sql.push_str(" ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        if let Some(comment) = request.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            sql.push_str(&format!(" COMMENT={}", dialect.string_literal(comment)));
        }
    }
    sql.push(';');
    Ok(sql)
}

/// Table engines the ClickHouse wizard offers. The engine name is written into
/// the statement, so it is only ever taken from this list.
const CLICKHOUSE_ENGINES: [&str; 6] = [
    "MergeTree",
    "ReplacingMergeTree",
    "SummingMergeTree",
    "AggregatingMergeTree",
    "Log",
    "Memory",
];

fn validate_clickhouse_expression(expression: &str, label: &str) -> Result<()> {
    let trimmed = expression.trim();
    if trimmed.is_empty()
        || trimmed.contains(';')
        || trimmed.contains("--")
        || trimmed.contains("/*")
        || trimmed.contains("*/")
    {
        return Err(DriverError::Config(format!(
            "invalid ClickHouse {label} expression"
        )));
    }
    Ok(())
}

/// Build a ClickHouse `CREATE TABLE` from the wizard definition.
///
/// ClickHouse has no NULL constraint (nullability is the `Nullable(T)` type) and
/// no auto-increment. MergeTree-family tables need a sorting key: the explicit
/// `orderBy` columns, or else the primary-key columns.
pub fn create_clickhouse_table(request: &CreateTableRequest) -> Result<String> {
    let table = request.table.trim();
    if table.is_empty() {
        return Err(DriverError::Config("a table name is required".into()));
    }
    if request.columns.is_empty() {
        return Err(DriverError::Config(
            "a table needs at least one column".into(),
        ));
    }
    let engine = request
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|engine| !engine.is_empty())
        .unwrap_or("MergeTree");
    if !CLICKHOUSE_ENGINES.contains(&engine) {
        return Err(DriverError::Config(format!(
            "unsupported ClickHouse engine: {engine}"
        )));
    }

    let mut seen = std::collections::HashSet::new();
    let mut lines = Vec::with_capacity(request.columns.len());
    for column in &request.columns {
        let name = column.name.trim();
        if name.is_empty() {
            return Err(DriverError::Config("every column needs a name".into()));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(DriverError::Config(format!(
                "duplicate column name: {name}"
            )));
        }
        if column.is_auto_increment {
            return Err(DriverError::Config(
                "ClickHouse has no auto-increment columns".into(),
            ));
        }
        let data_type = column.data_type.trim();
        if data_type.is_empty() {
            return Err(DriverError::Config(format!("column {name} needs a type")));
        }
        let data_type = if column.nullable && !data_type.starts_with("Nullable(") {
            format!("Nullable({data_type})")
        } else {
            data_type.to_string()
        };
        let mut definition = format!("  {} {}", Dialect::Ansi.quote(name), data_type);
        if let Some(default) = column
            .default_value
            .as_deref()
            .map(str::trim)
            .filter(|default| !default.is_empty())
        {
            definition.push_str(&format!(" DEFAULT {default}"));
        }
        if let Some(comment) = column.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            definition.push_str(&format!(
                " COMMENT {}",
                Dialect::Ansi.string_literal(comment)
            ));
        }
        lines.push(definition);
    }

    let sorting_key: Vec<String> = if engine.ends_with("MergeTree") {
        let explicit: Vec<String> = request
            .order_by
            .iter()
            .map(|column| column.trim().to_string())
            .filter(|column| !column.is_empty())
            .collect();
        let keys = if explicit.is_empty() {
            request
                .columns
                .iter()
                .filter(|column| column.is_primary_key)
                .map(|column| column.name.trim().to_string())
                .collect()
        } else {
            explicit
        };
        if keys.is_empty() {
            return Err(DriverError::Config(
                "MergeTree tables need an ORDER BY: choose sorting key columns".into(),
            ));
        }
        for key in &keys {
            let column = request
                .columns
                .iter()
                .find(|column| column.name.trim() == key)
                .ok_or_else(|| {
                    DriverError::Config(format!(
                        "ORDER BY column {key} is not defined in the table"
                    ))
                })?;
            if column.nullable || column.data_type.trim().starts_with("Nullable(") {
                return Err(DriverError::Config(format!(
                    "ORDER BY column {key} cannot be Nullable"
                )));
            }
        }
        keys
    } else {
        if request
            .order_by
            .iter()
            .any(|column| !column.trim().is_empty())
        {
            return Err(DriverError::Config(
                "ORDER BY only applies to MergeTree-family engines".into(),
            ));
        }
        Vec::new()
    };

    let qualified = Dialect::Ansi.quote_qualified(
        Some(request.database.trim()).filter(|database| !database.is_empty()),
        table,
    );
    let if_not_exists = if request.if_not_exists.unwrap_or(false) {
        " IF NOT EXISTS"
    } else {
        ""
    };
    let mut sql = format!(
        "CREATE TABLE{if_not_exists} {qualified} (\n{}\n) ENGINE = {engine}",
        lines.join(",\n")
    );
    if let Some(partition_by) = request
        .partition_by
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !engine.ends_with("MergeTree") {
            return Err(DriverError::Config(
                "PARTITION BY only applies to MergeTree-family engines".into(),
            ));
        }
        validate_clickhouse_expression(partition_by, "PARTITION BY")?;
        sql.push_str(&format!(" PARTITION BY {partition_by}"));
    }
    if !sorting_key.is_empty() {
        let keys: Vec<String> = sorting_key
            .iter()
            .map(|key| Dialect::Ansi.quote(key))
            .collect();
        sql.push_str(&format!(" ORDER BY ({})", keys.join(", ")));
    }
    if let Some(primary_key) = request
        .primary_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !engine.ends_with("MergeTree") {
            return Err(DriverError::Config(
                "PRIMARY KEY only applies to MergeTree-family engines".into(),
            ));
        }
        validate_clickhouse_expression(primary_key, "PRIMARY KEY")?;
        sql.push_str(&format!(" PRIMARY KEY {primary_key}"));
    }
    if let Some(ttl) = request
        .ttl
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !engine.ends_with("MergeTree") {
            return Err(DriverError::Config(
                "TTL only applies to MergeTree-family engines".into(),
            ));
        }
        validate_clickhouse_expression(ttl, "TTL")?;
        sql.push_str(&format!(" TTL {ttl}"));
    }
    if !request.settings.is_empty() {
        if !engine.ends_with("MergeTree") {
            return Err(DriverError::Config(
                "SETTINGS only applies to MergeTree-family engines".into(),
            ));
        }
        let settings = request
            .settings
            .iter()
            .map(|setting| {
                let (name, value) = setting
                    .trim()
                    .split_once('=')
                    .ok_or_else(|| DriverError::Config("settings must use name = value".into()))?;
                let name = name.trim();
                let value = value.trim();
                if name.is_empty()
                    || !name
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                    || value.is_empty()
                    || !value
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "_'.+-".contains(ch))
                {
                    return Err(DriverError::Config(
                        "invalid ClickHouse setting; use a setting name and simple literal value"
                            .into(),
                    ));
                }
                Ok(format!("{name} = {value}"))
            })
            .collect::<Result<Vec<_>>>()?;
        sql.push_str(&format!(" SETTINGS {}", settings.join(", ")));
    }
    if let Some(comment) = request.comment.as_deref().filter(|c| !c.trim().is_empty()) {
        sql.push_str(&format!(
            " COMMENT {}",
            Dialect::Ansi.string_literal(comment.trim())
        ));
    }
    sql.push(';');
    Ok(sql)
}

// ---------------------------------------------------------------------------
// Row-level mutations (grid editing)
// ---------------------------------------------------------------------------

/// Render a single JSON value as a SQL literal for the dialect. Null becomes
/// `NULL`, numbers and booleans go through unquoted, and everything else is
/// quoted as a string so user data can never break out of the statement. SQL
/// Server has no boolean literals — a `bit` column wants `1`/`0`.
pub fn row_value(value: &Value, dialect: Dialect) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(true) => {
            if dialect == Dialect::SqlServer {
                "1".to_string()
            } else {
                "TRUE".to_string()
            }
        }
        Value::Bool(false) => {
            if dialect == Dialect::SqlServer {
                "0".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => dialect.string_literal(text),
        other => dialect.string_literal(&other.to_string()),
    }
}

fn row_table(request: &RowChangeRequest, dialect: Dialect) -> String {
    dialect.quote_qualified(request.namespace.as_deref(), &request.object)
}

/// `col = value AND ...` used to target exactly one row. An empty key is
/// refused so a malformed request can never update or delete a whole table.
fn row_where(key: &[RowValue], dialect: Dialect) -> Result<String> {
    if key.is_empty() {
        return Err(DriverError::Config(
            "a row key is required to target a single row".into(),
        ));
    }
    Ok(key
        .iter()
        .map(|entry| {
            format!(
                "{} = {}",
                dialect.quote(&entry.column),
                row_value(&entry.value, dialect)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND "))
}

/// Build a row-change statement with positional placeholders and ordered values.
/// MySQL and PostgreSQL use this form so SQL data remains data regardless of
/// the server's SQL mode, string-literal rules or column types. PostgreSQL
/// placeholders carry a cast to the column's introspected type because values
/// travel as text parameters.
pub fn row_change_sql_with_params(
    request: &RowChangeRequest,
    dialect: Dialect,
) -> Result<(String, Vec<Value>)> {
    let table = row_table(request, dialect);
    let mut params = Vec::new();
    let sql = match request.kind {
        RowChangeKind::Insert => {
            if request.values.is_empty() {
                return Err(DriverError::Config(
                    "an insert needs at least one column".into(),
                ));
            }
            let columns = request
                .values
                .iter()
                .map(|entry| dialect.quote(&entry.column))
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = request
                .values
                .iter()
                .map(|entry| push_row_bind(&mut params, dialect, entry))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({columns}) VALUES ({placeholders})")
        }
        RowChangeKind::Update => {
            if request.values.is_empty() {
                return Err(DriverError::Config("no columns to update".into()));
            }
            if request.key.is_empty() {
                return Err(DriverError::Config(
                    "a row key is required to target a single row".into(),
                ));
            }
            let sets = request
                .values
                .iter()
                .map(|entry| {
                    format!(
                        "{} = {}",
                        dialect.quote(&entry.column),
                        push_row_bind(&mut params, dialect, entry)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let where_sql = request
                .key
                .iter()
                .map(|entry| {
                    format!(
                        "{} = {}",
                        dialect.quote(&entry.column),
                        push_row_bind(&mut params, dialect, entry)
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("UPDATE {table} SET {sets} WHERE {where_sql}")
        }
        RowChangeKind::Delete => {
            if request.key.is_empty() {
                return Err(DriverError::Config(
                    "a row key is required to target a single row".into(),
                ));
            }
            let where_sql = request
                .key
                .iter()
                .map(|entry| {
                    format!(
                        "{} = {}",
                        dialect.quote(&entry.column),
                        push_row_bind(&mut params, dialect, entry)
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("DELETE FROM {table} WHERE {where_sql}")
        }
    };
    Ok((sql, params))
}

/// True when every value and key has a column type that can be rendered as a
/// PostgreSQL cast. A request that fails this check uses the escaped literal
/// path instead of risking a text parameter with the wrong type.
pub fn postgres_row_change_is_bindable(request: &RowChangeRequest) -> bool {
    request
        .values
        .iter()
        .chain(request.key.iter())
        .all(|entry| {
            entry
                .data_type
                .as_deref()
                .is_some_and(|data_type| postgres_cast_type(data_type).is_some())
        })
}

/// Append one value to the parameter list and render its placeholder.
fn push_row_bind(params: &mut Vec<Value>, dialect: Dialect, entry: &RowValue) -> String {
    let index = params.len();
    params.push(row_parameter_value(dialect, entry));
    match dialect {
        Dialect::Postgres => match entry.data_type.as_deref().and_then(postgres_cast_type) {
            Some(data_type) => format!("CAST(${} AS {data_type})", index + 1),
            None => format!("${}", index + 1),
        },
        _ => "?".to_string(),
    }
}

/// Convert a JSON value into the text PostgreSQL receives through the bind.
fn row_parameter_value(dialect: Dialect, entry: &RowValue) -> Value {
    if dialect != Dialect::Postgres {
        return entry.value.clone();
    }
    let data_type = entry
        .data_type
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if data_type.ends_with("[]") {
        if let Value::Array(values) = &entry.value {
            return Value::String(postgres_array_literal(values));
        }
    }
    if (data_type == "bytea" || data_type.ends_with(".bytea")) && entry.value.is_string() {
        if let Some(encoded) = entry
            .value
            .as_str()
            .and_then(|text| text.strip_prefix("base64:"))
        {
            if let Ok(bytes) = BASE64.decode(encoded) {
                return Value::String(format!("\\x{}", hex(&bytes)));
            }
        }
    }
    entry.value.clone()
}

/// Pick the cast target for a PostgreSQL text parameter. Character types cast
/// to `text`: an explicit cast to `varchar(n)` would silently truncate where
/// the column assignment would have rejected an overlong value.
fn postgres_cast_type(data_type: &str) -> Option<String> {
    let trimmed = data_type.trim();
    if trimmed.is_empty()
        || !trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '_' | ' ' | '.' | '"' | '[' | ']' | '(' | ')' | ','
                )
        })
    {
        return None;
    }
    if let Some(element) = trimmed.strip_suffix("[]") {
        return postgres_cast_type(element).map(|mapped| format!("{mapped}[]"));
    }
    let lowered = trimmed.to_ascii_lowercase();
    Some(
        if lowered.starts_with("character varying")
            || lowered.starts_with("character(")
            || lowered == "character"
            || lowered == "char"
            || lowered == "bpchar"
            || lowered == "\"char\""
        {
            "text".to_string()
        } else {
            trimmed.to_string()
        },
    )
}

/// Render a JSON array as a PostgreSQL array literal, quoted per element so
/// commas, braces, quotes and backslashes survive the text-to-array cast.
fn postgres_array_literal(values: &[Value]) -> String {
    let elements = values
        .iter()
        .map(|value| match value {
            Value::Null => "NULL".to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Number(number) => number.to_string(),
            Value::String(text) => postgres_array_string(text),
            Value::Array(values) => postgres_array_literal(values),
            Value::Object(_) => postgres_array_string(&value.to_string()),
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{elements}}}")
}

fn postgres_array_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `INSERT INTO t (cols) VALUES (...)` for one new row.
pub fn insert_row_sql(request: &RowChangeRequest, dialect: Dialect) -> Result<String> {
    if request.values.is_empty() {
        if dialect == Dialect::Sqlite || dialect == Dialect::SqlServer {
            return Ok(format!(
                "INSERT INTO {} DEFAULT VALUES;",
                row_table(request, dialect)
            ));
        }
        return Err(DriverError::Config(
            "an insert needs at least one column".into(),
        ));
    }
    let columns = request
        .values
        .iter()
        .map(|entry| dialect.quote(&entry.column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = request
        .values
        .iter()
        .map(|entry| row_value(&entry.value, dialect))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "INSERT INTO {} ({columns}) VALUES ({values});",
        row_table(request, dialect)
    ))
}

/// `UPDATE t SET ... WHERE key` for one existing row.
pub fn update_row_sql(request: &RowChangeRequest, dialect: Dialect) -> Result<String> {
    if request.values.is_empty() {
        return Err(DriverError::Config("no columns to update".into()));
    }
    let where_sql = row_where(&request.key, dialect)?;
    let sets = request
        .values
        .iter()
        .map(|entry| {
            format!(
                "{} = {}",
                dialect.quote(&entry.column),
                row_value(&entry.value, dialect)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "UPDATE {} SET {sets} WHERE {where_sql};",
        row_table(request, dialect)
    ))
}

/// `DELETE FROM t WHERE key` for one existing row.
pub fn delete_row_sql(request: &RowChangeRequest, dialect: Dialect) -> Result<String> {
    let where_sql = row_where(&request.key, dialect)?;
    Ok(format!(
        "DELETE FROM {} WHERE {where_sql};",
        row_table(request, dialect)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ColumnSchema, ForeignKeySchema, IndexSchema, RowChangeKind};

    fn request(action: ObjectAction) -> ObjectActionRequest {
        ObjectActionRequest {
            connection_id: "c".into(),
            database: "shop".into(),
            namespace: Some("public".into()),
            object: "orders".into(),
            object_kind: Some(ObjectKind::Table),
            action,
            new_name: None,
            with_data: None,
            if_exists: None,
            cascade: None,
            maintenance: None,
            index: None,
            index_name: None,
            column: None,
            rename_to: None,
        }
    }

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::MySql.quote("a`b"), "`a``b`");
        assert_eq!(Dialect::Postgres.quote("a\"b"), "\"a\"\"b\"");
        assert_eq!(Dialect::MySql.string_literal("it's"), "'it''s'");
        // A bracket quote is escaped by doubling the closing bracket.
        assert_eq!(Dialect::SqlServer.quote("a]b"), "[a]]b]");
        assert_eq!(Dialect::SqlServer.quote_char(), "[");
        assert_eq!(
            Dialect::SqlServer.quote_qualified(Some("dbo"), "orders"),
            "[dbo].[orders]"
        );
    }

    #[test]
    fn sql_server_writes_tsql_not_ansi() {
        let mut rename = request(ObjectAction::RenameObject);
        rename.new_name = Some("revenue".into());
        assert_eq!(
            action_sql(&rename, Dialect::SqlServer).unwrap(),
            "EXEC sp_rename '[public].[orders]', 'revenue';"
        );

        let mut duplicate = request(ObjectAction::DuplicateObject);
        duplicate.new_name = Some("orders_copy".into());
        duplicate.with_data = Some(true);
        assert_eq!(
            action_sql(&duplicate, Dialect::SqlServer).unwrap(),
            "SELECT * INTO [public].[orders_copy] FROM [public].[orders];"
        );
        duplicate.with_data = Some(false);
        assert_eq!(
            action_sql(&duplicate, Dialect::SqlServer).unwrap(),
            "SELECT * INTO [public].[orders_copy] FROM [public].[orders] WHERE 0;"
        );

        assert_eq!(
            action_sql(&request(ObjectAction::Reindex), Dialect::SqlServer).unwrap(),
            "ALTER INDEX ALL ON [public].[orders] REBUILD;"
        );
        let mut drop_index = request(ObjectAction::DropIndex);
        drop_index.index_name = Some("idx_customer".into());
        assert_eq!(
            action_sql(&drop_index, Dialect::SqlServer).unwrap(),
            "DROP INDEX [idx_customer] ON [public].[orders];"
        );
    }

    #[test]
    fn sql_server_alter_column_renames_and_types_but_refuses_defaults() {
        let mut req = request(ObjectAction::AlterColumn);
        let mut column = ColumnDefinition {
            name: "status".into(),
            data_type: "nvarchar(50)".into(),
            nullable: true,
            default_value: None,
            is_primary_key: false,
            is_auto_increment: false,
            comment: None,
            after: None,
        };
        req.column = Some(column.clone());
        assert_eq!(
            action_sql(&req, Dialect::SqlServer).unwrap(),
            "ALTER TABLE [public].[orders] ALTER COLUMN [status] nvarchar(50) NULL;"
        );
        req.rename_to = Some("state".into());
        assert_eq!(
            action_sql(&req, Dialect::SqlServer).unwrap(),
            "EXEC sp_rename '[public].[orders].[status]', 'state', 'COLUMN';\n\
             ALTER TABLE [public].[orders] ALTER COLUMN [state] nvarchar(50) NULL;"
        );
        // A default is a named constraint whose server-generated name the
        // editor does not know, so a change is refused rather than guessed at.
        column.default_value = Some("'new'".into());
        req.column = Some(column);
        assert!(action_sql(&req, Dialect::SqlServer).is_err());
    }

    #[test]
    fn sql_server_row_edits_speak_bit_not_boolean() {
        assert_eq!(row_value(&serde_json::json!(true), Dialect::SqlServer), "1");
        assert_eq!(
            row_value(&serde_json::json!(true), Dialect::Postgres),
            "TRUE"
        );
    }

    #[test]
    fn drop_table_is_dialect_aware() {
        let mut req = request(ObjectAction::DropObject);
        req.if_exists = Some(true);
        req.cascade = Some(true);
        assert_eq!(
            action_sql(&req, Dialect::MySql).unwrap(),
            "DROP TABLE IF EXISTS `public`.`orders`;"
        );
        assert_eq!(
            action_sql(&req, Dialect::Postgres).unwrap(),
            "DROP TABLE IF EXISTS \"public\".\"orders\" CASCADE;"
        );
    }

    #[test]
    fn create_index_defaults_name_and_handles_unique() {
        let mut req = request(ObjectAction::CreateIndex);
        req.index = Some(IndexDefinition {
            name: None,
            columns: vec!["customer_id".into(), "status".into()],
            unique: true,
            kind: IndexKind::BTree,
            prefix_lengths: vec![],
        });
        let mysql = action_sql(&req, Dialect::MySql).unwrap();
        assert!(mysql.contains("CREATE UNIQUE INDEX `idx_orders_customer_id_status` ON `public`.`orders` (`customer_id`, `status`);"));

        let pg = action_sql(&req, Dialect::Postgres).unwrap();
        assert!(pg.contains("CREATE UNIQUE INDEX \"public\".\"idx_orders_customer_id_status\" ON \"public\".\"orders\" (\"customer_id\", \"status\");"));
    }

    #[test]
    fn truncate_and_maintenance_differ() {
        let req = request(ObjectAction::Truncate);
        assert_eq!(
            action_sql(&req, Dialect::MySql).unwrap(),
            "TRUNCATE TABLE `public`.`orders`;"
        );

        let mut vacuum = request(ObjectAction::Maintenance);
        vacuum.maintenance = Some(MaintenanceKind::Vacuum);
        assert!(action_sql(&vacuum, Dialect::MySql).is_err());
        assert_eq!(
            action_sql(&vacuum, Dialect::Postgres).unwrap(),
            "VACUUM \"public\".\"orders\";"
        );
    }

    #[test]
    fn add_column_renders_definition() {
        let mut req = request(ObjectAction::AddColumn);
        req.column = Some(ColumnDefinition {
            name: "note".into(),
            data_type: "text".into(),
            nullable: true,
            default_value: Some("'x'".into()),
            is_primary_key: false,
            is_auto_increment: false,
            comment: Some("it's a note".into()),
            after: Some("status".into()),
        });
        let sql = action_sql(&req, Dialect::MySql).unwrap();
        assert!(sql.contains(
            "ADD COLUMN `note` text NULL DEFAULT 'x' COMMENT 'it''s a note' AFTER `status`;"
        ));
    }

    #[test]
    fn create_table_includes_keys() {
        let schema = ObjectSchema {
            name: "orders".into(),
            kind: ObjectKind::Table,
            columns: vec![
                ColumnSchema {
                    name: "id".into(),
                    data_type: "bigint".into(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_auto_increment: true,
                    comment: None,
                    ordinal: 1,
                },
                ColumnSchema {
                    name: "customer_id".into(),
                    data_type: "bigint".into(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    comment: None,
                    ordinal: 2,
                },
            ],
            indexes: vec![IndexSchema {
                name: "idx_customer".into(),
                columns: vec!["customer_id".into()],
                unique: false,
                primary: false,
            }],
            foreign_keys: vec![ForeignKeySchema {
                name: "fk_customer".into(),
                columns: vec!["customer_id".into()],
                referenced_table: "customers".into(),
                referenced_columns: vec!["id".into()],
            }],
        };
        let sql = create_table(&schema, Dialect::MySql);
        assert!(sql.contains("PRIMARY KEY (`id`)"));
        assert!(sql.contains("KEY `idx_customer` (`customer_id`)"));
        assert!(sql.contains(
            "CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)"
        ));
        assert!(sql.contains("ENGINE=InnoDB"));
    }

    #[test]
    fn sqlite_dialect_renders_valid_ddl() {
        assert_eq!(Dialect::Sqlite.quote("a\"b"), "\"a\"\"b\"");
        assert_eq!(Dialect::Sqlite.quote_char(), "\"");

        // AUTO_INCREMENT must become SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT`.
        let mut id = column("id", "INTEGER");
        id.is_primary_key = true;
        id.is_auto_increment = true;
        let sql = create_table_from_columns(
            &create_request(vec![id, column("note", "text")]),
            Dialect::Sqlite,
        )
        .unwrap();
        assert!(sql.starts_with("CREATE TABLE \"orders\" ("));
        assert!(sql.contains("\"id\" INTEGER PRIMARY KEY AUTOINCREMENT"));
        assert!(!sql.contains("ENGINE="));

        let mut drop = request(ObjectAction::DropObject);
        drop.namespace = None;
        drop.if_exists = Some(true);
        drop.cascade = Some(true);
        assert_eq!(
            action_sql(&drop, Dialect::Sqlite).unwrap(),
            "DROP TABLE IF EXISTS \"orders\";"
        );

        let mut truncate = request(ObjectAction::Truncate);
        truncate.namespace = None;
        assert_eq!(
            action_sql(&truncate, Dialect::Sqlite).unwrap(),
            "DELETE FROM \"orders\";"
        );

        let mut reindex = request(ObjectAction::Reindex);
        reindex.namespace = None;
        assert_eq!(
            action_sql(&reindex, Dialect::Sqlite).unwrap(),
            "REINDEX \"orders\";"
        );

        let mut vacuum = request(ObjectAction::Maintenance);
        vacuum.namespace = None;
        vacuum.maintenance = Some(MaintenanceKind::Vacuum);
        assert_eq!(action_sql(&vacuum, Dialect::Sqlite).unwrap(), "VACUUM;");
    }

    #[test]
    fn sqlite_create_table_emits_indexes_separately() {
        let schema = ObjectSchema {
            name: "orders".into(),
            kind: ObjectKind::Table,
            columns: vec![ColumnSchema {
                name: "id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_auto_increment: true,
                comment: None,
                ordinal: 1,
            }],
            indexes: vec![IndexSchema {
                name: "idx_customer".into(),
                columns: vec!["customer_id".into()],
                unique: true,
                primary: false,
            }],
            foreign_keys: vec![],
        };
        let sql = create_table(&schema, Dialect::Sqlite);
        assert!(sql.contains("\"id\" INTEGER PRIMARY KEY AUTOINCREMENT"));
        assert_eq!(sql.matches("PRIMARY KEY").count(), 1);
        assert!(!sql.contains("KEY \"idx"));
        assert!(
            sql.contains("CREATE UNIQUE INDEX \"idx_customer\" ON \"orders\" (\"customer_id\");")
        );
    }

    #[test]
    fn sqlite_alter_column_only_renames() {
        let mut req = request(ObjectAction::AlterColumn);
        req.namespace = None;
        req.column = Some(column("status", "text"));
        req.rename_to = Some("state".into());
        assert!(action_sql(&req, Dialect::Sqlite)
            .unwrap()
            .contains("ALTER TABLE \"orders\" RENAME COLUMN \"status\" TO \"state\";"));

        let mut rename_trigger = request(ObjectAction::RenameObject);
        rename_trigger.namespace = None;
        rename_trigger.object_kind = Some(ObjectKind::Trigger);
        rename_trigger.new_name = Some("renamed_trigger".into());
        assert!(action_sql(&rename_trigger, Dialect::Sqlite).is_err());

        let mut drop_trigger = request(ObjectAction::DropObject);
        drop_trigger.namespace = None;
        drop_trigger.object_kind = Some(ObjectKind::Trigger);
        drop_trigger.if_exists = Some(true);
        assert_eq!(
            action_sql(&drop_trigger, Dialect::Sqlite).unwrap(),
            "DROP TRIGGER IF EXISTS \"orders\";"
        );
        let mut truncate_trigger = request(ObjectAction::Truncate);
        truncate_trigger.object_kind = Some(ObjectKind::Trigger);
        assert!(action_sql(&truncate_trigger, Dialect::Sqlite).is_err());

        let mut retype = request(ObjectAction::AlterColumn);
        retype.namespace = None;
        retype.column = Some(column("status", "text"));
        assert!(action_sql(&retype, Dialect::Sqlite).is_err());
    }

    fn column(name: &str, data_type: &str) -> ColumnDefinition {
        ColumnDefinition {
            name: name.into(),
            data_type: data_type.into(),
            nullable: false,
            default_value: None,
            is_primary_key: false,
            is_auto_increment: false,
            comment: None,
            after: None,
        }
    }

    fn create_request(columns: Vec<ColumnDefinition>) -> CreateTableRequest {
        CreateTableRequest {
            connection_id: "c".into(),
            database: "shop".into(),
            namespace: None,
            table: "orders".into(),
            columns,
            if_not_exists: None,
            comment: None,
            engine: None,
            order_by: vec![],
            partition_by: None,
            primary_key: None,
            ttl: None,
            settings: vec![],
        }
    }

    #[test]
    fn create_table_from_columns_handles_single_key() {
        let mut id = column("id", "bigint unsigned");
        id.is_primary_key = true;
        id.is_auto_increment = true;
        let sql = create_table_from_columns(
            &create_request(vec![id, column("note", "text")]),
            Dialect::MySql,
        )
        .unwrap();
        assert!(sql.starts_with("CREATE TABLE `orders` ("));
        assert!(sql.contains("`id` bigint unsigned AUTO_INCREMENT NOT NULL PRIMARY KEY"));
        assert!(sql.contains("ENGINE=InnoDB"));
        assert!(!sql.contains("PRIMARY KEY ("));
    }

    #[test]
    fn create_table_from_columns_emits_composite_key_once() {
        let mut a = column("a", "int");
        a.is_primary_key = true;
        let mut b = column("b", "int");
        b.is_primary_key = true;
        let sql =
            create_table_from_columns(&create_request(vec![a, b]), Dialect::Postgres).unwrap();
        assert!(sql.contains("PRIMARY KEY (\"a\", \"b\")"));
        assert_eq!(sql.matches("PRIMARY KEY").count(), 1);
    }

    #[test]
    fn create_table_from_columns_validates() {
        assert!(create_table_from_columns(&create_request(vec![]), Dialect::MySql).is_err());

        let mut a = column("a", "int");
        let mut a2 = column("A", "int");
        assert!(create_table_from_columns(
            &create_request(vec![a.clone(), a2.clone()]),
            Dialect::MySql
        )
        .is_err());

        // two auto-increment columns
        a.is_auto_increment = true;
        a.is_primary_key = true;
        a2.is_auto_increment = true;
        a2.is_primary_key = true;
        assert!(create_table_from_columns(&create_request(vec![a, a2]), Dialect::MySql).is_err());

        // auto-increment without primary key
        let mut c = column("c", "int");
        c.is_auto_increment = true;
        assert!(create_table_from_columns(&create_request(vec![c]), Dialect::MySql).is_err());
    }

    #[test]
    fn clickhouse_table_uses_primary_key_as_sorting_key() {
        let mut id = column("id", "UInt64");
        id.is_primary_key = true;
        let mut note = column("note", "String");
        note.nullable = true;
        let sql = create_clickhouse_table(&create_request(vec![id, note])).unwrap();
        assert_eq!(
            sql,
            "CREATE TABLE \"shop\".\"orders\" (\n  \"id\" UInt64,\n  \"note\" Nullable(String)\n) ENGINE = MergeTree ORDER BY (\"id\");"
        );
    }

    #[test]
    fn clickhouse_default_sort_key_is_non_nullable() {
        let mut id = column("id", "String");
        id.is_primary_key = true;
        let sql = create_clickhouse_table(&create_request(vec![id])).unwrap();
        assert!(sql.contains("\"id\" String"));
        assert!(!sql.contains("\"id\" Nullable(String)"));
        assert!(sql.ends_with("ORDER BY (\"id\");"));
    }

    #[test]
    fn clickhouse_explicit_order_by_and_engine_options() {
        let mut request = create_request(vec![column("day", "Date"), column("sku", "String")]);
        request.engine = Some("ReplacingMergeTree".into());
        request.order_by = vec!["day".into(), "sku".into()];
        request.partition_by = Some("toYYYYMM(day)".into());
        request.primary_key = Some("day".into());
        request.ttl = Some("day + INTERVAL 90 DAY DELETE".into());
        request.settings = vec!["index_granularity = 8192".into()];
        request.comment = Some("it's events".into());
        request.if_not_exists = Some(true);
        let sql = create_clickhouse_table(&request).unwrap();
        assert!(sql.starts_with("CREATE TABLE IF NOT EXISTS \"shop\".\"orders\" ("));
        assert!(sql.ends_with(
            ") ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(day) ORDER BY (\"day\", \"sku\") PRIMARY KEY day TTL day + INTERVAL 90 DAY DELETE SETTINGS index_granularity = 8192 COMMENT 'it''s events';"
        ));
    }

    #[test]
    fn clickhouse_create_table_rejects_multi_statement_expression_fragments() {
        let mut request = create_request(vec![
            column("created_at", "DateTime"),
            column("id", "UInt64"),
        ]);
        request.order_by = vec!["id".into()];
        request.partition_by = Some("toYYYYMM(created_at); DROP TABLE orders".into());
        assert!(create_clickhouse_table(&request).is_err());
        request.partition_by = None;
        request.ttl = Some("created_at + INTERVAL 1 DAY -- comment".into());
        assert!(create_clickhouse_table(&request).is_err());
        request.ttl = None;
        request.primary_key = Some("id); DROP TABLE orders; --".into());
        assert!(create_clickhouse_table(&request).is_err());
    }

    #[test]
    fn clickhouse_memory_engine_takes_no_order_by() {
        let mut request = create_request(vec![column("msg", "String")]);
        request.engine = Some("Memory".into());
        let sql = create_clickhouse_table(&request).unwrap();
        assert!(sql.ends_with(") ENGINE = Memory;"));

        request.order_by = vec!["msg".into()];
        assert!(create_clickhouse_table(&request).is_err());
    }

    #[test]
    fn clickhouse_validation_rejects_unsafe_or_incomplete_requests() {
        let mut bad_engine = create_request(vec![column("a", "UInt8")]);
        bad_engine.engine = Some("MergeTree; DROP TABLE x".into());
        assert!(create_clickhouse_table(&bad_engine).is_err());

        // A MergeTree table needs a sorting key.
        assert!(create_clickhouse_table(&create_request(vec![column("a", "UInt8")])).is_err());

        let mut nullable_sort_key = create_request(vec![column("id", "String")]);
        nullable_sort_key.order_by = vec!["id".into()];
        nullable_sort_key.columns[0].nullable = true;
        assert!(create_clickhouse_table(&nullable_sort_key).is_err());
        nullable_sort_key.columns[0].nullable = false;
        nullable_sort_key.columns[0].data_type = "Nullable(String)".into();
        assert!(create_clickhouse_table(&nullable_sort_key).is_err());

        let mut missing_key = create_request(vec![column("a", "UInt8")]);
        missing_key.order_by = vec!["nope".into()];
        assert!(create_clickhouse_table(&missing_key).is_err());

        let mut auto = column("id", "UInt64");
        auto.is_auto_increment = true;
        auto.is_primary_key = true;
        assert!(create_clickhouse_table(&create_request(vec![auto])).is_err());

        let mut untyped = column("a", "  ");
        untyped.is_primary_key = true;
        assert!(create_clickhouse_table(&create_request(vec![untyped])).is_err());
    }

    fn row_request(kind: RowChangeKind) -> RowChangeRequest {
        RowChangeRequest {
            connection_id: "c".into(),
            database: "shop".into(),
            namespace: Some("public".into()),
            object: "orders".into(),
            kind,
            key: vec![RowValue {
                column: "id".into(),
                value: serde_json::json!(7),
                data_type: None,
            }],
            values: vec![RowValue {
                column: "status".into(),
                value: serde_json::json!("paid"),
                data_type: None,
            }],
        }
    }

    #[test]
    fn row_values_quote_by_type_and_dialect() {
        assert_eq!(row_value(&Value::Null, Dialect::MySql), "NULL");
        assert_eq!(row_value(&Value::Bool(true), Dialect::MySql), "TRUE");
        assert_eq!(row_value(&Value::Bool(false), Dialect::Postgres), "FALSE");
        assert_eq!(row_value(&serde_json::json!(42), Dialect::MySql), "42");
        assert_eq!(
            row_value(&serde_json::json!("it's"), Dialect::MySql),
            "'it''s'"
        );
        assert_eq!(
            row_value(&serde_json::json!("x"), Dialect::Postgres),
            "E'x'"
        );
    }

    #[test]
    fn postgres_literals_escape_backslashes_as_well_as_quotes() {
        // Under `standard_conforming_strings = off` a plain literal could end
        // early at `\'`; the E-string keeps the whole value inside one literal.
        assert_eq!(
            Dialect::Postgres.string_literal("a\\'; DROP TABLE t; --"),
            "E'a\\\\''; DROP TABLE t; --'"
        );
        assert_eq!(Dialect::Postgres.string_literal("it's"), "E'it''s'");
        assert_eq!(Dialect::MySql.string_literal("it's"), "'it''s'");
    }

    #[test]
    fn postgres_row_changes_cast_text_binds_to_column_types() {
        let mut req = row_request(RowChangeKind::Update);
        req.values[0].data_type = Some("character varying(20)".into());
        req.key[0].data_type = Some("bigint".into());
        assert!(postgres_row_change_is_bindable(&req));
        let (sql, params) = row_change_sql_with_params(&req, Dialect::Postgres).unwrap();
        assert_eq!(
            sql,
            "UPDATE \"public\".\"orders\" SET \"status\" = CAST($1 AS text) WHERE \"id\" = CAST($2 AS bigint)"
        );
        assert_eq!(
            params,
            vec![serde_json::json!("paid"), serde_json::json!(7)]
        );
    }

    #[test]
    fn postgres_row_parameters_encode_arrays_and_bytea() {
        let mut req = row_request(RowChangeKind::Insert);
        req.values = vec![
            RowValue {
                column: "tags".into(),
                value: serde_json::json!(["a,b", "c\"d", "e\\f", null]),
                data_type: Some("text[]".into()),
            },
            RowValue {
                column: "payload".into(),
                value: serde_json::json!("base64:3q2+7w=="),
                data_type: Some("bytea".into()),
            },
            RowValue {
                column: "doc".into(),
                value: serde_json::json!({ "a": 1 }),
                data_type: Some("jsonb".into()),
            },
            RowValue {
                column: "qty".into(),
                value: serde_json::json!(7),
                data_type: Some("integer".into()),
            },
        ];
        let (sql, params) = row_change_sql_with_params(&req, Dialect::Postgres).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"public\".\"orders\" (\"tags\", \"payload\", \"doc\", \"qty\") VALUES (CAST($1 AS text[]), CAST($2 AS bytea), CAST($3 AS jsonb), CAST($4 AS integer))"
        );
        assert_eq!(
            params[0],
            serde_json::json!("{\"a,b\",\"c\\\"d\",\"e\\\\f\",NULL}")
        );
        assert_eq!(params[1], serde_json::json!("\\xDEADBEEF"));
        assert_eq!(params[2], serde_json::json!({ "a": 1 }));
        assert_eq!(params[3], serde_json::json!(7));
    }

    #[test]
    fn postgres_casts_reject_unsafe_column_types() {
        let mut req = row_request(RowChangeKind::Update);
        req.values[0].data_type = Some("text); DROP TABLE orders; --".into());
        req.key[0].data_type = Some("bigint".into());
        assert!(!postgres_row_change_is_bindable(&req));
        let (sql, _) = row_change_sql_with_params(&req, Dialect::Postgres).unwrap();
        assert_eq!(
            sql,
            "UPDATE \"public\".\"orders\" SET \"status\" = $1 WHERE \"id\" = CAST($2 AS bigint)"
        );
        assert!(!sql.contains("DROP"));
    }

    #[test]
    fn parameterized_row_change_keeps_values_out_of_sql_and_orders_binds() {
        let mut req = row_request(RowChangeKind::Update);
        req.key[0].value = serde_json::json!("\\\\' OR 1=1 -- ");
        let (sql, params) = row_change_sql_with_params(&req, Dialect::MySql).unwrap();
        assert_eq!(
            sql,
            "UPDATE `public`.`orders` SET `status` = ? WHERE `id` = ?"
        );
        assert_eq!(
            params,
            vec![serde_json::json!("paid"), req.key[0].value.clone()]
        );
        assert!(!sql.contains("OR 1=1"));
    }

    #[test]
    fn update_requires_key_and_quotes_values() {
        let req = row_request(RowChangeKind::Update);
        assert_eq!(
            update_row_sql(&req, Dialect::MySql).unwrap(),
            "UPDATE `public`.`orders` SET `status` = 'paid' WHERE `id` = 7;"
        );
        let mut no_key = req;
        no_key.key.clear();
        assert!(update_row_sql(&no_key, Dialect::MySql).is_err());
    }

    #[test]
    fn delete_refuses_empty_key() {
        let mut req = row_request(RowChangeKind::Delete);
        assert_eq!(
            delete_row_sql(&req, Dialect::Postgres).unwrap(),
            "DELETE FROM \"public\".\"orders\" WHERE \"id\" = 7;"
        );
        req.key.clear();
        assert!(delete_row_sql(&req, Dialect::Postgres).is_err());
    }

    #[test]
    fn insert_requires_columns() {
        let req = row_request(RowChangeKind::Insert);
        assert_eq!(
            insert_row_sql(&req, Dialect::MySql).unwrap(),
            "INSERT INTO `public`.`orders` (`status`) VALUES ('paid');"
        );
        let mut empty = req;
        empty.values.clear();
        assert!(insert_row_sql(&empty, Dialect::MySql).is_err());
        assert_eq!(
            insert_row_sql(&empty, Dialect::Sqlite).unwrap(),
            "INSERT INTO \"public\".\"orders\" DEFAULT VALUES;"
        );
    }
}
