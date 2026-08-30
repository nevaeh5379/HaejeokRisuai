use serde::{Deserialize, Serialize};

/// Query parameters for paginated chat messages endpoint: `GET /api/database-v2/chats/{chatId}/messages?limit=...&before=...`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ChatMessagesQuery {
    pub limit: Option<usize>,
    pub before: Option<usize>,
}

/// Paginated messages envelope matching backend `risuai_core::pagination::PaginatedMessagesResponse<T>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaginatedMessagesResponse<T> {
    pub messages: Vec<T>,
    pub offset: usize,
    pub total: usize,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

impl<T> Default for PaginatedMessagesResponse<T> {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
            offset: 0,
            total: 0,
            has_more: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paginated_messages_response_envelope_serde() {
        let json_str = r#"{
            "messages": ["msg_1", "msg_2", "msg_3"],
            "offset": 10,
            "total": 42,
            "hasMore": true
        }"#;

        let resp: PaginatedMessagesResponse<String> =
            serde_json::from_str(json_str).expect("should deserialize PaginatedMessagesResponse");
        assert_eq!(resp.messages, vec!["msg_1", "msg_2", "msg_3"]);
        assert_eq!(resp.offset, 10);
        assert_eq!(resp.total, 42);
        assert!(resp.has_more);

        let serialized =
            serde_json::to_string(&resp).expect("should serialize PaginatedMessagesResponse");
        assert!(serialized.contains(r#""hasMore":true"#));
        assert!(serialized.contains(r#""offset":10"#));
        assert!(serialized.contains(r#""total":42"#));
    }
}
