//! Registry of open database connections (sessions).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::drivers::Connection;
use crate::models::SessionInfo;

pub struct SessionEntry {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub connection: Arc<dyn Connection>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: RwLock<HashMap<String, SessionEntry>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, entry: SessionEntry) {
        self.sessions.write().await.insert(entry.id.clone(), entry);
    }

    pub async fn get(&self, id: &str) -> Option<Arc<dyn Connection>> {
        self.sessions
            .read()
            .await
            .get(id)
            .map(|e| e.connection.clone())
    }

    pub async fn remove(&self, id: &str) -> Option<SessionEntry> {
        self.sessions.write().await.remove(id)
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .read()
            .await
            .values()
            .map(|entry| SessionInfo {
                id: entry.id.clone(),
                profile_id: entry.profile_id.clone(),
                driver: entry.connection.driver_id().to_string(),
                name: entry.name.clone(),
                server: entry.connection.server_info().clone(),
            })
            .collect()
    }
}

/// Tracks in-flight query runs by their caller-supplied id so a later
/// `cancel_query` can signal the matching execution to stop.
///
/// A plain `std::sync::Mutex` is enough: the lock is only ever held for a map
/// lookup, never across an `.await`.
#[derive(Default)]
pub struct QueryRegistry {
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl QueryRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a run and return its cancellation token.
    pub fn register(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.running
            .lock()
            .unwrap()
            .insert(id.to_string(), token.clone());
        token
    }

    /// Signal a registered run to stop. Returns `false` when the run is unknown
    /// (already finished, or the id was never registered).
    pub fn cancel(&self, id: &str) -> bool {
        match self.running.lock().unwrap().get(id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Forget a finished run.
    pub fn finish(&self, id: &str) {
        self.running.lock().unwrap().remove(id);
    }

    /// Number of currently registered runs (used by tests).
    pub fn len(&self) -> usize {
        self.running.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_cancel_and_finish() {
        let registry = QueryRegistry::new();
        let token = registry.register("run-1");
        assert_eq!(registry.len(), 1);
        assert!(!token.is_cancelled());

        assert!(registry.cancel("run-1"));
        assert!(token.is_cancelled());
        // Cancelling an unknown run is a no-op, not a panic.
        assert!(!registry.cancel("missing"));

        registry.finish("run-1");
        assert!(registry.is_empty());
        assert!(!registry.cancel("run-1"));
    }
}
