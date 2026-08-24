use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_channel::{Receiver, Sender};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tiktoken_rs::{
    ChatCompletionRequestMessage, bpe_for_model, num_tokens_from_messages, o200k_base_singleton,
};
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};
use zeroize::Zeroizing;

use crate::asset::{
    AssetError, AssetStore, ImageAsset, MAX_IMAGES_PER_MESSAGE, MAX_REQUEST_IMAGE_BYTES,
    inlay_tokens, inlay_tokens_as_placeholder,
};
use crate::lorebook::{ActiveLore, LorePosition, LoreRole, select_lore};
use crate::memory::{
    HypaMemoryEntry, HypaMemoryState, HypaV2Chunk, HypaV2MainChunk, HypaV2State, HypaV3Metrics,
    HypaV3State, HypaV3Summary, MemoryError, SupaMemoryState, merge_summary, plan_summary_chunk,
    restore_hypa_memory, restore_memory,
};
use crate::model::{
    Character, HypaV3Settings, MemoryMode, Message, ProviderKind, ProviderSettings, Role,
};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const DEFAULT_CONTEXT_TOKENS: usize = 4_000;
pub const DEFAULT_OUTPUT_TOKENS: usize = 500;
pub const DEFAULT_EMBEDDING_MODEL: &str = "text-embedding-3-small";
pub const DEFAULT_MEMORY_ALLOCATED_TOKENS: usize = 3_000;
pub const DEFAULT_MEMORY_CHUNK_TOKENS: usize = 3_000;
const MAX_ERROR_BODY_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProviderRole {
    System,
    User,
    Assistant,
}

impl ProviderRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ChatInput {
    role: ProviderRole,
    content: String,
}

impl ChatInput {
    pub fn for_character(
        character: &Character,
        model: &str,
        max_context_tokens: usize,
        max_output_tokens: usize,
    ) -> Result<Vec<Self>, ProviderError> {
        Ok(Self::for_character_with_memory(
            character,
            None,
            model,
            max_context_tokens,
            max_output_tokens,
        )?
        .messages)
    }

    fn for_character_with_memory(
        character: &Character,
        memory_summary: Option<&str>,
        model: &str,
        max_context_tokens: usize,
        max_output_tokens: usize,
    ) -> Result<FittedContext, ProviderError> {
        let mut inputs = Vec::new();
        let profile = &character.profile;
        let lore_entries = character
            .global_lore
            .iter()
            .chain(&character.local_lore)
            .chain(&character.module_lore)
            .chain(&character.persona.embedded_lore)
            .cloned()
            .collect::<Vec<_>>();
        let active_lore = select_lore(
            &lore_entries,
            &character.messages,
            &character.lore_settings,
            model,
        );
        if !profile.system_prompt.trim().is_empty() {
            inputs.push(Self {
                role: ProviderRole::System,
                content: render_basic_template(
                    &profile.system_prompt.replace("{{original}}", ""),
                    &character.name,
                    &character.persona.name,
                ),
            });
        }

        inputs.extend(
            active_lore
                .iter()
                .filter(|lore| lore.position == LorePosition::BeforeDescription)
                .map(|lore| Self::from_lore(lore, &character.name, &character.persona.name)),
        );
        if let Some(summary) = memory_summary.filter(|summary| !summary.trim().is_empty()) {
            inputs.push(Self {
                role: ProviderRole::System,
                content: if summary.trim_start().starts_with("<Past Events") {
                    summary.trim().to_owned()
                } else {
                    format!("[Summary of the earlier conversation]\n{}", summary.trim())
                },
            });
        }

        let mut description = render_basic_template(
            &profile.description,
            &character.name,
            &character.persona.name,
        );
        if !profile.personality.trim().is_empty() {
            description.push_str(&format!(
                "\n\nDescription of {}: {}",
                character.name,
                render_basic_template(
                    &profile.personality,
                    &character.name,
                    &character.persona.name,
                )
            ));
        }
        if !profile.scenario.trim().is_empty() {
            description.push_str(&format!(
                "\n\nCircumstances and context of the dialogue: {}",
                render_basic_template(&profile.scenario, &character.name, &character.persona.name,)
            ));
        }
        if !description.trim().is_empty() {
            inputs.push(Self {
                role: ProviderRole::System,
                content: description,
            });
        }
        if !character.persona.prompt.trim().is_empty() {
            inputs.push(Self {
                role: ProviderRole::System,
                content: render_basic_template(
                    &character.persona.prompt,
                    &character.name,
                    &character.persona.name,
                ),
            });
        }

        inputs.extend(
            active_lore
                .iter()
                .filter(|lore| {
                    matches!(
                        lore.position,
                        LorePosition::Normal | LorePosition::AfterDescription
                    )
                })
                .map(|lore| Self::from_lore(lore, &character.name, &character.persona.name)),
        );

        let mut chat = parse_example_messages(
            &profile.example_message,
            &character.name,
            &character.persona.name,
        );
        chat.push(Self {
            role: ProviderRole::System,
            content: "[Start a new chat]".into(),
        });
        chat.extend(character.messages.iter().map(Self::from));

        let depth_lore = active_lore
            .iter()
            .enumerate()
            .filter(|(_, lore)| {
                matches!(
                    lore.position,
                    LorePosition::Depth(_) | LorePosition::ReverseDepth(_)
                )
            })
            .map(|(order, lore)| (order, lore.clone()))
            .collect::<Vec<_>>();
        let mut suffix = Vec::new();
        if !profile.post_history_instructions.trim().is_empty() {
            suffix.push(Self {
                role: ProviderRole::System,
                content: render_basic_template(
                    &profile.post_history_instructions,
                    &character.name,
                    &character.persona.name,
                ),
            });
        }
        fit_context(
            inputs,
            chat,
            &depth_lore,
            suffix,
            ContextBudget {
                character_name: &character.name,
                user_name: &character.persona.name,
                model,
                max_context_tokens,
                max_output_tokens,
            },
        )
    }

    fn from_lore(lore: &ActiveLore, character_name: &str, user_name: &str) -> Self {
        Self {
            role: match lore.role {
                LoreRole::System => ProviderRole::System,
                LoreRole::User => ProviderRole::User,
                LoreRole::Assistant => ProviderRole::Assistant,
            },
            content: render_basic_template(&lore.content, character_name, user_name),
        }
    }
}

#[derive(Clone, Copy)]
struct ContextBudget<'a> {
    character_name: &'a str,
    user_name: &'a str,
    model: &'a str,
    max_context_tokens: usize,
    max_output_tokens: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FittedContext {
    messages: Vec<ChatInput>,
    removed_count: usize,
}

fn fit_context(
    prefix: Vec<ChatInput>,
    chat: Vec<ChatInput>,
    depth_lore: &[(usize, ActiveLore)],
    suffix: Vec<ChatInput>,
    budget: ContextBudget<'_>,
) -> Result<FittedContext, ProviderError> {
    validate_token_limits(budget.max_context_tokens, budget.max_output_tokens)?;
    let mut remove_count = 0;
    loop {
        let messages = assemble_prompt(
            &prefix,
            &chat[remove_count..],
            depth_lore,
            &suffix,
            budget.character_name,
            budget.user_name,
        );
        let required_tokens =
            chat_token_count(budget.model, &messages).saturating_add(budget.max_output_tokens);
        if required_tokens <= budget.max_context_tokens {
            return Ok(FittedContext {
                messages,
                removed_count: remove_count,
            });
        }
        if chat.len().saturating_sub(remove_count) <= 1 {
            return Err(ProviderError::PromptTooLarge {
                required: required_tokens,
                limit: budget.max_context_tokens,
            });
        }
        remove_count += 1;
    }
}

fn assemble_prompt(
    prefix: &[ChatInput],
    chat: &[ChatInput],
    depth_lore: &[(usize, ActiveLore)],
    suffix: &[ChatInput],
    character_name: &str,
    user_name: &str,
) -> Vec<ChatInput> {
    let mut positioned_chat = chat.to_vec();
    let chat_len = positioned_chat.len();
    let mut injections = depth_lore
        .iter()
        .filter_map(|(order, lore)| {
            let index = match lore.position {
                LorePosition::Depth(depth) => chat_len.saturating_sub(depth),
                LorePosition::ReverseDepth(depth) => depth.min(chat_len),
                _ => return None,
            };
            Some((
                index,
                *order,
                ChatInput::from_lore(lore, character_name, user_name),
            ))
        })
        .collect::<Vec<_>>();
    injections.sort_by_key(|(index, order, _)| (*index, *order));
    for (offset, (index, _, input)) in injections.into_iter().enumerate() {
        positioned_chat.insert(index + offset, input);
    }

    prefix
        .iter()
        .cloned()
        .chain(positioned_chat)
        .chain(suffix.iter().cloned())
        .collect()
}

fn chat_token_count(model: &str, messages: &[ChatInput]) -> usize {
    const ESTIMATED_IMAGE_TOKENS: usize = 93;
    let tiktoken_messages = messages
        .iter()
        .map(|message| ChatCompletionRequestMessage {
            role: message.role.as_str().into(),
            content: Some(crate::asset::without_inlay_tokens(&message.content)),
            ..ChatCompletionRequestMessage::default()
        })
        .collect::<Vec<_>>();
    let text_tokens = num_tokens_from_messages(model, &tiktoken_messages).unwrap_or_else(|_| {
        let tokenizer = bpe_for_model(model).unwrap_or_else(|_| o200k_base_singleton());
        3 + messages
            .iter()
            .map(|message| {
                3 + tokenizer
                    .encode_with_special_tokens(message.role.as_str())
                    .len()
                    + tokenizer
                        .encode_with_special_tokens(&crate::asset::without_inlay_tokens(
                            &message.content,
                        ))
                        .len()
            })
            .sum::<usize>()
    });
    let image_tokens = messages
        .iter()
        .map(|message| {
            inlay_tokens(&message.content)
                .into_iter()
                .filter(|token| {
                    message.role == ProviderRole::User
                        || (message.role == ProviderRole::Assistant && token.kind == "inlayeddata")
                })
                .count()
        })
        .sum::<usize>()
        .saturating_mul(ESTIMATED_IMAGE_TOKENS);
    text_tokens.saturating_add(image_tokens)
}

fn parse_example_messages(source: &str, character_name: &str, user_name: &str) -> Vec<ChatInput> {
    let mut result = Vec::new();
    let mut current: Option<ChatInput> = None;

    let flush = |current: &mut Option<ChatInput>, result: &mut Vec<ChatInput>| {
        if let Some(message) = current.take() {
            result.push(message);
        }
    };

    for line in source.lines() {
        let trimmed = line.trim();
        let lowered = trimmed.to_lowercase();
        let character_prefix = format!("{}:", character_name.to_lowercase());
        let next = if lowered == "<start>" {
            flush(&mut current, &mut result);
            result.push(ChatInput {
                role: ProviderRole::System,
                content: "[Start a new chat]".into(),
            });
            continue;
        } else if lowered.starts_with("{{char}}:")
            || lowered.starts_with("<bot>:")
            || lowered.starts_with(&character_prefix)
        {
            Some(ProviderRole::Assistant)
        } else if lowered.starts_with("{{user}}:") || lowered.starts_with("<user>:") {
            Some(ProviderRole::User)
        } else {
            None
        };

        if let Some(role) = next {
            flush(&mut current, &mut result);
            let content = trimmed
                .split_once(':')
                .map(|(_, content)| content.trim_start())
                .unwrap_or_default();
            current = Some(ChatInput {
                role,
                content: content.to_owned(),
            });
        } else if let Some(message) = &mut current {
            message.content.push('\n');
            message.content.push_str(trimmed);
        }
    }
    flush(&mut current, &mut result);

    result
        .into_iter()
        .map(|mut message| {
            message.content = render_basic_template(&message.content, character_name, user_name);
            message
        })
        .collect()
}

