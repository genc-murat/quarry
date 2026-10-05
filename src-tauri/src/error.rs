/// Errors surfaced by database drivers. Kept serializable so they can cross the
/// IPC boundary as structured data if a future UI wants to key off `kind`.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("query failed: {0}")]
    Query(String),
    #[error("introspection failed: {0}")]
    Introspect(String),
    #[error("unsupported operation: {0}")]
    Unsupported(String),
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cancelled: {0}")]
    Cancelled(String),
}

impl DriverError {
    /// Machine readable discriminator used by the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            DriverError::Connect(_) => "connect",
            DriverError::Query(_) => "query",
            DriverError::Introspect(_) => "introspect",
            DriverError::Unsupported(_) => "unsupported",
            DriverError::Config(_) => "config",
            DriverError::NotFound(_) => "notFound",
            DriverError::Cancelled(_) => "cancelled",
        }
    }
}

impl From<DriverError> for String {
    fn from(value: DriverError) -> Self {
        value.to_string()
    }
}

pub type Result<T> = std::result::Result<T, DriverError>;
