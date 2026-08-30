use crate::api::client::{ApiClient, Result};
use crate::models::chat::{Chat, Message};
use crate::models::pagination::PaginatedMessagesResponse;

impl ApiClient {
    /// Calls GET `/api/database-v2/chats/{chatId}`
    /// Returns stored raw RisuAI chat JSON deserialized into `Chat`.
    pub async fn get_chat(&self, chat_id: &str) -> Result<Chat> {
        let path = format!("/api/database-v2/chats/{}", urlencoding::encode(chat_id));
        self.get(&path).await
    }

    /// Calls GET `/api/database-v2/chats/{chatId}/messages?limit=...&before=...`
    /// Deserializes the backend `PaginatedMessagesResponse<Message>` envelope.
    /// Crucial for memory optimization on low-RAM devices: loads only requested window of messages.
    pub async fn get_chat_messages(
        &self,
        chat_id: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<PaginatedMessagesResponse<Message>> {
        let mut query_parts = Vec::new();
        if let Some(l) = limit {
            query_parts.push(format!("limit={}", l));
        }
        if let Some(b) = before {
            query_parts.push(format!("before={}", b));
        }

        let query_str = if query_parts.is_empty() {
            String::new()
        } else {
            format!("?{}", query_parts.join("&"))
        };

        let path = format!(
            "/api/database-v2/chats/{}/messages{}",
            urlencoding::encode(chat_id),
            query_str
        );
        self.get(&path).await
    }
}