impl From<&Message> for ChatInput {
    fn from(message: &Message) -> Self {
        Self {
            role: match message.role {
                Role::User => ProviderRole::User,
                Role::Character => ProviderRole::Assistant,
            },
            content: message.content.clone(),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum ProviderEvent {
    Delta(String),
    Finished,
    Failed(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedChat {
    pub messages: Vec<ChatInput>,
    pub supa_memory_data: Option<String>,
    pub hypa_v2_data: Option<HypaV2State>,
    pub hypa_v3_data: Option<HypaV3State>,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("공급자 URL이 올바르지 않습니다: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("공급자 URL은 http 또는 https만 지원합니다.")]
    UnsupportedScheme,
    #[error("공급자 기본 URL에 사용자 이름이나 비밀번호를 넣을 수 없습니다.")]
    UrlContainsCredentials,
    #[error("공급자 기본 URL에 쿼리 문자열이나 프래그먼트를 넣을 수 없습니다.")]
    UrlContainsQueryOrFragment,
    #[error("공급자 기본 URL을 입력해 주세요.")]
    EmptyBaseUrl,
    #[error("AI 모델 ID를 입력해 주세요.")]
    EmptyModel,
    #[error("환경 변수 RISUAI_PROVIDER_KIND는 openai, anthropic 또는 gemini여야 합니다.")]
    InvalidProviderKind,
    #[error("임베딩 모델 ID를 입력해 주세요.")]
    EmptyEmbeddingModel,
    #[error("환경 변수 RISUAI_MEMORY_MODE는 supa, hypa, hypa-v2 또는 hypa-v3여야 합니다.")]
    InvalidMemoryMode,
    #[error("메모리 할당 토큰과 요약 청크 토큰은 1 이상이어야 합니다.")]
    InvalidMemoryTokens,
    #[error("HypaMemory V3 비율 합계와 요약/검색 메시지 수 설정이 올바르지 않습니다.")]
    InvalidHypaV3Settings,
    #[error("HypaMemory V2 메모리 예산이 컨텍스트에 비해 너무 큽니다.")]
    MemoryBudgetExceedsContext,
    #[error(
        "HypaMemory V2 메시지 크기({required} 토큰)가 요약 청크 제한({limit} 토큰)을 초과합니다."
    )]
    MemoryChunkTooSmall { required: usize, limit: usize },
    #[error("HypaMemory V2는 마지막 4개 메시지를 보존해야 해서 더 요약할 수 없습니다.")]
    MemoryTailTooLarge,
    #[error("HypaMemory V3 메모리 비율이 컨텍스트에 비해 너무 큽니다.")]
    HypaV3MemoryBudgetExceedsContext,
    #[error(
        "HypaMemory V3는 최근 {query_count}개 메시지를 검색 질의로 남겨야 해서 더 요약할 수 없습니다."
    )]
    HypaV3CannotSummarize { query_count: usize },
    #[error("최대 컨텍스트 토큰은 1 이상이어야 합니다.")]
    InvalidContextTokens,
    #[error("최대 응답 토큰은 1 이상이어야 합니다.")]
    InvalidOutputTokens,
    #[error("최대 응답 토큰은 최대 컨텍스트 토큰보다 작아야 합니다.")]
    OutputExceedsContext,
    #[error(
        "고정 프롬프트와 마지막 메시지가 컨텍스트 제한을 초과합니다: 필요 {required}, 제한 {limit} 토큰"
    )]
    PromptTooLarge { required: usize, limit: usize },
    #[error("환경 변수 {name}에 올바른 양의 정수 토큰 값을 지정해 주세요.")]
    InvalidEnvironmentTokens { name: &'static str },
    #[error("HTTP 클라이언트를 만들지 못했습니다: {0}")]
    Client(#[source] reqwest::Error),
    #[error("공급자 요청에 실패했습니다: {0}")]
    Request(#[source] reqwest::Error),
    #[error("공급자가 HTTP {status}를 반환했습니다: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("공급자 스트림이 올바른 UTF-8이 아닙니다: {0}")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("공급자 스트림 JSON을 해석하지 못했습니다: {0}")]
    Json(#[from] serde_json::Error),
    #[error("공급자가 오류를 반환했습니다: {0}")]
    Remote(String),
    #[error("공급자가 빈 응답을 반환했습니다.")]
    EmptyResponse,
    #[error("첨부 이미지를 처리하지 못했습니다: {0}")]
    Asset(#[from] AssetError),
    #[error("공급자의 임베딩 응답 형식이나 벡터 차원이 올바르지 않습니다.")]
    InvalidEmbeddingResponse,
    #[error("{0:?} 네이티브 공급자는 현재 OpenAI 호환 임베딩 엔드포인트를 제공하지 않습니다.")]
    EmbeddingUnavailable(ProviderKind),
    #[error("SupaMemory 상태를 처리하지 못했습니다: {0}")]
    Memory(#[from] MemoryError),
    #[error("비동기 런타임을 만들지 못했습니다: {0}")]
    Runtime(#[source] std::io::Error),
}

#[derive(Clone)]
struct ProviderConfig {
    provider_kind: ProviderKind,
    endpoint: Url,
    non_stream_endpoint: Url,
    embedding_endpoint: Url,
    api_key: Option<Zeroizing<String>>,
    model: String,
    max_context_tokens: usize,
    max_output_tokens: usize,
    memory_mode: MemoryMode,
    embedding_model: String,
    memory_allocated_tokens: usize,
    memory_chunk_tokens: usize,
    hypa_v3: HypaV3Settings,
}

impl ProviderConfig {
    fn from_environment() -> Result<Option<Self>, ProviderError> {
        let model = match non_empty_environment("RISUAI_PROVIDER_MODEL")
            .or_else(|| non_empty_environment("RISUAI_OPENAI_MODEL"))
        {
            Some(model) => model,
            None => return Ok(None),
        };
        let provider_kind = match non_empty_environment("RISUAI_PROVIDER_KIND").as_deref() {
            None | Some("openai") | Some("openai-compatible") => ProviderKind::OpenAiCompatible,
            Some("anthropic") => ProviderKind::Anthropic,
            Some("gemini") => ProviderKind::Gemini,
            Some(_) => return Err(ProviderError::InvalidProviderKind),
        };
        let base_url = non_empty_environment("RISUAI_PROVIDER_BASE_URL")
            .or_else(|| non_empty_environment("RISUAI_OPENAI_BASE_URL"))
            .unwrap_or_else(|| {
                match provider_kind {
                    ProviderKind::OpenAiCompatible => DEFAULT_BASE_URL,
                    ProviderKind::Anthropic => DEFAULT_ANTHROPIC_BASE_URL,
                    ProviderKind::Gemini => DEFAULT_GEMINI_BASE_URL,
                }
                .to_owned()
            });
        let max_context_tokens =
            environment_token_limit("RISUAI_MAX_CONTEXT_TOKENS", DEFAULT_CONTEXT_TOKENS)?;
        let max_output_tokens =
            environment_token_limit("RISUAI_MAX_OUTPUT_TOKENS", DEFAULT_OUTPUT_TOKENS)?;
        let memory_mode = match non_empty_environment("RISUAI_MEMORY_MODE").as_deref() {
            None | Some("supa") => MemoryMode::Supa,
            Some("hypa") => MemoryMode::Hypa,
            Some("hypa-v2") => MemoryMode::HypaV2,
            Some("hypa-v3") => MemoryMode::HypaV3,
            Some(_) => return Err(ProviderError::InvalidMemoryMode),
        };
        let embedding_model = non_empty_environment("RISUAI_EMBEDDING_MODEL")
            .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_owned());
        let memory_allocated_tokens = environment_token_limit(
            "RISUAI_MEMORY_ALLOCATED_TOKENS",
            DEFAULT_MEMORY_ALLOCATED_TOKENS,
        )?;
        let memory_chunk_tokens =
            environment_token_limit("RISUAI_MEMORY_CHUNK_TOKENS", DEFAULT_MEMORY_CHUNK_TOKENS)?;
        let settings = validate_settings(
            &base_url,
            provider_kind,
            &model,
            max_context_tokens,
            max_output_tokens,
            memory_mode,
            &embedding_model,
            memory_allocated_tokens,
            memory_chunk_tokens,
            HypaV3Settings::default(),
            None,
        )?;
        Self::from_settings(
            &settings,
            non_empty_environment("RISUAI_PROVIDER_API_KEY")
                .or_else(|| non_empty_environment("RISUAI_OPENAI_API_KEY"))
                .map(Zeroizing::new),
        )
        .map(Some)
    }

    fn from_settings(
        settings: &ProviderSettings,
        api_key: Option<Zeroizing<String>>,
    ) -> Result<Self, ProviderError> {
        let settings = validate_settings(
            &settings.base_url,
            settings.provider_kind,
            &settings.model,
            settings.max_context_tokens,
            settings.max_output_tokens,
            settings.memory_mode,
            &settings.embedding_model,
            settings.memory_allocated_tokens,
            settings.memory_chunk_tokens,
            settings.hypa_v3.clone(),
            settings.credential_id.clone(),
        )?;
        let base_url = settings.base_url.trim_end_matches('/');
        let (endpoint, non_stream_endpoint) =
            provider_endpoints(settings.provider_kind, base_url, &settings.model)?;
        let embedding_endpoint = Url::parse(&format!("{base_url}/embeddings"))?;
        Ok(Self {
            provider_kind: settings.provider_kind,
            endpoint,
            non_stream_endpoint,
            embedding_endpoint,
            api_key,
            model: settings.model,
            max_context_tokens: settings.max_context_tokens,
            max_output_tokens: settings.max_output_tokens,
            memory_mode: settings.memory_mode,
            embedding_model: settings.embedding_model,
            memory_allocated_tokens: settings.memory_allocated_tokens,
            memory_chunk_tokens: settings.memory_chunk_tokens,
            hypa_v3: settings.hypa_v3,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub fn validate_settings(
    base_url: &str,
    provider_kind: ProviderKind,
    model: &str,
    max_context_tokens: usize,
    max_output_tokens: usize,
    memory_mode: MemoryMode,
    embedding_model: &str,
    memory_allocated_tokens: usize,
    memory_chunk_tokens: usize,
    hypa_v3: HypaV3Settings,
    credential_id: Option<String>,
) -> Result<ProviderSettings, ProviderError> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(ProviderError::EmptyBaseUrl);
    }
    let parsed = Url::parse(base_url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ProviderError::UnsupportedScheme);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ProviderError::UrlContainsCredentials);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ProviderError::UrlContainsQueryOrFragment);
    }
    let model = model.trim();
    if model.is_empty() {
        return Err(ProviderError::EmptyModel);
    }
    let embedding_model = embedding_model.trim();
    if embedding_model.is_empty() {
        return Err(ProviderError::EmptyEmbeddingModel);
    }
    if memory_allocated_tokens == 0 || memory_chunk_tokens == 0 {
        return Err(ProviderError::InvalidMemoryTokens);
    }
    if !(1..=10_000).contains(&hypa_v3.memory_ratio_bps)
        || hypa_v3.extra_summarization_ratio_bps >= 10_000
        || hypa_v3
            .recent_ratio_bps
            .saturating_add(hypa_v3.similar_ratio_bps)
            > 10_000
        || hypa_v3.max_messages_per_summary == 0
        || hypa_v3.query_message_count == 0
        || hypa_v3.summary_chunk_separator.trim().is_empty()
    {
        return Err(ProviderError::InvalidHypaV3Settings);
    }
    validate_token_limits(max_context_tokens, max_output_tokens)?;
    Ok(ProviderSettings {
        provider_kind,
        base_url: base_url.to_owned(),
        model: model.to_owned(),
        max_context_tokens,
        max_output_tokens,
        memory_mode,
        embedding_model: embedding_model.to_owned(),
        memory_allocated_tokens,
        memory_chunk_tokens,
        hypa_v3,
        credential_id,
    })
}

fn validate_token_limits(
    max_context_tokens: usize,
    max_output_tokens: usize,
) -> Result<(), ProviderError> {
    if max_context_tokens == 0 {
        return Err(ProviderError::InvalidContextTokens);
    }
    if max_output_tokens == 0 {
        return Err(ProviderError::InvalidOutputTokens);
    }
    if max_output_tokens >= max_context_tokens {
        return Err(ProviderError::OutputExceedsContext);
    }
    Ok(())
}

fn provider_endpoints(
    provider_kind: ProviderKind,
    base_url: &str,
    model: &str,
) -> Result<(Url, Url), ProviderError> {
    match provider_kind {
        ProviderKind::OpenAiCompatible => {
            let endpoint = if base_url
                .trim_end_matches('/')
                .ends_with("/chat/completions")
            {
                Url::parse(base_url)?
            } else {
                Url::parse(&format!(
                    "{}/chat/completions",
                    base_url.trim_end_matches('/')
                ))?
            };
            Ok((endpoint.clone(), endpoint))
        }
        ProviderKind::Anthropic => {
            let base = base_url.trim_end_matches('/');
            let endpoint = if base.ends_with("/messages") {
                Url::parse(base)?
            } else if base.ends_with("/v1") {
                Url::parse(&format!("{base}/messages"))?
            } else {
                Url::parse(&format!("{base}/v1/messages"))?
            };
            Ok((endpoint.clone(), endpoint))
        }
        ProviderKind::Gemini => {
            let make_endpoint = |method: &str| -> Result<Url, ProviderError> {
                let mut endpoint = Url::parse(base_url)?;
                endpoint
                    .path_segments_mut()
                    .map_err(|_| ProviderError::UnsupportedScheme)?
                    .pop_if_empty()
                    .push("models")
                    .push(&format!("{model}:{method}"));
                Ok(endpoint)
            };
            let mut stream = make_endpoint("streamGenerateContent")?;
            stream.query_pairs_mut().append_pair("alt", "sse");
            Ok((stream, make_endpoint("generateContent")?))
        }
    }
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

fn provider_request_body(
    provider_kind: ProviderKind,
    model: &str,
    messages: &[ChatInput],
    max_output_tokens: usize,
    stream: bool,
) -> serde_json::Value {
    let messages = messages
        .iter()
        .map(|message| ResolvedProviderMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            images: Vec::new(),
        })
        .collect::<Vec<_>>();
    resolved_provider_request_body(provider_kind, model, &messages, max_output_tokens, stream)
}

fn provider_request_body_with_assets(
    provider_kind: ProviderKind,
    model: &str,
    messages: &[ChatInput],
    max_output_tokens: usize,
    stream: bool,
    asset_store: &AssetStore,
) -> Result<serde_json::Value, ProviderError> {
    if !messages
        .iter()
        .any(|message| !inlay_tokens(&message.content).is_empty())
    {
        return Ok(provider_request_body(
            provider_kind,
            model,
            messages,
            max_output_tokens,
            stream,
        ));
    }
    let messages = resolve_provider_messages(messages, asset_store)?;
    Ok(resolved_provider_request_body(
        provider_kind,
        model,
        &messages,
        max_output_tokens,
        stream,
    ))
}

#[derive(Clone)]
struct ResolvedProviderMessage {
    role: ProviderRole,
    content: String,
    images: Vec<ImageAsset>,
}

fn resolve_provider_messages(
    messages: &[ChatInput],
    asset_store: &AssetStore,
) -> Result<Vec<ResolvedProviderMessage>, ProviderError> {
    let mut request_image_bytes = 0_usize;
    messages
        .iter()
        .map(|message| {
            let mut content = String::with_capacity(message.content.len());
            let mut images = Vec::new();
            let mut previous_end = 0;
            for token in inlay_tokens(&message.content) {
                content.push_str(&message.content[previous_end..token.start]);
                let should_attach = message.role == ProviderRole::User
                    || (message.role == ProviderRole::Assistant && token.kind == "inlayeddata");
                if should_attach {
                    if images.len() >= MAX_IMAGES_PER_MESSAGE {
                        return Err(ProviderError::Asset(AssetError::TooManyImages {
                            limit: MAX_IMAGES_PER_MESSAGE,
                        }));
                    }
                    let image = asset_store.load_image(&token.id)?;
                    request_image_bytes = request_image_bytes.saturating_add(image.byte_len);
                    if request_image_bytes > MAX_REQUEST_IMAGE_BYTES {
                        return Err(ProviderError::Asset(AssetError::RequestImagesTooLarge {
                            limit_mib: MAX_REQUEST_IMAGE_BYTES / 1024 / 1024,
                        }));
                    }
                    images.push(image);
                }
                previous_end = token.end;
            }
            content.push_str(&message.content[previous_end..]);
            Ok(ResolvedProviderMessage {
                role: message.role.clone(),
                content,
                images,
            })
        })
        .collect()
}

fn resolved_provider_request_body(
    provider_kind: ProviderKind,
    model: &str,
    messages: &[ResolvedProviderMessage],
    max_output_tokens: usize,
    stream: bool,
) -> serde_json::Value {
    match provider_kind {
        ProviderKind::OpenAiCompatible => {
            let messages = messages
                .iter()
                .map(|message| {
                    let content =
                        if message.role == ProviderRole::User && !message.images.is_empty() {
                            let mut parts = message
                                .images
                                .iter()
                                .map(|image| {
                                    serde_json::json!({
                                        "type": "image_url",
                                        "image_url": {
                                            "url": format!(
                                                "data:{};base64,{}",
                                                image.mime_type, image.base64
                                            ),
                                            "detail": "auto",
                                        },
                                    })
                                })
                                .collect::<Vec<_>>();
                            parts.push(serde_json::json!({
                                "type": "text",
                                "text": message.content,
                            }));
                            Value::Array(parts)
                        } else {
                            Value::String(message.content.clone())
                        };
                    serde_json::json!({"role": message.role.as_str(), "content": content})
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": stream,
                "max_tokens": max_output_tokens,
            })
        }
        ProviderKind::Anthropic => {
            anthropic_request_body_resolved(model, messages, max_output_tokens, stream)
        }
        ProviderKind::Gemini => gemini_request_body_resolved(messages, max_output_tokens),
    }
}

#[cfg(test)]
fn anthropic_request_body(
    model: &str,
    messages: &[ChatInput],
    max_output_tokens: usize,
    stream: bool,
) -> serde_json::Value {
    let messages = messages
        .iter()
        .map(|message| ResolvedProviderMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            images: Vec::new(),
        })
        .collect::<Vec<_>>();
    anthropic_request_body_resolved(model, &messages, max_output_tokens, stream)
}

fn anthropic_request_body_resolved(
    model: &str,
    messages: &[ResolvedProviderMessage],
    max_output_tokens: usize,
    stream: bool,
) -> serde_json::Value {
    let mut system = Vec::new();
    let mut chat = Vec::<ResolvedProviderMessage>::new();
    for message in messages {
        match message.role {
            ProviderRole::System if chat.is_empty() => system.push(message.content.clone()),
            ProviderRole::System => push_merged_provider_message(
                &mut chat,
                ResolvedProviderMessage {
                    role: ProviderRole::User,
                    content: format!("System: {}", message.content),
                    images: Vec::new(),
                },
            ),
            ProviderRole::User | ProviderRole::Assistant => {
                push_merged_provider_message(&mut chat, message.clone())
            }
        }
    }
    if chat.is_empty() && !system.is_empty() {
        chat.push(ResolvedProviderMessage {
            role: ProviderRole::User,
            content: "Start".into(),
            images: Vec::new(),
        });
        system.clear();
    }
    if chat
        .first()
        .is_some_and(|message| message.role != ProviderRole::User)
    {
        chat.insert(
            0,
            ResolvedProviderMessage {
                role: ProviderRole::User,
                content: "Start".into(),
                images: Vec::new(),
            },
        );
    }
    let messages = chat
        .into_iter()
        .map(|message| {
            let mut content = message
                .images
                .into_iter()
                .map(|image| {
                    serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type,
                            "data": image.base64,
                        },
                    })
                })
                .collect::<Vec<_>>();
            if !message.content.is_empty() || content.is_empty() {
                content.push(serde_json::json!({"type": "text", "text": message.content}));
            }
            serde_json::json!({"role": message.role.as_str(), "content": content})
        })
        .collect::<Vec<_>>();
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "stream": stream,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system.join("\n\n"));
    }
    body
}

#[cfg(test)]
fn gemini_request_body(messages: &[ChatInput], max_output_tokens: usize) -> serde_json::Value {
    let messages = messages
        .iter()
        .map(|message| ResolvedProviderMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            images: Vec::new(),
        })
        .collect::<Vec<_>>();
    gemini_request_body_resolved(&messages, max_output_tokens)
}

