use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::backup::Backup;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use thiserror::Error;
use uuid::Uuid;

use crate::asset::inlay_tokens;
use crate::memory::{HypaMemoryState, HypaV2State, HypaV3State, MemoryError, SupaMemoryState};
use crate::model::{
    Character, CharacterProfile, ChatSummary, HypaV3Settings, LoreEntry, LoreSettings, MemoryMode,
    Message, Persona, PresetSummary, ProviderKind, ProviderSettings, Role,
};
use crate::provider::{
    DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_BASE_URL, DEFAULT_CONTEXT_TOKENS, DEFAULT_EMBEDDING_MODEL,
    DEFAULT_GEMINI_BASE_URL, DEFAULT_MEMORY_ALLOCATED_TOKENS, DEFAULT_MEMORY_CHUNK_TOKENS,
    DEFAULT_OUTPUT_TOKENS,
};
use crate::relational::{
    DecodeError as RelationalDecodeError, NodeRow, RelationalValue, decode_rows,
};

const SCHEMA: &str = include_str!("../../src/ts/storage/sqlite-schema.sql");
const SCHEMA_VERSION: i64 = 3;
const SCHEMA_LAYOUT: &str = "relational-schema-v3";

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("데이터 디렉터리를 만들 수 없습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite 작업에 실패했습니다: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("지원하지 않는 데이터베이스 스키마입니다: {version}/{layout}")]
    SchemaMismatch { version: i64, layout: String },
    #[error("캐릭터 또는 채팅을 찾을 수 없습니다.")]
    MissingConversation,
    #[error("요청한 메시지가 현재 채팅의 올바른 응답 경계가 아닙니다.")]
    InvalidMessageBoundary,
    #[error("다른 프로세스가 데이터베이스를 변경해 메시지 삭제를 안전하게 재시도해야 합니다.")]
    ConcurrentModification,
    #[error("메시지를 입력해 주세요.")]
    EmptyMessage,
    #[error("캐릭터 이름을 입력해 주세요.")]
    EmptyCharacterName,
    #[error("캐릭터 이름은 120자를 넘을 수 없습니다.")]
    CharacterNameTooLong,
    #[error("인코딩된 메시지가 올바른 Base64가 아닙니다: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("인코딩된 메시지가 올바른 UTF-16이 아닙니다: {0}")]
    Utf16(#[from] std::string::FromUtf16Error),
    #[error("가져올 원본이 일반 파일이 아닙니다: {0}")]
    InvalidSource(PathBuf),
    #[error("가져오기 대상이 이미 존재합니다: {0}")]
    DestinationExists(PathBuf),
    #[error("SQLite 무결성 검사에 실패했습니다: {0}")]
    IntegrityCheck(String),
    #[error("관계형 확장 데이터를 해석하지 못했습니다: {0}")]
    Relational(#[from] RelationalDecodeError),
    #[error("네이티브 공급자 설정의 {0} 값이 문자열이 아닙니다.")]
    InvalidProviderSetting(String),
    #[error("메모리 상태를 해석하지 못했습니다: {0}")]
    Memory(#[from] MemoryError),
}

pub struct StoredMessage {
    pub chat_id: String,
    pub message: Message,
}

pub struct ReplacedMessageTail {
    pub stored: StoredMessage,
    pub removed_count: usize,
}

pub struct DeletedMessages {
    pub messages: Vec<Message>,
    pub supa_memory_data: Option<String>,
    pub hypa_v2_data: Option<HypaV2State>,
    pub hypa_v3_data: Option<HypaV3State>,
}

pub struct SavedPersonas {
    pub personas: Vec<Persona>,
    pub selected_index: usize,
    pub bound_persona_id: Option<String>,
}

pub struct DeletedChat {
    pub chats: Vec<ChatSummary>,
    pub active_chat_id: String,
    pub messages: Vec<Message>,
    pub local_lore: Vec<LoreEntry>,
    pub module_lore: Vec<LoreEntry>,
    pub supa_memory_data: Option<String>,
    pub hypa_v2_data: Option<HypaV2State>,
    pub hypa_v3_data: Option<HypaV3State>,
    pub bound_persona_id: Option<String>,
}

pub struct LoadedChat {
    pub messages: Vec<Message>,
    pub local_lore: Vec<LoreEntry>,
    pub module_lore: Vec<LoreEntry>,
    pub supa_memory_data: Option<String>,
    pub hypa_v2_data: Option<HypaV2State>,
    pub hypa_v3_data: Option<HypaV3State>,
    pub bound_persona_id: Option<String>,
}

struct CharacterDetails {
    profile: CharacterProfile,
    global_lore: Vec<LoreEntry>,
    lore_settings: LoreSettings,
    module_ids: Vec<String>,
    supa_memory_enabled: bool,
}

struct ChatDetails {
    local_lore: Vec<LoreEntry>,
    module_ids: Vec<String>,
    supa_memory_data: Option<String>,
    hypa_v2_value: Option<RelationalValue>,
    hypa_v3_value: Option<RelationalValue>,
    bound_persona_id: Option<String>,
}

#[derive(Clone, Debug)]
struct NativeModule {
    id: String,
    namespace: Option<String>,
    lore: Vec<LoreEntry>,
}

#[derive(Default)]
struct ModuleContext {
    modules: Vec<NativeModule>,
    base_ids: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ImportReport {
    pub destination: PathBuf,
    pub characters: u64,
    pub chats: u64,
    pub messages: u64,
}

pub struct Repository {
    connection: Connection,
    path: PathBuf,
}

impl Repository {
    pub fn default_path() -> PathBuf {
        gtk::glib::user_data_dir()
            .join("risuai-native")
            .join("risuai-native.sqlite3")
    }

    pub fn open_default() -> Result<Self, StorageError> {
        Self::open(Self::default_path())
    }

    pub fn import_snapshot_to_default(
        source: impl AsRef<Path>,
    ) -> Result<ImportReport, StorageError> {
        Self::import_snapshot(source, Self::default_path())
    }

    pub fn import_snapshot(
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> Result<ImportReport, StorageError> {
        let source = source.as_ref();
        let destination = destination.as_ref();
        if !source.is_file() {
            return Err(StorageError::InvalidSource(source.to_path_buf()));
        }
        if destination.exists() {
            return Err(StorageError::DestinationExists(destination.to_path_buf()));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| StorageError::InvalidSource(destination.to_path_buf()))?;
        fs::create_dir_all(parent)?;

        let source_connection = Connection::open_with_flags(
            source,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        validate_existing_schema(&source_connection)?;
        verify_integrity(&source_connection)?;

        let staging_file = tempfile::Builder::new()
            .prefix(".risuai-import-")
            .suffix(".sqlite3")
            .tempfile_in(parent)?;
        let staging_path = staging_file.into_temp_path();
        let mut staging_connection = Connection::open(&staging_path)?;
        {
            let backup = Backup::new(&source_connection, &mut staging_connection)?;
            backup.run_to_completion(128, Duration::from_millis(10), None)?;
        }
        drop(staging_connection);
        drop(source_connection);

        let verification_connection = Connection::open_with_flags(
            &staging_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        validate_existing_schema(&verification_connection)?;
        verify_integrity(&verification_connection)?;
        let report = ImportReport {
            destination: destination.to_path_buf(),
            characters: table_count(&verification_connection, "characters")?,
            chats: table_count(&verification_connection, "chats")?,
            messages: table_count(&verification_connection, "messages")?,
        };
        drop(verification_connection);

        staging_path
            .persist_noclobber(destination)
            .map_err(std::io::Error::from)?;
        Ok(report)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        validate_existing_schema(&connection)?;
        connection.execute_batch(SCHEMA)?;

        let mut repository = Self { connection, path };
        repository.seed_if_empty()?;
        Ok(repository)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn referenced_inlay_ids(&self) -> Result<HashSet<String>, StorageError> {
        let rows = {
            let mut statement = self.connection.prepare(
                "SELECT content_text, content_encoded FROM messages
                 UNION ALL SELECT text_value, encoded_text_value FROM system_settings
                 UNION ALL SELECT text_value, encoded_text_value FROM setting_extension_nodes
                 UNION ALL SELECT text_value, encoded_text_value FROM character_extension_nodes
                 UNION ALL SELECT text_value, encoded_text_value FROM chat_extension_nodes
                 UNION ALL SELECT text_value, encoded_text_value FROM message_extension_nodes
                 UNION ALL SELECT text_value, encoded_text_value FROM cold_extension_nodes
                 UNION ALL SELECT data, NULL FROM bot_presets
                 UNION ALL SELECT value, NULL FROM plugin_custom_storage",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut ids = HashSet::new();
        for (content_text, content_encoded) in rows {
            let content = decode_text(content_text, content_encoded)?;
            ids.extend(inlay_tokens(&content).into_iter().map(|token| token.id));
        }
        Ok(ids)
    }

    pub fn load_characters(&self) -> Result<Vec<Character>, StorageError> {
        let default_lore_settings = self.load_default_lore_settings()?;
        let module_context = self.load_module_context()?;
        let personas = self.load_personas()?;
        let selected_persona = self.load_selected_persona_index()?;
        let metadata = {
            let mut statement = self.connection.prepare(
                "SELECT c.id, c.name, c.kind,
                        (SELECT id FROM chats WHERE character_id = c.id ORDER BY position LIMIT 1)
                   FROM characters c
                  WHERE c.trash_time IS NULL
                  ORDER BY c.position, c.id",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        metadata
            .into_iter()
            .map(|(id, name, kind, chat_id)| {
                let details = self.load_character_details(&id, &default_lore_settings)?;
                let chats = self.load_chats(&id)?;
                let mut chat = match chat_id.as_deref() {
                    Some(chat_id) => {
                        let chat_details = self.load_chat_details(chat_id)?;
                        let messages = self.load_messages(chat_id)?;
                        let hypa_v2_data =
                            decode_hypa_v2(chat_details.hypa_v2_value.as_ref(), &messages)?;
                        let hypa_v3_data =
                            decode_hypa_v3(chat_details.hypa_v3_value.as_ref(), &messages, true)?;
                        LoadedChat {
                            messages,
                            local_lore: chat_details.local_lore,
                            module_lore: resolve_module_lore(
                                &module_context,
                                &details.module_ids,
                                &chat_details.module_ids,
                            ),
                            supa_memory_data: chat_details.supa_memory_data,
                            hypa_v2_data,
                            hypa_v3_data,
                            bound_persona_id: chat_details.bound_persona_id,
                        }
                    }
                    None => LoadedChat {
                        messages: Vec::new(),
                        local_lore: Vec::new(),
                        module_lore: resolve_module_lore(&module_context, &details.module_ids, &[]),
                        supa_memory_data: None,
                        hypa_v2_data: None,
                        hypa_v3_data: None,
                        bound_persona_id: None,
                    },
                };
                if !details.profile.first_message.is_empty()
                    && chat
                        .messages
                        .first()
                        .is_none_or(|message| message.content != details.profile.first_message)
                {
                    chat.messages.insert(
                        0,
                        Message {
                            id: format!("virtual-first-message:{id}"),
                            role: Role::Character,
                            content: details.profile.first_message.clone(),
                        },
                    );
                }
                let persona = resolve_persona(
                    &personas,
                    selected_persona,
                    chat.bound_persona_id.as_deref(),
                );
                Ok(Character {
                    id,
                    chat_id,
                    chats,
                    initials: initials(&name),
                    description: if !details.profile.description.trim().is_empty() {
                        details.profile.description.clone()
                    } else if kind == "group" {
                        "Group chat".into()
                    } else {
                        "Character".into()
                    },
                    name,
                    messages: chat.messages,
                    profile: details.profile,
                    global_lore: details.global_lore,
                    local_lore: chat.local_lore,
                    module_lore: chat.module_lore,
                    lore_settings: details.lore_settings,
                    supa_memory_enabled: details.supa_memory_enabled,
                    supa_memory_data: chat.supa_memory_data,
                    hypa_v2_data: chat.hypa_v2_data,
                    hypa_v3_data: chat.hypa_v3_data,
                    persona,
                    bound_persona_id: chat.bound_persona_id,
                })
            })
            .collect()
    }

    pub fn load_personas(&self) -> Result<Vec<Persona>, StorageError> {
        let mut personas = load_setting_value(&self.connection, "personas")?
            .as_ref()
            .and_then(RelationalValue::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, value)| persona_from_value(value, index))
            .collect::<Vec<_>>();
        if personas.is_empty() {
            personas.push(Persona {
                name: load_setting_string(&self.connection, "username")?
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "User".into()),
                prompt: load_setting_string(&self.connection, "personaPrompt")?.unwrap_or_default(),
                note: load_setting_string(&self.connection, "userNote")?.unwrap_or_default(),
                icon: load_setting_string(&self.connection, "userIcon")?.unwrap_or_default(),
                ..Persona::default()
            });
        }
        Ok(personas)
    }

    pub fn load_selected_persona_index(&self) -> Result<usize, StorageError> {
        Ok(load_setting_number(&self.connection, "selectedPersona")?
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map_or(0, |value| value as usize))
    }

    pub fn save_personas(
        &mut self,
        personas: &[Persona],
        selected_index: usize,
        character_id: &str,
        chat_id: &str,
        bind_selected_to_chat: bool,
    ) -> Result<SavedPersonas, StorageError> {
        if personas.is_empty() || selected_index >= personas.len() {
            return Err(StorageError::InvalidMessageBoundary);
        }
        let mut personas = personas.to_vec();
        for (index, persona) in personas.iter_mut().enumerate() {
            persona.source_index = index;
            if persona.id.is_none() {
                persona.id = Some(Uuid::new_v4().to_string());
            }
            if persona.name.trim().is_empty() {
                persona.name = "User".into();
            }
        }
        let original = load_setting_value(&self.connection, "personas")?;
        let value = merge_personas_value(original.as_ref(), &personas);
        let bound_persona_id = bind_selected_to_chat
            .then(|| personas[selected_index].id.clone())
            .flatten();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        replace_setting_value(&transaction, "personas", "personas", &value)?;
        upsert_setting_number(
            &transaction,
            "selectedPersona",
            "personas",
            selected_index as f64,
        )?;
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            chat_id,
            "bindedPersona",
            &bound_persona_id
                .as_ref()
                .map(|id| RelationalValue::String(id.clone()))
                .unwrap_or(RelationalValue::Undefined),
        )?;
        bump_revision(&transaction, "save-native-personas")?;
        transaction.commit()?;
        Ok(SavedPersonas {
            personas,
            selected_index,
            bound_persona_id,
        })
    }

    pub fn load_provider_settings(&self) -> Result<Option<ProviderSettings>, StorageError> {
        let Some(model) = load_setting_string(&self.connection, "nativeProviderModel")? else {
            return Ok(None);
        };
        let provider_kind = ProviderKind::from_storage(
            load_setting_string(&self.connection, "nativeProviderKind")?.as_deref(),
        );
        let base_url = load_setting_string(&self.connection, "nativeProviderBaseUrl")?
            .unwrap_or_else(|| match provider_kind {
                ProviderKind::OpenAiCompatible => DEFAULT_BASE_URL.into(),
                ProviderKind::Anthropic => DEFAULT_ANTHROPIC_BASE_URL.into(),
                ProviderKind::Gemini => DEFAULT_GEMINI_BASE_URL.into(),
            });
        let credential_id = load_setting_string(&self.connection, "nativeProviderCredentialId")?;
        let max_context_tokens =
            load_setting_number(&self.connection, "nativeProviderMaxContextTokens")?
                .map(|value| bounded_usize(value, DEFAULT_CONTEXT_TOKENS, 10_000_000))
                .unwrap_or(DEFAULT_CONTEXT_TOKENS);
        let max_output_tokens =
            load_setting_number(&self.connection, "nativeProviderMaxOutputTokens")?
                .map(|value| bounded_usize(value, DEFAULT_OUTPUT_TOKENS, 10_000_000))
                .unwrap_or(DEFAULT_OUTPUT_TOKENS);
        let memory_mode = load_setting_string(&self.connection, "nativeProviderMemoryMode")?
            .map(|value| MemoryMode::from_storage(Some(&value)))
            .unwrap_or(
                if load_setting_boolean(&self.connection, "hypaV3")?.unwrap_or(false) {
                    MemoryMode::HypaV3
                } else if load_setting_boolean(&self.connection, "hypav2")?.unwrap_or(false) {
                    MemoryMode::HypaV2
                } else if load_setting_boolean(&self.connection, "hypaMemory")?.unwrap_or(false) {
                    MemoryMode::Hypa
                } else {
                    MemoryMode::Supa
                },
            );
        let legacy_embedding_model = load_setting_string(&self.connection, "hypaModel")?;
        let embedding_model =
            load_setting_string(&self.connection, "nativeProviderEmbeddingModel")?
                .or_else(|| {
                    legacy_embedding_model.map(|model| match model.as_str() {
                        "ada" => "text-embedding-ada-002".to_owned(),
                        "openai3large" => "text-embedding-3-large".to_owned(),
                        _ => DEFAULT_EMBEDDING_MODEL.to_owned(),
                    })
                })
                .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_owned());
        let memory_allocated_tokens =
            load_setting_number(&self.connection, "nativeMemoryAllocatedTokens")?
                .or(load_setting_number(
                    &self.connection,
                    "hypaAllocatedTokens",
                )?)
                .map(|value| bounded_usize(value, DEFAULT_MEMORY_ALLOCATED_TOKENS, 10_000_000))
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_MEMORY_ALLOCATED_TOKENS);
        let memory_chunk_tokens = load_setting_number(&self.connection, "nativeMemoryChunkTokens")?
            .or(load_setting_number(&self.connection, "hypaChunkSize")?)
            .map(|value| bounded_usize(value, DEFAULT_MEMORY_CHUNK_TOKENS, 10_000_000))
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MEMORY_CHUNK_TOKENS);
        let hypa_v3 = load_hypa_v3_settings(&self.connection)?;
        Ok(Some(ProviderSettings {
            provider_kind,
            base_url,
            model,
            max_context_tokens,
            max_output_tokens,
            memory_mode,
            embedding_model,
            memory_allocated_tokens,
            memory_chunk_tokens,
            hypa_v3,
            credential_id,
        }))
    }

    pub fn save_provider_settings(
        &mut self,
        settings: &ProviderSettings,
    ) -> Result<(), StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        upsert_setting_string(
            &transaction,
            "nativeProviderKind",
            "model",
            settings.provider_kind.as_storage(),
        )?;
        upsert_setting_string(
            &transaction,
            "nativeProviderBaseUrl",
            "model",
            &settings.base_url,
        )?;
        upsert_setting_string(
            &transaction,
            "nativeProviderModel",
            "model",
            &settings.model,
        )?;
        upsert_setting_number(
            &transaction,
            "nativeProviderMaxContextTokens",
            "model",
            settings.max_context_tokens as f64,
        )?;
        upsert_setting_number(
            &transaction,
            "nativeProviderMaxOutputTokens",
            "model",
            settings.max_output_tokens as f64,
        )?;
        upsert_setting_string(
            &transaction,
            "nativeProviderMemoryMode",
            "model",
            settings.memory_mode.as_storage(),
        )?;
        upsert_setting_string(
            &transaction,
            "nativeProviderEmbeddingModel",
            "model",
            &settings.embedding_model,
        )?;
        upsert_setting_number(
            &transaction,
            "nativeMemoryAllocatedTokens",
            "model",
            settings.memory_allocated_tokens as f64,
        )?;
        upsert_setting_number(
            &transaction,
            "nativeMemoryChunkTokens",
            "model",
            settings.memory_chunk_tokens as f64,
        )?;
        for (key, value) in [
            (
                "nativeHypaV3MemoryRatioBps",
                settings.hypa_v3.memory_ratio_bps,
            ),
            (
                "nativeHypaV3ExtraSummarizationRatioBps",
                settings.hypa_v3.extra_summarization_ratio_bps,
            ),
            (
                "nativeHypaV3RecentRatioBps",
                settings.hypa_v3.recent_ratio_bps,
            ),
            (
                "nativeHypaV3SimilarRatioBps",
                settings.hypa_v3.similar_ratio_bps,
            ),
        ] {
            upsert_setting_number(&transaction, key, "model", value as f64)?;
        }
        upsert_setting_number(
            &transaction,
            "nativeHypaV3MaxMessagesPerSummary",
            "model",
            settings.hypa_v3.max_messages_per_summary as f64,
        )?;
        upsert_setting_number(
            &transaction,
            "nativeHypaV3QueryMessageCount",
            "model",
            settings.hypa_v3.query_message_count as f64,
        )?;
        for (key, value) in [
            (
                "nativeHypaV3PreserveOrphanedMemory",
                settings.hypa_v3.preserve_orphaned_memory,
            ),
            (
                "nativeHypaV3DoNotSummarizeUserMessages",
                settings.hypa_v3.do_not_summarize_user_messages,
            ),
            (
                "nativeHypaV3EnableSimilarityCorrection",
                settings.hypa_v3.enable_similarity_correction,
            ),
        ] {
            upsert_setting_boolean(&transaction, key, "model", value)?;
        }
        upsert_setting_string(
            &transaction,
            "nativeHypaV3SummaryChunkSeparator",
            "model",
            &settings.hypa_v3.summary_chunk_separator,
        )?;
        upsert_setting_string(
            &transaction,
            "nativeHypaV3SummaryPrompt",
            "model",
            &settings.hypa_v3.summary_prompt,
        )?;
        if let Some(credential_id) = &settings.credential_id {
            upsert_setting_string(
                &transaction,
                "nativeProviderCredentialId",
                "model",
                credential_id,
            )?;
        } else {
            transaction.execute(
                "DELETE FROM system_settings WHERE key = 'nativeProviderCredentialId'",
                [],
            )?;
        }
        bump_revision(&transaction, "save-native-provider-settings")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_preset_summaries(&self) -> Result<Vec<PresetSummary>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT preset_id, name, api_type, ai_model
               FROM bot_presets ORDER BY position, preset_id",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(PresetSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    api_type: row.get(2)?,
                    model: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn load_chats(&self, character_id: &str) -> Result<Vec<ChatSummary>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT c.id, c.name, COUNT(m.id)
               FROM chats c
               LEFT JOIN messages m ON m.chat_id = c.id
              WHERE c.character_id = ?1
              GROUP BY c.id, c.name, c.position
              ORDER BY c.position, c.id",
        )?;
        Ok(statement
            .query_map([character_id], |row| {
                Ok(ChatSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    message_count: row.get::<_, i64>(2)?.max(0) as usize,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn load_chat_context(&self, chat_id: &str) -> Result<LoadedChat, StorageError> {
        let character_id = self
            .connection
            .query_row(
                "SELECT character_id FROM chats WHERE id = ?1",
                [chat_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(StorageError::MissingConversation)?;
        let defaults = self.load_default_lore_settings()?;
        let character_details = self.load_character_details(&character_id, &defaults)?;
        let chat_details = self.load_chat_details(chat_id)?;
        let module_context = self.load_module_context()?;
        let messages = self.load_messages(chat_id)?;
        let hypa_v2_data = decode_hypa_v2(chat_details.hypa_v2_value.as_ref(), &messages)?;
        let hypa_v3_data = decode_hypa_v3(chat_details.hypa_v3_value.as_ref(), &messages, true)?;
        Ok(LoadedChat {
            messages,
            local_lore: chat_details.local_lore,
            module_lore: resolve_module_lore(
                &module_context,
                &character_details.module_ids,
                &chat_details.module_ids,
            ),
            supa_memory_data: chat_details.supa_memory_data,
            hypa_v2_data,
            hypa_v3_data,
            bound_persona_id: chat_details.bound_persona_id,
        })
    }

    fn load_character_details(
        &self,
        character_id: &str,
        defaults: &LoreSettings,
    ) -> Result<CharacterDetails, StorageError> {
        let rows = {
            let mut statement = self.connection.prepare(
                "SELECT node_id, parent_node_id, node_order, object_key,
                        object_key_encoded, value_type, text_value,
                        encoded_text_value, number_value, boolean_value
                   FROM character_extension_nodes
                  WHERE character_id = ?1
                  ORDER BY node_id",
            )?;
            statement
                .query_map([character_id], |row| {
                    Ok(NodeRow {
                        node_id: row.get(0)?,
                        parent_node_id: row.get(1)?,
                        node_order: row.get(2)?,
                        object_key: row.get(3)?,
                        object_key_encoded: row.get(4)?,
                        value_type: row.get(5)?,
                        text_value: row.get(6)?,
                        encoded_text_value: row.get(7)?,
                        number_value: row.get(8)?,
                        boolean_value: row.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        if rows.is_empty() {
            return Ok(CharacterDetails {
                profile: CharacterProfile::default(),
                global_lore: Vec::new(),
                lore_settings: defaults.clone(),
                module_ids: Vec::new(),
                supa_memory_enabled: false,
            });
        }
        let value = decode_rows(rows)?;
        Ok(CharacterDetails {
            profile: CharacterProfile {
                first_message: string_field(&value, "firstMessage"),
                description: string_field(&value, "desc"),
                personality: string_field(&value, "personality"),
                scenario: string_field(&value, "scenario"),
                system_prompt: string_field(&value, "systemPrompt"),
                post_history_instructions: string_field(&value, "postHistoryInstructions"),
                example_message: string_field(&value, "exampleMessage"),
                creator_notes: string_field(&value, "creatorNotes"),
            },
            global_lore: lore_entries(value.get("globalLore")),
            lore_settings: character_lore_settings(value.get("loreSettings"), defaults),
            module_ids: string_array(value.get("modules")),
            supa_memory_enabled: bool_field(&value, "supaMemory").unwrap_or(false),
        })
    }

    fn load_chat_details(&self, chat_id: &str) -> Result<ChatDetails, StorageError> {
        let rows = {
            let mut statement = self.connection.prepare(
                "SELECT node_id, parent_node_id, node_order, object_key,
                        object_key_encoded, value_type, text_value,
                        encoded_text_value, number_value, boolean_value
                   FROM chat_extension_nodes
                  WHERE chat_id = ?1
                  ORDER BY node_id",
            )?;
            statement
                .query_map([chat_id], |row| {
                    Ok(NodeRow {
                        node_id: row.get(0)?,
                        parent_node_id: row.get(1)?,
                        node_order: row.get(2)?,
                        object_key: row.get(3)?,
                        object_key_encoded: row.get(4)?,
                        value_type: row.get(5)?,
                        text_value: row.get(6)?,
                        encoded_text_value: row.get(7)?,
                        number_value: row.get(8)?,
                        boolean_value: row.get(9)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        if rows.is_empty() {
            return Ok(ChatDetails {
                local_lore: Vec::new(),
                module_ids: Vec::new(),
                supa_memory_data: None,
                hypa_v2_value: None,
                hypa_v3_value: None,
                bound_persona_id: None,
            });
        }
        let value = decode_rows(rows)?;
        Ok(ChatDetails {
            local_lore: lore_entries(value.get("localLore")),
            module_ids: string_array(value.get("modules")),
            supa_memory_data: optional_string_field(&value, "supaMemoryData")
                .filter(|data| !data.is_empty()),
            hypa_v2_value: value.get("hypaV2Data").cloned().filter(|value| {
                !matches!(value, RelationalValue::Null | RelationalValue::Undefined)
            }),
            hypa_v3_value: value.get("hypaV3Data").cloned().filter(|value| {
                !matches!(value, RelationalValue::Null | RelationalValue::Undefined)
            }),
            bound_persona_id: optional_string_field(&value, "bindedPersona")
                .filter(|id| !id.trim().is_empty()),
        })
    }

    fn load_default_lore_settings(&self) -> Result<LoreSettings, StorageError> {
        let mut settings = LoreSettings::default();
        if let Some(token_budget) = load_setting_number(&self.connection, "loreBookToken")? {
            settings.token_budget = bounded_usize(token_budget, settings.token_budget, 1_000_000);
        }
        if let Some(scan_depth) = load_setting_number(&self.connection, "loreBookDepth")? {
            settings.scan_depth = bounded_usize(scan_depth, settings.scan_depth, 10_000);
        }
        Ok(settings)
    }

    fn load_module_context(&self) -> Result<ModuleContext, StorageError> {
        let modules = load_setting_value(&self.connection, "modules")?
            .as_ref()
            .map(native_modules)
            .unwrap_or_default();
        let mut base_ids = load_setting_value(&self.connection, "enabledModules")?
            .as_ref()
            .map(|value| string_array(Some(value)))
            .unwrap_or_default();
        if let Some(integration) = load_setting_value(&self.connection, "moduleIntergration")?
            .as_ref()
            .and_then(RelationalValue::as_str)
        {
            base_ids.extend(
                integration
                    .split(',')
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
            );
        }
        Ok(ModuleContext { modules, base_ids })
    }

    pub fn append_user_message(
        &mut self,
        character_id: &str,
        current_chat_id: Option<&str>,
        content: &str,
    ) -> Result<StoredMessage, StorageError> {
        self.append_message(character_id, current_chat_id, Role::User, content)
    }

    pub fn create_character(&mut self, name: &str) -> Result<Character, StorageError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::EmptyCharacterName);
        }
        if name.chars().count() > 120 {
            return Err(StorageError::CharacterNameTooLong);
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let character_id = Uuid::new_v4().to_string();
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM characters",
            [],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO characters
                 (id, position, kind, name, creation_time, modification_time, details_loaded)
             VALUES (?1, ?2, 'character', ?3, unixepoch() * 1000, unixepoch() * 1000, 1)",
            params![character_id, position, name],
        )?;
        transaction.execute(
            "INSERT INTO character_extension_nodes
                 (character_id, node_id, parent_node_id, node_order, value_type)
             VALUES (?1, 0, NULL, 0, 'object')",
            [&character_id],
        )?;
        for (node_id, key) in [
            "firstMessage",
            "desc",
            "personality",
            "scenario",
            "systemPrompt",
            "postHistoryInstructions",
            "exampleMessage",
            "creatorNotes",
        ]
        .into_iter()
        .enumerate()
        {
            transaction.execute(
                "INSERT INTO character_extension_nodes
                     (character_id, node_id, parent_node_id, node_order,
                      object_key, value_type, text_value)
                 VALUES (?1, ?2, 0, ?3, ?4, 'string', '')",
                params![character_id, node_id as i64 + 1, node_id as i64, key],
            )?;
        }
        let chat_id = create_chat(&transaction, &character_id)?;
        bump_revision(&transaction, "create-native-character")?;
        transaction.commit()?;

        let personas = self.load_personas()?;
        let selected_persona = self.load_selected_persona_index()?;
        Ok(Character {
            id: character_id,
            chat_id: Some(chat_id.clone()),
            chats: vec![ChatSummary {
                id: chat_id.clone(),
                name: "Chat 1".into(),
                message_count: 0,
            }],
            name: name.to_owned(),
            description: "Character".into(),
            initials: initials(name),
            messages: Vec::new(),
            profile: CharacterProfile::default(),
            global_lore: Vec::new(),
            local_lore: Vec::new(),
            module_lore: resolve_module_lore(&self.load_module_context()?, &[], &[]),
            lore_settings: self.load_default_lore_settings()?,
            supa_memory_enabled: false,
            supa_memory_data: None,
            hypa_v2_data: None,
            hypa_v3_data: None,
            persona: resolve_persona(&personas, selected_persona, None),
            bound_persona_id: None,
        })
    }

    pub fn update_character(
        &mut self,
        character_id: &str,
        name: &str,
        profile: &CharacterProfile,
        supa_memory_enabled: bool,
    ) -> Result<String, StorageError> {
        let name = validate_character_name(name)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE characters
                SET name = ?2, modification_time = unixepoch() * 1000,
                    updated_at = datetime('now')
              WHERE id = ?1 AND trash_time IS NULL",
            params![character_id, name],
        )?;
        if changed == 0 {
            return Err(StorageError::MissingConversation);
        }
        for (key, value) in [
            ("firstMessage", profile.first_message.as_str()),
            ("desc", profile.description.as_str()),
            ("personality", profile.personality.as_str()),
            ("scenario", profile.scenario.as_str()),
            ("systemPrompt", profile.system_prompt.as_str()),
            (
                "postHistoryInstructions",
                profile.post_history_instructions.as_str(),
            ),
            ("exampleMessage", profile.example_message.as_str()),
            ("creatorNotes", profile.creator_notes.as_str()),
        ] {
            upsert_character_string_field(&transaction, character_id, key, value)?;
        }
        replace_extension_field(
            &transaction,
            ExtensionScope::Character,
            character_id,
            "supaMemory",
            &RelationalValue::Boolean(supa_memory_enabled),
        )?;
        bump_revision(&transaction, "update-native-character")?;
        transaction.commit()?;
        Ok(name.to_owned())
    }

    pub fn update_lorebooks(
        &mut self,
        character_id: &str,
        chat_id: &str,
        global_lore: &[LoreEntry],
        local_lore: &[LoreEntry],
        settings: &LoreSettings,
    ) -> Result<(), StorageError> {
        let character_value =
            load_extension_value(&self.connection, ExtensionScope::Character, character_id)?;
        let chat_value = load_extension_value(&self.connection, ExtensionScope::Chat, chat_id)?;
        let global_value = merge_lore_value(
            character_value
                .as_ref()
                .and_then(|value| value.get("globalLore")),
            global_lore,
        );
        let local_value = merge_lore_value(
            chat_value.as_ref().and_then(|value| value.get("localLore")),
            local_lore,
        );
        let settings_value = merge_lore_settings_value(
            character_value
                .as_ref()
                .and_then(|value| value.get("loreSettings")),
            settings,
        );

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        ensure_extension_root(&transaction, ExtensionScope::Character, character_id)?;
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Character,
            character_id,
            "globalLore",
            &global_value,
        )?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Character,
            character_id,
            "loreSettings",
            &settings_value,
        )?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            chat_id,
            "localLore",
            &local_value,
        )?;
        transaction.execute(
            "UPDATE characters
                SET modification_time = unixepoch() * 1000,
                    updated_at = datetime('now')
              WHERE id = ?1",
            [character_id],
        )?;
        bump_revision(&transaction, "update-native-lorebooks")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_supa_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        data: Option<&str>,
    ) -> Result<(), StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        let value = data
            .map(|data| RelationalValue::String(data.to_owned()))
            .unwrap_or(RelationalValue::Undefined);
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            chat_id,
            "supaMemoryData",
            &value,
        )?;
        transaction.execute(
            "UPDATE chats SET updated_at = datetime('now') WHERE id = ?1",
            [chat_id],
        )?;
        bump_revision(&transaction, "update-native-supa-memory")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_hypa_v2_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        state: Option<&HypaV2State>,
    ) -> Result<(), StorageError> {
        let original = load_extension_value(&self.connection, ExtensionScope::Chat, chat_id)?;
        let value = state
            .map(|state| {
                merge_hypa_v2_value(original.as_ref().and_then(|v| v.get("hypaV2Data")), state)
            })
            .unwrap_or(RelationalValue::Undefined);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            chat_id,
            "hypaV2Data",
            &value,
        )?;
        transaction.execute(
            "UPDATE chats SET updated_at = datetime('now') WHERE id = ?1",
            [chat_id],
        )?;
        bump_revision(&transaction, "update-native-hypa-v2-memory")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_hypa_v3_memory(
        &mut self,
        character_id: &str,
        chat_id: &str,
        state: Option<&HypaV3State>,
    ) -> Result<(), StorageError> {
        let original = load_extension_value(&self.connection, ExtensionScope::Chat, chat_id)?;
        let value = state
            .map(|state| {
                merge_hypa_v3_value(original.as_ref().and_then(|v| v.get("hypaV3Data")), state)
            })
            .unwrap_or(RelationalValue::Undefined);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            chat_id,
            "hypaV3Data",
            &value,
        )?;
        transaction.execute(
            "UPDATE chats SET updated_at = datetime('now') WHERE id = ?1",
            [chat_id],
        )?;
        bump_revision(&transaction, "update-native-hypa-v3-memory")?;
        transaction.commit()?;
        Ok(())
    }

    pub fn create_chat_for_character(
        &mut self,
        character_id: &str,
    ) -> Result<ChatSummary, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        let chat_id = create_chat(&transaction, character_id)?;
        let name: String =
            transaction.query_row("SELECT name FROM chats WHERE id = ?1", [&chat_id], |row| {
                row.get(0)
            })?;
        bump_revision(&transaction, "create-native-chat")?;
        transaction.commit()?;
        Ok(ChatSummary {
            id: chat_id,
            name,
            message_count: 0,
        })
    }

    pub fn delete_chat(
        &mut self,
        character_id: &str,
        chat_id: &str,
        preferred_active_chat_id: Option<&str>,
    ) -> Result<DeletedChat, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        transaction.execute("DELETE FROM chats WHERE id = ?1", [chat_id])?;
        transaction.execute(
            "UPDATE chats
                SET position = (SELECT COUNT(*) FROM chats earlier
                                 WHERE earlier.character_id = chats.character_id
                                   AND (earlier.position < chats.position OR
                                        (earlier.position = chats.position AND earlier.id < chats.id)))
              WHERE character_id = ?1",
            [character_id],
        )?;
        let preferred_active_chat_id = match preferred_active_chat_id {
            Some(preferred)
                if preferred != chat_id
                    && chat_belongs_to(&transaction, preferred, character_id)? =>
            {
                Some(preferred.to_owned())
            }
            _ => None,
        };
        let active_chat_id = if let Some(preferred) = preferred_active_chat_id {
            preferred
        } else {
            match transaction
                .query_row(
                    "SELECT id FROM chats WHERE character_id = ?1 ORDER BY position, id LIMIT 1",
                    [character_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                Some(chat_id) => chat_id,
                None => create_chat(&transaction, character_id)?,
            }
        };
        bump_revision(&transaction, "delete-native-chat")?;
        transaction.commit()?;
        let chat = self.load_chat_context(&active_chat_id)?;
        Ok(DeletedChat {
            chats: self.load_chats(character_id)?,
            messages: chat.messages,
            local_lore: chat.local_lore,
            module_lore: chat.module_lore,
            supa_memory_data: chat.supa_memory_data,
            hypa_v2_data: chat.hypa_v2_data,
            hypa_v3_data: chat.hypa_v3_data,
            bound_persona_id: chat.bound_persona_id,
            active_chat_id,
        })
    }

    pub fn append_character_message(
        &mut self,
        character_id: &str,
        current_chat_id: Option<&str>,
        content: &str,
    ) -> Result<StoredMessage, StorageError> {
        self.append_message(character_id, current_chat_id, Role::Character, content)
    }

    pub fn extend_last_character_message(
        &mut self,
        character_id: &str,
        chat_id: &str,
        message_id: &str,
        content: &str,
    ) -> Result<StoredMessage, StorageError> {
        if content.trim().is_empty() {
            return Err(StorageError::EmptyMessage);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let boundary = transaction
            .query_row(
                "SELECT m.position, m.role,
                        (SELECT MAX(position) FROM messages WHERE chat_id = m.chat_id)
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.chat_id = ?1 AND m.id = ?2 AND c.character_id = ?3",
                params![chat_id, message_id, character_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((position, role, last_position)) = boundary else {
            return Err(StorageError::MissingConversation);
        };
        if role != "char" || position != last_position {
            return Err(StorageError::InvalidMessageBoundary);
        }
        let (content_text, content_encoded) = encode_text(content);
        transaction.execute(
            "UPDATE messages
                SET content_text = ?1, content_encoded = ?2
              WHERE chat_id = ?3 AND id = ?4",
            params![content_text, content_encoded, chat_id, message_id],
        )?;
        touch_conversation(&transaction, character_id, chat_id)?;
        bump_revision(&transaction, "extend-native-character-message")?;
        transaction.commit()?;
        Ok(StoredMessage {
            chat_id: chat_id.to_owned(),
            message: Message {
                id: message_id.to_owned(),
                role: Role::Character,
                content: content.to_owned(),
            },
        })
    }

    pub fn update_message_content(
        &mut self,
        character_id: &str,
        chat_id: &str,
        message_id: &str,
        content: &str,
    ) -> Result<StoredMessage, StorageError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let role = transaction
            .query_row(
                "SELECT m.role
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.chat_id = ?1 AND m.id = ?2 AND c.character_id = ?3",
                params![chat_id, message_id, character_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(StorageError::MissingConversation)?;
        let (content_text, content_encoded) = encode_text(content);
        transaction.execute(
            "UPDATE messages
                SET content_text = ?1, content_encoded = ?2
              WHERE chat_id = ?3 AND id = ?4",
            params![content_text, content_encoded, chat_id, message_id],
        )?;
        touch_conversation(&transaction, character_id, chat_id)?;
        bump_revision(&transaction, "edit-native-message")?;
        transaction.commit()?;
        Ok(StoredMessage {
            chat_id: chat_id.to_owned(),
            message: Message {
                id: message_id.to_owned(),
                role: if role == "user" {
                    Role::User
                } else {
                    Role::Character
                },
                content: content.to_owned(),
            },
        })
    }

    pub fn delete_message_range(
        &mut self,
        character_id: &str,
        chat_id: &str,
        message_id: &str,
        delete_tail: bool,
    ) -> Result<DeletedMessages, StorageError> {
        let revision_before: i64 = self.connection.query_row(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let target_position = self
            .connection
            .query_row(
                "SELECT m.position
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.chat_id = ?1 AND m.id = ?2 AND c.character_id = ?3",
                params![chat_id, message_id, character_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or(StorageError::MissingConversation)?;
        let rows = {
            let (comparison, parameter): (&str, &dyn rusqlite::ToSql) = if delete_tail {
                ("position >= ?2", &target_position)
            } else {
                ("id = ?2", &message_id)
            };
            let sql = format!(
                "SELECT id, role, content_text, content_encoded
                   FROM messages
                  WHERE chat_id = ?1 AND {comparison}
                  ORDER BY position, id"
            );
            let mut statement = self.connection.prepare(&sql)?;
            statement
                .query_map(params![chat_id, parameter], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let deleted_messages = rows
            .into_iter()
            .map(|(id, role, content_text, content_encoded)| {
                Ok(Message {
                    id,
                    role: if role == "user" {
                        Role::User
                    } else {
                        Role::Character
                    },
                    content: decode_text(content_text, content_encoded)?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        if deleted_messages.is_empty() {
            return Err(StorageError::MissingConversation);
        }
        let deleted_ids = deleted_messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<HashSet<_>>();
        let remaining_messages = self
            .load_messages(chat_id)?
            .into_iter()
            .filter(|message| !deleted_ids.contains(message.id.as_str()))
            .collect::<Vec<_>>();
        let original_extension =
            load_extension_value(&self.connection, ExtensionScope::Chat, chat_id)?;
        let original_supa = original_extension
            .as_ref()
            .and_then(|value| value.get("supaMemoryData"))
            .and_then(RelationalValue::as_str)
            .filter(|data| !data.trim().is_empty());
        let supa_memory_data = clean_supa_memory_after_delete(original_supa, &remaining_messages)?;
        let hypa_v2_data = decode_hypa_v2(
            original_extension
                .as_ref()
                .and_then(|value| value.get("hypaV2Data"))
                .filter(|value| {
                    !matches!(value, RelationalValue::Null | RelationalValue::Undefined)
                }),
            &remaining_messages,
        )?;
        let hypa_v3_data = decode_hypa_v3(
            original_extension
                .as_ref()
                .and_then(|value| value.get("hypaV3Data"))
                .filter(|value| {
                    !matches!(value, RelationalValue::Null | RelationalValue::Undefined)
                }),
            &remaining_messages,
            false,
        )?;
        let supa_value = supa_memory_data
            .as_ref()
            .map(|data| RelationalValue::String(data.clone()))
            .unwrap_or(RelationalValue::Undefined);
        let hypa_v2_value = hypa_v2_data
            .as_ref()
            .map(|state| {
                merge_hypa_v2_value(
                    original_extension
                        .as_ref()
                        .and_then(|value| value.get("hypaV2Data")),
                    state,
                )
            })
            .unwrap_or(RelationalValue::Undefined);
        let hypa_v3_value = hypa_v3_data
            .as_ref()
            .map(|state| {
                merge_hypa_v3_value(
                    original_extension
                        .as_ref()
                        .and_then(|value| value.get("hypaV3Data")),
                    state,
                )
            })
            .unwrap_or(RelationalValue::Undefined);

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let locked_revision: i64 = transaction.query_row(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        if locked_revision != revision_before {
            return Err(StorageError::ConcurrentModification);
        }
        ensure_character_exists(&transaction, character_id)?;
        if !chat_belongs_to(&transaction, chat_id, character_id)? {
            return Err(StorageError::MissingConversation);
        }
        if delete_tail {
            transaction.execute(
                "DELETE FROM messages WHERE chat_id = ?1 AND position >= ?2",
                params![chat_id, target_position],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM messages WHERE chat_id = ?1 AND id = ?2",
                params![chat_id, message_id],
            )?;
        }
        ensure_extension_root(&transaction, ExtensionScope::Chat, chat_id)?;
        for (field, value) in [
            ("supaMemoryData", &supa_value),
            ("hypaV2Data", &hypa_v2_value),
            ("hypaV3Data", &hypa_v3_value),
        ] {
            if original_extension
                .as_ref()
                .and_then(|extension| extension.get(field))
                .is_none()
                && matches!(value, RelationalValue::Undefined)
            {
                continue;
            }
            replace_extension_field(&transaction, ExtensionScope::Chat, chat_id, field, value)?;
        }
        refresh_conversation_after_delete(&transaction, character_id, chat_id)?;
        bump_revision(&transaction, "delete-native-message")?;
        transaction.commit()?;
        Ok(DeletedMessages {
            messages: deleted_messages,
            supa_memory_data,
            hypa_v2_data,
            hypa_v3_data,
        })
    }

    pub fn replace_tail_after_user(
        &mut self,
        character_id: &str,
        chat_id: &str,
        user_message_id: &str,
        content: &str,
    ) -> Result<ReplacedMessageTail, StorageError> {
        if content.trim().is_empty() {
            return Err(StorageError::EmptyMessage);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let boundary = transaction
            .query_row(
                "SELECT m.position, m.role,
                        EXISTS(
                            SELECT 1 FROM messages later
                             WHERE later.chat_id = m.chat_id
                               AND later.position > m.position
                               AND later.role = 'user'
                        )
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.chat_id = ?1 AND m.id = ?2 AND c.character_id = ?3",
                params![chat_id, user_message_id, character_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((position, role, has_later_user)) = boundary else {
            return Err(StorageError::MissingConversation);
        };
        if role != "user" || has_later_user {
            return Err(StorageError::InvalidMessageBoundary);
        }
        let removed_count = transaction.execute(
            "DELETE FROM messages WHERE chat_id = ?1 AND position > ?2",
            params![chat_id, position],
        )?;
        let message_id = Uuid::new_v4().to_string();
        let (content_text, content_encoded) = encode_text(content);
        transaction.execute(
            "INSERT INTO messages
                 (chat_id, id, position, role, content_text, content_encoded, sent_time)
             VALUES (?1, ?2, ?3, 'char', ?4, ?5, unixepoch() * 1000)",
            params![
                chat_id,
                message_id,
                position + 1,
                content_text,
                content_encoded
            ],
        )?;
        touch_conversation(&transaction, character_id, chat_id)?;
        bump_revision(&transaction, "regenerate-native-character-message")?;
        transaction.commit()?;
        Ok(ReplacedMessageTail {
            stored: StoredMessage {
                chat_id: chat_id.to_owned(),
                message: Message {
                    id: message_id,
                    role: Role::Character,
                    content: content.to_owned(),
                },
            },
            removed_count,
        })
    }

    fn append_message(
        &mut self,
        character_id: &str,
        current_chat_id: Option<&str>,
        role: Role,
        content: &str,
    ) -> Result<StoredMessage, StorageError> {
        let content = content.trim();
        if content.is_empty() {
            return Err(StorageError::EmptyMessage);
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let character_exists = transaction
            .query_row(
                "SELECT 1 FROM characters WHERE id = ?1 AND trash_time IS NULL",
                [character_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !character_exists {
            return Err(StorageError::MissingConversation);
        }

        let chat_id = match current_chat_id {
            Some(chat_id) if chat_belongs_to(&transaction, chat_id, character_id)? => {
                chat_id.to_owned()
            }
            Some(_) => return Err(StorageError::MissingConversation),
            None => create_chat(&transaction, character_id)?,
        };

        let message_id = Uuid::new_v4().to_string();
        let stored_role = match role {
            Role::User => "user",
            Role::Character => "char",
        };
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE chat_id = ?1",
            [&chat_id],
            |row| row.get(0),
        )?;
        let (content_text, content_encoded) = encode_text(content);
        transaction.execute(
            "INSERT INTO messages
                 (chat_id, id, position, role, content_text, content_encoded, sent_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch() * 1000)",
            params![
                chat_id,
                message_id,
                position,
                stored_role,
                content_text,
                content_encoded
            ],
        )?;
        transaction.execute(
            "UPDATE chats
                SET last_message_time = unixepoch() * 1000,
                    messages_loaded = 1,
                    updated_at = datetime('now')
              WHERE id = ?1",
            [&chat_id],
        )?;
        transaction.execute(
            "UPDATE characters
                SET last_interaction_time = unixepoch() * 1000,
                    modification_time = unixepoch() * 1000,
                    updated_at = datetime('now')
              WHERE id = ?1",
            [character_id],
        )?;
        bump_revision(
            &transaction,
            match role {
                Role::User => "append-native-user-message",
                Role::Character => "append-native-character-message",
            },
        )?;
        transaction.commit()?;

        Ok(StoredMessage {
            chat_id,
            message: Message {
                id: message_id,
                role,
                content: content.to_owned(),
            },
        })
    }

    fn load_messages(&self, chat_id: &str) -> Result<Vec<Message>, StorageError> {
        let rows = {
            let mut statement = self.connection.prepare(
                "SELECT id, role, content_text, content_encoded
                   FROM messages
                  WHERE chat_id = ?1
                  ORDER BY position, id",
            )?;
            statement
                .query_map([chat_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        rows.into_iter()
            .map(|(id, role, content_text, content_encoded)| {
                Ok(Message {
                    id,
                    role: if role == "user" {
                        Role::User
                    } else {
                        Role::Character
                    },
                    content: decode_text(content_text, content_encoded)?,
                })
            })
            .collect()
    }

    fn seed_if_empty(&mut self) -> Result<(), StorageError> {
        let (initialized, count): (i64, i64) = self.connection.query_row(
            "SELECT initialized, (SELECT COUNT(*) FROM characters)
               FROM system_storage_meta WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if initialized != 0 || count != 0 {
            return Ok(());
        }

        let transaction = self.connection.transaction()?;
        seed_character(
            &transaction,
            "native-risu",
            0,
            "character",
            "Risu",
            "안녕하세요! 이 대화는 relational-schema-v3 SQLite 데이터베이스에서 불러왔어요.",
        )?;
        seed_character(
            &transaction,
            "native-aria",
            1,
            "character",
            "Aria",
            "새로운 이야기를 함께 만들어 볼까요?",
        )?;
        seed_character(
            &transaction,
            "native-research-lab",
            2,
            "group",
            "Research Lab",
            "그룹 채팅을 위한 네이티브 화면 자리입니다.",
        )?;
        transaction.execute(
            "UPDATE system_storage_meta
                SET initialized = 1, revision = revision + 1, updated_at = datetime('now')
              WHERE singleton = 1",
            [],
        )?;
        transaction.execute(
            "INSERT INTO system_revisions
                 (storage_revision, database_initialized, scope, action)
             SELECT revision, initialized, 'database', 'initialize-native-preview'
               FROM system_storage_meta WHERE singleton = 1",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn verify_integrity(connection: &Connection) -> Result<(), StorageError> {
    let result: String = connection.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    if result != "ok" {
        return Err(StorageError::IntegrityCheck(result));
    }
    Ok(())
}

fn table_count(connection: &Connection, table: &str) -> Result<u64, StorageError> {
    let sql = match table {
        "characters" => "SELECT COUNT(*) FROM characters",
        "chats" => "SELECT COUNT(*) FROM chats",
        "messages" => "SELECT COUNT(*) FROM messages",
        _ => unreachable!("table name is internal and fixed"),
    };
    let count: i64 = connection.query_row(sql, [], |row| row.get(0))?;
    Ok(count.max(0) as u64)
}

fn string_field(value: &RelationalValue, key: &str) -> String {
    value
        .get(key)
        .and_then(RelationalValue::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_array(value: Option<&RelationalValue>) -> Vec<String> {
    value
        .and_then(RelationalValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(RelationalValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn native_modules(value: &RelationalValue) -> Vec<NativeModule> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value.as_object()?;
            let id = string_field(value, "id");
            if id.trim().is_empty() {
                return None;
            }
            Some(NativeModule {
                id,
                namespace: optional_string_field(value, "namespace")
                    .filter(|namespace| !namespace.trim().is_empty()),
                lore: lore_entries(value.get("lorebook")),
            })
        })
        .collect()
}

fn resolve_module_lore(
    context: &ModuleContext,
    character_ids: &[String],
    chat_ids: &[String],
) -> Vec<LoreEntry> {
    let selected = context
        .base_ids
        .iter()
        .chain(chat_ids)
        .chain(character_ids)
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    context
        .modules
        .iter()
        .filter(|module| {
            selected.contains(module.id.as_str())
                || module
                    .namespace
                    .as_deref()
                    .is_some_and(|namespace| selected.contains(namespace))
        })
        .filter(|module| seen_ids.insert(module.id.as_str()))
        .flat_map(|module| module.lore.iter().cloned())
        .collect()
}

fn lore_entries(value: Option<&RelationalValue>) -> Vec<LoreEntry> {
    value
        .and_then(RelationalValue::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(source_index, value)| lore_entry(value, source_index))
        .collect()
}

fn lore_entry(value: &RelationalValue, source_index: usize) -> Option<LoreEntry> {
    value.as_object()?;
    let extensions = value.get("extentions");
    Some(LoreEntry {
        source_index: Some(source_index),
        id: optional_string_field(value, "id"),
        key: string_field(value, "key"),
        second_key: string_field(value, "secondkey"),
        insertion_order: number_field(value, "insertorder")
            .filter(|value| value.is_finite())
            .map(|value| value as i64)
            .unwrap_or(100),
        name: string_field(value, "comment"),
        content: string_field(value, "content"),
        mode: optional_string_field(value, "mode").unwrap_or_else(|| "normal".into()),
        always_active: bool_field(value, "alwaysActive").unwrap_or(false),
        selective: bool_field(value, "selective").unwrap_or(false),
        use_regex: bool_field(value, "useRegex").unwrap_or(false),
        case_sensitive: extensions
            .and_then(|extensions| bool_field(extensions, "risu_case_sensitive"))
            .unwrap_or(false),
        activation_percent: number_field(value, "activationPercent")
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0) as u8),
    })
}

fn persona_from_value(value: &RelationalValue, source_index: usize) -> Option<Persona> {
    value.as_object()?;
    let name = optional_string_field(value, "name").unwrap_or_else(|| "User".into());
    Some(Persona {
        source_index,
        id: optional_string_field(value, "id").filter(|id| !id.trim().is_empty()),
        name: if name.trim().is_empty() {
            "User".into()
        } else {
            name
        },
        prompt: optional_string_field(value, "personaPrompt").unwrap_or_default(),
        note: optional_string_field(value, "note").unwrap_or_default(),
        icon: optional_string_field(value, "icon").unwrap_or_default(),
        large_portrait: bool_field(value, "largePortrait").unwrap_or(false),
        embedded_lore: lore_entries(
            value
                .get("embeddedModule")
                .and_then(|module| module.get("lorebook")),
        ),
    })
}

fn resolve_persona(personas: &[Persona], selected_index: usize, bound_id: Option<&str>) -> Persona {
    bound_id
        .and_then(|id| {
            personas
                .iter()
                .find(|persona| persona.id.as_deref() == Some(id))
        })
        .or_else(|| personas.get(selected_index))
        .or_else(|| personas.first())
        .cloned()
        .unwrap_or_else(|| Persona {
            name: "User".into(),
            ..Persona::default()
        })
}

fn character_lore_settings(
    value: Option<&RelationalValue>,
    defaults: &LoreSettings,
) -> LoreSettings {
    let Some(value) = value.filter(|value| value.as_object().is_some()) else {
        return defaults.clone();
    };
    LoreSettings {
        token_budget: number_field(value, "tokenBudget")
            .map(|value| bounded_usize(value, defaults.token_budget, 1_000_000))
            .unwrap_or(defaults.token_budget),
        scan_depth: number_field(value, "scanDepth")
            .map(|value| bounded_usize(value, defaults.scan_depth, 10_000))
            .unwrap_or(defaults.scan_depth),
        recursive_scanning: bool_field(value, "recursiveScanning")
            .unwrap_or(defaults.recursive_scanning),
        full_word_matching: bool_field(value, "fullWordMatching")
            .unwrap_or(defaults.full_word_matching),
    }
}

fn optional_string_field(value: &RelationalValue, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(RelationalValue::as_str)
        .map(str::to_owned)
}

fn bool_field(value: &RelationalValue, key: &str) -> Option<bool> {
    value.get(key).and_then(RelationalValue::as_bool)
}

fn number_field(value: &RelationalValue, key: &str) -> Option<f64> {
    value.get(key).and_then(RelationalValue::as_f64)
}

fn decode_hypa_v2(
    value: Option<&RelationalValue>,
    messages: &[Message],
) -> Result<Option<HypaV2State>, StorageError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let json = value
        .to_json_value()
        .ok_or(MemoryError::InvalidHypaV2State)?;
    HypaV2State::from_json_value(json, messages)
        .map(Some)
        .map_err(Into::into)
}

fn decode_hypa_v3(
    value: Option<&RelationalValue>,
    messages: &[Message],
    preserve_orphaned: bool,
) -> Result<Option<HypaV3State>, StorageError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let json = value
        .to_json_value()
        .ok_or(MemoryError::InvalidHypaV3State)?;
    HypaV3State::from_json_value(json, messages, preserve_orphaned)
        .map(Some)
        .map_err(Into::into)
}

fn bounded_usize(value: f64, fallback: usize, maximum: usize) -> usize {
    if !value.is_finite() || value < 0.0 {
        fallback
    } else {
        (value as usize).min(maximum)
    }
}

fn ratio_bps(value: f64, fallback: u16) -> u16 {
    if value.is_finite() {
        (value.clamp(0.0, 1.0) * 10_000.0).round() as u16
    } else {
        fallback
    }
}

fn apply_hypa_v3_settings(settings: &mut HypaV3Settings, value: &RelationalValue) {
    if let Some(value) = number_field(value, "memoryTokensRatio") {
        settings.memory_ratio_bps = ratio_bps(value, settings.memory_ratio_bps);
    }
    if let Some(value) = number_field(value, "extraSummarizationRatio") {
        settings.extra_summarization_ratio_bps =
            ratio_bps(value, settings.extra_summarization_ratio_bps);
    }
    if let Some(value) = number_field(value, "recentMemoryRatio") {
        settings.recent_ratio_bps = ratio_bps(value, settings.recent_ratio_bps);
    }
    if let Some(value) = number_field(value, "similarMemoryRatio") {
        settings.similar_ratio_bps = ratio_bps(value, settings.similar_ratio_bps);
    }
    if let Some(value) = number_field(value, "maxChatsPerSummary") {
        settings.max_messages_per_summary =
            bounded_usize(value, settings.max_messages_per_summary, 10_000).max(1);
    }
    if let Some(value) = number_field(value, "queryChatCount") {
        settings.query_message_count =
            bounded_usize(value, settings.query_message_count, 10_000).max(1);
    }
    settings.preserve_orphaned_memory =
        bool_field(value, "preserveOrphanedMemory").unwrap_or(settings.preserve_orphaned_memory);
    settings.do_not_summarize_user_messages = bool_field(value, "doNotSummarizeUserMessage")
        .unwrap_or(settings.do_not_summarize_user_messages);
    settings.enable_similarity_correction = bool_field(value, "enableSimilarityCorrection")
        .unwrap_or(settings.enable_similarity_correction);
    if let Some(separator) = optional_string_field(value, "summaryChunkSeparator") {
        settings.summary_chunk_separator = separator;
    }
    if let Some(prompt) = optional_string_field(value, "summarizationPrompt") {
        settings.summary_prompt = prompt;
    }
}

fn load_hypa_v3_settings(connection: &Connection) -> Result<HypaV3Settings, StorageError> {
    let mut settings = HypaV3Settings::default();
    let selected = load_setting_number(connection, "hypaV3PresetId")?
        .map(|value| bounded_usize(value, 0, 10_000))
        .unwrap_or(0);
    if let Some(presets) = load_setting_value(connection, "hypaV3Presets")?
        .as_ref()
        .and_then(RelationalValue::as_array)
        && let Some(preset) = presets.get(selected)
        && let Some(value) = preset.get("settings")
    {
        apply_hypa_v3_settings(&mut settings, value);
    } else if let Some(value) = load_setting_value(connection, "hypaV3Settings")? {
        apply_hypa_v3_settings(&mut settings, &value);
    }

    if let Some(value) = load_setting_number(connection, "nativeHypaV3MemoryRatioBps")? {
        settings.memory_ratio_bps =
            bounded_usize(value, settings.memory_ratio_bps.into(), 10_000) as u16;
    }
    if let Some(value) = load_setting_number(connection, "nativeHypaV3ExtraSummarizationRatioBps")?
    {
        settings.extra_summarization_ratio_bps =
            bounded_usize(value, settings.extra_summarization_ratio_bps.into(), 10_000) as u16;
    }
    if let Some(value) = load_setting_number(connection, "nativeHypaV3RecentRatioBps")? {
        settings.recent_ratio_bps =
            bounded_usize(value, settings.recent_ratio_bps.into(), 10_000) as u16;
    }
    if let Some(value) = load_setting_number(connection, "nativeHypaV3SimilarRatioBps")? {
        settings.similar_ratio_bps =
            bounded_usize(value, settings.similar_ratio_bps.into(), 10_000) as u16;
    }
    if let Some(value) = load_setting_number(connection, "nativeHypaV3MaxMessagesPerSummary")? {
        settings.max_messages_per_summary =
            bounded_usize(value, settings.max_messages_per_summary, 10_000).max(1);
    }
    if let Some(value) = load_setting_number(connection, "nativeHypaV3QueryMessageCount")? {
        settings.query_message_count =
            bounded_usize(value, settings.query_message_count, 10_000).max(1);
    }
    settings.preserve_orphaned_memory =
        load_setting_boolean(connection, "nativeHypaV3PreserveOrphanedMemory")?
            .unwrap_or(settings.preserve_orphaned_memory);
    settings.do_not_summarize_user_messages =
        load_setting_boolean(connection, "nativeHypaV3DoNotSummarizeUserMessages")?
            .unwrap_or(settings.do_not_summarize_user_messages);
    settings.enable_similarity_correction =
        load_setting_boolean(connection, "nativeHypaV3EnableSimilarityCorrection")?
            .unwrap_or(settings.enable_similarity_correction);
    settings.summary_chunk_separator =
        load_setting_string(connection, "nativeHypaV3SummaryChunkSeparator")?
            .unwrap_or(settings.summary_chunk_separator);
    settings.summary_prompt = load_setting_string(connection, "nativeHypaV3SummaryPrompt")?
        .unwrap_or(settings.summary_prompt);
    Ok(settings)
}

fn load_setting_value(
    connection: &Connection,
    key: &str,
) -> Result<Option<RelationalValue>, StorageError> {
    let rows = connection
        .prepare(
            "SELECT node_id, parent_node_id, node_order, object_key,
                    object_key_encoded, value_type, text_value,
                    encoded_text_value, number_value, boolean_value
               FROM setting_extension_nodes
              WHERE setting_key = ?1 ORDER BY node_id",
        )?
        .query_map([key], |row| {
            Ok(NodeRow {
                node_id: row.get(0)?,
                parent_node_id: row.get(1)?,
                node_order: row.get(2)?,
                object_key: row.get(3)?,
                object_key_encoded: row.get(4)?,
                value_type: row.get(5)?,
                text_value: row.get(6)?,
                encoded_text_value: row.get(7)?,
                number_value: row.get(8)?,
                boolean_value: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if !rows.is_empty() {
        return Ok(Some(decode_rows(rows)?));
    }
    let root = connection
        .query_row(
            "SELECT value_type, text_value, encoded_text_value,
                    number_value, boolean_value
               FROM system_settings WHERE key = ?1",
            [key],
            |row| {
                Ok(NodeRow {
                    node_id: 0,
                    parent_node_id: None,
                    node_order: 0,
                    object_key: None,
                    object_key_encoded: None,
                    value_type: row.get(0)?,
                    text_value: row.get(1)?,
                    encoded_text_value: row.get(2)?,
                    number_value: row.get(3)?,
                    boolean_value: row.get(4)?,
                })
            },
        )
        .optional()?;
    root.map(|root| decode_rows(vec![root]))
        .transpose()
        .map_err(Into::into)
}

fn load_setting_number(connection: &Connection, key: &str) -> Result<Option<f64>, StorageError> {
    let row = connection
        .query_row(
            "SELECT value_type, text_value, number_value
               FROM system_settings WHERE key = ?1",
            [key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((value_type, text, number)) = row else {
        return Ok(None);
    };
    if value_type != "number" {
        return Ok(None);
    }
    Ok(match text.as_deref() {
        Some("NaN") => Some(f64::NAN),
        Some("Infinity") => Some(f64::INFINITY),
        Some("-Infinity") => Some(f64::NEG_INFINITY),
        _ => number,
    })
}

fn load_setting_string(connection: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    let row = connection
        .query_row(
            "SELECT value_type, text_value, encoded_text_value
               FROM system_settings WHERE key = ?1",
            [key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((value_type, text, encoded)) = row else {
        return Ok(None);
    };
    if value_type != "string" {
        return Err(StorageError::InvalidProviderSetting(key.to_owned()));
    }
    Ok(Some(decode_text(text, encoded)?))
}

fn load_setting_boolean(connection: &Connection, key: &str) -> Result<Option<bool>, StorageError> {
    let row = connection
        .query_row(
            "SELECT value_type, boolean_value
               FROM system_settings WHERE key = ?1",
            [key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<bool>>(1)?)),
        )
        .optional()?;
    let Some((value_type, value)) = row else {
        return Ok(None);
    };
    Ok((value_type == "boolean").then_some(value).flatten())
}

fn upsert_setting_string(
    transaction: &Transaction<'_>,
    key: &str,
    domain: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    let (text, encoded) = encode_text(value);
    transaction.execute(
        "INSERT INTO system_settings
             (key, domain, value_type, text_value, encoded_text_value,
              number_value, boolean_value, updated_at)
         VALUES (?1, ?2, 'string', ?3, ?4, NULL, NULL, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
             domain = excluded.domain, value_type = 'string',
             text_value = excluded.text_value,
             encoded_text_value = excluded.encoded_text_value,
             number_value = NULL, boolean_value = NULL,
             updated_at = datetime('now')",
        params![key, domain, text, encoded],
    )?;
    Ok(())
}

fn upsert_setting_number(
    transaction: &Transaction<'_>,
    key: &str,
    domain: &str,
    value: f64,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO system_settings
             (key, domain, value_type, text_value, encoded_text_value,
              number_value, boolean_value, updated_at)
         VALUES (?1, ?2, 'number', NULL, NULL, ?3, NULL, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
             domain = excluded.domain, value_type = 'number',
             text_value = NULL, encoded_text_value = NULL,
             number_value = excluded.number_value, boolean_value = NULL,
             updated_at = datetime('now')",
        params![key, domain, value],
    )?;
    Ok(())
}

fn replace_setting_value(
    transaction: &Transaction<'_>,
    key: &str,
    domain: &str,
    value: &RelationalValue,
) -> Result<(), rusqlite::Error> {
    let columns = relational_columns(value);
    transaction.execute(
        "INSERT INTO system_settings
            (key, domain, value_type, text_value, encoded_text_value,
             number_value, boolean_value, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            domain = excluded.domain, value_type = excluded.value_type,
            text_value = excluded.text_value,
            encoded_text_value = excluded.encoded_text_value,
            number_value = excluded.number_value,
            boolean_value = excluded.boolean_value,
            updated_at = datetime('now')",
        params![
            key,
            domain,
            columns.kind,
            columns.text,
            columns.encoded_text,
            columns.number,
            columns.boolean
        ],
    )?;
    transaction.execute(
        "DELETE FROM setting_extension_nodes WHERE setting_key = ?1",
        [key],
    )?;
    transaction.execute(
        "INSERT INTO setting_extension_nodes
            (setting_key, node_id, parent_node_id, node_order, value_type,
             text_value, encoded_text_value, number_value, boolean_value)
         VALUES (?1, 0, NULL, 0, ?2, ?3, ?4, ?5, ?6)",
        params![
            key,
            columns.kind,
            columns.text,
            columns.encoded_text,
            columns.number,
            columns.boolean
        ],
    )?;
    let mut next_id = 1;
    insert_relational_children(
        transaction,
        ExtensionScope::Setting,
        key,
        0,
        value,
        &mut next_id,
    )
}

fn upsert_setting_boolean(
    transaction: &Transaction<'_>,
    key: &str,
    domain: &str,
    value: bool,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO system_settings
             (key, domain, value_type, text_value, encoded_text_value,
              number_value, boolean_value, updated_at)
         VALUES (?1, ?2, 'boolean', NULL, NULL, NULL, ?3, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
             domain = excluded.domain, value_type = 'boolean',
             text_value = NULL, encoded_text_value = NULL,
             number_value = NULL, boolean_value = excluded.boolean_value,
             updated_at = datetime('now')",
        params![key, domain, value],
    )?;
    Ok(())
}

fn validate_existing_schema(connection: &Connection) -> Result<(), StorageError> {
    let meta_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = 'system_storage_meta'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !meta_exists {
        return Ok(());
    }

    let (version, layout): (i64, String) = connection.query_row(
        "SELECT schema_version, schema_layout
           FROM system_storage_meta WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if version != SCHEMA_VERSION || layout != SCHEMA_LAYOUT {
        return Err(StorageError::SchemaMismatch { version, layout });
    }
    Ok(())
}

fn chat_belongs_to(
    transaction: &Transaction<'_>,
    chat_id: &str,
    character_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(transaction
        .query_row(
            "SELECT 1 FROM chats WHERE id = ?1 AND character_id = ?2",
            [chat_id, character_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn touch_conversation(
    transaction: &Transaction<'_>,
    character_id: &str,
    chat_id: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "UPDATE chats
            SET last_message_time = unixepoch() * 1000,
                messages_loaded = 1,
                updated_at = datetime('now')
          WHERE id = ?1",
        [chat_id],
    )?;
    transaction.execute(
        "UPDATE characters
            SET last_interaction_time = unixepoch() * 1000,
                modification_time = unixepoch() * 1000,
                updated_at = datetime('now')
          WHERE id = ?1",
        [character_id],
    )?;
    Ok(())
}

fn refresh_conversation_after_delete(
    transaction: &Transaction<'_>,
    character_id: &str,
    chat_id: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "UPDATE chats
            SET last_message_time = (
                    SELECT MAX(sent_time) FROM messages WHERE chat_id = ?1
                ),
                messages_loaded = 1,
                updated_at = datetime('now')
          WHERE id = ?1",
        [chat_id],
    )?;
    transaction.execute(
        "UPDATE characters
            SET last_interaction_time = unixepoch() * 1000,
                modification_time = unixepoch() * 1000,
                updated_at = datetime('now')
          WHERE id = ?1",
        [character_id],
    )?;
    Ok(())
}

fn clean_supa_memory_after_delete(
    data: Option<&str>,
    remaining_messages: &[Message],
) -> Result<Option<String>, StorageError> {
    let Some(data) = data else {
        return Ok(None);
    };
    let remaining = remaining_messages
        .iter()
        .map(|message| message.id.as_str())
        .collect::<HashSet<_>>();
    if data.starts_with("hypa:\n") {
        let mut state = HypaMemoryState::parse(data)?;
        state
            .entries
            .retain(|entry| remaining.contains(entry.id.as_str()));
        return if state.entries.is_empty() {
            Ok(None)
        } else {
            state.serialize().map(Some).map_err(Into::into)
        };
    }
    let state = SupaMemoryState::parse(Some(data))?;
    Ok(state
        .filter(|state| remaining.contains(state.checkpoint_id.as_str()))
        .map(|state| state.serialize()))
}

fn ensure_character_exists(
    transaction: &Transaction<'_>,
    character_id: &str,
) -> Result<(), StorageError> {
    let exists = transaction
        .query_row(
            "SELECT 1 FROM characters WHERE id = ?1 AND trash_time IS NULL",
            [character_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(StorageError::MissingConversation)
    }
}

fn validate_character_name(name: &str) -> Result<&str, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StorageError::EmptyCharacterName);
    }
    if name.chars().count() > 120 {
        return Err(StorageError::CharacterNameTooLong);
    }
    Ok(name)
}

#[derive(Clone, Copy)]
enum ExtensionScope {
    Character,
    Chat,
    Setting,
}

impl ExtensionScope {
    fn table(self) -> &'static str {
        match self {
            Self::Character => "character_extension_nodes",
            Self::Chat => "chat_extension_nodes",
            Self::Setting => "setting_extension_nodes",
        }
    }

    fn owner_column(self) -> &'static str {
        match self {
            Self::Character => "character_id",
            Self::Chat => "chat_id",
            Self::Setting => "setting_key",
        }
    }
}

fn load_extension_value(
    connection: &Connection,
    scope: ExtensionScope,
    owner_id: &str,
) -> Result<Option<RelationalValue>, StorageError> {
    let sql = format!(
        "SELECT node_id, parent_node_id, node_order, object_key,
                object_key_encoded, value_type, text_value,
                encoded_text_value, number_value, boolean_value
           FROM {} WHERE {} = ?1 ORDER BY node_id",
        scope.table(),
        scope.owner_column()
    );
    let rows = connection
        .prepare(&sql)?
        .query_map([owner_id], |row| {
            Ok(NodeRow {
                node_id: row.get(0)?,
                parent_node_id: row.get(1)?,
                node_order: row.get(2)?,
                object_key: row.get(3)?,
                object_key_encoded: row.get(4)?,
                value_type: row.get(5)?,
                text_value: row.get(6)?,
                encoded_text_value: row.get(7)?,
                number_value: row.get(8)?,
                boolean_value: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        Ok(None)
    } else {
        Ok(Some(decode_rows(rows)?))
    }
}

fn merge_lore_value(original: Option<&RelationalValue>, lore: &[LoreEntry]) -> RelationalValue {
    let originals = original
        .and_then(RelationalValue::as_array)
        .unwrap_or_default();
    let mut used = vec![false; originals.len()];
    let mut values = Vec::with_capacity(lore.len());
    for (index, entry) in lore.iter().enumerate() {
        let id_match = entry.id.as_deref().and_then(|id| {
            originals.iter().enumerate().find_map(|(candidate, value)| {
                (!used[candidate] && optional_string_field(value, "id").as_deref() == Some(id))
                    .then_some(candidate)
            })
        });
        let source_index = id_match
            .or_else(|| {
                entry
                    .source_index
                    .filter(|source_index| *source_index < originals.len() && !used[*source_index])
            })
            .or_else(|| (index < originals.len() && !used[index]).then_some(index));
        let source = source_index.map(|source_index| {
            used[source_index] = true;
            &originals[source_index]
        });
        values.push(merge_lore_entry(source, entry));
    }
    RelationalValue::Array(values)
}

fn merge_personas_value(
    original: Option<&RelationalValue>,
    personas: &[Persona],
) -> RelationalValue {
    let originals = original
        .and_then(RelationalValue::as_array)
        .unwrap_or_default();
    let mut used = vec![false; originals.len()];
    RelationalValue::Array(
        personas
            .iter()
            .enumerate()
            .map(|(index, persona)| {
                let source_index = persona
                    .id
                    .as_deref()
                    .and_then(|id| {
                        originals.iter().enumerate().find_map(|(candidate, value)| {
                            (!used[candidate]
                                && optional_string_field(value, "id").as_deref() == Some(id))
                            .then_some(candidate)
                        })
                    })
                    .or_else(|| {
                        (persona.source_index < originals.len() && !used[persona.source_index])
                            .then_some(persona.source_index)
                    })
                    .or_else(|| (index < originals.len() && !used[index]).then_some(index));
                let mut fields = source_index
                    .map(|source_index| {
                        used[source_index] = true;
                        originals[source_index]
                            .as_object()
                            .map(<[(String, RelationalValue)]>::to_vec)
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                for (key, value) in [
                    ("name", persona.name.as_str()),
                    ("personaPrompt", persona.prompt.as_str()),
                    ("note", persona.note.as_str()),
                    ("icon", persona.icon.as_str()),
                ] {
                    set_object_field(
                        &mut fields,
                        key,
                        Some(RelationalValue::String(value.to_owned())),
                    );
                }
                set_object_field(
                    &mut fields,
                    "id",
                    persona.id.clone().map(RelationalValue::String),
                );
                set_object_field(
                    &mut fields,
                    "largePortrait",
                    Some(RelationalValue::Boolean(persona.large_portrait)),
                );
                RelationalValue::Object(fields)
            })
            .collect(),
    )
}

fn merge_lore_entry(original: Option<&RelationalValue>, lore: &LoreEntry) -> RelationalValue {
    let mut fields = original
        .and_then(RelationalValue::as_object)
        .map(<[(String, RelationalValue)]>::to_vec)
        .unwrap_or_default();
    set_object_field(
        &mut fields,
        "id",
        lore.id.clone().map(RelationalValue::String),
    );
    for (key, value) in [
        ("key", lore.key.as_str()),
        ("secondkey", lore.second_key.as_str()),
        ("comment", lore.name.as_str()),
        ("content", lore.content.as_str()),
        ("mode", lore.mode.as_str()),
    ] {
        set_object_field(
            &mut fields,
            key,
            Some(RelationalValue::String(value.to_owned())),
        );
    }
    set_object_field(
        &mut fields,
        "insertorder",
        Some(RelationalValue::Number(lore.insertion_order as f64)),
    );
    for (key, value) in [
        ("alwaysActive", lore.always_active),
        ("selective", lore.selective),
        ("useRegex", lore.use_regex),
    ] {
        set_object_field(&mut fields, key, Some(RelationalValue::Boolean(value)));
    }
    set_object_field(
        &mut fields,
        "activationPercent",
        lore.activation_percent
            .map(|value| RelationalValue::Number(f64::from(value))),
    );

    let mut extensions = fields
        .iter()
        .find_map(|(key, value)| (key == "extentions").then_some(value))
        .and_then(RelationalValue::as_object)
        .map(<[(String, RelationalValue)]>::to_vec)
        .unwrap_or_default();
    set_object_field(
        &mut extensions,
        "risu_case_sensitive",
        Some(RelationalValue::Boolean(lore.case_sensitive)),
    );
    set_object_field(
        &mut fields,
        "extentions",
        Some(RelationalValue::Object(extensions)),
    );
    RelationalValue::Object(fields)
}

fn merge_lore_settings_value(
    original: Option<&RelationalValue>,
    settings: &LoreSettings,
) -> RelationalValue {
    let mut fields = original
        .and_then(RelationalValue::as_object)
        .map(<[(String, RelationalValue)]>::to_vec)
        .unwrap_or_default();
    for (key, value) in [
        ("tokenBudget", settings.token_budget),
        ("scanDepth", settings.scan_depth),
    ] {
        set_object_field(
            &mut fields,
            key,
            Some(RelationalValue::Number(value as f64)),
        );
    }
    for (key, value) in [
        ("recursiveScanning", settings.recursive_scanning),
        ("fullWordMatching", settings.full_word_matching),
    ] {
        set_object_field(&mut fields, key, Some(RelationalValue::Boolean(value)));
    }
    RelationalValue::Object(fields)
}

fn merge_hypa_v2_value(original: Option<&RelationalValue>, state: &HypaV2State) -> RelationalValue {
    let mut fields = original
        .and_then(RelationalValue::as_object)
        .map(<[(String, RelationalValue)]>::to_vec)
        .unwrap_or_default();
    set_object_field(
        &mut fields,
        "lastMainChunkID",
        Some(RelationalValue::Number(state.last_main_chunk_id as f64)),
    );

    let original_main = original
        .and_then(|value| value.get("mainChunks"))
        .and_then(RelationalValue::as_array)
        .unwrap_or_default();
    let main_chunks = state
        .main_chunks
        .iter()
        .map(|chunk| {
            let source = original_main
                .iter()
                .find(|value| number_field(value, "id").is_some_and(|id| id as i64 == chunk.id));
            let mut entry = source
                .and_then(RelationalValue::as_object)
                .map(<[(String, RelationalValue)]>::to_vec)
                .unwrap_or_default();
            set_object_field(
                &mut entry,
                "id",
                Some(RelationalValue::Number(chunk.id as f64)),
            );
            set_object_field(
                &mut entry,
                "text",
                Some(RelationalValue::String(chunk.text.clone())),
            );
            set_object_field(
                &mut entry,
                "chatMemos",
                Some(RelationalValue::Array(
                    chunk
                        .chat_memos
                        .iter()
                        .cloned()
                        .map(RelationalValue::String)
                        .collect(),
                )),
            );
            set_object_field(
                &mut entry,
                "lastChatMemo",
                Some(RelationalValue::String(chunk.last_chat_memo.clone())),
            );
            RelationalValue::Object(entry)
        })
        .collect();
    set_object_field(
        &mut fields,
        "mainChunks",
        Some(RelationalValue::Array(main_chunks)),
    );

    let original_chunks = original
        .and_then(|value| value.get("chunks"))
        .and_then(RelationalValue::as_array)
        .unwrap_or_default();
    let mut used = vec![false; original_chunks.len()];
    let chunks = state
        .chunks
        .iter()
        .map(|chunk| {
            let source_index = original_chunks
                .iter()
                .enumerate()
                .find_map(|(index, value)| {
                    (!used[index]
                        && number_field(value, "mainChunkID")
                            .is_some_and(|id| id as i64 == chunk.main_chunk_id)
                        && optional_string_field(value, "text").as_deref()
                            == Some(chunk.text.as_str()))
                    .then_some(index)
                });
            let mut entry = source_index
                .map(|index| {
                    used[index] = true;
                    &original_chunks[index]
                })
                .and_then(RelationalValue::as_object)
                .map(<[(String, RelationalValue)]>::to_vec)
                .unwrap_or_default();
            set_object_field(
                &mut entry,
                "mainChunkID",
                Some(RelationalValue::Number(chunk.main_chunk_id as f64)),
            );
            set_object_field(
                &mut entry,
                "text",
                Some(RelationalValue::String(chunk.text.clone())),
            );
            RelationalValue::Object(entry)
        })
        .collect();
    set_object_field(&mut fields, "chunks", Some(RelationalValue::Array(chunks)));
    RelationalValue::Object(fields)
}

fn merge_hypa_v3_value(original: Option<&RelationalValue>, state: &HypaV3State) -> RelationalValue {
    let mut fields = original
        .and_then(RelationalValue::as_object)
        .map(<[(String, RelationalValue)]>::to_vec)
        .unwrap_or_default();
    let original_summaries = original
        .and_then(|value| value.get("summaries"))
        .and_then(RelationalValue::as_array)
        .unwrap_or_default();
    let mut used = vec![false; original_summaries.len()];
    let summaries = state
        .summaries
        .iter()
        .map(|summary| {
            let source_index = original_summaries
                .iter()
                .enumerate()
                .find_map(|(index, value)| {
                    if used[index] {
                        return None;
                    }
                    let memos = string_array(value.get("chatMemos"));
                    (memos == summary.chat_memos
                        || (memos.is_empty()
                            && optional_string_field(value, "text").as_deref()
                                == Some(summary.text.as_str())))
                    .then_some(index)
                });
            let mut entry = source_index
                .map(|index| {
                    used[index] = true;
                    &original_summaries[index]
                })
                .and_then(RelationalValue::as_object)
                .map(<[(String, RelationalValue)]>::to_vec)
                .unwrap_or_default();
            set_object_field(
                &mut entry,
                "text",
                Some(RelationalValue::String(summary.text.clone())),
            );
            set_object_field(
                &mut entry,
                "chatMemos",
                Some(RelationalValue::Array(
                    summary
                        .chat_memos
                        .iter()
                        .cloned()
                        .map(RelationalValue::String)
                        .collect(),
                )),
            );
            set_object_field(
                &mut entry,
                "isImportant",
                Some(RelationalValue::Boolean(summary.is_important)),
            );
            set_object_field(
                &mut entry,
                "categoryId",
                summary
                    .category_id
                    .as_ref()
                    .map(|value| RelationalValue::String(value.clone())),
            );
            set_object_field(
                &mut entry,
                "tags",
                Some(RelationalValue::Array(
                    summary
                        .tags
                        .iter()
                        .cloned()
                        .map(RelationalValue::String)
                        .collect(),
                )),
            );
            RelationalValue::Object(entry)
        })
        .collect();
    set_object_field(
        &mut fields,
        "summaries",
        Some(RelationalValue::Array(summaries)),
    );
    set_object_field(
        &mut fields,
        "categories",
        state.categories.as_ref().map(|categories| {
            let original_categories = original
                .and_then(|value| value.get("categories"))
                .and_then(RelationalValue::as_array)
                .unwrap_or_default();
            RelationalValue::Array(
                categories
                    .iter()
                    .map(|category| {
                        let mut entry = original_categories
                            .iter()
                            .find(|value| {
                                optional_string_field(value, "id").as_deref()
                                    == Some(category.id.as_str())
                            })
                            .and_then(RelationalValue::as_object)
                            .map(<[(String, RelationalValue)]>::to_vec)
                            .unwrap_or_default();
                        set_object_field(
                            &mut entry,
                            "id",
                            Some(RelationalValue::String(category.id.clone())),
                        );
                        set_object_field(
                            &mut entry,
                            "name",
                            Some(RelationalValue::String(category.name.clone())),
                        );
                        RelationalValue::Object(entry)
                    })
                    .collect(),
            )
        }),
    );
    set_object_field(
        &mut fields,
        "metrics",
        state.metrics.as_ref().map(|metrics| {
            let mut entry = original
                .and_then(|value| value.get("metrics"))
                .and_then(RelationalValue::as_object)
                .map(<[(String, RelationalValue)]>::to_vec)
                .unwrap_or_default();
            for (key, values) in [
                ("lastImportantSummaries", &metrics.last_important_summaries),
                ("lastRecentSummaries", &metrics.last_recent_summaries),
                ("lastSimilarSummaries", &metrics.last_similar_summaries),
                ("lastRandomSummaries", &metrics.last_random_summaries),
            ] {
                set_object_field(
                    &mut entry,
                    key,
                    Some(RelationalValue::Array(
                        values
                            .iter()
                            .map(|value| RelationalValue::Number(*value as f64))
                            .collect(),
                    )),
                );
            }
            RelationalValue::Object(entry)
        }),
    );
    set_object_field(
        &mut fields,
        "modalSettings",
        state
            .modal_settings
            .clone()
            .map(RelationalValue::from_json_value),
    );
    set_object_field(&mut fields, "lastSelectedSummaries", None);
    RelationalValue::Object(fields)
}

fn set_object_field(
    fields: &mut Vec<(String, RelationalValue)>,
    key: &str,
    value: Option<RelationalValue>,
) {
    if let Some(index) = fields.iter().position(|(field, _)| field == key) {
        if let Some(value) = value {
            fields[index].1 = value;
        } else {
            fields.remove(index);
        }
    } else if let Some(value) = value {
        fields.push((key.to_owned(), value));
    }
}

fn replace_extension_field(
    transaction: &Transaction<'_>,
    scope: ExtensionScope,
    owner_id: &str,
    key: &str,
    value: &RelationalValue,
) -> Result<(), rusqlite::Error> {
    let table = scope.table();
    let owner_column = scope.owner_column();
    let node_id = transaction
        .query_row(
            &format!(
                "SELECT node_id FROM {table}
                  WHERE {owner_column} = ?1 AND parent_node_id = 0 AND object_key = ?2
                  ORDER BY node_order, node_id LIMIT 1"
            ),
            params![owner_id, key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let (node_id, node_order) = match node_id {
        Some(node_id) => {
            let node_order = transaction.query_row(
                &format!(
                    "SELECT node_order FROM {table}
                      WHERE {owner_column} = ?1 AND node_id = ?2"
                ),
                params![owner_id, node_id],
                |row| row.get::<_, i64>(0),
            )?;
            transaction.execute(
                &format!(
                    "WITH RECURSIVE descendants(node_id) AS (
                         SELECT node_id FROM {table}
                          WHERE {owner_column} = ?1 AND parent_node_id = ?2
                         UNION ALL
                         SELECT child.node_id FROM {table} child
                         JOIN descendants parent ON child.parent_node_id = parent.node_id
                          WHERE child.{owner_column} = ?1
                     )
                     DELETE FROM {table}
                      WHERE {owner_column} = ?1
                        AND node_id IN (SELECT node_id FROM descendants)"
                ),
                params![owner_id, node_id],
            )?;
            (node_id, node_order)
        }
        None => transaction.query_row(
            &format!(
                "SELECT COALESCE(MAX(node_id), -1) + 1,
                        COALESCE(MAX(CASE WHEN parent_node_id = 0 THEN node_order END), -1) + 1
                   FROM {table} WHERE {owner_column} = ?1"
            ),
            [owner_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?,
    };
    let columns = relational_columns(value);
    if node_id == 0 {
        debug_assert_eq!(key, "");
    }
    transaction.execute(
        &format!(
            "INSERT INTO {table}
                 ({owner_column}, node_id, parent_node_id, node_order, object_key,
                  object_key_encoded, value_type, text_value, encoded_text_value,
                  number_value, boolean_value)
             VALUES (?1, ?2, 0, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT({owner_column}, node_id) DO UPDATE SET
                 value_type = excluded.value_type,
                 text_value = excluded.text_value,
                 encoded_text_value = excluded.encoded_text_value,
                 number_value = excluded.number_value,
                 boolean_value = excluded.boolean_value"
        ),
        params![
            owner_id,
            node_id,
            node_order,
            key,
            columns.kind,
            columns.text,
            columns.encoded_text,
            columns.number,
            columns.boolean
        ],
    )?;
    let mut next_id: i64 = transaction.query_row(
        &format!("SELECT COALESCE(MAX(node_id), -1) + 1 FROM {table} WHERE {owner_column} = ?1"),
        [owner_id],
        |row| row.get(0),
    )?;
    insert_relational_children(transaction, scope, owner_id, node_id, value, &mut next_id)
}

fn ensure_extension_root(
    transaction: &Transaction<'_>,
    scope: ExtensionScope,
    owner_id: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        &format!(
            "INSERT OR IGNORE INTO {}
                 ({}, node_id, parent_node_id, node_order, value_type)
             VALUES (?1, 0, NULL, 0, 'object')",
            scope.table(),
            scope.owner_column()
        ),
        [owner_id],
    )?;
    Ok(())
}

struct RelationalColumns {
    kind: &'static str,
    text: Option<String>,
    encoded_text: Option<String>,
    number: Option<f64>,
    boolean: Option<i64>,
}

fn relational_columns(value: &RelationalValue) -> RelationalColumns {
    match value {
        RelationalValue::Null => RelationalColumns {
            kind: "null",
            text: None,
            encoded_text: None,
            number: None,
            boolean: None,
        },
        RelationalValue::Undefined => RelationalColumns {
            kind: "undefined",
            text: None,
            encoded_text: None,
            number: None,
            boolean: None,
        },
        RelationalValue::Boolean(value) => RelationalColumns {
            kind: "boolean",
            text: None,
            encoded_text: None,
            number: None,
            boolean: Some(i64::from(*value)),
        },
        RelationalValue::Number(value) => {
            let text = if value.is_nan() {
                Some("NaN".into())
            } else if *value == f64::INFINITY {
                Some("Infinity".into())
            } else if *value == f64::NEG_INFINITY {
                Some("-Infinity".into())
            } else {
                None
            };
            RelationalColumns {
                kind: "number",
                text,
                encoded_text: None,
                number: value.is_finite().then_some(*value),
                boolean: None,
            }
        }
        RelationalValue::String(value) => {
            let (text, encoded_text) = encode_text(value);
            RelationalColumns {
                kind: "string",
                text,
                encoded_text,
                number: None,
                boolean: None,
            }
        }
        RelationalValue::Array(_) => RelationalColumns {
            kind: "array",
            text: None,
            encoded_text: None,
            number: None,
            boolean: None,
        },
        RelationalValue::Object(_) => RelationalColumns {
            kind: "object",
            text: None,
            encoded_text: None,
            number: None,
            boolean: None,
        },
    }
}

fn insert_relational_children(
    transaction: &Transaction<'_>,
    scope: ExtensionScope,
    owner_id: &str,
    parent_id: i64,
    value: &RelationalValue,
    next_id: &mut i64,
) -> Result<(), rusqlite::Error> {
    match value {
        RelationalValue::Array(values) => {
            for (order, value) in values.iter().enumerate() {
                insert_relational_node(
                    transaction,
                    scope,
                    owner_id,
                    parent_id,
                    order as i64,
                    None,
                    value,
                    next_id,
                )?;
            }
        }
        RelationalValue::Object(values) => {
            for (order, (key, value)) in values.iter().enumerate() {
                insert_relational_node(
                    transaction,
                    scope,
                    owner_id,
                    parent_id,
                    order as i64,
                    Some(key),
                    value,
                    next_id,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_relational_node(
    transaction: &Transaction<'_>,
    scope: ExtensionScope,
    owner_id: &str,
    parent_id: i64,
    order: i64,
    key: Option<&str>,
    value: &RelationalValue,
    next_id: &mut i64,
) -> Result<(), rusqlite::Error> {
    let node_id = *next_id;
    *next_id += 1;
    let (object_key, object_key_encoded) = key.map(encode_text).unwrap_or((None, None));
    let columns = relational_columns(value);
    transaction.execute(
        &format!(
            "INSERT INTO {}
                 ({}, node_id, parent_node_id, node_order, object_key,
                  object_key_encoded, value_type, text_value, encoded_text_value,
                  number_value, boolean_value)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            scope.table(),
            scope.owner_column()
        ),
        params![
            owner_id,
            node_id,
            parent_id,
            order,
            object_key,
            object_key_encoded,
            columns.kind,
            columns.text,
            columns.encoded_text,
            columns.number,
            columns.boolean
        ],
    )?;
    insert_relational_children(transaction, scope, owner_id, node_id, value, next_id)
}

fn upsert_character_string_field(
    transaction: &Transaction<'_>,
    character_id: &str,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    let node_id = transaction
        .query_row(
            "SELECT node_id
               FROM character_extension_nodes
              WHERE character_id = ?1 AND parent_node_id = 0 AND object_key = ?2
              ORDER BY node_order, node_id LIMIT 1",
            params![character_id, key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let (text_value, encoded_text_value) = encode_text(value);
    if let Some(node_id) = node_id {
        transaction.execute(
            "WITH RECURSIVE descendants(node_id) AS (
                 SELECT node_id FROM character_extension_nodes
                  WHERE character_id = ?1 AND parent_node_id = ?2
                 UNION ALL
                 SELECT child.node_id FROM character_extension_nodes child
                 JOIN descendants parent ON child.parent_node_id = parent.node_id
                  WHERE child.character_id = ?1
             )
             DELETE FROM character_extension_nodes
              WHERE character_id = ?1 AND node_id IN (SELECT node_id FROM descendants)",
            params![character_id, node_id],
        )?;
        transaction.execute(
            "UPDATE character_extension_nodes
                SET value_type = 'string', text_value = ?3, encoded_text_value = ?4,
                    number_value = NULL, boolean_value = NULL
              WHERE character_id = ?1 AND node_id = ?2",
            params![character_id, node_id, text_value, encoded_text_value],
        )?;
    } else {
        let (next_id, next_order): (i64, i64) = transaction.query_row(
            "SELECT COALESCE(MAX(node_id), -1) + 1,
                    COALESCE(MAX(CASE WHEN parent_node_id = 0 THEN node_order END), -1) + 1
               FROM character_extension_nodes WHERE character_id = ?1",
            [character_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        transaction.execute(
            "INSERT INTO character_extension_nodes
                 (character_id, node_id, parent_node_id, node_order, object_key,
                  value_type, text_value, encoded_text_value)
             VALUES (?1, ?2, 0, ?3, ?4, 'string', ?5, ?6)",
            params![
                character_id,
                next_id,
                next_order,
                key,
                text_value,
                encoded_text_value
            ],
        )?;
    }
    Ok(())
}

fn create_chat(
    transaction: &Transaction<'_>,
    character_id: &str,
) -> Result<String, rusqlite::Error> {
    let chat_id = Uuid::new_v4().to_string();
    let position: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM chats WHERE character_id = ?1",
        [character_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO chats
             (id, character_id, position, name, messages_loaded)
         VALUES (?1, ?2, ?3, ?4, 1)",
        params![
            chat_id,
            character_id,
            position,
            format!("Chat {}", position + 1)
        ],
    )?;
    transaction.execute(
        "INSERT INTO chat_extension_nodes
             (chat_id, node_id, parent_node_id, node_order, value_type)
         VALUES (?1, 0, NULL, 0, 'object')",
        [&chat_id],
    )?;
    Ok(chat_id)
}

fn bump_revision(transaction: &Transaction<'_>, action: &str) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "UPDATE system_storage_meta
            SET initialized = 1, revision = revision + 1, updated_at = datetime('now')
          WHERE singleton = 1",
        [],
    )?;
    transaction.execute(
        "INSERT INTO system_revisions
             (storage_revision, database_initialized, scope, action)
         SELECT revision, initialized, 'database', ?1
           FROM system_storage_meta WHERE singleton = 1",
        [action],
    )?;
    Ok(())
}

fn seed_character(
    transaction: &Transaction<'_>,
    character_id: &str,
    position: i64,
    kind: &str,
    name: &str,
    greeting: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO characters
             (id, position, kind, name, creation_time, modification_time, details_loaded)
         VALUES (?1, ?2, ?3, ?4, unixepoch() * 1000, unixepoch() * 1000, 1)",
        params![character_id, position, kind, name],
    )?;
    transaction.execute(
        "INSERT INTO character_extension_nodes
             (character_id, node_id, parent_node_id, node_order, value_type)
         VALUES (?1, 0, NULL, 0, 'object')",
        [character_id],
    )?;
    let chat_id = format!("{character_id}-chat");
    transaction.execute(
        "INSERT INTO chats
             (id, character_id, position, name, last_message_time, messages_loaded)
         VALUES (?1, ?2, 0, 'Chat', unixepoch() * 1000, 1)",
        params![chat_id, character_id],
    )?;
    transaction.execute(
        "INSERT INTO chat_extension_nodes
             (chat_id, node_id, parent_node_id, node_order, value_type)
         VALUES (?1, 0, NULL, 0, 'object')",
        [&chat_id],
    )?;
    transaction.execute(
        "INSERT INTO messages
             (chat_id, id, position, role, content_text, sent_time)
         VALUES (?1, ?2, 0, 'char', ?3, unixepoch() * 1000)",
        params![chat_id, format!("{character_id}-greeting"), greeting],
    )?;
    Ok(())
}

fn encode_text(value: &str) -> (Option<String>, Option<String>) {
    if !value.contains('\0') {
        return (Some(value.to_owned()), None);
    }

    let bytes = value
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    (None, Some(BASE64.encode(bytes)))
}

fn decode_text(text: Option<String>, encoded: Option<String>) -> Result<String, StorageError> {
    let Some(encoded) = encoded else {
        return Ok(text.unwrap_or_default());
    };
    let bytes = BASE64.decode(encoded)?;
    if bytes.len() % 2 != 0 {
        return String::from_utf16(&[0xD800]).map_err(StorageError::from);
    }
    let code_units = bytes
        .chunks_exact(2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    Ok(String::from_utf16(&code_units)?)
}

fn initials(name: &str) -> String {
    let initials = name
        .split_whitespace()
        .filter_map(|word| word.chars().next())
        .take(2)
        .collect::<String>();
    if initials.is_empty() {
        "?".into()
    } else {
        initials
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{
        HypaV2Chunk, HypaV2MainChunk, HypaV3Category, HypaV3Metrics, HypaV3Summary,
    };

    fn repository() -> (tempfile::TempDir, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repository = Repository::open(directory.path().join("risu.sqlite3")).unwrap();
        (directory, repository)
    }

    fn write_setting_value(repository: &mut Repository, key: &str, value: &RelationalValue) {
        let transaction = repository.connection.transaction().unwrap();
        let columns = relational_columns(value);
        transaction
            .execute(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value, encoded_text_value,
                     number_value, boolean_value)
                 VALUES (?1, 'test', ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(key) DO UPDATE SET
                    value_type = excluded.value_type,
                    text_value = excluded.text_value,
                    encoded_text_value = excluded.encoded_text_value,
                    number_value = excluded.number_value,
                    boolean_value = excluded.boolean_value",
                params![
                    key,
                    columns.kind,
                    columns.text.as_deref(),
                    columns.encoded_text.as_deref(),
                    columns.number,
                    columns.boolean,
                ],
            )
            .unwrap();
        transaction
            .execute(
                "DELETE FROM setting_extension_nodes WHERE setting_key = ?1",
                [key],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO setting_extension_nodes
                    (setting_key, node_id, parent_node_id, node_order, value_type,
                     text_value, encoded_text_value, number_value, boolean_value)
                 VALUES (?1, 0, NULL, 0, ?2, ?3, ?4, ?5, ?6)",
                params![
                    key,
                    columns.kind,
                    columns.text.as_deref(),
                    columns.encoded_text.as_deref(),
                    columns.number,
                    columns.boolean,
                ],
            )
            .unwrap();
        let mut next_id = 1;
        insert_relational_children(
            &transaction,
            ExtensionScope::Setting,
            key,
            0,
            value,
            &mut next_id,
        )
        .unwrap();
        transaction.commit().unwrap();
    }

    #[test]
    fn a_new_database_uses_the_shared_schema_and_seeds_characters() {
        let (_directory, repository) = repository();
        let characters = repository.load_characters().unwrap();

        assert_eq!(characters.len(), 3);
        assert_eq!(characters[0].name, "Risu");
        assert_eq!(characters[0].messages.len(), 1);
    }

    #[test]
    fn personas_load_with_chat_binding_and_save_without_losing_unknown_or_embedded_fields() {
        let (_directory, mut repository) = repository();
        let personas = RelationalValue::Array(vec![
            RelationalValue::Object(vec![
                ("id".into(), RelationalValue::String("persona-a".into())),
                ("name".into(), RelationalValue::String("Alice".into())),
                (
                    "personaPrompt".into(),
                    RelationalValue::String("Alice prompt".into()),
                ),
                (
                    "futureField".into(),
                    RelationalValue::String("preserve me".into()),
                ),
            ]),
            RelationalValue::Object(vec![
                ("id".into(), RelationalValue::String("persona-b".into())),
                ("name".into(), RelationalValue::String("Bob".into())),
                (
                    "personaPrompt".into(),
                    RelationalValue::String("{{user}} prompt".into()),
                ),
                (
                    "embeddedModule".into(),
                    RelationalValue::Object(vec![(
                        "lorebook".into(),
                        RelationalValue::Array(vec![RelationalValue::Object(vec![
                            ("key".into(), RelationalValue::String(String::new())),
                            (
                                "content".into(),
                                RelationalValue::String("persona lore".into()),
                            ),
                            ("alwaysActive".into(), RelationalValue::Boolean(true)),
                        ])]),
                    )]),
                ),
            ]),
        ]);
        write_setting_value(&mut repository, "personas", &personas);
        write_setting_value(
            &mut repository,
            "selectedPersona",
            &RelationalValue::Number(0.0),
        );
        let character = repository.load_characters().unwrap().remove(0);
        let chat_id = character.chat_id.clone().unwrap();
        let transaction = repository.connection.transaction().unwrap();
        replace_extension_field(
            &transaction,
            ExtensionScope::Chat,
            &chat_id,
            "bindedPersona",
            &RelationalValue::String("persona-b".into()),
        )
        .unwrap();
        transaction.commit().unwrap();

        let character = repository.load_characters().unwrap().remove(0);
        assert_eq!(character.persona.name, "Bob");
        assert_eq!(character.bound_persona_id.as_deref(), Some("persona-b"));
        assert_eq!(character.persona.embedded_lore[0].content, "persona lore");
        let mut loaded = repository.load_personas().unwrap();
        loaded[0].name = "Alice edited".into();
        let saved = repository
            .save_personas(&loaded, 0, &character.id, &chat_id, false)
            .unwrap();
        assert_eq!(saved.personas[0].name, "Alice edited");
        assert!(saved.bound_persona_id.is_none());
        let stored = load_setting_value(&repository.connection, "personas")
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.as_array().unwrap()[0]
                .get("futureField")
                .and_then(RelationalValue::as_str),
            Some("preserve me")
        );
        assert!(
            stored.as_array().unwrap()[1]
                .get("embeddedModule")
                .is_some()
        );
        assert_eq!(repository.load_selected_persona_index().unwrap(), 0);
        assert!(
            repository
                .load_chat_context(&chat_id)
                .unwrap()
                .bound_persona_id
                .is_none()
        );
    }

    #[test]
    fn persona_catalog_selection_and_chat_binding_roll_back_together() {
        let (_directory, mut repository) = repository();
        let character = repository.load_characters().unwrap().remove(0);
        let chat_id = character.chat_id.unwrap();
        let before = repository.load_personas().unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_persona_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();
        let mut changed = before.clone();
        changed[0].name = "must roll back".into();

        assert!(
            repository
                .save_personas(&changed, 0, &character.id, &chat_id, true)
                .is_err()
        );
        assert_eq!(repository.load_personas().unwrap(), before);
        assert!(
            repository
                .load_chat_context(&chat_id)
                .unwrap()
                .bound_persona_id
                .is_none()
        );
    }

    #[test]
    fn native_provider_settings_store_only_public_configuration_and_credential_reference() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("risu.sqlite3");
        let settings = ProviderSettings {
            provider_kind: ProviderKind::Anthropic,
            base_url: "https://llm.example/v1".into(),
            model: "native-model".into(),
            max_context_tokens: 16_384,
            max_output_tokens: 777,
            memory_mode: MemoryMode::Hypa,
            embedding_model: "text-embedding-3-large".into(),
            memory_allocated_tokens: 4_096,
            memory_chunk_tokens: 2_048,
            hypa_v3: HypaV3Settings::default(),
            credential_id: Some("credential-reference-only".into()),
        };
        {
            let mut repository = Repository::open(&path).unwrap();
            repository.save_provider_settings(&settings).unwrap();
            assert_eq!(
                repository.load_provider_settings().unwrap(),
                Some(settings.clone())
            );
        }

        let database_bytes = fs::read(&path).unwrap();
        assert!(
            !database_bytes
                .windows(b"actual-api-secret".len())
                .any(|window| window == b"actual-api-secret")
        );
        let repository = Repository::open(&path).unwrap();
        assert_eq!(repository.load_provider_settings().unwrap(), Some(settings));
    }

    #[test]
    fn provider_settings_without_native_token_limits_load_compatible_defaults() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute_batch(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value)
                 VALUES
                    ('nativeProviderModel', 'model', 'string', 'legacy-native-model'),
                    ('nativeProviderBaseUrl', 'model', 'string', 'http://127.0.0.1:11434/v1');",
            )
            .unwrap();
        assert_eq!(
            repository.load_provider_settings().unwrap(),
            Some(ProviderSettings {
                provider_kind: ProviderKind::OpenAiCompatible,
                base_url: "http://127.0.0.1:11434/v1".into(),
                model: "legacy-native-model".into(),
                max_context_tokens: DEFAULT_CONTEXT_TOKENS,
                max_output_tokens: DEFAULT_OUTPUT_TOKENS,
                memory_mode: MemoryMode::Supa,
                embedding_model: DEFAULT_EMBEDDING_MODEL.into(),
                memory_allocated_tokens: DEFAULT_MEMORY_ALLOCATED_TOKENS,
                memory_chunk_tokens: DEFAULT_MEMORY_CHUNK_TOKENS,
                hypa_v3: HypaV3Settings::default(),
                credential_id: None,
            })
        );
    }

    #[test]
    fn legacy_hypa_settings_seed_native_memory_mode_and_embedding_model() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute_batch(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value, boolean_value)
                 VALUES
                    ('nativeProviderModel', 'model', 'string', 'native-model', NULL),
                    ('hypaMemory', 'model', 'boolean', NULL, 1),
                    ('hypaModel', 'model', 'string', 'openai3large', NULL);",
            )
            .unwrap();

        let settings = repository.load_provider_settings().unwrap().unwrap();
        assert_eq!(settings.memory_mode, MemoryMode::Hypa);
        assert_eq!(settings.embedding_model, "text-embedding-3-large");
    }

    #[test]
    fn legacy_hypa_v2_settings_take_priority_and_seed_token_budgets() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute_batch(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value, number_value, boolean_value)
                 VALUES
                    ('nativeProviderModel', 'model', 'string', 'native-model', NULL, NULL),
                    ('hypaMemory', 'model', 'boolean', NULL, NULL, 1),
                    ('hypav2', 'model', 'boolean', NULL, NULL, 1),
                    ('hypaAllocatedTokens', 'model', 'number', NULL, 1777, NULL),
                    ('hypaChunkSize', 'model', 'number', NULL, 888, NULL);",
            )
            .unwrap();

        let settings = repository.load_provider_settings().unwrap().unwrap();
        assert_eq!(settings.memory_mode, MemoryMode::HypaV2);
        assert_eq!(settings.memory_allocated_tokens, 1_777);
        assert_eq!(settings.memory_chunk_tokens, 888);
    }

    #[test]
    fn legacy_hypa_v3_mode_and_selected_preset_seed_native_settings() {
        let (_directory, mut repository) = repository();
        repository
            .connection
            .execute_batch(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value, number_value, boolean_value)
                 VALUES
                    ('nativeProviderModel', 'model', 'string', 'native-model', NULL, NULL),
                    ('hypaMemory', 'model', 'boolean', NULL, NULL, 1),
                    ('hypav2', 'model', 'boolean', NULL, NULL, 1),
                    ('hypaV3', 'model', 'boolean', NULL, NULL, 1),
                    ('hypaV3PresetId', 'model', 'number', NULL, 1, NULL);",
            )
            .unwrap();
        let preset = |name: &str, ratio: f64, query_count: f64| {
            RelationalValue::Object(vec![
                ("name".into(), RelationalValue::String(name.into())),
                (
                    "settings".into(),
                    RelationalValue::Object(vec![
                        ("memoryTokensRatio".into(), RelationalValue::Number(ratio)),
                        (
                            "extraSummarizationRatio".into(),
                            RelationalValue::Number(0.1),
                        ),
                        ("maxChatsPerSummary".into(), RelationalValue::Number(9.0)),
                        ("recentMemoryRatio".into(), RelationalValue::Number(0.25)),
                        ("similarMemoryRatio".into(), RelationalValue::Number(0.5)),
                        (
                            "queryChatCount".into(),
                            RelationalValue::Number(query_count),
                        ),
                        (
                            "preserveOrphanedMemory".into(),
                            RelationalValue::Boolean(true),
                        ),
                        (
                            "summaryChunkSeparator".into(),
                            RelationalValue::String("---".into()),
                        ),
                        (
                            "summarizationPrompt".into(),
                            RelationalValue::String("summarize {{slot}}".into()),
                        ),
                    ]),
                ),
            ])
        };
        write_setting_value(
            &mut repository,
            "hypaV3Presets",
            &RelationalValue::Array(vec![
                preset("First", 0.2, 3.0),
                preset("Selected", 0.35, 5.0),
            ]),
        );

        let settings = repository.load_provider_settings().unwrap().unwrap();
        assert_eq!(settings.memory_mode, MemoryMode::HypaV3);
        assert_eq!(settings.hypa_v3.memory_ratio_bps, 3_500);
        assert_eq!(settings.hypa_v3.extra_summarization_ratio_bps, 1_000);
        assert_eq!(settings.hypa_v3.max_messages_per_summary, 9);
        assert_eq!(settings.hypa_v3.recent_ratio_bps, 2_500);
        assert_eq!(settings.hypa_v3.similar_ratio_bps, 5_000);
        assert_eq!(settings.hypa_v3.query_message_count, 5);
        assert!(settings.hypa_v3.preserve_orphaned_memory);
        assert_eq!(settings.hypa_v3.summary_chunk_separator, "---");
        assert_eq!(settings.hypa_v3.summary_prompt, "summarize {{slot}}");
    }

    #[test]
    fn preset_summaries_do_not_parse_or_return_legacy_plaintext_keys() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute(
                "INSERT INTO bot_presets
                    (preset_id, position, name, api_type, ai_model, data, content_hash)
                 VALUES ('legacy', 0, 'Legacy preset', 'openai', 'gpt-test',
                         '{\"openAIKey\":\"DO_NOT_LOAD_THIS_SECRET\"}', 'hash')",
                [],
            )
            .unwrap();

        assert_eq!(
            repository.list_preset_summaries().unwrap(),
            vec![PresetSummary {
                id: "legacy".into(),
                name: "Legacy preset".into(),
                api_type: "openai".into(),
                model: "gpt-test".into(),
            }]
        );
    }

    #[test]
    fn character_extension_profile_and_virtual_first_message_are_loaded() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute(
                "DELETE FROM character_extension_nodes WHERE character_id = 'native-risu'",
                [],
            )
            .unwrap();
        repository
            .connection
            .execute_batch(
                "INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES ('native-risu',0,NULL,0,NULL,'object');
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    ('native-risu',1,0,0,'firstMessage','string','Imported greeting'),
                    ('native-risu',2,0,1,'desc','string','Imported description'),
                    ('native-risu',3,0,2,'personality','string','Curious'),
                    ('native-risu',4,0,3,'scenario','string','A native app'),
                    ('native-risu',5,0,4,'systemPrompt','string','Act as {{char}}'),
                    ('native-risu',6,0,5,'postHistoryInstructions','string','Stay in character');",
            )
            .unwrap();

        let character = repository.load_characters().unwrap().remove(0);
        assert_eq!(character.profile.first_message, "Imported greeting");
        assert_eq!(character.profile.description, "Imported description");
        assert_eq!(character.profile.personality, "Curious");
        assert_eq!(character.profile.scenario, "A native app");
        assert_eq!(character.profile.system_prompt, "Act as {{char}}");
        assert_eq!(
            character.profile.post_history_instructions,
            "Stay in character"
        );
        assert_eq!(character.messages[0].content, "Imported greeting");
        assert!(
            character.messages[0]
                .id
                .starts_with("virtual-first-message:")
        );
    }

    #[test]
    fn character_and_chat_lorebooks_and_lore_settings_are_loaded_from_relational_nodes() {
        let (_directory, repository) = repository();
        repository
            .connection
            .execute_batch(
                "INSERT INTO system_settings
                    (key, domain, value_type, number_value)
                 VALUES ('loreBookToken', 'model', 'number', 123),
                        ('loreBookDepth', 'model', 'number', 9);

                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES
                    ('native-risu',10,0,0,'globalLore','array'),
                    ('native-risu',11,10,0,NULL,'object'),
                    ('native-risu',20,11,8,'extentions','object'),
                    ('native-risu',30,0,1,'loreSettings','object');
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    ('native-risu',12,11,0,'id','string','global-one'),
                    ('native-risu',13,11,1,'key','string','Dragon'),
                    ('native-risu',14,11,2,'secondkey','string','Moon'),
                    ('native-risu',15,11,3,'comment','string','Dragon lore'),
                    ('native-risu',16,11,4,'content','string','A silver dragon'),
                    ('native-risu',17,11,5,'mode','string','normal');
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,number_value)
                 VALUES
                    ('native-risu',18,11,6,'insertorder','number',42),
                    ('native-risu',31,30,0,'tokenBudget','number',77),
                    ('native-risu',32,30,1,'scanDepth','number',2);
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,boolean_value)
                 VALUES
                    ('native-risu',19,11,7,'selective','boolean',1),
                    ('native-risu',21,20,0,'risu_case_sensitive','boolean',1),
                    ('native-risu',33,30,2,'recursiveScanning','boolean',0),
                    ('native-risu',34,30,3,'fullWordMatching','boolean',1);

                 INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES
                    ('native-risu-chat',10,0,0,'localLore','array'),
                    ('native-risu-chat',11,10,0,NULL,'object');
                 INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    ('native-risu-chat',12,11,0,'key','string',''),
                    ('native-risu-chat',13,11,1,'comment','string','Local lore'),
                    ('native-risu-chat',14,11,2,'content','string','Always local'),
                    ('native-risu-chat',15,11,3,'mode','string','normal');
                 INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,boolean_value)
                 VALUES
                    ('native-risu-chat',16,11,4,'alwaysActive','boolean',1);",
            )
            .unwrap();

        let characters = repository.load_characters().unwrap();
        let risu = characters
            .iter()
            .find(|character| character.id == "native-risu")
            .unwrap();
        assert_eq!(risu.global_lore.len(), 1);
        assert_eq!(risu.global_lore[0].id.as_deref(), Some("global-one"));
        assert_eq!(risu.global_lore[0].key, "Dragon");
        assert_eq!(risu.global_lore[0].second_key, "Moon");
        assert_eq!(risu.global_lore[0].insertion_order, 42);
        assert!(risu.global_lore[0].selective);
        assert!(risu.global_lore[0].case_sensitive);
        assert_eq!(risu.local_lore.len(), 1);
        assert!(risu.local_lore[0].always_active);
        assert_eq!(risu.lore_settings.token_budget, 77);
        assert_eq!(risu.lore_settings.scan_depth, 2);
        assert!(!risu.lore_settings.recursive_scanning);
        assert!(risu.lore_settings.full_word_matching);

        let aria = characters
            .iter()
            .find(|character| character.id == "native-aria")
            .unwrap();
        assert_eq!(aria.lore_settings.token_budget, 123);
        assert_eq!(aria.lore_settings.scan_depth, 9);
        assert!(aria.global_lore.is_empty());
    }

    #[test]
    fn enabled_character_chat_namespace_and_integration_modules_resolve_in_catalog_order() {
        let (_directory, mut repository) = repository();
        let module = |id: &str, namespace: Option<&str>, content: &str| {
            let mut fields = vec![
                ("id".into(), RelationalValue::String(id.into())),
                (
                    "name".into(),
                    RelationalValue::String(format!("Module {id}")),
                ),
                (
                    "lorebook".into(),
                    RelationalValue::Array(vec![RelationalValue::Object(vec![
                        ("key".into(), RelationalValue::String(String::new())),
                        ("comment".into(), RelationalValue::String(content.into())),
                        ("content".into(), RelationalValue::String(content.into())),
                        ("mode".into(), RelationalValue::String("normal".into())),
                        ("alwaysActive".into(), RelationalValue::Boolean(true)),
                    ])]),
                ),
            ];
            if let Some(namespace) = namespace {
                fields.push((
                    "namespace".into(),
                    RelationalValue::String(namespace.into()),
                ));
            }
            RelationalValue::Object(fields)
        };
        write_setting_value(
            &mut repository,
            "modules",
            &RelationalValue::Array(vec![
                module("character-module", None, "character module lore"),
                module("global-module", None, "global module lore"),
                module("chat-module", Some("chat-namespace"), "chat module lore"),
                module("global-module", None, "duplicate must be ignored"),
                RelationalValue::String("malformed module".into()),
                module("integrated-module", None, "integrated module lore"),
            ]),
        );
        write_setting_value(
            &mut repository,
            "enabledModules",
            &RelationalValue::Array(vec![
                RelationalValue::String("global-module".into()),
                RelationalValue::String("missing-module".into()),
            ]),
        );
        repository
            .connection
            .execute(
                "INSERT INTO system_settings
                    (key, domain, value_type, text_value)
                 VALUES ('moduleIntergration', 'test', 'string',
                         ' integrated-module, global-module, ')",
                [],
            )
            .unwrap();
        {
            let transaction = repository.connection.transaction().unwrap();
            replace_extension_field(
                &transaction,
                ExtensionScope::Character,
                "native-risu",
                "modules",
                &RelationalValue::Array(vec![RelationalValue::String("character-module".into())]),
            )
            .unwrap();
            replace_extension_field(
                &transaction,
                ExtensionScope::Chat,
                "native-risu-chat",
                "modules",
                &RelationalValue::Array(vec![RelationalValue::String("chat-namespace".into())]),
            )
            .unwrap();
            transaction.commit().unwrap();
        }

        let risu = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|character| character.id == "native-risu")
            .unwrap();
        assert_eq!(
            risu.module_lore
                .iter()
                .map(|lore| lore.content.as_str())
                .collect::<Vec<_>>(),
            vec![
                "character module lore",
                "global module lore",
                "chat module lore",
                "integrated module lore",
            ]
        );

        let second_chat = repository.create_chat_for_character("native-risu").unwrap();
        let second_context = repository.load_chat_context(&second_chat.id).unwrap();
        assert_eq!(
            second_context
                .module_lore
                .iter()
                .map(|lore| lore.content.as_str())
                .collect::<Vec<_>>(),
            vec![
                "character module lore",
                "global module lore",
                "integrated module lore",
            ]
        );
    }

    #[test]
    fn lorebook_updates_are_atomic_and_preserve_unknown_relational_fields() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Lore editor").unwrap();
        let chat_id = character.chat_id.clone().unwrap();
        repository
            .connection
            .execute_batch(&format!(
                "INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES
                    ('{id}',10,0,0,'globalLore','array'),
                    ('{id}',11,10,0,NULL,'object'),
                    ('{id}',14,11,2,'unknownNested','object'),
                    ('{id}',20,0,1,'loreSettings','object');
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    ('{id}',12,11,0,'id','string','preserve-me'),
                    ('{id}',13,11,1,'key','string','old-key'),
                    ('{id}',15,14,0,'pluginValue','string','keep-inside-entry'),
                    ('{id}',21,20,0,'pluginSetting','string','keep-setting'),
                    ('{id}',30,0,2,'unknownTopLevel','string','keep-top-level');

                 INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES
                    ('{chat_id}',10,0,0,'localLore','array'),
                    ('{chat_id}',11,10,0,NULL,'object');
                 INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    ('{chat_id}',12,11,0,'id','string','local-one'),
                    ('{chat_id}',13,11,1,'content','string','old local');",
                id = character.id,
            ))
            .unwrap();

        let lore = |id: &str, key: &str, content: &str| LoreEntry {
            source_index: None,
            id: Some(id.into()),
            key: key.into(),
            second_key: String::new(),
            insertion_order: 123,
            name: "Edited lore".into(),
            content: content.into(),
            mode: "normal".into(),
            always_active: false,
            selective: false,
            use_regex: false,
            case_sensitive: true,
            activation_percent: Some(88),
        };
        let global = vec![
            lore("preserve-me", "new-key", "new global"),
            lore("new-entry", "second", "new entry"),
        ];
        let local = vec![lore("local-one", "", "new local")];
        let settings = LoreSettings {
            token_budget: 321,
            scan_depth: 7,
            recursive_scanning: false,
            full_word_matching: true,
        };
        repository
            .update_lorebooks(&character.id, &chat_id, &global, &local, &settings)
            .unwrap();
        let mut expected_global = global.clone();
        for (index, entry) in expected_global.iter_mut().enumerate() {
            entry.source_index = Some(index);
        }
        let mut expected_local = local.clone();
        for (index, entry) in expected_local.iter_mut().enumerate() {
            entry.source_index = Some(index);
        }

        let loaded = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == character.id)
            .unwrap();
        assert_eq!(loaded.global_lore, expected_global);
        assert_eq!(loaded.local_lore, expected_local);
        assert_eq!(loaded.lore_settings, settings);

        let character_value = load_extension_value(
            &repository.connection,
            ExtensionScope::Character,
            &character.id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            character_value
                .get("unknownTopLevel")
                .and_then(RelationalValue::as_str),
            Some("keep-top-level")
        );
        assert_eq!(
            character_value
                .get("loreSettings")
                .and_then(|value| value.get("pluginSetting"))
                .and_then(RelationalValue::as_str),
            Some("keep-setting")
        );
        assert_eq!(
            character_value
                .get("globalLore")
                .and_then(RelationalValue::as_array)
                .and_then(|values| values.first())
                .and_then(|value| value.get("unknownNested"))
                .and_then(|value| value.get("pluginValue"))
                .and_then(RelationalValue::as_str),
            Some("keep-inside-entry")
        );

        repository
            .connection
            .execute_batch(&format!(
                "CREATE TRIGGER reject_lore_update
                   BEFORE INSERT ON chat_extension_nodes
                   WHEN NEW.chat_id = '{chat_id}' AND NEW.parent_node_id IS NOT NULL
                   BEGIN SELECT RAISE(ABORT, 'late lore failure'); END;"
            ))
            .unwrap();
        let attempted_global = vec![lore("preserve-me", "must-rollback", "rollback")];
        assert!(
            repository
                .update_lorebooks(
                    &character.id,
                    &chat_id,
                    &attempted_global,
                    &local,
                    &settings,
                )
                .is_err()
        );
        let reloaded = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.id == character.id)
            .unwrap();
        assert_eq!(reloaded.global_lore, expected_global);
        assert_eq!(reloaded.local_lore, expected_local);
    }

    #[test]
    fn idless_lore_uses_its_loaded_source_index_when_an_earlier_entry_is_deleted() {
        let original = RelationalValue::Array(vec![
            RelationalValue::Object(vec![
                ("key".into(), RelationalValue::String("first".into())),
                (
                    "pluginMarker".into(),
                    RelationalValue::String("belongs-to-first".into()),
                ),
            ]),
            RelationalValue::Object(vec![
                ("key".into(), RelationalValue::String("second".into())),
                (
                    "pluginMarker".into(),
                    RelationalValue::String("belongs-to-second".into()),
                ),
            ]),
        ]);
        let edited = LoreEntry {
            source_index: Some(1),
            id: Some("assigned-by-native-editor".into()),
            key: "edited second".into(),
            second_key: String::new(),
            insertion_order: 100,
            name: String::new(),
            content: String::new(),
            mode: "normal".into(),
            always_active: false,
            selective: false,
            use_regex: false,
            case_sensitive: false,
            activation_percent: None,
        };
        let merged = merge_lore_value(Some(&original), &[edited]);
        assert_eq!(
            merged
                .as_array()
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("pluginMarker"))
                .and_then(RelationalValue::as_str),
            Some("belongs-to-second")
        );
    }

    #[test]
    fn creating_a_character_persists_metadata_profile_chat_and_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("risu.sqlite3");
        let created_id;
        {
            let mut repository = Repository::open(&path).unwrap();
            let before_revision: i64 = repository
                .connection
                .query_row(
                    "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let created = repository.create_character("  Native Mina  ").unwrap();
            created_id = created.id.clone();
            assert_eq!(created.name, "Native Mina");
            assert!(created.chat_id.is_some());
            let after_revision: i64 = repository
                .connection
                .query_row(
                    "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(after_revision, before_revision + 1);
        }

        let repository = Repository::open(&path).unwrap();
        let created = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|character| character.id == created_id)
            .unwrap();
        assert_eq!(created.name, "Native Mina");
        assert!(created.chat_id.is_some());
        assert_eq!(created.profile, CharacterProfile::default());
    }

    #[test]
    fn invalid_character_names_do_not_write_partial_rows() {
        let (_directory, mut repository) = repository();
        let before = repository.load_characters().unwrap().len();
        assert!(matches!(
            repository.create_character("   "),
            Err(StorageError::EmptyCharacterName)
        ));
        assert!(matches!(
            repository.create_character(&"x".repeat(121)),
            Err(StorageError::CharacterNameTooLong)
        ));
        assert_eq!(repository.load_characters().unwrap().len(), before);
    }

    #[test]
    fn editing_a_profile_preserves_unknown_extension_nodes_and_encoded_text() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Before").unwrap();
        repository
            .connection
            .execute_batch(&format!(
                "INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES ('{}',20,0,20,'futureField','object');
                 INSERT INTO character_extension_nodes
                    (character_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES ('{}',21,20,0,'nested','string','keep me');",
                character.id, character.id
            ))
            .unwrap();
        let profile = CharacterProfile {
            first_message: "hello\0native".into(),
            description: "A native profile".into(),
            personality: "Curious".into(),
            scenario: "GTK desktop".into(),
            system_prompt: "Act as {{char}}".into(),
            post_history_instructions: "Stay focused".into(),
            example_message: "Example".into(),
            creator_notes: "Notes".into(),
        };

        let saved_name = repository
            .update_character(&character.id, "  After  ", &profile, true)
            .unwrap();
        assert_eq!(saved_name, "After");
        let loaded = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|loaded| loaded.id == character.id)
            .unwrap();
        assert_eq!(loaded.name, "After");
        assert_eq!(loaded.profile, profile);
        assert!(loaded.supa_memory_enabled);
        assert_eq!(loaded.messages[0].content, "hello\0native");
        let future_nodes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM character_extension_nodes
                  WHERE character_id = ?1 AND node_id IN (20, 21)",
                [&character.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(future_nodes, 2);
    }

    #[test]
    fn supa_memory_settings_and_per_chat_state_round_trip_without_touching_other_fields() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Memory").unwrap();
        let first_chat_id = character.chat_id.clone().unwrap();
        let second_chat = repository.create_chat_for_character(&character.id).unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type)
                 VALUES (?1,20,0,20,'futureField','object')",
                [&first_chat_id],
            )
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES (?1,21,20,0,'nested','string','keep me')",
                [&first_chat_id],
            )
            .unwrap();

        repository
            .update_character(
                &character.id,
                &character.name,
                &CharacterProfile::default(),
                true,
            )
            .unwrap();
        repository
            .save_supa_memory(
                &character.id,
                &first_chat_id,
                Some("message-2\nfirst summary"),
            )
            .unwrap();
        repository
            .save_supa_memory(
                &character.id,
                &second_chat.id,
                Some("message-9\nsecond summary"),
            )
            .unwrap();

        let loaded = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|loaded| loaded.id == character.id)
            .unwrap();
        assert!(loaded.supa_memory_enabled);
        assert_eq!(
            loaded.supa_memory_data.as_deref(),
            Some("message-2\nfirst summary")
        );
        assert_eq!(
            repository
                .load_chat_context(&second_chat.id)
                .unwrap()
                .supa_memory_data
                .as_deref(),
            Some("message-9\nsecond summary")
        );
        let future_nodes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM chat_extension_nodes
                  WHERE chat_id = ?1 AND node_id IN (20, 21)",
                [&first_chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(future_nodes, 2);

        repository
            .save_supa_memory(&character.id, &first_chat_id, None)
            .unwrap();
        assert!(
            repository
                .load_chat_context(&first_chat_id)
                .unwrap()
                .supa_memory_data
                .is_none()
        );
        assert_eq!(
            repository
                .load_chat_context(&second_chat.id)
                .unwrap()
                .supa_memory_data
                .as_deref(),
            Some("message-9\nsecond summary")
        );
    }

    #[test]
    fn a_late_supa_memory_failure_rolls_back_state_and_revision() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Memory rollback").unwrap();
        let chat_id = character.chat_id.unwrap();
        repository
            .save_supa_memory(&character.id, &chat_id, Some("message-1\nold summary"))
            .unwrap();
        let revision_before: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_supa_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();

        assert!(
            repository
                .save_supa_memory(&character.id, &chat_id, Some("message-2\nnew summary"))
                .is_err()
        );
        assert_eq!(
            repository
                .load_chat_context(&chat_id)
                .unwrap()
                .supa_memory_data
                .as_deref(),
            Some("message-1\nold summary")
        );
        let revision_after: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[test]
    fn hypa_v2_state_round_trips_and_preserves_unknown_nested_fields() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Hypa V2").unwrap();
        let chat_id = character.chat_id.unwrap();
        let first = repository
            .append_user_message(&character.id, Some(&chat_id), "first")
            .unwrap()
            .message;
        let second = repository
            .append_character_message(&character.id, Some(&chat_id), "second")
            .unwrap()
            .message;
        let state = HypaV2State {
            last_main_chunk_id: 1,
            main_chunks: vec![HypaV2MainChunk {
                id: 1,
                text: "summary".into(),
                chat_memos: vec![first.id.clone(), second.id.clone()],
                last_chat_memo: second.id.clone(),
            }],
            chunks: vec![HypaV2Chunk {
                main_chunk_id: 1,
                text: "detail".into(),
            }],
        };
        repository
            .save_hypa_v2_memory(&character.id, &chat_id, Some(&state))
            .unwrap();

        let (hypa_node, main_node, chunk_node, next_id): (i64, i64, i64, i64) = repository
            .connection
            .query_row(
                "SELECT
                    (SELECT node_id FROM chat_extension_nodes
                      WHERE chat_id = ?1 AND parent_node_id = 0 AND object_key = 'hypaV2Data'),
                    (SELECT item.node_id FROM chat_extension_nodes item
                       JOIN chat_extension_nodes array_node
                         ON array_node.chat_id = item.chat_id
                        AND array_node.node_id = item.parent_node_id
                      WHERE item.chat_id = ?1 AND array_node.object_key = 'mainChunks'
                      ORDER BY item.node_order LIMIT 1),
                    (SELECT item.node_id FROM chat_extension_nodes item
                       JOIN chat_extension_nodes array_node
                         ON array_node.chat_id = item.chat_id
                        AND array_node.node_id = item.parent_node_id
                      WHERE item.chat_id = ?1 AND array_node.object_key = 'chunks'
                      ORDER BY item.node_order LIMIT 1),
                    (SELECT MAX(node_id) + 1 FROM chat_extension_nodes WHERE chat_id = ?1)",
                [&chat_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    (?1,?2,?3,90,'futureTop','string','top'),
                    (?1,?4,?5,90,'futureMain','string','main'),
                    (?1,?6,?7,90,'futureChunk','string','chunk')",
                params![
                    &chat_id,
                    next_id,
                    hypa_node,
                    next_id + 1,
                    main_node,
                    next_id + 2,
                    chunk_node,
                ],
            )
            .unwrap();

        let updated = HypaV2State {
            main_chunks: vec![HypaV2MainChunk {
                text: "updated summary".into(),
                ..state.main_chunks[0].clone()
            }],
            ..state.clone()
        };
        repository
            .save_hypa_v2_memory(&character.id, &chat_id, Some(&updated))
            .unwrap();
        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().hypa_v2_data,
            Some(updated)
        );
        let unknown_nodes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM chat_extension_nodes
                  WHERE chat_id = ?1 AND object_key IN ('futureTop','futureMain','futureChunk')",
                [&chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unknown_nodes, 3);
    }

    #[test]
    fn a_late_hypa_v2_failure_rolls_back_state_and_revision() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Hypa V2 rollback").unwrap();
        let chat_id = character.chat_id.unwrap();
        let message = repository
            .append_user_message(&character.id, Some(&chat_id), "message")
            .unwrap()
            .message;
        let original = HypaV2State {
            last_main_chunk_id: 1,
            main_chunks: vec![HypaV2MainChunk {
                id: 1,
                text: "original".into(),
                chat_memos: vec![message.id.clone()],
                last_chat_memo: message.id,
            }],
            chunks: vec![HypaV2Chunk {
                main_chunk_id: 1,
                text: "original".into(),
            }],
        };
        repository
            .save_hypa_v2_memory(&character.id, &chat_id, Some(&original))
            .unwrap();
        let revision_before: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_hypa_v2_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();
        let mut updated = original.clone();
        updated.main_chunks[0].text = "must roll back".into();

        assert!(
            repository
                .save_hypa_v2_memory(&character.id, &chat_id, Some(&updated))
                .is_err()
        );
        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().hypa_v2_data,
            Some(original)
        );
        let revision_after: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[test]
    fn hypa_v3_state_round_trips_and_preserves_unknown_nested_fields() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Hypa V3").unwrap();
        let chat_id = character.chat_id.unwrap();
        let message = repository
            .append_user_message(&character.id, Some(&chat_id), "message")
            .unwrap()
            .message;
        let original = HypaV3State {
            summaries: vec![HypaV3Summary {
                text: "original summary".into(),
                chat_memos: vec![message.id],
                is_important: false,
                category_id: None,
                tags: vec!["old".into()],
            }],
            categories: Some(vec![HypaV3Category {
                id: "plot".into(),
                name: "Plot".into(),
            }]),
            metrics: Some(HypaV3Metrics::default()),
            ..HypaV3State::default()
        };
        repository
            .save_hypa_v3_memory(&character.id, &chat_id, Some(&original))
            .unwrap();
        let (root_node, summary_node, category_node, metrics_node, next_id): (
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = repository
            .connection
            .query_row(
                "SELECT
                    (SELECT node_id FROM chat_extension_nodes
                      WHERE chat_id = ?1 AND parent_node_id = 0 AND object_key = 'hypaV3Data'),
                    (SELECT item.node_id FROM chat_extension_nodes item
                       JOIN chat_extension_nodes array_node
                         ON array_node.chat_id = item.chat_id
                        AND array_node.node_id = item.parent_node_id
                      WHERE item.chat_id = ?1 AND array_node.object_key = 'summaries'
                      ORDER BY item.node_order LIMIT 1),
                    (SELECT item.node_id FROM chat_extension_nodes item
                       JOIN chat_extension_nodes array_node
                         ON array_node.chat_id = item.chat_id
                        AND array_node.node_id = item.parent_node_id
                      WHERE item.chat_id = ?1 AND array_node.object_key = 'categories'
                      ORDER BY item.node_order LIMIT 1),
                    (SELECT node_id FROM chat_extension_nodes
                      WHERE chat_id = ?1 AND object_key = 'metrics'),
                    (SELECT MAX(node_id) + 1 FROM chat_extension_nodes WHERE chat_id = ?1)",
                [&chat_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO chat_extension_nodes
                    (chat_id,node_id,parent_node_id,node_order,object_key,value_type,text_value)
                 VALUES
                    (?1,?2,?3,90,'futureTop','string','top'),
                    (?1,?4,?5,90,'futureSummary','string','summary'),
                    (?1,?6,?7,90,'futureCategory','string','category'),
                    (?1,?8,?9,90,'futureMetrics','string','metrics')",
                params![
                    &chat_id,
                    next_id,
                    root_node,
                    next_id + 1,
                    summary_node,
                    next_id + 2,
                    category_node,
                    next_id + 3,
                    metrics_node,
                ],
            )
            .unwrap();
        let mut updated = original.clone();
        updated.summaries[0].text = "updated summary".into();
        updated.summaries[0].is_important = true;
        updated.summaries[0].category_id = Some("plot".into());
        updated.summaries[0].tags = vec!["new".into()];
        updated.categories.as_mut().unwrap()[0].name = "Main plot".into();
        updated.metrics.as_mut().unwrap().last_recent_summaries = vec![0];
        repository
            .save_hypa_v3_memory(&character.id, &chat_id, Some(&updated))
            .unwrap();

        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().hypa_v3_data,
            Some(updated)
        );
        let unknown_nodes: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM chat_extension_nodes
                  WHERE chat_id = ?1 AND object_key IN
                        ('futureTop','futureSummary','futureCategory','futureMetrics')",
                [&chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unknown_nodes, 4);
    }

    #[test]
    fn a_late_hypa_v3_failure_rolls_back_state_and_revision() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Hypa V3 rollback").unwrap();
        let chat_id = character.chat_id.unwrap();
        let message = repository
            .append_user_message(&character.id, Some(&chat_id), "message")
            .unwrap()
            .message;
        let original = HypaV3State {
            summaries: vec![HypaV3Summary {
                text: "original".into(),
                chat_memos: vec![message.id],
                is_important: false,
                category_id: None,
                tags: Vec::new(),
            }],
            ..HypaV3State::default()
        };
        repository
            .save_hypa_v3_memory(&character.id, &chat_id, Some(&original))
            .unwrap();
        let revision_before: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_hypa_v3_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();
        let mut updated = original.clone();
        updated.summaries[0].text = "must roll back".into();
        assert!(
            repository
                .save_hypa_v3_memory(&character.id, &chat_id, Some(&updated))
                .is_err()
        );
        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().hypa_v3_data,
            Some(original)
        );
        let revision_after: i64 = repository
            .connection
            .query_row(
                "SELECT revision FROM system_storage_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[test]
    fn a_late_profile_failure_rolls_back_metadata_and_extensions() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Before").unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_profile_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();
        let profile = CharacterProfile {
            description: "must roll back".into(),
            ..CharacterProfile::default()
        };

        assert!(
            repository
                .update_character(&character.id, "After", &profile, false)
                .is_err()
        );
        let loaded = repository
            .load_characters()
            .unwrap()
            .into_iter()
            .find(|loaded| loaded.id == character.id)
            .unwrap();
        assert_eq!(loaded.name, "Before");
        assert_eq!(loaded.profile, CharacterProfile::default());
    }

    #[test]
    fn chats_can_be_created_loaded_and_deleted_without_changing_another_active_chat() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Chats").unwrap();
        let first_chat_id = character.chat_id.unwrap();
        repository
            .append_user_message(&character.id, Some(&first_chat_id), "keep active")
            .unwrap();
        let second = repository.create_chat_for_character(&character.id).unwrap();
        repository
            .append_user_message(&character.id, Some(&second.id), "delete me")
            .unwrap();

        let deleted = repository
            .delete_chat(&character.id, &second.id, Some(&first_chat_id))
            .unwrap();
        assert_eq!(deleted.active_chat_id, first_chat_id);
        assert_eq!(deleted.messages.len(), 1);
        assert_eq!(deleted.messages[0].content, "keep active");
        assert_eq!(deleted.chats.len(), 1);
        assert_eq!(deleted.chats[0].message_count, 1);
        assert!(matches!(
            repository.load_chat_context(&second.id),
            Err(StorageError::MissingConversation)
        ));
    }

    #[test]
    fn deleting_the_last_chat_atomically_creates_an_empty_replacement() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Last chat").unwrap();
        let original_chat_id = character.chat_id.unwrap();
        repository
            .append_user_message(&character.id, Some(&original_chat_id), "gone")
            .unwrap();

        let deleted = repository
            .delete_chat(&character.id, &original_chat_id, Some(&original_chat_id))
            .unwrap();
        assert_ne!(deleted.active_chat_id, original_chat_id);
        assert_eq!(deleted.chats.len(), 1);
        assert_eq!(deleted.chats[0].id, deleted.active_chat_id);
        assert_eq!(deleted.chats[0].name, "Chat 1");
        assert!(deleted.messages.is_empty());
    }

    #[test]
    fn messages_survive_reopening_including_nul_text() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("risu.sqlite3");
        {
            let mut repository = Repository::open(&path).unwrap();
            let character = repository.load_characters().unwrap().remove(0);
            repository
                .append_user_message(&character.id, character.chat_id.as_deref(), "hello\0native")
                .unwrap();
        }

        let repository = Repository::open(&path).unwrap();
        let character = repository.load_characters().unwrap().remove(0);
        assert_eq!(character.messages.last().unwrap().content, "hello\0native");
    }

    #[test]
    fn compatible_image_inlay_tokens_round_trip_without_schema_extensions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("risu.sqlite3");
        let image_id = Uuid::new_v4();
        let profile_image_id = Uuid::new_v4();
        let content = format!("look\0\n{{{{inlayed::{image_id}}}}}");
        {
            let mut repository = Repository::open(&path).unwrap();
            let character = repository.load_characters().unwrap().remove(0);
            repository
                .append_user_message(&character.id, character.chat_id.as_deref(), &content)
                .unwrap();
        }

        let repository = Repository::open(&path).unwrap();
        let character = repository.load_characters().unwrap().remove(0);
        assert_eq!(character.messages.last().unwrap().content, content);
        repository
            .connection
            .execute(
                "INSERT INTO character_extension_nodes
                    (character_id, node_id, parent_node_id, node_order,
                     object_key, value_type, text_value)
                 VALUES (?1, 900, 0, 900, 'futureImageReference', 'string', ?2)",
                params![character.id, format!("{{{{inlayed::{profile_image_id}}}}}")],
            )
            .unwrap();
        assert_eq!(
            repository.referenced_inlay_ids().unwrap(),
            HashSet::from([image_id.to_string(), profile_image_id.to_string()])
        );
        let extension_count: i64 = repository
            .connection
            .query_row("SELECT COUNT(*) FROM message_extension_nodes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(extension_count, 0);
    }

    #[test]
    fn completed_character_responses_survive_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("risu.sqlite3");
        {
            let mut repository = Repository::open(&path).unwrap();
            let character = repository.load_characters().unwrap().remove(0);
            repository
                .append_character_message(
                    &character.id,
                    character.chat_id.as_deref(),
                    "persisted provider response",
                )
                .unwrap();
        }

        let repository = Repository::open(&path).unwrap();
        let message = repository
            .load_characters()
            .unwrap()
            .remove(0)
            .messages
            .pop()
            .unwrap();
        assert_eq!(message.role, Role::Character);
        assert_eq!(message.content, "persisted provider response");
    }

    #[test]
    fn a_late_write_failure_rolls_back_the_message() {
        let (_directory, mut repository) = repository();
        let character = repository.load_characters().unwrap().remove(0);
        let before = character.messages.len();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();

        assert!(
            repository
                .append_user_message(&character.id, character.chat_id.as_deref(), "rollback me")
                .is_err()
        );
        assert_eq!(
            repository.load_characters().unwrap()[0].messages.len(),
            before
        );
    }

    #[test]
    fn snapshot_import_captures_committed_wal_without_modifying_source() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let destination_path = directory.path().join("imported.sqlite3");
        let mut source = Repository::open(&source_path).unwrap();
        let character = source.load_characters().unwrap().remove(0);
        source
            .append_user_message(
                &character.id,
                character.chat_id.as_deref(),
                "committed in WAL",
            )
            .unwrap();

        let report = Repository::import_snapshot(&source_path, &destination_path).unwrap();
        assert_eq!(report.characters, 3);
        assert_eq!(report.chats, 3);
        assert_eq!(report.messages, 4);
        assert_eq!(report.destination, destination_path);

        let imported = Repository::open(&report.destination).unwrap();
        assert_eq!(
            imported.load_characters().unwrap()[0]
                .messages
                .last()
                .unwrap()
                .content,
            "committed in WAL"
        );
        assert_eq!(
            source.load_characters().unwrap()[0]
                .messages
                .last()
                .unwrap()
                .content,
            "committed in WAL"
        );
    }

    #[test]
    fn snapshot_import_never_overwrites_an_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.sqlite3");
        let destination_path = directory.path().join("existing.sqlite3");
        let _source = Repository::open(&source_path).unwrap();
        fs::write(&destination_path, b"keep this database").unwrap();

        assert!(matches!(
            Repository::import_snapshot(&source_path, &destination_path),
            Err(StorageError::DestinationExists(path)) if path == destination_path
        ));
        assert_eq!(fs::read(destination_path).unwrap(), b"keep this database");
    }

    #[test]
    fn an_unknown_schema_is_not_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("future.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE system_storage_meta (
                    singleton INTEGER PRIMARY KEY,
                    schema_version INTEGER NOT NULL,
                    schema_layout TEXT NOT NULL
                 );
                 INSERT INTO system_storage_meta VALUES (1, 999, 'future-layout');",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            Repository::open(&path),
            Err(StorageError::SchemaMismatch { version: 999, .. })
        ));
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .query_row(
                "SELECT schema_version FROM system_storage_meta",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 999);
    }

    #[test]
    fn continue_updates_only_the_last_character_message_and_preserves_extensions() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Continue").unwrap();
        let chat_id = character.chat_id.unwrap();
        repository
            .append_user_message(&character.id, Some(&chat_id), "prompt")
            .unwrap();
        let response = repository
            .append_character_message(&character.id, Some(&chat_id), "first")
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO message_extension_nodes
                    (chat_id, message_id, node_id, parent_node_id, node_order,
                     value_type)
                 VALUES (?1, ?2, 0, NULL, 0, 'object')",
                params![chat_id, response.message.id],
            )
            .unwrap();

        let updated = repository
            .extend_last_character_message(
                &character.id,
                &chat_id,
                &response.message.id,
                "first second",
            )
            .unwrap();
        assert_eq!(updated.message.id, response.message.id);
        assert_eq!(updated.message.content, "first second");
        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().messages[1],
            updated.message
        );
        let extension_count: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM message_extension_nodes
                  WHERE chat_id = ?1 AND message_id = ?2",
                params![chat_id, response.message.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extension_count, 1);

        repository
            .append_user_message(&character.id, Some(&chat_id), "new turn")
            .unwrap();
        assert!(matches!(
            repository.extend_last_character_message(
                &character.id,
                &chat_id,
                &response.message.id,
                "must not update"
            ),
            Err(StorageError::InvalidMessageBoundary)
        ));
    }

    #[test]
    fn editing_a_message_preserves_role_id_extensions_and_exact_text() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Edit message").unwrap();
        let chat_id = character.chat_id.unwrap();
        let message = repository
            .append_user_message(&character.id, Some(&chat_id), "before")
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO message_extension_nodes
                    (chat_id, message_id, node_id, parent_node_id, node_order,
                     value_type, object_key, text_value)
                 VALUES (?1, ?2, 0, NULL, 0, 'object', NULL, NULL),
                        (?1, ?2, 1, 0, 0, 'string', 'unknown', 'keep')",
                params![chat_id, message.message.id],
            )
            .unwrap();

        let updated = repository
            .update_message_content(
                &character.id,
                &chat_id,
                &message.message.id,
                "  after\0exact  ",
            )
            .unwrap();
        assert_eq!(updated.message.id, message.message.id);
        assert_eq!(updated.message.role, Role::User);
        assert_eq!(updated.message.content, "  after\0exact  ");
        assert_eq!(
            repository.load_chat_context(&chat_id).unwrap().messages,
            vec![updated.message]
        );
        let unknown: String = repository
            .connection
            .query_row(
                "SELECT text_value FROM message_extension_nodes
                  WHERE chat_id = ?1 AND message_id = ?2 AND object_key = 'unknown'",
                params![chat_id, message.message.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unknown, "keep");
    }

    #[test]
    fn deleting_messages_cleans_memory_references_and_cascades_extensions() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Delete message").unwrap();
        let chat_id = character.chat_id.unwrap();
        let first = repository
            .append_user_message(&character.id, Some(&chat_id), "first")
            .unwrap();
        let second = repository
            .append_character_message(&character.id, Some(&chat_id), "second")
            .unwrap();
        let third = repository
            .append_user_message(&character.id, Some(&chat_id), "third")
            .unwrap();
        let fourth = repository
            .append_character_message(&character.id, Some(&chat_id), "fourth")
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO message_extension_nodes
                    (chat_id, message_id, node_id, parent_node_id, node_order,
                     value_type)
                 VALUES (?1, ?2, 0, NULL, 0, 'object')",
                params![chat_id, fourth.message.id],
            )
            .unwrap();
        repository
            .save_supa_memory(
                &character.id,
                &chat_id,
                Some(&format!("{}\nsummary", fourth.message.id)),
            )
            .unwrap();
        let v2 = HypaV2State {
            last_main_chunk_id: 2,
            main_chunks: vec![
                HypaV2MainChunk {
                    id: 1,
                    text: "keep".into(),
                    chat_memos: vec![first.message.id.clone(), second.message.id.clone()],
                    last_chat_memo: second.message.id.clone(),
                },
                HypaV2MainChunk {
                    id: 2,
                    text: "remove".into(),
                    chat_memos: vec![third.message.id.clone(), fourth.message.id.clone()],
                    last_chat_memo: fourth.message.id.clone(),
                },
            ],
            chunks: vec![
                HypaV2Chunk {
                    main_chunk_id: 1,
                    text: "keep detail".into(),
                },
                HypaV2Chunk {
                    main_chunk_id: 2,
                    text: "remove detail".into(),
                },
            ],
        };
        repository
            .save_hypa_v2_memory(&character.id, &chat_id, Some(&v2))
            .unwrap();
        let v3 = HypaV3State {
            summaries: vec![
                HypaV3Summary {
                    text: "keep".into(),
                    chat_memos: vec![first.message.id.clone(), second.message.id.clone()],
                    is_important: false,
                    category_id: None,
                    tags: Vec::new(),
                },
                HypaV3Summary {
                    text: "remove".into(),
                    chat_memos: vec![third.message.id.clone(), fourth.message.id.clone()],
                    is_important: false,
                    category_id: None,
                    tags: Vec::new(),
                },
            ],
            ..HypaV3State::default()
        };
        repository
            .save_hypa_v3_memory(&character.id, &chat_id, Some(&v3))
            .unwrap();

        let deleted = repository
            .delete_message_range(&character.id, &chat_id, &fourth.message.id, false)
            .unwrap();
        assert_eq!(deleted.messages, vec![fourth.message.clone()]);
        assert!(deleted.supa_memory_data.is_none());
        assert_eq!(deleted.hypa_v2_data.as_ref().unwrap().main_chunks.len(), 1);
        assert_eq!(deleted.hypa_v3_data.as_ref().unwrap().summaries.len(), 1);
        let loaded = repository.load_chat_context(&chat_id).unwrap();
        assert_eq!(loaded.messages.len(), 3);
        assert!(loaded.supa_memory_data.is_none());
        assert_eq!(loaded.hypa_v2_data.unwrap().main_chunks.len(), 1);
        assert_eq!(loaded.hypa_v3_data.unwrap().summaries.len(), 1);
        let extension_count: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM message_extension_nodes
                  WHERE chat_id = ?1 AND message_id = ?2",
                params![chat_id, fourth.message.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(extension_count, 0);

        let tail = repository
            .delete_message_range(&character.id, &chat_id, &second.message.id, true)
            .unwrap();
        assert_eq!(tail.messages.len(), 2);
        let loaded = repository.load_chat_context(&chat_id).unwrap();
        assert_eq!(loaded.messages, vec![first.message]);
        assert!(loaded.hypa_v2_data.unwrap().main_chunks.is_empty());
        assert!(loaded.hypa_v3_data.unwrap().summaries.is_empty());
    }

    #[test]
    fn message_delete_rolls_back_rows_extensions_and_memory_on_revision_failure() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Delete rollback").unwrap();
        let chat_id = character.chat_id.unwrap();
        let message = repository
            .append_user_message(&character.id, Some(&chat_id), "keep")
            .unwrap();
        repository
            .save_supa_memory(
                &character.id,
                &chat_id,
                Some(&format!("{}\nsummary", message.message.id)),
            )
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO message_extension_nodes
                    (chat_id, message_id, node_id, parent_node_id, node_order,
                     value_type)
                 VALUES (?1, ?2, 0, NULL, 0, 'object')",
                params![chat_id, message.message.id],
            )
            .unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_message_delete_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();

        assert!(
            repository
                .delete_message_range(&character.id, &chat_id, &message.message.id, false,)
                .is_err()
        );
        let loaded = repository.load_chat_context(&chat_id).unwrap();
        assert_eq!(loaded.messages, vec![message.message.clone()]);
        assert_eq!(
            loaded.supa_memory_data,
            Some(format!("{}\nsummary", message.message.id))
        );
        let extension_count: i64 = repository
            .connection
            .query_row("SELECT COUNT(*) FROM message_extension_nodes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(extension_count, 1);
    }

    #[test]
    fn regenerate_atomically_replaces_only_the_tail_after_the_last_user() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Regenerate").unwrap();
        let chat_id = character.chat_id.unwrap();
        repository
            .append_user_message(&character.id, Some(&chat_id), "turn one")
            .unwrap();
        repository
            .append_character_message(&character.id, Some(&chat_id), "keep")
            .unwrap();
        let anchor = repository
            .append_user_message(&character.id, Some(&chat_id), "turn two")
            .unwrap();
        let removed = repository
            .append_character_message(&character.id, Some(&chat_id), "old one")
            .unwrap();
        repository
            .append_character_message(&character.id, Some(&chat_id), "old two")
            .unwrap();
        repository
            .connection
            .execute(
                "INSERT INTO message_extension_nodes
                    (chat_id, message_id, node_id, parent_node_id, node_order,
                     value_type)
                 VALUES (?1, ?2, 0, NULL, 0, 'object')",
                params![chat_id, removed.message.id],
            )
            .unwrap();

        let replacement = repository
            .replace_tail_after_user(&character.id, &chat_id, &anchor.message.id, "new answer")
            .unwrap();
        assert_eq!(replacement.removed_count, 2);
        let messages = repository.load_chat_context(&chat_id).unwrap().messages;
        assert_eq!(
            messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["turn one", "keep", "turn two", "new answer"]
        );
        assert_eq!(messages.last().unwrap(), &replacement.stored.message);
        let dangling_extensions: i64 = repository
            .connection
            .query_row(
                "SELECT COUNT(*) FROM message_extension_nodes
                  WHERE chat_id = ?1 AND message_id = ?2",
                params![chat_id, removed.message.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dangling_extensions, 0);
    }

    #[test]
    fn regenerate_rolls_back_the_deleted_tail_when_revision_commit_fails() {
        let (_directory, mut repository) = repository();
        let character = repository.create_character("Rollback").unwrap();
        let chat_id = character.chat_id.unwrap();
        let anchor = repository
            .append_user_message(&character.id, Some(&chat_id), "prompt")
            .unwrap();
        let original = repository
            .append_character_message(&character.id, Some(&chat_id), "original")
            .unwrap();
        repository
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_regenerate_revision BEFORE UPDATE ON system_storage_meta
                 BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END;",
            )
            .unwrap();

        assert!(
            repository
                .replace_tail_after_user(
                    &character.id,
                    &chat_id,
                    &anchor.message.id,
                    "replacement",
                )
                .is_err()
        );
        let messages = repository.load_chat_context(&chat_id).unwrap().messages;
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1], original.message);
    }
}
