use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPlanRequest {
    #[serde(default)]
    pub formated: Vec<serde_json::Value>,
    #[serde(rename = "maxContextTokens")]
    pub max_context_tokens: usize,
    #[serde(rename = "maxResponseTokens")]
    pub max_response_tokens: usize,
    pub model: Option<String>,
    pub encoding: Option<String>,
    #[serde(rename = "chatAdditionalTokens")]
    pub chat_additional_tokens: Option<usize>,
    #[serde(rename = "useName")]
    pub use_name: Option<bool>,
    #[serde(rename = "countThoughts")]
    pub count_thoughts: Option<bool>,
    #[serde(rename = "supportsInlayImage")]
    pub supports_inlay_image: Option<bool>,
    #[serde(rename = "visionQuality")]
    pub vision_quality: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPlanResponse {
    pub ok: bool,
    #[serde(rename = "keptIndexes")]
    pub kept_indexes: Vec<usize>,
    #[serde(rename = "inputTokens")]
    pub input_tokens: usize,
    #[serde(rename = "outputTokens")]
    pub output_tokens: usize,
    #[serde(rename = "generationId")]
    pub generation_id: String,
    #[serde(rename = "generationModel", skip_serializing_if = "Option::is_none")]
    pub generation_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContinuationRequest {
    pub result: String,
    #[serde(rename = "minimumTokens")]
    pub minimum_tokens: Option<usize>,
    #[serde(rename = "usedContinueTokens")]
    pub used_continue_tokens: Option<usize>,
    #[serde(rename = "continueIncomplete")]
    pub continue_incomplete: Option<bool>,
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContinuationResponse {
    #[serde(rename = "shouldContinue")]
    pub should_continue: bool,
    #[serde(rename = "resultTokens")]
    pub result_tokens: usize,
}

pub fn ends_with_completion_punctuation(text: &str) -> bool {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return false;
    }
    let last_char = trimmed.chars().last().unwrap();
    [
        '.', '!', '?', '"', '\'', '”', '’', '。', '！', '？', '」', '』', '…', '~', '—', '\n',
    ]
    .contains(&last_char)
}

pub fn plan_continuation(req: &ChatContinuationRequest) -> ChatContinuationResponse {
    let generated = crate::tokenize::count_tokens(&req.result, req.encoding.as_deref());
    let used = req.used_continue_tokens.unwrap_or(0);
    let result_tokens = generated + used;
    let min_tokens = req.minimum_tokens.unwrap_or(0);
    let continue_incomplete = req.continue_incomplete.unwrap_or(true);
    let ends_punct = ends_with_completion_punctuation(&req.result);

    let should_continue = if result_tokens < min_tokens {
        true
    } else if continue_incomplete {
        !ends_punct
    } else {
        false
    };

    ChatContinuationResponse {
        should_continue,
        result_tokens,
    }
}