fn gemini_request_body_resolved(
    messages: &[ResolvedProviderMessage],
    max_output_tokens: usize,
) -> serde_json::Value {
    let mut system = None;
    let mut chat = Vec::<(String, String, Vec<ImageAsset>)>::new();
    for (index, message) in messages.iter().enumerate() {
        if index == 0 && message.role == ProviderRole::System {
            system = Some(message.content.clone());
            continue;
        }
        if !message.images.is_empty() {
            chat.push((
                if message.role == ProviderRole::User {
                    "user".into()
                } else {
                    "model".into()
                },
                message.content.clone(),
                message.images.clone(),
            ));
            continue;
        }
        match message.role {
            ProviderRole::User => chat.push(("user".into(), message.content.clone(), Vec::new())),
            ProviderRole::Assistant => {
                chat.push(("model".into(), message.content.clone(), Vec::new()))
            }
            ProviderRole::System => {
                if let Some((previous_role, previous_content, _)) = chat.last_mut()
                    && previous_role == "user"
                {
                    previous_content.push_str("\nsystem:");
                    previous_content.push_str(&message.content);
                } else {
                    chat.push((
                        "user".into(),
                        format!("system:{}", message.content),
                        Vec::new(),
                    ));
                }
            }
        }
    }
    if chat.is_empty() {
        chat.push(("user".into(), "Start".into(), Vec::new()));
    }
    let contents = chat
        .into_iter()
        .map(|(role, content, images)| {
            let mut parts = vec![serde_json::json!({"text": content})];
            parts.extend(images.into_iter().map(|image| {
                serde_json::json!({
                    "inlineData": {"mimeType": image.mime_type, "data": image.base64},
                })
            }));
            serde_json::json!({"role": role, "parts": parts})
        })
        .collect::<Vec<_>>();
    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_output_tokens},
    });
    if let Some(system) = system.filter(|system| !system.trim().is_empty()) {
        body["systemInstruction"] = serde_json::json!({"parts": [{"text": system}]});
    }
    body
}

fn push_merged_provider_message(
    messages: &mut Vec<ResolvedProviderMessage>,
    mut message: ResolvedProviderMessage,
) {
    if let Some(previous) = messages.last_mut()
        && previous.role == message.role
    {
        previous.content.push_str("\n\n");
        previous.content.push_str(&message.content);
        previous.images.append(&mut message.images);
    } else {
        messages.push(message);
    }
}

fn extract_provider_response_text(provider_kind: ProviderKind, value: &Value) -> Option<String> {
    match provider_kind {
        ProviderKind::OpenAiCompatible => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ProviderKind::Anthropic => {
            let mut output = String::new();
            let mut thinking = false;
            for block in value.get("content")?.as_array()? {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => append_response_part(
                        &mut output,
                        &mut thinking,
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        false,
                    ),
                    Some("thinking") => append_response_part(
                        &mut output,
                        &mut thinking,
                        block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        true,
                    ),
                    Some("redacted_thinking") => append_response_part(
                        &mut output,
                        &mut thinking,
                        "{{redacted_thinking}}",
                        true,
                    ),
                    _ => {}
                }
            }
            close_response_thinking(&mut output, &mut thinking);
            (!output.is_empty()).then_some(output)
        }
        ProviderKind::Gemini => {
            let mut output = String::new();
            let mut thinking = false;
            for part in value.pointer("/candidates/0/content/parts")?.as_array()? {
                append_response_part(
                    &mut output,
                    &mut thinking,
                    part.get("text").and_then(Value::as_str).unwrap_or_default(),
                    part.get("thought")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
            }
            close_response_thinking(&mut output, &mut thinking);
            (!output.is_empty()).then_some(output)
        }
    }
}

fn append_response_part(output: &mut String, thinking: &mut bool, text: &str, is_thinking: bool) {
    if text.is_empty() {
        return;
    }
    if is_thinking && !*thinking {
        output.push_str("<Thoughts>\n");
        *thinking = true;
    } else if !is_thinking {
        close_response_thinking(output, thinking);
    }
    output.push_str(text);
}

fn close_response_thinking(output: &mut String, thinking: &mut bool) {
    if *thinking {
        output.push_str("\n</Thoughts>\n\n");
        *thinking = false;
    }
}

#[async_trait]
trait ChatProvider: Send + Sync {
    fn model(&self) -> &str;
    fn max_context_tokens(&self) -> usize;
    fn max_output_tokens(&self) -> usize;
    fn memory_mode(&self) -> MemoryMode;
    fn memory_allocated_tokens(&self) -> usize;
    fn memory_chunk_tokens(&self) -> usize;
    fn hypa_v3_settings(&self) -> HypaV3Settings {
        HypaV3Settings::default()
    }
    async fn stream_chat(
        &self,
        messages: Vec<ChatInput>,
        sender: &Sender<ProviderEvent>,
    ) -> Result<(), ProviderError>;
    async fn summarize(
        &self,
        existing_summary: Option<&str>,
        conversation: &str,
        character_name: &str,
    ) -> Result<String, ProviderError>;
    async fn summarize_v3(
        &self,
        conversation: &str,
        character_name: &str,
        _prompt: &str,
    ) -> Result<String, ProviderError> {
        self.summarize(None, conversation, character_name).await
    }
    async fn retrieve_similar_scored(
        &self,
        candidates: &[String],
        query: &str,
        top_k: usize,
    ) -> Result<Vec<(String, f64)>, ProviderError>;
}

struct NativeProvider {
    client: reqwest::Client,
    config: ProviderConfig,
    asset_store: AssetStore,
    embedding_cache: Mutex<HashMap<String, Vec<f64>>>,
}

impl NativeProvider {
    fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Self::new_with_asset_store(config, AssetStore::open_default()?)
    }

    fn new_with_asset_store(
        config: ProviderConfig,
        asset_store: AssetStore,
    ) -> Result<Self, ProviderError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600))
            .user_agent(concat!("risuai-gtk/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(ProviderError::Client)?;
        Ok(Self {
            client,
            config,
            asset_store,
            embedding_cache: Mutex::new(HashMap::new()),
        })
    }

    fn request_to(&self, endpoint: Url) -> reqwest::RequestBuilder {
        let mut request = self.client.post(endpoint);
        if let Some(api_key) = &self.config.api_key {
            request = match self.config.provider_kind {
                ProviderKind::OpenAiCompatible => request.bearer_auth(api_key.as_str()),
                ProviderKind::Anthropic => request.header("x-api-key", api_key.as_str()),
                ProviderKind::Gemini => request.header("x-goog-api-key", api_key.as_str()),
            };
        }
        if self.config.provider_kind == ProviderKind::Anthropic {
            request = request.header("anthropic-version", "2023-06-01");
        }
        request
    }

    async fn complete_summary_messages(
        &self,
        messages: &[ChatInput],
    ) -> Result<String, ProviderError> {
        let request_body = provider_request_body_with_assets(
            self.config.provider_kind,
            &self.config.model,
            messages,
            self.config.max_output_tokens.min(8_192),
            false,
            &self.asset_store,
        )?;
        let response = self
            .request_to(self.config.non_stream_endpoint.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(ProviderError::Request)?;
        let status = response.status();
        let body = response.text().await.map_err(ProviderError::Request)?;
        if !status.is_success() {
            return Err(ProviderError::HttpStatus {
                status: status.as_u16(),
                body: truncate_error_body(&body),
            });
        }
        let value: Value = serde_json::from_str(&body)?;
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return Err(ProviderError::Remote(message.to_owned()));
        }
        extract_provider_response_text(self.config.provider_kind, &value)
            .map(|summary| strip_reasoning_blocks(&summary))
            .filter(|summary| !summary.is_empty())
            .ok_or(ProviderError::EmptyResponse)
    }
}

#[async_trait]
impl ChatProvider for NativeProvider {
    fn model(&self) -> &str {
        &self.config.model
    }

    fn max_context_tokens(&self) -> usize {
        self.config.max_context_tokens
    }

    fn max_output_tokens(&self) -> usize {
        self.config.max_output_tokens
    }

    fn memory_mode(&self) -> MemoryMode {
        self.config.memory_mode
    }

    fn memory_allocated_tokens(&self) -> usize {
        self.config.memory_allocated_tokens
    }

    fn memory_chunk_tokens(&self) -> usize {
        self.config.memory_chunk_tokens
    }

    fn hypa_v3_settings(&self) -> HypaV3Settings {
        self.config.hypa_v3.clone()
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatInput>,
        sender: &Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        let request_body = provider_request_body_with_assets(
            self.config.provider_kind,
            &self.config.model,
            &messages,
            self.config.max_output_tokens,
            true,
            &self.asset_store,
        )?;
        let request = self
            .request_to(self.config.endpoint.clone())
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .json(&request_body);
        let response = request.send().await.map_err(ProviderError::Request)?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.map_err(ProviderError::Request)?;
            return Err(ProviderError::HttpStatus {
                status: status.as_u16(),
                body: truncate_error_body(&body),
            });
        }

        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut state = ProviderStreamState::default();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(ProviderError::Request)?;
            for data in decoder.push(&chunk)? {
                if handle_provider_data_event(self.config.provider_kind, &data, sender, &mut state)
                    .await?
                {
                    return Ok(());
                }
            }
        }
        for data in decoder.finish()? {
            if handle_provider_data_event(self.config.provider_kind, &data, sender, &mut state)
                .await?
            {
                return Ok(());
            }
        }
        close_stream_thinking(sender, &mut state).await;
        if state.received_text {
            Ok(())
        } else {
            Err(ProviderError::EmptyResponse)
        }
    }

    async fn summarize(
        &self,
        existing_summary: Option<&str>,
        conversation: &str,
        character_name: &str,
    ) -> Result<String, ProviderError> {
        let existing = existing_summary.map(|summary| {
            format!(
                "Existing summary of the earlier conversation:\n{}",
                summary.trim()
            )
        });
        let conversation = format!("New conversation segment:\n{}", conversation.trim());
        let combined = merge_summary(existing.as_deref(), &conversation);
        let messages = vec![
            ChatInput {
                role: ProviderRole::System,
                content: format!(
                    "Summarize the ongoing role-play conversation involving {character_name}. Preserve important events, relationships, facts, and unresolved intentions. Remove redundancy and unnecessary wording. Return only the updated compact summary."
                ),
            },
            ChatInput {
                role: ProviderRole::User,
                content: combined,
            },
        ];
        self.complete_summary_messages(&messages).await
    }

    async fn summarize_v3(
        &self,
        conversation: &str,
        character_name: &str,
        prompt: &str,
    ) -> Result<String, ProviderError> {
        let default_prompt = format!(
            "Summarize the ongoing role-play conversation involving {character_name}. Preserve important events, relationships, facts, and unresolved intentions. Remove redundancy and unnecessary wording. Return only the compact summary."
        );
        let prompt = if prompt.trim().is_empty() {
            default_prompt
        } else {
            prompt.to_owned()
        };
        let messages = if prompt.contains("{{slot}}") {
            vec![ChatInput {
                role: ProviderRole::User,
                content: prompt.replace("{{slot}}", conversation),
            }]
        } else {
            vec![
                ChatInput {
                    role: ProviderRole::System,
                    content: prompt,
                },
                ChatInput {
                    role: ProviderRole::User,
                    content: conversation.to_owned(),
                },
            ]
        };
        self.complete_summary_messages(&messages).await
    }

    async fn retrieve_similar_scored(
        &self,
        candidates: &[String],
        query: &str,
        top_k: usize,
    ) -> Result<Vec<(String, f64)>, ProviderError> {
        if candidates.is_empty() || query.trim().is_empty() || top_k == 0 {
            return Ok(Vec::new());
        }
        if self.config.provider_kind != ProviderKind::OpenAiCompatible {
            return Err(ProviderError::EmbeddingUnavailable(
                self.config.provider_kind,
            ));
        }
        let mut input = candidates.to_vec();
        input.push(query.to_owned());
        let missing = {
            let cache = self.embedding_cache.lock().unwrap();
            let mut seen = std::collections::HashSet::new();
            input
                .iter()
                .filter(|text| !cache.contains_key(*text) && seen.insert((*text).clone()))
                .cloned()
                .collect::<Vec<_>>()
        };
        if !missing.is_empty() {
            let request_body = EmbeddingRequest {
                model: &self.config.embedding_model,
                input: &missing,
            };
            let response = self
                .request_to(self.config.embedding_endpoint.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .json(&request_body)
                .send()
                .await
                .map_err(ProviderError::Request)?;
            let status = response.status();
            let body = response.text().await.map_err(ProviderError::Request)?;
            if !status.is_success() {
                return Err(ProviderError::HttpStatus {
                    status: status.as_u16(),
                    body: truncate_error_body(&body),
                });
            }
            let value: Value = serde_json::from_str(&body)?;
            if let Some(message) = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                return Err(ProviderError::Remote(message.to_owned()));
            }
            let data = value
                .get("data")
                .and_then(Value::as_array)
                .ok_or(ProviderError::InvalidEmbeddingResponse)?;
            let mut generated = vec![None; missing.len()];
            for item in data {
                let index = item
                    .get("index")
                    .and_then(Value::as_u64)
                    .and_then(|index| usize::try_from(index).ok())
                    .filter(|index| *index < generated.len())
                    .ok_or(ProviderError::InvalidEmbeddingResponse)?;
                let embedding = item
                    .get("embedding")
                    .and_then(Value::as_array)
                    .ok_or(ProviderError::InvalidEmbeddingResponse)?
                    .iter()
                    .map(|value| {
                        value
                            .as_f64()
                            .filter(|value| value.is_finite())
                            .ok_or(ProviderError::InvalidEmbeddingResponse)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if embedding.is_empty() || generated[index].replace(embedding).is_some() {
                    return Err(ProviderError::InvalidEmbeddingResponse);
                }
            }
            let generated = generated
                .into_iter()
                .collect::<Option<Vec<_>>>()
                .ok_or(ProviderError::InvalidEmbeddingResponse)?;
            let dimension = generated[0].len();
            if generated
                .iter()
                .any(|embedding| embedding.len() != dimension)
            {
                return Err(ProviderError::InvalidEmbeddingResponse);
            }
            let mut cache = self.embedding_cache.lock().unwrap();
            for (text, embedding) in missing.into_iter().zip(generated) {
                cache.insert(text, embedding);
            }
        }
        let embeddings = {
            let cache = self.embedding_cache.lock().unwrap();
            input
                .iter()
                .map(|text| cache.get(text).cloned())
                .collect::<Option<Vec<_>>>()
                .ok_or(ProviderError::InvalidEmbeddingResponse)?
        };
        let query_embedding = embeddings
            .last()
            .ok_or(ProviderError::InvalidEmbeddingResponse)?;
        if embeddings
            .iter()
            .any(|embedding| embedding.len() != query_embedding.len())
        {
            return Err(ProviderError::InvalidEmbeddingResponse);
        }
        let mut ranked = candidates
            .iter()
            .zip(&embeddings[..candidates.len()])
            .map(|(candidate, embedding)| {
                let score = embedding
                    .iter()
                    .zip(query_embedding)
                    .map(|(left, right)| left * right)
                    .sum::<f64>();
                (candidate.clone(), score)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
        Ok(ranked.into_iter().take(top_k).collect())
    }
}

pub struct ChatService {
    runtime: Runtime,
    provider: Arc<dyn ChatProvider>,
}

#[derive(Clone, Debug)]
pub struct RequestCancellation {
    abort_handle: tokio::task::AbortHandle,
}

impl RequestCancellation {
    pub fn cancel(&self) {
        self.abort_handle.abort();
    }
}

pub struct ProviderRun<T> {
    receiver: Receiver<T>,
    cancellation: RequestCancellation,
}

impl<T> ProviderRun<T> {
    pub async fn recv(&self) -> Result<T, async_channel::RecvError> {
        self.receiver.recv().await
    }

    #[cfg(test)]
    pub fn recv_blocking(&self) -> Result<T, async_channel::RecvError> {
        self.receiver.recv_blocking()
    }

    pub fn cancellation(&self) -> RequestCancellation {
        self.cancellation.clone()
    }
}

impl ChatService {
    pub fn from_environment() -> Result<Option<Self>, ProviderError> {
        let Some(config) = ProviderConfig::from_environment()? else {
            return Ok(None);
        };
        let provider = Arc::new(NativeProvider::new(config)?);
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(ProviderError::Runtime)?;
        Ok(Some(Self { runtime, provider }))
    }

    pub fn from_settings(
        settings: &ProviderSettings,
        api_key: Option<Zeroizing<String>>,
    ) -> Result<Self, ProviderError> {
        let provider = Arc::new(NativeProvider::new(ProviderConfig::from_settings(
            settings, api_key,
        )?)?);
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(ProviderError::Runtime)?;
        Ok(Self { runtime, provider })
    }

    pub fn model(&self) -> &str {
        self.provider.model()
    }

    pub fn memory_mode(&self) -> MemoryMode {
        self.provider.memory_mode()
    }

    pub fn prepare_character(
        &self,
        character: Character,
    ) -> ProviderRun<Result<PreparedChat, String>> {
        let (sender, receiver) = async_channel::bounded(1);
        let provider = Arc::clone(&self.provider);
        let task = self.runtime.spawn(async move {
            let result = prepare_character(provider.as_ref(), character)
                .await
                .map_err(|error| error.to_string());
            let _ = sender.send(result).await;
        });
        ProviderRun {
            receiver,
            cancellation: RequestCancellation {
                abort_handle: task.abort_handle(),
            },
        }
    }

    pub fn start(&self, messages: Vec<ChatInput>) -> ProviderRun<ProviderEvent> {
        let (sender, receiver) = async_channel::bounded(64);
        let provider = Arc::clone(&self.provider);
        let task = self.runtime.spawn(async move {
            match provider.stream_chat(messages, &sender).await {
                Ok(()) => {
                    let _ = sender.send(ProviderEvent::Finished).await;
                }
                Err(error) => {
                    let _ = sender.send(ProviderEvent::Failed(error.to_string())).await;
                }
            }
        });
        ProviderRun {
            receiver,
            cancellation: RequestCancellation {
                abort_handle: task.abort_handle(),
            },
        }
    }
}

async fn prepare_character(
    provider: &dyn ChatProvider,
    mut character: Character,
) -> Result<PreparedChat, ProviderError> {
    if !character.supa_memory_enabled {
        return Ok(PreparedChat {
            messages: ChatInput::for_character(
                &character,
                provider.model(),
                provider.max_context_tokens(),
                provider.max_output_tokens(),
            )?,
            supa_memory_data: character.supa_memory_data,
            hypa_v2_data: character.hypa_v2_data,
            hypa_v3_data: character.hypa_v3_data,
        });
    }
    match provider.memory_mode() {
        MemoryMode::Hypa => return prepare_hypa_character(provider, character).await,
        MemoryMode::HypaV2 => return prepare_hypa_v2_character(provider, character).await,
        MemoryMode::HypaV3 => return prepare_hypa_v3_character(provider, character).await,
        MemoryMode::Supa => {}
    }

    let state = SupaMemoryState::parse(character.supa_memory_data.as_deref())?;
    let restored = restore_memory(character.supa_memory_data.as_deref(), &character.messages)?;
    character.messages = restored.messages;
    let mut summary = restored.summary;
    let mut checkpoint_id = state.map(|state| state.checkpoint_id);
    let max_chunk_tokens = (provider.max_context_tokens() / 3).clamp(1, 1_200);

    loop {
        let fitted = ChatInput::for_character_with_memory(
            &character,
            summary.as_deref(),
            provider.model(),
            provider.max_context_tokens(),
            provider.max_output_tokens(),
        )?;
        if fitted.removed_count == 0 {
            let supa_memory_data = match (checkpoint_id, summary) {
                (Some(checkpoint_id), Some(summary)) => Some(
                    SupaMemoryState {
                        checkpoint_id,
                        summary,
                    }
                    .serialize(),
                ),
                _ => None,
            };
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data,
                hypa_v2_data: character.hypa_v2_data.clone(),
                hypa_v3_data: character.hypa_v3_data.clone(),
            });
        }

        let Some(chunk) = plan_summary_chunk(
            &character.messages,
            max_chunk_tokens,
            provider.model(),
            &character.name,
        )?
        else {
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data: match (checkpoint_id, summary) {
                    (Some(checkpoint_id), Some(summary)) => Some(
                        SupaMemoryState {
                            checkpoint_id,
                            summary,
                        }
                        .serialize(),
                    ),
                    _ => None,
                },
                hypa_v2_data: character.hypa_v2_data.clone(),
                hypa_v3_data: character.hypa_v3_data.clone(),
            });
        };
        let updated_summary = provider
            .summarize(summary.as_deref(), &chunk.input, &character.name)
            .await?;
        character.messages.drain(..chunk.removed_count);
        checkpoint_id = Some(chunk.checkpoint_id);
        summary = Some(updated_summary);
    }
}

