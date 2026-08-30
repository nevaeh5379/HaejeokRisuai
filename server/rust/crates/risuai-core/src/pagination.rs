use serde::{Deserialize, Serialize};

pub const DEFAULT_MESSAGE_PAGE_LIMIT: usize = 40;
pub const MAX_MESSAGE_PAGE_LIMIT: usize = 500;

pub fn normalize_page_integer(value: Option<usize>, fallback: usize, maximum: usize) -> usize {
    match value {
        Some(v) => v.min(maximum),
        None => fallback,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedMessagesResponse<T> {
    pub messages: Vec<T>,
    pub offset: usize,
    pub total: usize,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

pub fn paginate_messages<T: Clone>(
    messages: &[T],
    limit_opt: Option<usize>,
    before_opt: Option<usize>,
) -> PaginatedMessagesResponse<T> {
    let total = messages.len();
    let limit = limit_opt
        .unwrap_or(DEFAULT_MESSAGE_PAGE_LIMIT)
        .clamp(1, MAX_MESSAGE_PAGE_LIMIT);
    let end = before_opt.unwrap_or(total).min(total);
    let offset = end.saturating_sub(limit);

    PaginatedMessagesResponse {
        messages: messages[offset..end].to_vec(),
        offset,
        total,
        has_more: offset > 0,
    }
}
