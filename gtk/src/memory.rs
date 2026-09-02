use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;
use tiktoken_rs::{bpe_for_model, o200k_base_singleton};

use crate::model::{Message, Role};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupaMemoryState {
    pub checkpoint_id: String,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HypaMemoryEntry {
    pub id: String,
    pub supa: String,
    pub hypa: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HypaMemoryState {
    pub entries: Vec<HypaMemoryEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV2MainChunk {
    pub id: i64,
    pub text: String,
    #[serde(default)]
    pub chat_memos: Vec<String>,
    pub last_chat_memo: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV2Chunk {
    #[serde(rename = "mainChunkID")]
    pub main_chunk_id: i64,
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV2State {
    #[serde(rename = "lastMainChunkID")]
    pub last_main_chunk_id: i64,
    #[serde(default)]
    pub main_chunks: Vec<HypaV2MainChunk>,
    #[serde(default)]
    pub chunks: Vec<HypaV2Chunk>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV3Summary {
    pub text: String,
    #[serde(default, deserialize_with = "deserialize_hypa_v3_memos")]
    pub chat_memos: Vec<String>,
    #[serde(default)]
    pub is_important: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV3Metrics {
    #[serde(default)]
    pub last_important_summaries: Vec<usize>,
    #[serde(default)]
    pub last_recent_summaries: Vec<usize>,
    #[serde(default)]
    pub last_similar_summaries: Vec<usize>,
    #[serde(default)]
    pub last_random_summaries: Vec<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HypaV3Category {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HypaV3State {
    #[serde(default)]
    pub summaries: Vec<HypaV3Summary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<HypaV3Category>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<HypaV3Metrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modal_settings: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_selected_summaries: Option<Vec<usize>>,
}

fn deserialize_hypa_v3_memos<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<Option<String>>::deserialize(deserializer)
        .map(|memos| memos.into_iter().flatten().collect())
}

impl HypaV3State {
    pub fn from_json_value(
        value: serde_json::Value,
        messages: &[Message],
        preserve_orphaned: bool,
    ) -> Result<Self, MemoryError> {
        let mut state =
            serde_json::from_value::<Self>(value).map_err(|_| MemoryError::InvalidHypaV3State)?;
        state.clean(messages, preserve_orphaned);
        Ok(state)
    }

    pub fn clean(&mut self, messages: &[Message], preserve_orphaned: bool) {
        if !preserve_orphaned {
            let current = messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<HashSet<_>>();
            let original_len = self.summaries.len();
            self.summaries.retain(|summary| {
                summary
                    .chat_memos
                    .iter()
                    .all(|memo| current.contains(memo.as_str()))
            });
            if self.summaries.len() != original_len {
                self.metrics = None;
            }
        }
        self.last_selected_summaries = None;
    }

    pub fn next_message_index(&self, messages: &[Message]) -> usize {
        self.summaries
            .last()
            .and_then(|summary| summary.chat_memos.last())
            .and_then(|memo| messages.iter().position(|message| message.id == *memo))
            .map_or(0, |index| index + 1)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHypaV2State {
    #[serde(default)]
    main_chunks: Vec<LegacyHypaV2Chunk>,
    #[serde(default)]
    chunks: Vec<LegacyHypaV2Chunk>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyHypaV2Chunk {
    text: String,
    target_id: String,
}

impl HypaV2State {
    pub fn from_json_value(
        value: serde_json::Value,
        messages: &[Message],
    ) -> Result<Self, MemoryError> {
        if let Ok(mut state) = serde_json::from_value::<Self>(value.clone()) {
            state.clean(messages);
            return Ok(state);
        }
        let legacy = serde_json::from_value::<LegacyHypaV2State>(value)
            .map_err(|_| MemoryError::InvalidHypaV2State)?;
        let mut state = Self::from_legacy(legacy, messages);
        state.clean(messages);
        Ok(state)
    }

    pub fn clean(&mut self, messages: &[Message]) {
        let current = messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<HashSet<_>>();
        self.main_chunks.retain(|chunk| {
            !chunk.chat_memos.is_empty()
                && chunk
                    .chat_memos
                    .iter()
                    .all(|memo| current.contains(memo.as_str()))
                && current.contains(chunk.last_chat_memo.as_str())
        });
        let valid_ids = self
            .main_chunks
            .iter()
            .map(|chunk| chunk.id)
            .collect::<HashSet<_>>();
        self.chunks
            .retain(|chunk| valid_ids.contains(&chunk.main_chunk_id));
        self.last_main_chunk_id = self.main_chunks.last().map_or(0, |chunk| chunk.id);
    }

    fn from_legacy(legacy: LegacyHypaV2State, messages: &[Message]) -> Self {
        let old_main_chunks = legacy.main_chunks.into_iter().rev().collect::<Vec<_>>();
        let message_index = messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.as_str(), index))
            .collect::<std::collections::HashMap<_, _>>();
        let mut state = Self::default();
        let mut previous_target: Option<String> = None;
        for old in old_main_chunks {
            let Some(&end) = message_index.get(old.target_id.as_str()) else {
                continue;
            };
            let previous_index = previous_target
                .as_deref()
                .and_then(|target| message_index.get(target).copied())
                .unwrap_or(0);
            let start = previous_index.min(end);
            let end = previous_index.max(end);
            let chat_memos = messages[start..=end]
                .iter()
                .map(|message| message.id.clone())
                .collect::<Vec<_>>();
            state.last_main_chunk_id += 1;
            let id = state.last_main_chunk_id;
            state.main_chunks.push(HypaV2MainChunk {
                id,
                text: old.text,
                chat_memos,
                last_chat_memo: old.target_id.clone(),
            });
            state.chunks.extend(
                legacy
                    .chunks
                    .iter()
                    .filter(|chunk| chunk.target_id == old.target_id)
                    .map(|chunk| HypaV2Chunk {
                        main_chunk_id: id,
                        text: chunk.text.clone(),
                    }),
            );
            previous_target = Some(old.target_id);
        }
        state
    }
}

impl HypaMemoryState {
    pub fn parse(data: &str) -> Result<Self, MemoryError> {
        let Some(json) = data.strip_prefix("hypa:\n") else {
            return Err(MemoryError::InvalidHypaState);
        };
        let entries = serde_json::from_str::<Vec<HypaMemoryEntry>>(json.trim())
            .map_err(|_| MemoryError::InvalidHypaState)?;
        if entries.iter().any(|entry| entry.id.trim().is_empty()) {
            return Err(MemoryError::InvalidHypaState);
        }
        Ok(Self { entries })
    }

    pub fn serialize(&self) -> Result<String, MemoryError> {
        serde_json::to_string_pretty(&self.entries)
            .map(|json| format!("hypa:\n{json}"))
            .map_err(|_| MemoryError::InvalidHypaState)
    }
}

impl SupaMemoryState {
    pub fn parse(data: Option<&str>) -> Result<Option<Self>, MemoryError> {
        let Some(data) = data.filter(|data| !data.trim().is_empty()) else {
            return Ok(None);
        };
        let Some((checkpoint_id, summary)) = data.split_once('\n') else {
            return Err(MemoryError::InvalidState);
        };
        let checkpoint_id = checkpoint_id.trim();
        if checkpoint_id == "hypa:" {
            return Err(MemoryError::HypaState);
        }
        if checkpoint_id.is_empty() || summary.trim().is_empty() {
            return Err(MemoryError::InvalidState);
        }
        Ok(Some(Self {
            checkpoint_id: checkpoint_id.to_owned(),
            summary: summary.to_owned(),
        }))
    }

    pub fn serialize(&self) -> String {
        format!("{}\n{}", self.checkpoint_id, self.summary)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestoredMemory {
    pub summary: Option<String>,
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SummaryChunk {
    pub checkpoint_id: String,
    pub input: String,
    pub removed_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestoredHypaMemory {
    pub selected_index: usize,
    pub summary: String,
    pub retrieval_chunks: Vec<String>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum MemoryError {
    #[error("SupaMemory 상태는 첫 줄의 체크포인트 ID와 다음 줄부터의 요약으로 구성되어야 합니다.")]
    InvalidState,
    #[error("현재 채팅에는 HypaMemory 상태가 저장되어 있어 SupaMemory로 열 수 없습니다.")]
    HypaState,
    #[error("SupaMemory 체크포인트 메시지를 현재 채팅에서 찾지 못했습니다: {0}")]
    MissingCheckpoint(String),
    #[error("SupaMemory 체크포인트로 사용할 메시지 ID가 비어 있습니다.")]
    EmptyCheckpoint,
    #[error("HypaMemory 상태 JSON이 올바른 hypa 배열 형식이 아닙니다.")]
    InvalidHypaState,
    #[error("HypaMemory 상태의 체크포인트를 현재 채팅에서 찾지 못했습니다.")]
    MissingHypaCheckpoint,
    #[error("HypaMemory V2 상태가 올바른 mainChunks/chunks 형식이 아닙니다.")]
    InvalidHypaV2State,
    #[error("HypaMemory V3 상태가 올바른 summaries 형식이 아닙니다.")]
    InvalidHypaV3State,
}

pub fn validate_memory_state(data: Option<&str>) -> Result<(), MemoryError> {
    let Some(data) = data.filter(|data| !data.trim().is_empty()) else {
        return Ok(());
    };
    if data.starts_with("hypa:") {
        HypaMemoryState::parse(data).map(|_| ())
    } else {
        SupaMemoryState::parse(Some(data)).map(|_| ())
    }
}

pub fn restore_memory(
    data: Option<&str>,
    messages: &[Message],
) -> Result<RestoredMemory, MemoryError> {
    let Some(state) = SupaMemoryState::parse(data)? else {
        return Ok(RestoredMemory {
            summary: None,
            messages: messages.to_vec(),
        });
    };
    let index = messages
        .iter()
        .position(|message| message.id == state.checkpoint_id)
        .ok_or_else(|| MemoryError::MissingCheckpoint(state.checkpoint_id.clone()))?;
    Ok(RestoredMemory {
        summary: Some(state.summary),
        // RisuAI keeps the checkpoint message itself and discards only the prefix.
        messages: messages[index..].to_vec(),
    })
}

pub fn restore_hypa_memory(
    state: &HypaMemoryState,
    messages: &[Message],
) -> Result<RestoredHypaMemory, MemoryError> {
    for (selected_index, entry) in state.entries.iter().enumerate() {
        if let Some(message_index) = messages.iter().position(|message| message.id == entry.id) {
            return Ok(RestoredHypaMemory {
                selected_index,
                summary: entry.supa.clone(),
                retrieval_chunks: entry.hypa.clone(),
                // The legacy implementation also retains the checkpoint itself.
                messages: messages[message_index..].to_vec(),
            });
        }
    }
    Err(MemoryError::MissingHypaCheckpoint)
}

pub fn plan_summary_chunk(
    messages: &[Message],
    max_chunk_tokens: usize,
    model: &str,
    character_name: &str,
) -> Result<Option<SummaryChunk>, MemoryError> {
    if messages.len() <= 1 {
        return Ok(None);
    }
    let tokenizer = bpe_for_model(model).unwrap_or_else(|_| o200k_base_singleton());
    let mut input = Vec::new();
    let mut used_tokens: usize = 0;
    let mut removed_count = 0;
    for message in &messages[..messages.len() - 1] {
        let rendered = format!(
            "{}: {}",
            match message.role {
                Role::User => "User",
                Role::Character => character_name,
            },
            message.content
        );
        let tokens = tokenizer.encode_with_special_tokens(&rendered).len();
        if removed_count > 0 && used_tokens.saturating_add(tokens) > max_chunk_tokens {
            break;
        }
        used_tokens = used_tokens.saturating_add(tokens);
        input.push(rendered);
        removed_count += 1;
    }
    if removed_count == 0 {
        return Ok(None);
    }
    let checkpoint_id = messages[removed_count].id.trim();
    if checkpoint_id.is_empty() {
        return Err(MemoryError::EmptyCheckpoint);
    }
    Ok(Some(SummaryChunk {
        checkpoint_id: checkpoint_id.to_owned(),
        input: input.join("\n\n"),
        removed_count,
    }))
}

pub fn merge_summary(existing: Option<&str>, addition: &str) -> String {
    match existing
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
        Some(existing) => format!("{existing}\n\n{}", addition.trim()),
        None => addition.trim().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, role: Role, content: &str) -> Message {
        Message {
            id: id.into(),
            role,
            content: content.into(),
        }
    }

    #[test]
    fn state_round_trips_multiline_summary_and_rejects_hypa_or_malformed_data() {
        let state = SupaMemoryState::parse(Some("checkpoint\nline one\nline two"))
            .unwrap()
            .unwrap();
        assert_eq!(state.checkpoint_id, "checkpoint");
        assert_eq!(state.summary, "line one\nline two");
        assert_eq!(state.serialize(), "checkpoint\nline one\nline two");
        assert_eq!(
            SupaMemoryState::parse(Some("hypa:\n[]")),
            Err(MemoryError::HypaState)
        );
        assert_eq!(
            SupaMemoryState::parse(Some("checkpoint-only")),
            Err(MemoryError::InvalidState)
        );
    }

    #[test]
    fn restore_discards_only_messages_before_the_checkpoint() {
        let messages = vec![
            message("one", Role::User, "old"),
            message("two", Role::Character, "checkpoint"),
            message("three", Role::User, "new"),
        ];
        let restored = restore_memory(Some("two\nprior summary"), &messages).unwrap();
        assert_eq!(restored.summary.as_deref(), Some("prior summary"));
        assert_eq!(
            restored
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
        assert_eq!(
            restore_memory(Some("missing\nsummary"), &messages),
            Err(MemoryError::MissingCheckpoint("missing".into()))
        );
    }

    #[test]
    fn chunk_plan_is_bounded_but_always_leaves_the_newest_message() {
        let messages = vec![
            message("one", Role::User, &"old ".repeat(100)),
            message("two", Role::Character, "middle"),
            message("three", Role::User, "newest"),
        ];
        let chunk = plan_summary_chunk(&messages, 1, "gpt-4o-mini", "Mina")
            .unwrap()
            .unwrap();
        assert_eq!(chunk.removed_count, 1);
        assert_eq!(chunk.checkpoint_id, "two");
        assert!(chunk.input.starts_with("User: old"));

        let larger = plan_summary_chunk(&messages, 10_000, "gpt-4o-mini", "Mina")
            .unwrap()
            .unwrap();
        assert_eq!(larger.removed_count, 2);
        assert_eq!(larger.checkpoint_id, "three");
        assert!(larger.input.contains("Mina: middle"));
        assert!(
            plan_summary_chunk(&messages[2..], 100, "gpt-4o-mini", "Mina")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn summaries_append_with_the_compatible_paragraph_separator() {
        assert_eq!(merge_summary(None, " first "), "first");
        assert_eq!(
            merge_summary(Some("previous"), " next "),
            "previous\n\nnext"
        );
    }

    #[test]
    fn hypa_state_round_trips_and_selects_the_first_checkpoint_still_in_chat() {
        let source = r#"hypa:
[
  {"id":"gone","supa":"old","hypa":["old retrieval"]},
  {"id":"two","supa":"current summary","hypa":["event one","event two"]}
]"#;
        let state = HypaMemoryState::parse(source).unwrap();
        let messages = vec![
            message("one", Role::User, "before"),
            message("two", Role::Character, "checkpoint"),
            message("three", Role::User, "after"),
        ];
        let restored = restore_hypa_memory(&state, &messages).unwrap();
        assert_eq!(restored.selected_index, 1);
        assert_eq!(restored.summary, "current summary");
        assert_eq!(restored.retrieval_chunks, vec!["event one", "event two"]);
        assert_eq!(
            restored
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
        assert_eq!(
            HypaMemoryState::parse(&state.serialize().unwrap()).unwrap(),
            state
        );
        assert!(validate_memory_state(Some(source)).is_ok());
    }

    #[test]
    fn hypa_state_rejects_malformed_shapes_and_missing_checkpoints() {
        assert_eq!(
            HypaMemoryState::parse("hypa:\n{}"),
            Err(MemoryError::InvalidHypaState)
        );
        assert_eq!(
            HypaMemoryState::parse(r#"hypa:\n[{"id":"","supa":"x","hypa":[]}]"#),
            Err(MemoryError::InvalidHypaState)
        );
        let state = HypaMemoryState {
            entries: vec![HypaMemoryEntry {
                id: "missing".into(),
                supa: "summary".into(),
                hypa: Vec::new(),
            }],
        };
        assert_eq!(
            restore_hypa_memory(&state, &[message("one", Role::User, "hello")]),
            Err(MemoryError::MissingHypaCheckpoint)
        );
    }

    #[test]
    fn hypa_v2_cleans_orphaned_chunks_and_tracks_the_last_valid_id() {
        let messages = vec![
            message("one", Role::User, "one"),
            message("two", Role::Character, "two"),
            message("three", Role::User, "three"),
        ];
        let mut state = HypaV2State {
            last_main_chunk_id: 99,
            main_chunks: vec![
                HypaV2MainChunk {
                    id: 4,
                    text: "valid".into(),
                    chat_memos: vec!["one".into(), "two".into()],
                    last_chat_memo: "two".into(),
                },
                HypaV2MainChunk {
                    id: 7,
                    text: "orphan".into(),
                    chat_memos: vec!["missing".into()],
                    last_chat_memo: "missing".into(),
                },
            ],
            chunks: vec![
                HypaV2Chunk {
                    main_chunk_id: 4,
                    text: "valid detail".into(),
                },
                HypaV2Chunk {
                    main_chunk_id: 7,
                    text: "orphan detail".into(),
                },
            ],
        };
        state.clean(&messages);
        assert_eq!(state.last_main_chunk_id, 4);
        assert_eq!(state.main_chunks.len(), 1);
        assert_eq!(state.chunks.len(), 1);
        assert_eq!(
            HypaV2State::from_json_value(serde_json::to_value(&state).unwrap(), &messages).unwrap(),
            state
        );
    }

    #[test]
    fn legacy_hypa_v2_data_converts_in_chronological_order() {
        let messages = vec![
            message("one", Role::User, "one"),
            message("two", Role::Character, "two"),
            message("three", Role::User, "three"),
        ];
        let legacy = serde_json::json!({
            "mainChunks": [
                {"text": "newer", "targetId": "three"},
                {"text": "older", "targetId": "two"}
            ],
            "chunks": [
                {"text": "older detail", "targetId": "two"},
                {"text": "newer detail", "targetId": "three"}
            ]
        });
        let state = HypaV2State::from_json_value(legacy, &messages).unwrap();
        assert_eq!(
            state
                .main_chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<Vec<_>>(),
            vec!["older", "newer"]
        );
        assert_eq!(state.main_chunks[0].chat_memos, vec!["one", "two"]);
        assert_eq!(state.main_chunks[1].chat_memos, vec!["two", "three"]);
        assert_eq!(state.chunks[0].main_chunk_id, state.main_chunks[0].id);
        assert_eq!(state.chunks[1].main_chunk_id, state.main_chunks[1].id);
    }

    #[test]
    fn hypa_v3_decodes_null_legacy_memos_and_cleans_orphans_when_requested() {
        let messages = vec![
            message("one", Role::User, "one"),
            message("two", Role::Character, "two"),
        ];
        let value = serde_json::json!({
            "summaries": [
                {
                    "text": "valid",
                    "chatMemos": [null, "one", "two"],
                    "isImportant": true,
                    "tags": ["plot"]
                },
                {
                    "text": "orphan",
                    "chatMemos": ["missing"],
                    "isImportant": false
                }
            ],
            "lastSelectedSummaries": [0, 1],
            "metrics": {
                "lastImportantSummaries": [0],
                "lastRecentSummaries": [1],
                "lastSimilarSummaries": [],
                "lastRandomSummaries": []
            }
        });
        let state = HypaV3State::from_json_value(value.clone(), &messages, false).unwrap();
        assert_eq!(state.summaries.len(), 1);
        assert_eq!(state.summaries[0].chat_memos, vec!["one", "two"]);
        assert!(state.summaries[0].is_important);
        assert_eq!(state.next_message_index(&messages), 2);
        assert!(state.metrics.is_none());
        assert!(state.last_selected_summaries.is_none());

        let preserved = HypaV3State::from_json_value(value, &messages, true).unwrap();
        assert_eq!(preserved.summaries.len(), 2);
        assert!(preserved.metrics.is_some());
        assert!(preserved.last_selected_summaries.is_none());
    }
}