async fn prepare_hypa_v3_character(
    provider: &dyn ChatProvider,
    character: Character,
) -> Result<PreparedChat, ProviderError> {
    let settings = provider.hypa_v3_settings();
    let mut state = character.hypa_v3_data.clone().unwrap_or_default();
    state.clean(&character.messages, settings.preserve_orphaned_memory);
    let empty_memory = wrap_hypa_v3_memory("");

    if state.summaries.is_empty() {
        let fitted = ChatInput::for_character_with_memory(
            &character,
            Some(&empty_memory),
            provider.model(),
            provider.max_context_tokens(),
            provider.max_output_tokens(),
        )?;
        if fitted.removed_count == 0 {
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data: character.supa_memory_data,
                hypa_v2_data: character.hypa_v2_data,
                hypa_v3_data: Some(state),
            });
        }
    }

    let memory_tokens = provider
        .max_context_tokens()
        .saturating_mul(settings.memory_ratio_bps as usize)
        / 10_000;
    let effective_context = provider
        .max_context_tokens()
        .checked_sub(memory_tokens)
        .filter(|limit| *limit > provider.max_output_tokens())
        .ok_or(ProviderError::HypaV3MemoryBudgetExceedsContext)?;
    let target_total = provider
        .max_context_tokens()
        .saturating_mul(10_000 - settings.extra_summarization_ratio_bps as usize)
        / 10_000;
    let target_context = target_total
        .checked_sub(memory_tokens)
        .filter(|limit| *limit > provider.max_output_tokens())
        .unwrap_or(effective_context);
    let mut index = state.next_message_index(&character.messages);
    let mut remaining = character.clone();
    remaining.messages = character.messages[index..].to_vec();
    let initial_probe = ChatInput::for_character_with_memory(
        &remaining,
        None,
        provider.model(),
        effective_context,
        provider.max_output_tokens(),
    )?;
    let summarization_mode = initial_probe.removed_count != 0;

    if summarization_mode {
        loop {
            remaining.messages = character.messages[index..].to_vec();
            let probe = ChatInput::for_character_with_memory(
                &remaining,
                None,
                provider.model(),
                target_context,
                provider.max_output_tokens(),
            )?;
            if probe.removed_count == 0 {
                break;
            }

            let summarizable_end = character
                .messages
                .len()
                .saturating_sub(settings.query_message_count);
            if index >= summarizable_end {
                return Err(ProviderError::HypaV3CannotSummarize {
                    query_count: settings.query_message_count,
                });
            }
            let end = index
                .saturating_add(settings.max_messages_per_summary)
                .min(summarizable_end);
            let batch = &character.messages[index..end];
            let summarizable = batch
                .iter()
                .filter(|message| {
                    !message.content.trim().is_empty()
                        && !message.id.starts_with("virtual-first-message:")
                        && !(settings.do_not_summarize_user_messages && message.role == Role::User)
                })
                .collect::<Vec<_>>();
            index = end;
            if summarizable.is_empty() {
                continue;
            }
            let conversation = summarizable
                .iter()
                .map(|message| {
                    format!(
                        "{}: {}",
                        match message.role {
                            Role::User => "user",
                            Role::Character => "assistant",
                        },
                        inlay_tokens_as_placeholder(&message.content)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let summary = provider
                .summarize_v3(&conversation, &character.name, &settings.summary_prompt)
                .await?;
            state.summaries.push(HypaV3Summary {
                text: summary,
                chat_memos: summarizable
                    .into_iter()
                    .map(|message| message.id.clone())
                    .collect(),
                is_important: false,
                category_id: None,
                tags: Vec::new(),
            });
        }
    }

    remaining.messages = character.messages[index..].to_vec();
    let memory = build_hypa_v3_context(provider, &mut state, &character.messages).await?;
    let fitted = ChatInput::for_character_with_memory(
        &remaining,
        Some(&memory),
        provider.model(),
        provider.max_context_tokens(),
        provider.max_output_tokens(),
    )?;
    if fitted.removed_count != 0 {
        return Err(ProviderError::HypaV3MemoryBudgetExceedsContext);
    }
    Ok(PreparedChat {
        messages: fitted.messages,
        supa_memory_data: character.supa_memory_data,
        hypa_v2_data: character.hypa_v2_data,
        hypa_v3_data: Some(state),
    })
}

async fn build_hypa_v3_context(
    provider: &dyn ChatProvider,
    state: &mut HypaV3State,
    messages: &[Message],
) -> Result<String, ProviderError> {
    if state.summaries.is_empty() {
        state.metrics = None;
        return Ok(wrap_hypa_v3_memory(""));
    }
    let settings = provider.hypa_v3_settings();
    let memory_tokens = provider
        .max_context_tokens()
        .saturating_mul(settings.memory_ratio_bps as usize)
        / 10_000;
    let empty_tokens = chat_token_count(
        provider.model(),
        &[ChatInput {
            role: ProviderRole::System,
            content: wrap_hypa_v3_memory(""),
        }],
    );
    let mut available = memory_tokens
        .checked_sub(empty_tokens)
        .ok_or(ProviderError::HypaV3MemoryBudgetExceedsContext)?;
    let summary_tokens = state
        .summaries
        .iter()
        .map(|summary| {
            chat_token_count(
                provider.model(),
                &[ChatInput {
                    role: ProviderRole::System,
                    content: format!("{}\n\n", summary.text),
                }],
            )
        })
        .collect::<Vec<_>>();
    let mut selected = HashSet::<usize>::new();
    let mut important = Vec::new();
    for (index, summary) in state.summaries.iter().enumerate() {
        if !summary.is_important {
            continue;
        }
        if summary_tokens[index] > available {
            break;
        }
        selected.insert(index);
        important.push(index);
        available -= summary_tokens[index];
    }

    let recent_budget = available.saturating_mul(settings.recent_ratio_bps as usize) / 10_000;
    let mut recent_used = 0_usize;
    let mut recent = Vec::new();
    for index in (0..state.summaries.len()).rev() {
        if selected.contains(&index) {
            continue;
        }
        if recent_used.saturating_add(summary_tokens[index]) > recent_budget {
            break;
        }
        recent_used += summary_tokens[index];
        selected.insert(index);
        recent.push(index);
    }

    let random_ratio = 10_000_usize
        .saturating_sub(settings.recent_ratio_bps as usize)
        .saturating_sub(settings.similar_ratio_bps as usize);
    let mut similar_budget = available.saturating_mul(settings.similar_ratio_bps as usize) / 10_000;
    if random_ratio == 0 {
        similar_budget = similar_budget.saturating_add(recent_budget - recent_used);
    }
    let mut similar_used = 0_usize;
    let mut similar = Vec::new();
    if settings.similar_ratio_bps > 0 {
        let mut candidate_parents = Vec::new();
        let mut candidates = Vec::new();
        for (summary_index, summary) in state.summaries.iter().enumerate() {
            if selected.contains(&summary_index) {
                continue;
            }
            for chunk in split_hypa_v3_chunks(&summary.text, &settings.summary_chunk_separator) {
                candidate_parents.push(summary_index);
                candidates.push(chunk);
            }
        }
        let mut queries = messages
            .iter()
            .rev()
            .filter(|message| !message.content.trim().is_empty())
            .take(settings.query_message_count)
            .collect::<Vec<_>>();
        queries.reverse();
        let mut query_texts = queries
            .iter()
            .map(|message| inlay_tokens_as_placeholder(&message.content))
            .collect::<Vec<_>>();
        if settings.enable_similarity_correction && query_texts.len() > 1 {
            let correction_input = queries
                .iter()
                .map(|message| {
                    format!(
                        "{}: {}",
                        match message.role {
                            Role::User => "user",
                            Role::Character => "assistant",
                        },
                        inlay_tokens_as_placeholder(&message.content)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            query_texts.push(
                provider
                    .summarize_v3(&correction_input, "conversation", &settings.summary_prompt)
                    .await?,
            );
        }
        let total_weight = query_texts.len().saturating_mul(query_texts.len() + 1) / 2;
        let mut child_scores = HashMap::<usize, f64>::new();
        for (query_index, query) in query_texts.iter().enumerate() {
            let results = provider
                .retrieve_similar_scored(&candidates, query, candidates.len())
                .await?;
            let mut used_candidates = HashSet::new();
            let weight = (query_index + 1) as f64 / total_weight.max(1) as f64;
            for (text, score) in results {
                if let Some((index, _)) =
                    candidates.iter().enumerate().find(|(index, candidate)| {
                        !used_candidates.contains(index) && **candidate == text
                    })
                {
                    used_candidates.insert(index);
                    *child_scores.entry(index).or_default() += score * weight;
                }
            }
        }
        let mut ranked_children = child_scores.into_iter().collect::<Vec<_>>();
        ranked_children.sort_by(|left, right| right.1.total_cmp(&left.1));
        let mut parent_scores = HashMap::<usize, f64>::new();
        for (rank, (child, _)) in ranked_children.into_iter().enumerate() {
            *parent_scores.entry(candidate_parents[child]).or_default() +=
                1.0 / (60 + rank + 1) as f64;
        }
        let mut ranked_parents = parent_scores.into_iter().collect::<Vec<_>>();
        ranked_parents.sort_by(|left, right| right.1.total_cmp(&left.1));
        for (index, _) in ranked_parents {
            if similar_used.saturating_add(summary_tokens[index]) > similar_budget {
                break;
            }
            similar_used += summary_tokens[index];
            selected.insert(index);
            similar.push(index);
        }
    }

    let mut random_budget = available.saturating_mul(random_ratio) / 10_000;
    random_budget = random_budget
        .saturating_add(recent_budget - recent_used)
        .saturating_add(similar_budget - similar_used);
    let mut random_used = 0_usize;
    let mut random_candidates = (0..state.summaries.len())
        .filter(|index| !selected.contains(index))
        .map(|index| (uuid::Uuid::new_v4(), index))
        .collect::<Vec<_>>();
    random_candidates.sort_by_key(|(key, _)| *key);
    let mut random = Vec::new();
    for (_, index) in random_candidates {
        if random_used.saturating_add(summary_tokens[index]) > random_budget {
            continue;
        }
        random_used += summary_tokens[index];
        selected.insert(index);
        random.push(index);
    }

    let mut ordered = selected.into_iter().collect::<Vec<_>>();
    ordered.sort_unstable();
    let content = ordered
        .iter()
        .map(|index| state.summaries[*index].text.trim())
        .collect::<Vec<_>>()
        .join("\n\n");
    state.metrics = Some(HypaV3Metrics {
        last_important_summaries: important,
        last_recent_summaries: recent,
        last_similar_summaries: similar,
        last_random_summaries: random,
    });
    Ok(wrap_hypa_v3_memory(&content))
}

fn split_hypa_v3_chunks(text: &str, separator: &str) -> Vec<String> {
    let (pattern, flags) = separator
        .strip_prefix('/')
        .and_then(|value| value.rsplit_once('/'))
        .unwrap_or((separator, ""));
    let mut prefix = String::new();
    if flags.contains('i') {
        prefix.push('i');
    }
    if flags.contains('m') {
        prefix.push('m');
    }
    if flags.contains('s') {
        prefix.push('s');
    }
    let pattern = if prefix.is_empty() {
        pattern.to_owned()
    } else {
        format!("(?{prefix}){pattern}")
    };
    regex::Regex::new(&pattern)
        .map(|regex| regex.split(text).map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_else(|_| text.split("\n\n").map(str::to_owned).collect())
        .into_iter()
        .map(|chunk| chunk.trim().to_owned())
        .filter(|chunk| !chunk.is_empty())
        .collect()
}

fn wrap_hypa_v3_memory(content: &str) -> String {
    format!(
        "<Past Events Summary>\n{}\n</Past Events Summary>",
        content.trim()
    )
}

async fn prepare_hypa_v2_character(
    provider: &dyn ChatProvider,
    character: Character,
) -> Result<PreparedChat, ProviderError> {
    let mut state = character.hypa_v2_data.clone().unwrap_or_default();
    state.clean(&character.messages);
    let mut index = state
        .main_chunks
        .last()
        .and_then(|chunk| {
            character
                .messages
                .iter()
                .position(|message| message.id == chunk.last_chat_memo)
        })
        .map_or(0, |index| index + 1);
    let effective_context = provider
        .max_context_tokens()
        .checked_sub(provider.memory_allocated_tokens())
        .filter(|limit| *limit > provider.max_output_tokens())
        .ok_or(ProviderError::MemoryBudgetExceedsContext)?;

    loop {
        let mut remaining_character = character.clone();
        remaining_character.messages = character.messages[index..].to_vec();
        let probe = ChatInput::for_character_with_memory(
            &remaining_character,
            None,
            provider.model(),
            effective_context,
            provider.max_output_tokens(),
        )?;
        if probe.removed_count == 0 {
            let context = build_hypa_v2_context(provider, &state, &character.messages).await?;
            let fitted = ChatInput::for_character_with_memory(
                &remaining_character,
                Some(&context),
                provider.model(),
                provider.max_context_tokens(),
                provider.max_output_tokens(),
            )?;
            if fitted.removed_count != 0 {
                return Err(ProviderError::MemoryBudgetExceedsContext);
            }
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data: character.supa_memory_data,
                hypa_v2_data: Some(state),
                hypa_v3_data: character.hypa_v3_data,
            });
        }

        let summarizable_end = character.messages.len().saturating_sub(4);
        if index >= summarizable_end {
            return Err(ProviderError::MemoryTailTooLarge);
        }
        let mut input = Vec::new();
        let mut chat_memos = Vec::new();
        let mut used_tokens = 0_usize;
        while index < summarizable_end {
            let message = &character.messages[index];
            if message.content.trim().is_empty() {
                index += 1;
                continue;
            }
            let rendered = format!(
                "{}: {}",
                match message.role {
                    Role::User => "user",
                    Role::Character => "assistant",
                },
                inlay_tokens_as_placeholder(&message.content)
            );
            let tokens = chat_token_count(
                provider.model(),
                &[ChatInput {
                    role: match message.role {
                        Role::User => ProviderRole::User,
                        Role::Character => ProviderRole::Assistant,
                    },
                    content: inlay_tokens_as_placeholder(&message.content),
                }],
            );
            if input.is_empty() && tokens > provider.memory_chunk_tokens() {
                return Err(ProviderError::MemoryChunkTooSmall {
                    required: tokens,
                    limit: provider.memory_chunk_tokens(),
                });
            }
            if !input.is_empty()
                && used_tokens.saturating_add(tokens) > provider.memory_chunk_tokens()
            {
                break;
            }
            used_tokens = used_tokens.saturating_add(tokens);
            input.push(rendered);
            chat_memos.push(message.id.clone());
            index += 1;
        }
        if input.is_empty() {
            return Err(ProviderError::MemoryTailTooLarge);
        }
        let summary = provider
            .summarize(None, &input.join("\n"), &character.name)
            .await?;
        state.last_main_chunk_id += 1;
        let main_chunk_id = state.last_main_chunk_id;
        state.main_chunks.push(HypaV2MainChunk {
            id: main_chunk_id,
            text: summary.clone(),
            last_chat_memo: chat_memos.last().cloned().unwrap_or_default(),
            chat_memos,
        });
        state.chunks.extend(
            summary
                .split("\n\n")
                .map(str::trim)
                .filter(|chunk| !chunk.is_empty())
                .map(|text| HypaV2Chunk {
                    main_chunk_id,
                    text: text.to_owned(),
                }),
        );
    }
}

async fn build_hypa_v2_context(
    provider: &dyn ChatProvider,
    state: &HypaV2State,
    messages: &[Message],
) -> Result<String, ProviderError> {
    let allocated = provider.memory_allocated_tokens();
    let mut main_prompt = String::new();
    let mut main_tokens = 0_usize;
    for chunk in &state.main_chunks {
        let tokens = chat_token_count(
            provider.model(),
            &[ChatInput {
                role: ProviderRole::System,
                content: chunk.text.clone(),
            }],
        );
        if main_tokens.saturating_add(tokens) > allocated / 2 {
            break;
        }
        if !main_prompt.is_empty() {
            main_prompt.push_str("\n\n");
        }
        main_prompt.push_str(&chunk.text);
        main_tokens = main_tokens.saturating_add(tokens);
    }

    const DOCUMENT_PREFIX: &str = "search_document: ";
    let candidates = state
        .chunks
        .iter()
        .map(|chunk| chunk.text.trim())
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| format!("{DOCUMENT_PREFIX}{chunk}"))
        .collect::<Vec<_>>();
    let mut scores = HashMap::<String, f64>::new();
    for (distance, message) in messages.iter().rev().take(3).enumerate() {
        let query = format!(
            "search_query: {}",
            inlay_tokens_as_placeholder(&message.content)
        );
        for (text, score) in provider
            .retrieve_similar_scored(&candidates, &query, candidates.len())
            .await?
        {
            *scores.entry(text).or_default() += score / (distance + 1) as f64;
        }
    }
    let mut ranked = scores.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
    let mut details = String::new();
    let mut detail_tokens = 0_usize;
    for (text, _) in ranked {
        let content = text.strip_prefix(DOCUMENT_PREFIX).unwrap_or(&text);
        let tokens = chat_token_count(
            provider.model(),
            &[ChatInput {
                role: ProviderRole::System,
                content: content.to_owned(),
            }],
        );
        if main_tokens
            .saturating_add(detail_tokens)
            .saturating_add(tokens)
            > allocated
        {
            break;
        }
        details.push_str(content);
        details.push_str("\n\n");
        detail_tokens = detail_tokens.saturating_add(tokens);
    }
    Ok(format!(
        "<Past Events Summary>{main_prompt}</Past Events Summary>\n<Past Events Details>{details}</Past Events Details>"
    ))
}

async fn prepare_hypa_character(
    provider: &dyn ChatProvider,
    mut character: Character,
) -> Result<PreparedChat, ProviderError> {
    let original_data = character.supa_memory_data.clone();
    let mut state = if original_data
        .as_deref()
        .is_some_and(|data| data.starts_with("hypa:"))
    {
        Some(HypaMemoryState::parse(
            original_data.as_deref().unwrap_or_default(),
        )?)
    } else {
        None
    };
    let (mut summary, mut retrieval_chunks) = if let Some(state) = &state {
        let restored = restore_hypa_memory(state, &character.messages)?;
        character.messages = restored.messages;
        (Some(restored.summary), restored.retrieval_chunks)
    } else {
        (None, Vec::new())
    };
    let max_chunk_tokens = (provider.max_context_tokens() / 3).clamp(1, 1_200);
    let mut changed = false;

    loop {
        let query = render_memory_query(&character.messages, &character.name);
        let candidates = unique_retrieval_chunks(&retrieval_chunks, summary.as_deref());
        let retrieved = provider
            .retrieve_similar_scored(&candidates, &query, 3)
            .await?
            .into_iter()
            .map(|(text, _)| text)
            .collect::<Vec<_>>();
        let memory_context = render_hypa_context(summary.as_deref(), &retrieved);
        let fitted = ChatInput::for_character_with_memory(
            &character,
            memory_context.as_deref(),
            provider.model(),
            provider.max_context_tokens(),
            provider.max_output_tokens(),
        )?;
        if fitted.removed_count == 0 {
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data: if changed {
                    state.as_ref().map(HypaMemoryState::serialize).transpose()?
                } else {
                    original_data
                },
                hypa_v2_data: character.hypa_v2_data.clone(),
                hypa_v3_data: character.hypa_v3_data.clone(),
            });
        }

        let Some(chunk) = plan_summary_chunk(
            &character.messages,
            max_chunk_tokens,
            provider.model(),
            &character.name,
        )?
        else {
            return Ok(PreparedChat {
                messages: fitted.messages,
                supa_memory_data: if changed {
                    state.as_ref().map(HypaMemoryState::serialize).transpose()?
                } else {
                    original_data
                },
                hypa_v2_data: character.hypa_v2_data.clone(),
                hypa_v3_data: character.hypa_v3_data.clone(),
            });
        };
        let updated_summary = provider
            .summarize(summary.as_deref(), &chunk.input, &character.name)
            .await?;
        character.messages.drain(..chunk.removed_count);
        if !retrieval_chunks.contains(&updated_summary) {
            retrieval_chunks.push(updated_summary.clone());
        }
        summary = Some(updated_summary.clone());
        let entry = HypaMemoryEntry {
            id: chunk.checkpoint_id,
            supa: updated_summary,
            hypa: retrieval_chunks.clone(),
        };
        let state = state.get_or_insert_with(|| HypaMemoryState {
            entries: Vec::new(),
        });
        if state
            .entries
            .first()
            .is_some_and(|current| current.id == entry.id)
        {
            state.entries[0] = entry;
        } else {
            state.entries.insert(0, entry);
        }
        changed = true;
    }
}

fn render_memory_query(messages: &[Message], character_name: &str) -> String {
    messages
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .take(4)
        .map(|message| {
            format!(
                "{}: {}",
                match message.role {
                    Role::User => "User",
                    Role::Character => character_name,
                },
                inlay_tokens_as_placeholder(&message.content)
                    .trim()
                    .to_owned()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn unique_retrieval_chunks(chunks: &[String], summary: Option<&str>) -> Vec<String> {
    let normalized_summary = summary.map(normalize_retrieval_text).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    chunks
        .iter()
        .filter_map(|chunk| {
            let chunk = chunk.trim();
            let normalized = normalize_retrieval_text(chunk);
            (!chunk.is_empty()
                && !normalized.is_empty()
                && !normalized_summary.contains(&normalized)
                && seen.insert(normalized))
            .then(|| chunk.to_owned())
        })
        .collect()
}

fn normalize_retrieval_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric() || character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn render_hypa_context(summary: Option<&str>, retrieved: &[String]) -> Option<String> {
    let mut context = summary
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_owned)
        .unwrap_or_default();
    if !retrieved.is_empty() {
        if !context.is_empty() {
            context.push_str("\n\n");
        }
        context.push_str("Relevant past events:\n");
        context.push_str(&retrieved.join("\n\n"));
    }
    (!context.is_empty()).then_some(context)
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, ProviderError> {
        self.buffer.extend_from_slice(chunk);
        self.drain_complete_frames()
    }

    fn finish(mut self) -> Result<Vec<String>, ProviderError> {
        let mut frames = self.drain_complete_frames()?;
        if !self.buffer.is_empty() {
            frames.extend(parse_sse_frame(&self.buffer)?);
            self.buffer.clear();
        }
        Ok(frames)
    }

    fn drain_complete_frames(&mut self) -> Result<Vec<String>, ProviderError> {
        let mut output = Vec::new();
        while let Some((position, delimiter_len)) = find_frame_boundary(&self.buffer) {
            let frame = self.buffer[..position].to_vec();
            self.buffer.drain(..position + delimiter_len);
            output.extend(parse_sse_frame(&frame)?);
        }
        Ok(output)
    }
}

fn find_frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(position), None) => Some((position, 2)),
        (None, Some(position)) => Some((position, 4)),
        (None, None) => None,
    }
}

fn parse_sse_frame(frame: &[u8]) -> Result<Vec<String>, ProviderError> {
    let frame = std::str::from_utf8(frame)?;
    let data = frame
        .lines()
        .filter_map(|line| {
            line.strip_suffix('\r')
                .unwrap_or(line)
                .strip_prefix("data:")
        })
        .map(|value| value.strip_prefix(' ').unwrap_or(value))
        .collect::<Vec<_>>();
    if data.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(vec![data.join("\n")])
    }
}

#[derive(Default)]
struct ProviderStreamState {
    received_text: bool,
    thinking: bool,
}

async fn handle_provider_data_event(
    provider_kind: ProviderKind,
    data: &str,
    sender: &Sender<ProviderEvent>,
    state: &mut ProviderStreamState,
) -> Result<bool, ProviderError> {
    if data == "[DONE]" {
        close_stream_thinking(sender, state).await;
        return if state.received_text {
            Ok(true)
        } else {
            Err(ProviderError::EmptyResponse)
        };
    }
    let value: Value = serde_json::from_str(data)?;
    if let Some(message) = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        return Err(ProviderError::Remote(message.to_owned()));
    }
    match provider_kind {
        ProviderKind::OpenAiCompatible => {
            if let Some(delta) = value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                && emit_stream_part(sender, state, delta, false).await
            {
                return Ok(true);
            }
        }
        ProviderKind::Anthropic => {
            let event_type = value.get("type").and_then(Value::as_str);
            if event_type == Some("message_stop") {
                close_stream_thinking(sender, state).await;
                return if state.received_text {
                    Ok(true)
                } else {
                    Err(ProviderError::EmptyResponse)
                };
            }
            let block = match event_type {
                Some("content_block_start") => value.get("content_block"),
                Some("content_block_delta") => value.get("delta"),
                _ => None,
            };
            if let Some(block) = block {
                let block_type = block.get("type").and_then(Value::as_str);
                let (text, is_thinking) = match block_type {
                    Some("text") | Some("text_delta") => {
                        (block.get("text").and_then(Value::as_str), false)
                    }
                    Some("thinking") | Some("thinking_delta") => {
                        (block.get("thinking").and_then(Value::as_str), true)
                    }
                    Some("redacted_thinking") => (Some("{{redacted_thinking}}"), true),
                    _ => (None, false),
                };
                if let Some(text) = text
                    && emit_stream_part(sender, state, text, is_thinking).await
                {
                    return Ok(true);
                }
            }
        }
        ProviderKind::Gemini => {
            if let Some(parts) = value
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
                    let is_thinking = part
                        .get("thought")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if emit_stream_part(sender, state, text, is_thinking).await {
                        return Ok(true);
                    }
                }
            }
            if value
                .pointer("/candidates/0/finishReason")
                .is_some_and(|reason| !reason.is_null())
            {
                close_stream_thinking(sender, state).await;
                return if state.received_text {
                    Ok(true)
                } else {
                    Err(ProviderError::EmptyResponse)
                };
            }
        }
    }
    Ok(false)
}

async fn emit_stream_part(
    sender: &Sender<ProviderEvent>,
    state: &mut ProviderStreamState,
    text: &str,
    is_thinking: bool,
) -> bool {
    if text.is_empty() {
        return false;
    }
    let mut delta = String::new();
    if is_thinking && !state.thinking {
        delta.push_str("<Thoughts>\n");
        state.thinking = true;
    } else if !is_thinking && state.thinking {
        delta.push_str("\n</Thoughts>\n\n");
        state.thinking = false;
    }
    delta.push_str(text);
    state.received_text = true;
    sender.send(ProviderEvent::Delta(delta)).await.is_err()
}

async fn close_stream_thinking(sender: &Sender<ProviderEvent>, state: &mut ProviderStreamState) {
    if state.thinking {
        state.thinking = false;
        let _ = sender
            .send(ProviderEvent::Delta("\n</Thoughts>\n\n".into()))
            .await;
    }
}

fn non_empty_environment(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn environment_token_limit(name: &'static str, default: usize) -> Result<usize, ProviderError> {
    let Some(value) = non_empty_environment(name) else {
        return Ok(default);
    };
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(ProviderError::InvalidEnvironmentTokens { name })
}

fn render_basic_template(value: &str, character_name: &str, user_name: &str) -> String {
    value
        .replace("{{char}}", character_name)
        .replace("{{user}}", user_name)
}

fn strip_reasoning_blocks(value: &str) -> String {
    let mut result = value.to_owned();
    for tag in ["Thoughts", "think"] {
        let pattern = format!("(?is)<{tag}>.*?</{tag}>");
        if let Ok(regex) = regex::Regex::new(&pattern) {
            result = regex.replace_all(&result, "").into_owned();
        }
    }
    result.trim().to_owned()
}

fn truncate_error_body(body: &str) -> String {
    let mut end = body.len().min(MAX_ERROR_BODY_BYTES);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    body[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD as BASE64;

    use super::*;
    use crate::model::{AppState, LoreEntry};

    fn character_inputs(character: &Character) -> Vec<ChatInput> {
        ChatInput::for_character(character, "gpt-4o-mini", 1_000_000, 500).unwrap()
    }

    fn spawn_http_server(
        content_type: &'static str,
        response_body: &'static str,
    ) -> (std::net::SocketAddr, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 2048];
            let expected_len = loop {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or_default();
                    break header_end + 4 + content_length;
                }
            };
            while request.len() < expected_len {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending JSON body");
                request.extend_from_slice(&chunk[..read]);
            }
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len(),
            )
            .unwrap();
            request
        });
        (address, server)
    }

    fn provider_test_config(
        provider_kind: ProviderKind,
        endpoint: Url,
        non_stream_endpoint: Url,
    ) -> ProviderConfig {
        ProviderConfig {
            provider_kind,
            endpoint,
            non_stream_endpoint,
            embedding_endpoint: Url::parse("http://127.0.0.1:9/v1/embeddings").unwrap(),
            api_key: Some(Zeroizing::new("native-secret".into())),
            model: "native-model".into(),
            max_context_tokens: 8_000,
            max_output_tokens: 321,
            memory_mode: MemoryMode::Supa,
            embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
            memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
            memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
            hypa_v3: HypaV3Settings::default(),
        }
    }

    fn collect_stream(config: ProviderConfig, messages: Vec<ChatInput>) -> Result<String, String> {
        collect_stream_with_asset_store(config, messages, AssetStore::open_default().unwrap())
    }

    fn collect_stream_with_asset_store(
        config: ProviderConfig,
        messages: Vec<ChatInput>,
        asset_store: AssetStore,
    ) -> Result<String, String> {
        let provider = Arc::new(NativeProvider::new_with_asset_store(config, asset_store).unwrap());
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let service = ChatService { runtime, provider };
        let receiver = service.start(messages);
        let mut output = String::new();
        loop {
            match receiver.recv_blocking().unwrap() {
                ProviderEvent::Delta(delta) => output.push_str(&delta),
                ProviderEvent::Finished => return Ok(output),
                ProviderEvent::Failed(error) => return Err(error),
            }
        }
    }

    #[test]
    fn provider_run_cancellation_aborts_the_task_and_closes_its_channel() {
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (sender, receiver) = async_channel::bounded::<ProviderEvent>(1);
        let task = runtime.spawn(async move {
            let _sender = sender;
            std::future::pending::<()>().await;
        });
        let run = ProviderRun {
            receiver,
            cancellation: RequestCancellation {
                abort_handle: task.abort_handle(),
            },
        };

        run.cancellation().cancel();
        let result = runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(1), run.recv()).await
        });
        assert!(matches!(result, Ok(Err(_))));
    }

    #[test]
    fn chat_inputs_map_character_messages_to_assistant_role() {
        let message = Message {
            id: "one".into(),
            role: Role::Character,
            content: "hello".into(),
        };
        assert_eq!(
            ChatInput::from(&message),
            ChatInput {
                role: ProviderRole::Assistant,
                content: "hello".into(),
            }
        );
    }

    #[test]
    fn character_profile_is_assembled_around_chat_history() {
        let mut character = AppState::demo().characters.remove(0);
        character.name = "Mina".into();
        character.profile.system_prompt = "Act as {{char}}. {{original}}".into();
        character.profile.description = "{{char}} is thoughtful.".into();
        character.profile.personality = "Curious".into();
        character.profile.scenario = "Talking with {{user}}".into();
        character.profile.post_history_instructions = "Reply only as {{char}}".into();
        character.persona.name = "iris".into();
        character.persona.prompt = "{{user}} is a careful tester of {{char}}.".into();

        let inputs = character_inputs(&character);
        assert_eq!(inputs[0].role, ProviderRole::System);
        assert_eq!(inputs[0].content, "Act as Mina. ");
        assert_eq!(
            inputs[1].content,
            "Mina is thoughtful.\n\nDescription of Mina: Curious\n\nCircumstances and context of the dialogue: Talking with iris"
        );
        assert_eq!(inputs[2].content, "iris is a careful tester of Mina.");
        let live_chat_start = inputs
            .iter()
            .position(|input| input.content == "[Start a new chat]")
            .unwrap();
        assert_eq!(inputs[live_chat_start + 1].role, ProviderRole::Assistant);
        assert_eq!(inputs.last().unwrap().content, "Reply only as Mina");
    }

    #[test]
    fn character_example_messages_are_parsed_before_the_live_chat() {
        let mut character = AppState::demo().characters.remove(0);
        character.name = "Mina".into();
        character.persona.name = "iris".into();
        character.profile.example_message =
            "<START>\n{{user}}: Hello {{char}}\ncontinued\nMina: Hi {{user}}".into();

        let inputs = character_inputs(&character);
        let example_start = inputs
            .iter()
            .position(|input| input.content == "[Start a new chat]")
            .unwrap();
        assert_eq!(inputs[example_start + 1].role, ProviderRole::User);
        assert_eq!(inputs[example_start + 1].content, "Hello Mina\ncontinued");
        assert_eq!(inputs[example_start + 2].role, ProviderRole::Assistant);
        assert_eq!(inputs[example_start + 2].content, "Hi iris");
        assert_eq!(inputs[example_start + 3].content, "[Start a new chat]");
        assert_eq!(
            inputs[example_start + 4].content,
            character.messages[0].content
        );
    }

    #[test]
    fn active_lore_is_placed_around_description_and_at_chat_depth() {
        let mut character = AppState::demo().characters.remove(0);
        character.name = "Mina".into();
        character.profile.description = "Base description".into();
        character.messages.push(Message {
            id: "keyword".into(),
            role: Role::User,
            content: "A dragon appeared".into(),
        });
        let lore = |key: &str, content: &str, order: i64, always_active: bool| LoreEntry {
            source_index: None,
            id: None,
            key: key.into(),
            second_key: String::new(),
            insertion_order: order,
            name: format!("lore {order}"),
            content: content.into(),
            mode: "normal".into(),
            always_active,
            selective: false,
            use_regex: false,
            case_sensitive: false,
            activation_percent: None,
        };
        character.global_lore = vec![
            lore("", "@@position before_desc\nBefore {{char}}", 1, true),
            lore("dragon", "Dragon fact", 2, false),
            lore("", "@@depth 0\n@@role user\nDepth prompt", 3, true),
        ];
        character.module_lore = vec![lore("", "Module fact", 4, true)];

        let inputs = character_inputs(&character);
        let before = inputs
            .iter()
            .position(|input| input.content == "Before Mina")
            .unwrap();
        let description = inputs
            .iter()
            .position(|input| input.content == "Base description")
            .unwrap();
        let normal = inputs
            .iter()
            .position(|input| input.content == "Dragon fact")
            .unwrap();
        let keyword = inputs
            .iter()
            .position(|input| input.content == "A dragon appeared")
            .unwrap();
        let module = inputs
            .iter()
            .position(|input| input.content == "Module fact")
            .unwrap();
        let depth = inputs
            .iter()
            .position(|input| input.content == "Depth prompt")
            .unwrap();
        assert!(before < description);
        assert!(description < normal);
        assert!(normal < module);
        assert!(module < keyword);
        assert!(keyword < depth);
        assert_eq!(inputs[depth].role, ProviderRole::User);
    }

    #[test]
    fn context_budget_removes_only_old_chat_items_and_keeps_fixed_and_depth_prompts() {
        let prefix = vec![ChatInput {
            role: ProviderRole::System,
            content: "fixed profile".into(),
        }];
        let chat = vec![
            ChatInput {
                role: ProviderRole::Assistant,
                content: "very old greeting that should be removed".repeat(20),
            },
            ChatInput {
                role: ProviderRole::User,
                content: "old user message that should be removed".repeat(20),
            },
            ChatInput {
                role: ProviderRole::User,
                content: "newest user message".into(),
            },
        ];
        let depth_lore = vec![(
            0,
            ActiveLore {
                content: "fixed depth lore".into(),
                role: LoreRole::System,
                position: LorePosition::Depth(0),
                source: "depth test".into(),
                insertion_order: 100,
                token_count: 3,
            },
        )];
        let suffix = vec![ChatInput {
            role: ProviderRole::System,
            content: "fixed post-history instruction".into(),
        }];
        let expected = assemble_prompt(&prefix, &chat[2..], &depth_lore, &suffix, "Mina", "User");
        let output_tokens = 50;
        let exact_limit = chat_token_count("gpt-4o-mini", &expected) + output_tokens;

        let fitted = fit_context(
            prefix.clone(),
            chat,
            &depth_lore,
            suffix.clone(),
            ContextBudget {
                character_name: "Mina",
                user_name: "User",
                model: "gpt-4o-mini",
                max_context_tokens: exact_limit,
                max_output_tokens: output_tokens,
            },
        )
        .unwrap();
        assert_eq!(fitted.messages, expected);
        assert_eq!(fitted.removed_count, 2);
        assert!(
            fitted
                .messages
                .iter()
                .any(|input| input.content == "fixed profile")
        );
        assert!(
            fitted
                .messages
                .iter()
                .any(|input| input.content == "fixed depth lore")
        );
        assert!(
            fitted
                .messages
                .iter()
                .any(|input| input.content == "newest user message")
        );
        assert!(
            fitted
                .messages
                .iter()
                .all(|input| !input.content.contains("should be removed"))
        );

        assert!(matches!(
            fit_context(
                prefix,
                vec![ChatInput {
                    role: ProviderRole::User,
                    content: "newest user message".into(),
                }],
                &depth_lore,
                suffix,
                ContextBudget {
                    character_name: "Mina",
                    user_name: "User",
                    model: "gpt-4o-mini",
                    max_context_tokens: exact_limit - 1,
                    max_output_tokens: output_tokens,
                },
            ),
            Err(ProviderError::PromptTooLarge { .. })
        ));
    }

    #[test]
    fn custom_openai_compatible_models_use_the_fallback_tokenizer() {
        let messages = vec![ChatInput {
            role: ProviderRole::User,
            content: "custom model prompt".into(),
        }];
        let tokens = chat_token_count("local-model-without-tiktoken-mapping", &messages);
        assert!(tokens > 0);
        assert!(
            fit_context(
                Vec::new(),
                messages,
                &[],
                Vec::new(),
                ContextBudget {
                    character_name: "Mina",
                    user_name: "User",
                    model: "local-model-without-tiktoken-mapping",
                    max_context_tokens: tokens + 10,
                    max_output_tokens: 10,
                },
            )
            .is_ok()
        );
    }

    #[test]
    fn sse_decoder_handles_split_utf8_crlf_and_multiple_data_lines() {
        let bytes = "data: {\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}\r\n\r\ndata: first\ndata: second\n\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut decoder = SseDecoder::default();

        assert!(decoder.push(&bytes[..split]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&bytes[split..]).unwrap(),
            vec![
                "{\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}".to_owned(),
                "first\nsecond".to_owned(),
            ]
        );
    }

    #[test]
    fn incomplete_final_sse_frame_is_not_dropped() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: [DO").unwrap().is_empty());
        assert_eq!(decoder.finish().unwrap(), vec!["[DO".to_owned()]);
    }

    #[test]
    fn long_error_bodies_are_truncated_on_a_utf8_boundary() {
        let body = "가".repeat(2000);
        let truncated = truncate_error_body(&body);
        assert!(truncated.len() <= MAX_ERROR_BODY_BYTES);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn anthropic_body_separates_leading_system_and_merges_alternating_chat_roles() {
        let messages = vec![
            ChatInput {
                role: ProviderRole::System,
                content: "first system".into(),
            },
            ChatInput {
                role: ProviderRole::System,
                content: "second system".into(),
            },
            ChatInput {
                role: ProviderRole::Assistant,
                content: "first answer".into(),
            },
            ChatInput {
                role: ProviderRole::Assistant,
                content: "continued answer".into(),
            },
            ChatInput {
                role: ProviderRole::System,
                content: "late instruction".into(),
            },
            ChatInput {
                role: ProviderRole::User,
                content: "question".into(),
            },
        ];
        let body = anthropic_request_body("claude-test", &messages, 777, true);

        assert_eq!(body["model"], "claude-test");
        assert_eq!(body["system"], "first system\n\nsecond system");
        assert_eq!(body["max_tokens"], 777);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][0]["text"], "Start");
        assert_eq!(body["messages"][1]["role"], "assistant");
        assert_eq!(
            body["messages"][1]["content"][0]["text"],
            "first answer\n\ncontinued answer"
        );
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(
            body["messages"][2]["content"][0]["text"],
            "System: late instruction\n\nquestion"
        );
    }

    #[test]
    fn gemini_body_matches_original_system_and_role_formatting() {
        let messages = vec![
            ChatInput {
                role: ProviderRole::System,
                content: "first system".into(),
            },
            ChatInput {
                role: ProviderRole::System,
                content: "late system".into(),
            },
            ChatInput {
                role: ProviderRole::User,
                content: "question".into(),
            },
            ChatInput {
                role: ProviderRole::System,
                content: "after question".into(),
            },
            ChatInput {
                role: ProviderRole::Assistant,
                content: "answer".into(),
            },
            ChatInput {
                role: ProviderRole::Assistant,
                content: "continued answer".into(),
            },
        ];
        let body = gemini_request_body(&messages, 888);

        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            "first system"
        );
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 888);
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(
            body["contents"][0]["parts"][0]["text"],
            "system:late system"
        );
        assert_eq!(body["contents"][1]["role"], "user");
        assert_eq!(
            body["contents"][1]["parts"][0]["text"],
            "question\nsystem:after question"
        );
        assert_eq!(body["contents"][2]["role"], "model");
        assert_eq!(body["contents"][2]["parts"][0]["text"], "answer");
        assert_eq!(body["contents"][3]["role"], "model");
        assert_eq!(body["contents"][3]["parts"][0]["text"], "continued answer");
        assert!(body.get("model").is_none());
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn image_inlays_map_to_each_native_provider_multimodal_contract() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("image.bin");
        let png = BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        std::fs::write(&source, &png).unwrap();
        let asset_store = AssetStore::open(directory.path().join("assets")).unwrap();
        let image = asset_store.import_image(&source).unwrap();
        let messages = vec![
            ChatInput {
                role: ProviderRole::System,
                content: "system".into(),
            },
            ChatInput {
                role: ProviderRole::User,
                content: format!("look {{{{inlayed::{}}}}} now", image.id),
            },
        ];
        let expected_base64 = image.base64.clone();
        let expected_data_uri = format!("data:image/png;base64,{expected_base64}");

        let openai = provider_request_body_with_assets(
            ProviderKind::OpenAiCompatible,
            "vision-model",
            &messages,
            500,
            true,
            &asset_store,
        )
        .unwrap();
        assert_eq!(
            openai["messages"][1]["content"][0]["image_url"]["url"],
            expected_data_uri
        );
        assert_eq!(
            openai["messages"][1]["content"][0]["image_url"]["detail"],
            "auto"
        );
        assert_eq!(openai["messages"][1]["content"][1]["text"], "look  now");

        let anthropic = provider_request_body_with_assets(
            ProviderKind::Anthropic,
            "claude-vision",
            &messages,
            500,
            true,
            &asset_store,
        )
        .unwrap();
        assert_eq!(anthropic["system"], "system");
        assert_eq!(anthropic["messages"][0]["content"][0]["type"], "image");
        assert_eq!(
            anthropic["messages"][0]["content"][0]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            anthropic["messages"][0]["content"][0]["source"]["data"],
            expected_base64
        );
        assert_eq!(anthropic["messages"][0]["content"][1]["text"], "look  now");

        let gemini = provider_request_body_with_assets(
            ProviderKind::Gemini,
            "gemini-vision",
            &messages,
            500,
            true,
            &asset_store,
        )
        .unwrap();
        assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], "system");
        assert_eq!(gemini["contents"][0]["parts"][0]["text"], "look  now");
        assert_eq!(
            gemini["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "image/png"
        );
        assert_eq!(
            gemini["contents"][0]["parts"][1]["inlineData"]["data"],
            expected_base64
        );
    }

    #[test]
    fn stored_image_token_is_resolved_in_an_actual_streaming_http_request() {
        let response = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"vision ok\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (address, server) = spawn_http_server("text/event-stream", response);
        let endpoint = Url::parse(&format!("http://{address}/v1/chat/completions")).unwrap();
        let config =
            provider_test_config(ProviderKind::OpenAiCompatible, endpoint.clone(), endpoint);
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("image.png");
        let png = BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        std::fs::write(&source, png).unwrap();
        let asset_store = AssetStore::open(directory.path().join("assets")).unwrap();
        let image = asset_store.import_image(&source).unwrap();
        let output = collect_stream_with_asset_store(
            config,
            vec![ChatInput {
                role: ProviderRole::User,
                content: format!("describe {{{{inlayed::{}}}}}", image.id),
            }],
            asset_store,
        )
        .unwrap();
        assert_eq!(output, "vision ok");

        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["messages"][0]["content"][0]["type"], "image_url");
        assert!(
            body["messages"][0]["content"][0]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert_eq!(body["messages"][0]["content"][1]["text"], "describe ");
    }

    #[test]
    fn missing_or_excessive_request_images_fail_explicitly() {
        let directory = tempfile::tempdir().unwrap();
        let asset_store = AssetStore::open(directory.path()).unwrap();
        let missing_id = uuid::Uuid::new_v4();
        let missing = vec![ChatInput {
            role: ProviderRole::User,
            content: format!("{{{{inlayed::{missing_id}}}}}"),
        }];
        assert!(matches!(
            provider_request_body_with_assets(
                ProviderKind::OpenAiCompatible,
                "model",
                &missing,
                500,
                true,
                &asset_store,
            ),
            Err(ProviderError::Asset(AssetError::Missing(_)))
        ));

        let assistant_display_only = vec![ChatInput {
            role: ProviderRole::Assistant,
            content: "before {{inlayed::not-an-id}} after".into(),
        }];
        let body = provider_request_body_with_assets(
            ProviderKind::OpenAiCompatible,
            "model",
            &assistant_display_only,
            500,
            true,
            &asset_store,
        )
        .unwrap();
        assert_eq!(body["messages"][0]["content"], "before  after");

        let source = directory.path().join("image.png");
        let png = BASE64
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        std::fs::write(&source, png).unwrap();
        let image = asset_store.import_image(&source).unwrap();
        let excessive = vec![ChatInput {
            role: ProviderRole::User,
            content: (0..=MAX_IMAGES_PER_MESSAGE)
                .map(|_| format!("{{{{inlayed::{}}}}}", image.id))
                .collect::<String>(),
        }];
        assert!(matches!(
            provider_request_body_with_assets(
                ProviderKind::Gemini,
                "model",
                &excessive,
                500,
                true,
                &asset_store,
            ),
            Err(ProviderError::Asset(AssetError::TooManyImages { limit }))
                if limit == MAX_IMAGES_PER_MESSAGE
        ));
    }

    #[test]
    fn context_budget_reserves_vision_tokens_without_counting_uuid_markup_as_text() {
        let id = uuid::Uuid::new_v4();
        let plain = vec![ChatInput {
            role: ProviderRole::User,
            content: "look now".into(),
        }];
        let image = vec![ChatInput {
            role: ProviderRole::User,
            content: format!("look {{{{inlayed::{id}}}}} now"),
        }];
        let plain_tokens = chat_token_count("gpt-4o-mini", &plain);
        let image_tokens = chat_token_count("gpt-4o-mini", &image);
        assert!(image_tokens >= plain_tokens + 90);

        let display_only = vec![ChatInput {
            role: ProviderRole::Assistant,
            content: format!("{{{{inlayed::{id}}}}}"),
        }];
        let assistant_plain = vec![ChatInput {
            role: ProviderRole::Assistant,
            content: String::new(),
        }];
        assert_eq!(
            chat_token_count("gpt-4o-mini", &display_only),
            chat_token_count("gpt-4o-mini", &assistant_plain)
        );
    }

    #[test]
    fn native_response_extractors_preserve_reasoning_boundaries() {
        let anthropic = serde_json::json!({
            "content": [
                {"type": "thinking", "thinking": "reason"},
                {"type": "redacted_thinking"},
                {"type": "text", "text": "answer"}
            ]
        });
        assert_eq!(
            extract_provider_response_text(ProviderKind::Anthropic, &anthropic).unwrap(),
            "<Thoughts>\nreason{{redacted_thinking}}\n</Thoughts>\n\nanswer"
        );
        let gemini = serde_json::json!({
            "candidates": [{"content": {"parts": [
                {"thought": true, "text": "reason"},
                {"text": "answer"}
            ]}}]
        });
        assert_eq!(
            extract_provider_response_text(ProviderKind::Gemini, &gemini).unwrap(),
            "<Thoughts>\nreason\n</Thoughts>\n\nanswer"
        );
    }

    #[test]
    fn provider_endpoints_match_native_api_paths() {
        let (anthropic_stream, anthropic_non_stream) = provider_endpoints(
            ProviderKind::Anthropic,
            "https://api.anthropic.com/v1",
            "claude-test",
        )
        .unwrap();
        assert_eq!(
            anthropic_stream.as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(anthropic_stream, anthropic_non_stream);

        let (gemini_stream, gemini_non_stream) = provider_endpoints(
            ProviderKind::Gemini,
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-test",
        )
        .unwrap();
        assert_eq!(
            gemini_stream.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            gemini_non_stream.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
        );
    }

    #[test]
    fn anthropic_stream_uses_native_headers_body_and_reasoning_events() {
        let response = concat!(
            "data: {\"type\":\"message_start\"}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reason\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"native claude\"}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let (address, server) = spawn_http_server("text/event-stream", response);
        let endpoint = Url::parse(&format!("http://{address}/v1/messages")).unwrap();
        let config = provider_test_config(ProviderKind::Anthropic, endpoint.clone(), endpoint);
        let output = collect_stream(
            config,
            vec![
                ChatInput {
                    role: ProviderRole::System,
                    content: "be helpful".into(),
                },
                ChatInput {
                    role: ProviderRole::User,
                    content: "hello".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(output, "<Thoughts>\nreason\n</Thoughts>\n\nnative claude");

        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/messages http/1.1"));
        assert!(headers.contains("x-api-key: native-secret"));
        assert!(headers.contains("anthropic-version: 2023-06-01"));
        assert!(!headers.contains("authorization:"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "native-model");
        assert_eq!(body["system"], "be helpful");
        assert_eq!(body["messages"][0]["content"][0]["text"], "hello");
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn gemini_stream_uses_native_header_path_body_and_thought_parts() {
        let response = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"thought\":true,\"text\":\"reason\"}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"native \"}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini\"}]},\"finishReason\":\"STOP\"}]}\n\n"
        );
        let (address, server) = spawn_http_server("text/event-stream", response);
        let base = format!("http://{address}/v1beta");
        let (endpoint, non_stream_endpoint) =
            provider_endpoints(ProviderKind::Gemini, &base, "native-model").unwrap();
        let config = provider_test_config(ProviderKind::Gemini, endpoint, non_stream_endpoint);
        let output = collect_stream(
            config,
            vec![
                ChatInput {
                    role: ProviderRole::System,
                    content: "be helpful".into(),
                },
                ChatInput {
                    role: ProviderRole::User,
                    content: "hello".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(output, "<Thoughts>\nreason\n</Thoughts>\n\nnative gemini");

        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with(
            "post /v1beta/models/native-model:streamgeneratecontent?alt=sse http/1.1"
        ));
        assert!(headers.contains("x-goog-api-key: native-secret"));
        assert!(!headers.contains("authorization:"));
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be helpful");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 321);
    }

    #[test]
    fn anthropic_non_stream_summary_uses_messages_response_and_removes_reasoning() {
        let response = concat!(
            "{\"content\":[",
            "{\"type\":\"thinking\",\"thinking\":\"private reason\"},",
            "{\"type\":\"text\",\"text\":\"anthropic summary\"}]}"
        );
        let (address, server) = spawn_http_server("application/json", response);
        let endpoint = Url::parse(&format!("http://{address}/v1/messages")).unwrap();
        let provider = NativeProvider::new(provider_test_config(
            ProviderKind::Anthropic,
            endpoint.clone(),
            endpoint,
        ))
        .unwrap();
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        assert_eq!(
            runtime
                .block_on(provider.summarize(None, "User: event", "Mina"))
                .unwrap(),
            "anthropic summary"
        );
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-api-key: native-secret")
        );
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["stream"], false);
        assert!(body["system"].as_str().unwrap().contains("Mina"));
    }

    #[test]
    fn gemini_non_stream_summary_uses_generate_content_response() {
        let response = concat!(
            "{\"candidates\":[{\"content\":{\"parts\":[",
            "{\"thought\":true,\"text\":\"private reason\"},",
            "{\"text\":\"gemini summary\"}]}}]}"
        );
        let (address, server) = spawn_http_server("application/json", response);
        let base = format!("http://{address}/v1beta");
        let (endpoint, non_stream_endpoint) =
            provider_endpoints(ProviderKind::Gemini, &base, "native-model").unwrap();
        let provider = NativeProvider::new(provider_test_config(
            ProviderKind::Gemini,
            endpoint,
            non_stream_endpoint,
        ))
        .unwrap();
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        assert_eq!(
            runtime
                .block_on(provider.summarize(None, "User: event", "Mina"))
                .unwrap(),
            "gemini summary"
        );
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .starts_with("post /v1beta/models/native-model:generatecontent http/1.1")
        );
        let body: Value = serde_json::from_str(body).unwrap();
        assert!(body.get("stream").is_none());
        assert!(
            body["systemInstruction"]["parts"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Mina")
        );
    }

    #[test]
    fn native_providers_reject_openai_only_embedding_retrieval() {
        for provider_kind in [ProviderKind::Anthropic, ProviderKind::Gemini] {
            let endpoint = Url::parse("http://127.0.0.1:9/native").unwrap();
            let provider = NativeProvider::new(provider_test_config(
                provider_kind,
                endpoint.clone(),
                endpoint,
            ))
            .unwrap();
            let runtime = RuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            assert!(matches!(
                runtime.block_on(provider.retrieve_similar_scored(
                    &["past event".into()],
                    "query",
                    1
                )),
                Err(ProviderError::EmbeddingUnavailable(kind)) if kind == provider_kind
            ));
        }
    }

    #[test]
    fn provider_settings_are_normalized_and_reject_secret_bearing_urls() {
        assert_eq!(
            validate_settings(
                "  https://example.test/v1///  ",
                ProviderKind::OpenAiCompatible,
                "  native-model  ",
                8_000,
                500,
                MemoryMode::Hypa,
                "  embedding-model  ",
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                Some("credential".into()),
            )
            .unwrap(),
            ProviderSettings {
                provider_kind: ProviderKind::OpenAiCompatible,
                base_url: "https://example.test/v1".into(),
                model: "native-model".into(),
                max_context_tokens: 8_000,
                max_output_tokens: 500,
                memory_mode: MemoryMode::Hypa,
                embedding_model: "embedding-model".into(),
                memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
                memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
                hypa_v3: HypaV3Settings::default(),
                credential_id: Some("credential".into()),
            }
        );
        assert!(matches!(
            validate_settings(
                "https://user:password@example.test/v1",
                ProviderKind::OpenAiCompatible,
                "model",
                8_000,
                500,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::UrlContainsCredentials)
        ));
        assert!(matches!(
            validate_settings(
                "https://example.test/v1?api_key=secret",
                ProviderKind::OpenAiCompatible,
                "model",
                8_000,
                500,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::UrlContainsQueryOrFragment)
        ));
        assert!(matches!(
            validate_settings(
                "file:///tmp/provider",
                ProviderKind::OpenAiCompatible,
                "model",
                8_000,
                500,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::UnsupportedScheme)
        ));
        assert!(matches!(
            validate_settings(
                "https://example.test/v1",
                ProviderKind::OpenAiCompatible,
                "model",
                0,
                500,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::InvalidContextTokens)
        ));
        assert!(matches!(
            validate_settings(
                "https://example.test/v1",
                ProviderKind::OpenAiCompatible,
                "model",
                8_000,
                0,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::InvalidOutputTokens)
        ));
        assert!(matches!(
            validate_settings(
                "https://example.test/v1",
                ProviderKind::OpenAiCompatible,
                "model",
                500,
                500,
                MemoryMode::Supa,
                DEFAULT_EMBEDDING_MODEL,
                DEFAULT_MEMORY_ALLOCATED_TOKENS,
                DEFAULT_MEMORY_CHUNK_TOKENS,
                HypaV3Settings::default(),
                None,
            ),
            Err(ProviderError::OutputExceedsContext)
        ));
    }

    struct SummaryProvider {
        conversations: Mutex<Vec<String>>,
        retrieval_queries: Mutex<Vec<(Vec<String>, String, usize)>>,
        retrieval_results: Vec<(String, f64)>,
        max_context_tokens: usize,
        max_output_tokens: usize,
        memory_mode: MemoryMode,
        memory_allocated_tokens: usize,
        memory_chunk_tokens: usize,
        hypa_v3: HypaV3Settings,
    }

    #[async_trait]
    impl ChatProvider for SummaryProvider {
        fn model(&self) -> &str {
            "gpt-4o-mini"
        }

        fn max_context_tokens(&self) -> usize {
            self.max_context_tokens
        }

        fn max_output_tokens(&self) -> usize {
            self.max_output_tokens
        }

        fn memory_mode(&self) -> MemoryMode {
            self.memory_mode
        }

        fn memory_allocated_tokens(&self) -> usize {
            self.memory_allocated_tokens
        }

        fn memory_chunk_tokens(&self) -> usize {
            self.memory_chunk_tokens
        }

        fn hypa_v3_settings(&self) -> HypaV3Settings {
            self.hypa_v3.clone()
        }

        async fn stream_chat(
            &self,
            _messages: Vec<ChatInput>,
            _sender: &Sender<ProviderEvent>,
        ) -> Result<(), ProviderError> {
            unreachable!("preparation test does not stream")
        }

        async fn summarize(
            &self,
            _existing_summary: Option<&str>,
            conversation: &str,
            _character_name: &str,
        ) -> Result<String, ProviderError> {
            self.conversations
                .lock()
                .unwrap()
                .push(conversation.to_owned());
            Ok("compact earlier events".into())
        }

        async fn retrieve_similar_scored(
            &self,
            candidates: &[String],
            query: &str,
            top_k: usize,
        ) -> Result<Vec<(String, f64)>, ProviderError> {
            self.retrieval_queries.lock().unwrap().push((
                candidates.to_vec(),
                query.to_owned(),
                top_k,
            ));
            Ok(self.retrieval_results.clone())
        }
    }

    #[test]
    fn supa_memory_summarizes_oldest_messages_and_returns_a_persistable_checkpoint() {
        let provider = SummaryProvider {
            conversations: Mutex::new(Vec::new()),
            retrieval_queries: Mutex::new(Vec::new()),
            retrieval_results: Vec::new(),
            max_context_tokens: 260,
            max_output_tokens: 40,
            memory_mode: MemoryMode::Supa,
            memory_allocated_tokens: 40,
            memory_chunk_tokens: 100,
            hypa_v3: HypaV3Settings::default(),
        };
        let mut character = AppState::demo().characters.remove(0);
        character.profile = Default::default();
        character.supa_memory_enabled = true;
        character.supa_memory_data = None;
        character.messages = vec![
            Message {
                id: "old-one".into(),
                role: Role::User,
                content: "first old detail ".repeat(80),
            },
            Message {
                id: "old-two".into(),
                role: Role::Character,
                content: "second old detail ".repeat(80),
            },
            Message {
                id: "latest".into(),
                role: Role::User,
                content: "current question".into(),
            },
        ];
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let prepared = runtime
            .block_on(prepare_character(&provider, character))
            .unwrap();

        assert_eq!(provider.conversations.lock().unwrap().len(), 2);
        assert_eq!(
            prepared.supa_memory_data.as_deref(),
            Some("latest\ncompact earlier events")
        );
        assert!(prepared.messages.iter().any(|message| {
            message
                .content
                .contains("[Summary of the earlier conversation]")
        }));
        assert!(
            prepared
                .messages
                .iter()
                .any(|message| message.content == "current question")
        );
        assert!(
            prepared
                .messages
                .iter()
                .all(|message| !message.content.contains("first old detail"))
        );
    }

    #[test]
    fn hypa_memory_restores_legacy_state_and_injects_retrieved_events() {
        let provider = SummaryProvider {
            conversations: Mutex::new(Vec::new()),
            retrieval_queries: Mutex::new(Vec::new()),
            retrieval_results: vec![("dragon promise".into(), 0.9)],
            max_context_tokens: 8_000,
            max_output_tokens: 100,
            memory_mode: MemoryMode::Hypa,
            memory_allocated_tokens: 100,
            memory_chunk_tokens: 100,
            hypa_v3: HypaV3Settings::default(),
        };
        let mut character = AppState::demo().characters.remove(0);
        character.profile = Default::default();
        character.supa_memory_enabled = true;
        character.messages = vec![
            Message {
                id: "before".into(),
                role: Role::User,
                content: "discarded history".into(),
            },
            Message {
                id: "checkpoint".into(),
                role: Role::Character,
                content: "retained answer".into(),
            },
            Message {
                id: "latest".into(),
                role: Role::User,
                content: "what did we promise?".into(),
            },
        ];
        let state = HypaMemoryState {
            entries: vec![HypaMemoryEntry {
                id: "checkpoint".into(),
                supa: "compact overview".into(),
                hypa: vec!["dragon promise".into(), "tea meeting".into()],
            }],
        }
        .serialize()
        .unwrap();
        character.supa_memory_data = Some(state.clone());
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let prepared = runtime
            .block_on(prepare_character(&provider, character))
            .unwrap();

        assert_eq!(prepared.supa_memory_data.as_deref(), Some(state.as_str()));
        assert!(prepared.messages.iter().any(|message| {
            message.content.contains("compact overview")
                && message.content.contains("Relevant past events")
                && message.content.contains("dragon promise")
        }));
        assert!(
            prepared
                .messages
                .iter()
                .all(|message| !message.content.contains("discarded history"))
        );
        let retrieval_queries = provider.retrieval_queries.lock().unwrap();
        assert_eq!(retrieval_queries.len(), 1);
        assert_eq!(
            retrieval_queries[0].0,
            vec!["dragon promise", "tea meeting"]
        );
        assert!(retrieval_queries[0].1.contains("retained answer"));
        assert_eq!(retrieval_queries[0].2, 3);
    }

    #[test]
    fn hypa_memory_overflow_creates_compatible_json_history() {
        let provider = SummaryProvider {
            conversations: Mutex::new(Vec::new()),
            retrieval_queries: Mutex::new(Vec::new()),
            retrieval_results: Vec::new(),
            max_context_tokens: 260,
            max_output_tokens: 40,
            memory_mode: MemoryMode::Hypa,
            memory_allocated_tokens: 40,
            memory_chunk_tokens: 100,
            hypa_v3: HypaV3Settings::default(),
        };
        let mut character = AppState::demo().characters.remove(0);
        character.profile = Default::default();
        character.supa_memory_enabled = true;
        character.supa_memory_data = None;
        character.messages = vec![
            Message {
                id: "old-one".into(),
                role: Role::User,
                content: "first old detail ".repeat(80),
            },
            Message {
                id: "old-two".into(),
                role: Role::Character,
                content: "second old detail ".repeat(80),
            },
            Message {
                id: "latest".into(),
                role: Role::User,
                content: "current question".into(),
            },
        ];
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let prepared = runtime
            .block_on(prepare_character(&provider, character))
            .unwrap();
        let state = HypaMemoryState::parse(prepared.supa_memory_data.as_deref().unwrap()).unwrap();

        assert_eq!(state.entries[0].id, "latest");
        assert_eq!(state.entries[0].supa, "compact earlier events");
        assert!(
            state.entries[0]
                .hypa
                .contains(&"compact earlier events".into())
        );
        assert!(state.entries.iter().any(|entry| entry.id == "old-two"));
    }

    #[test]
    fn hypa_v2_summarizes_a_prefix_preserves_four_messages_and_uses_three_queries() {
        let provider = SummaryProvider {
            conversations: Mutex::new(Vec::new()),
            retrieval_queries: Mutex::new(Vec::new()),
            retrieval_results: vec![("search_document: compact earlier events".into(), 0.8)],
            max_context_tokens: 180,
            max_output_tokens: 30,
            memory_mode: MemoryMode::HypaV2,
            memory_allocated_tokens: 60,
            memory_chunk_tokens: 100,
            hypa_v3: HypaV3Settings::default(),
        };
        let mut character = AppState::demo().characters.remove(0);
        character.profile = Default::default();
        character.supa_memory_enabled = true;
        character.supa_memory_data = Some("legacy supa data remains untouched".into());
        character.hypa_v2_data = None;
        character.messages = vec![
            Message {
                id: "old-one".into(),
                role: Role::User,
                content: "first old detail ".repeat(20),
            },
            Message {
                id: "old-two".into(),
                role: Role::Character,
                content: "second old detail ".repeat(20),
            },
            Message {
                id: "tail-one".into(),
                role: Role::User,
                content: "tail one".into(),
            },
            Message {
                id: "tail-two".into(),
                role: Role::Character,
                content: "tail two".into(),
            },
            Message {
                id: "tail-three".into(),
                role: Role::User,
                content: "tail three".into(),
            },
            Message {
                id: "tail-four".into(),
                role: Role::Character,
                content: "tail four".into(),
            },
        ];
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let prepared = runtime
            .block_on(prepare_character(&provider, character.clone()))
            .unwrap();
        let state = prepared.hypa_v2_data.clone().unwrap();

        assert_eq!(
            prepared.supa_memory_data.as_deref(),
            Some("legacy supa data remains untouched")
        );
        assert!(!state.main_chunks.is_empty());
        assert!(state.main_chunks.iter().all(|chunk| {
            chunk
                .chat_memos
                .iter()
                .all(|memo| !memo.starts_with("tail-"))
        }));
        for tail in ["tail one", "tail two", "tail three", "tail four"] {
            assert!(
                prepared
                    .messages
                    .iter()
                    .any(|message| message.content == tail)
            );
        }
        assert!(prepared.messages.iter().any(|message| {
            message.content.contains("<Past Events Summary>")
                && message.content.contains("<Past Events Details>")
                && message.content.contains("compact earlier events")
        }));
        assert!(
            prepared
                .messages
                .iter()
                .all(|message| !message.content.contains("first old detail"))
        );
        assert_eq!(provider.retrieval_queries.lock().unwrap().len(), 3);

        character.hypa_v2_data = Some(state);
        let summaries_before = provider.conversations.lock().unwrap().len();
        runtime
            .block_on(prepare_character(&provider, character))
            .unwrap();
        assert_eq!(
            provider.conversations.lock().unwrap().len(),
            summaries_before
        );
    }

    #[test]
    fn hypa_v3_summarizes_prefix_selects_similar_memory_and_does_not_repeat_work() {
        let provider = SummaryProvider {
            conversations: Mutex::new(Vec::new()),
            retrieval_queries: Mutex::new(Vec::new()),
            retrieval_results: vec![("compact earlier events".into(), 0.9)],
            max_context_tokens: 180,
            max_output_tokens: 30,
            memory_mode: MemoryMode::HypaV3,
            memory_allocated_tokens: 60,
            memory_chunk_tokens: 100,
            hypa_v3: HypaV3Settings {
                memory_ratio_bps: 3_000,
                max_messages_per_summary: 2,
                recent_ratio_bps: 0,
                similar_ratio_bps: 10_000,
                query_message_count: 3,
                ..HypaV3Settings::default()
            },
        };
        let mut character = AppState::demo().characters.remove(0);
        character.profile = Default::default();
        character.supa_memory_enabled = true;
        character.hypa_v3_data = None;
        character.messages = vec![
            Message {
                id: "old-one".into(),
                role: Role::User,
                content: "first old detail ".repeat(20),
            },
            Message {
                id: "old-two".into(),
                role: Role::Character,
                content: "second old detail ".repeat(20),
            },
            Message {
                id: "tail-one".into(),
                role: Role::User,
                content: "tail one".into(),
            },
            Message {
                id: "tail-two".into(),
                role: Role::Character,
                content: "tail two".into(),
            },
            Message {
                id: "tail-three".into(),
                role: Role::User,
                content: "tail three".into(),
            },
        ];
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let prepared = runtime
            .block_on(prepare_character(&provider, character.clone()))
            .unwrap();
        let state = prepared.hypa_v3_data.clone().unwrap();
        assert_eq!(state.summaries.len(), 1);
        assert_eq!(state.summaries[0].chat_memos, vec!["old-one", "old-two"]);
        assert_eq!(
            state.metrics.as_ref().unwrap().last_similar_summaries,
            vec![0]
        );
        assert!(prepared.messages.iter().any(|message| {
            message.content.contains("<Past Events Summary>")
                && message.content.contains("compact earlier events")
        }));
        for tail in ["tail one", "tail two", "tail three"] {
            assert!(
                prepared
                    .messages
                    .iter()
                    .any(|message| message.content == tail)
            );
        }
        assert!(
            prepared
                .messages
                .iter()
                .all(|message| !message.content.contains("first old detail"))
        );
        assert_eq!(provider.retrieval_queries.lock().unwrap().len(), 3);

        character.hypa_v3_data = Some(state);
        let summaries_before = provider.conversations.lock().unwrap().len();
        runtime
            .block_on(prepare_character(&provider, character))
            .unwrap();
        assert_eq!(
            provider.conversations.lock().unwrap().len(),
            summaries_before
        );
    }

    #[test]
    fn secure_provider_summary_is_non_streaming_and_combines_previous_context() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 2048];
            let expected_len = loop {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break header_end + 4 + content_length;
                }
            };
            while request.len() < expected_len {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending JSON body");
                request.extend_from_slice(&chunk[..read]);
            }
            let body = r#"{"choices":[{"message":{"content":"updated compact summary"}}]}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            request
        });
        let provider = NativeProvider::new(ProviderConfig {
            provider_kind: ProviderKind::OpenAiCompatible,
            endpoint: Url::parse(&format!("http://{address}/v1/chat/completions")).unwrap(),
            non_stream_endpoint: Url::parse(&format!("http://{address}/v1/chat/completions"))
                .unwrap(),
            embedding_endpoint: Url::parse(&format!("http://{address}/v1/embeddings")).unwrap(),
            api_key: Some(Zeroizing::new("summary-secret".into())),
            model: "summary-model".into(),
            max_context_tokens: 8_000,
            max_output_tokens: 321,
            memory_mode: MemoryMode::Supa,
            embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
            memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
            memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
            hypa_v3: HypaV3Settings::default(),
        })
        .unwrap();
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        assert_eq!(
            runtime
                .block_on(provider.summarize(
                    Some("previous compact context"),
                    "User: newest event",
                    "Mina",
                ))
                .unwrap(),
            "updated compact summary"
        );
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer summary-secret")
        );
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 321);
        assert!(
            body["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("Mina")
        );
        let combined = body["messages"][1]["content"].as_str().unwrap();
        assert!(combined.contains("previous compact context"));
        assert!(combined.contains("User: newest event"));
    }

    #[test]
    fn embedding_request_uses_secure_endpoint_and_ranks_out_of_order_vectors() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 2048];
            let expected_len = loop {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break header_end + 4 + content_length;
                }
            };
            while request.len() < expected_len {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending JSON body");
                request.extend_from_slice(&chunk[..read]);
            }
            let body = concat!(
                "{\"data\":[",
                "{\"index\":2,\"embedding\":[0.2,0.9]},",
                "{\"index\":0,\"embedding\":[1.0,0.0]},",
                "{\"index\":1,\"embedding\":[0.0,1.0]}]}"
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            request
        });
        let provider = NativeProvider::new(ProviderConfig {
            provider_kind: ProviderKind::OpenAiCompatible,
            endpoint: Url::parse(&format!("http://{address}/v1/chat/completions")).unwrap(),
            non_stream_endpoint: Url::parse(&format!("http://{address}/v1/chat/completions"))
                .unwrap(),
            embedding_endpoint: Url::parse(&format!("http://{address}/v1/embeddings")).unwrap(),
            api_key: Some(Zeroizing::new("embedding-secret".into())),
            model: "chat-model".into(),
            max_context_tokens: 8_000,
            max_output_tokens: 321,
            memory_mode: MemoryMode::Hypa,
            embedding_model: "embedding-model".into(),
            memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
            memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
            hypa_v3: HypaV3Settings::default(),
        })
        .unwrap();
        let runtime = RuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let candidates = ["left event".into(), "right event".into()];
        assert_eq!(
            runtime
                .block_on(provider.retrieve_similar_scored(&candidates, "query", 2))
                .unwrap(),
            vec![("right event".into(), 0.9), ("left event".into(), 0.2)]
        );
        // The listener serves only one request; an identical lookup must use the cache.
        assert_eq!(
            runtime
                .block_on(provider.retrieve_similar_scored(&candidates, "query", 1))
                .unwrap(),
            vec![("right event".into(), 0.9)]
        );
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /v1/embeddings HTTP/1.1"));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer embedding-secret")
        );
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "embedding-model");
        assert_eq!(body["input"][0], "left event");
        assert_eq!(body["input"][1], "right event");
        assert_eq!(body["input"][2], "query");
    }

    #[test]
    fn openai_compatible_service_sends_history_and_streams_deltas() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 2048];
            let expected_len = loop {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending headers");
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break header_end + 4 + content_length;
                }
            };
            while request.len() < expected_len {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client closed before sending JSON body");
                request.extend_from_slice(&chunk[..read]);
            }

            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"native \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}]}\n\n",
                "data: [DONE]\n\n"
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            request
        });

        let config = ProviderConfig {
            provider_kind: ProviderKind::OpenAiCompatible,
            endpoint: Url::parse(&format!("http://{address}/v1/chat/completions")).unwrap(),
            non_stream_endpoint: Url::parse(&format!("http://{address}/v1/chat/completions"))
                .unwrap(),
            embedding_endpoint: Url::parse(&format!("http://{address}/v1/embeddings")).unwrap(),
            api_key: Some(Zeroizing::new("test-secret".into())),
            model: "test-model".into(),
            max_context_tokens: 8_000,
            max_output_tokens: 321,
            memory_mode: MemoryMode::Supa,
            embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
            memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
            memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
            hypa_v3: HypaV3Settings::default(),
        };
        let provider = Arc::new(NativeProvider::new(config).unwrap());
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let service = ChatService { runtime, provider };
        let receiver = service.start(vec![ChatInput {
            role: ProviderRole::User,
            content: "hello".into(),
        }]);
        let mut deltas = String::new();
        loop {
            match receiver.recv_blocking().unwrap() {
                ProviderEvent::Delta(delta) => deltas.push_str(&delta),
                ProviderEvent::Finished => break,
                ProviderEvent::Failed(error) => panic!("stream failed: {error}"),
            }
        }
        assert_eq!(deltas, "native stream");

        let request = String::from_utf8(server.join().unwrap()).unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("authorization: bearer test-secret")
        );
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 321);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hello");
    }
}
