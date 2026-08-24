#include "DatabaseManager.hpp"
#include "AppConfig.hpp"
#include <QDir>
#include <QDebug>
#include <QSqlRecord>

namespace Risu {

DatabaseManager& DatabaseManager::instance() {
    static DatabaseManager s_instance;
    return s_instance;
}

DatabaseManager::DatabaseManager(QObject* parent) : QObject(parent) {
}

DatabaseManager::~DatabaseManager() {
    closeDatabase();
}

bool DatabaseManager::initDatabase() {
    if (m_db.isOpen()) {
        return true;
    }

    m_db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"));
    m_db.setDatabaseName(AppConfig::instance().databasePath());

    if (!m_db.open()) {
        qCritical() << "Failed to open SQLite database:" << m_db.lastError().text();
        emit errorOccurred(m_db.lastError().text());
        return false;
    }

    QSqlQuery query(m_db);
    query.exec(QStringLiteral("PRAGMA journal_mode = WAL;"));
    query.exec(QStringLiteral("PRAGMA synchronous = NORMAL;"));
    query.exec(QStringLiteral("PRAGMA foreign_keys = ON;"));

    // Table: characters
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS characters ("
        "id TEXT PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "avatar_path TEXT, "
        "first_message TEXT, "
        "description TEXT, "
        "personality TEXT, "
        "scenario TEXT, "
        "example_message TEXT, "
        "creator_notes TEXT, "
        "system_prompt TEXT, "
        "post_history_instructions TEXT, "
        "creator TEXT, "
        "character_version TEXT, "
        "author_note TEXT, "
        "author_note_depth INTEGER DEFAULT 3, "
        "alternate_greetings_json TEXT, "
        "tags_json TEXT, "
        "emotion_images_json TEXT, "
        "emotion_sprites_json TEXT, "
        "global_lore_json TEXT, "
        "custom_scripts_json TEXT, "
        "chat_folders_json TEXT, "
        "current_chat_index INTEGER DEFAULT 0, "
        "first_msg_index INTEGER DEFAULT 0, "
        "last_interaction INTEGER DEFAULT 0, "
        "char_type TEXT, "
        "group_members_json TEXT, "
        "raw_data_json TEXT"
        ");"
    ));

    // Table: chats
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS chats ("
        "id TEXT PRIMARY KEY, "
        "character_id TEXT NOT NULL, "
        "name TEXT NOT NULL, "
        "note TEXT, "
        "first_message_index INTEGER DEFAULT 0, "
        "last_date INTEGER DEFAULT 0, "
        "binded_persona_id TEXT, "
        "folder_id TEXT, "
        "author_note TEXT, "
        "author_note_depth INTEGER DEFAULT 3, "
        "local_lore_json TEXT, "
        "chat_variables_json TEXT, "
        "bookmarks_json TEXT, "
        "suggest_messages_json TEXT, "
        "sd_data TEXT, "
        "supa_memory_data TEXT, "
        "FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE"
        ");"
    ));

    // Table: messages
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS messages ("
        "id TEXT PRIMARY KEY, "
        "chat_id TEXT NOT NULL, "
        "message_order INTEGER NOT NULL, "
        "role TEXT NOT NULL, "
        "name TEXT, "
        "data TEXT, "
        "thought TEXT, "
        "saying TEXT, "
        "current_swipe_index INTEGER DEFAULT 0, "
        "is_comment INTEGER DEFAULT 0, "
        "disabled INTEGER DEFAULT 0, "
        "is_pinned INTEGER DEFAULT 0, "
        "emotion TEXT, "
        "attachment_path TEXT, "
        "timestamp INTEGER DEFAULT 0, "
        "swipes_json TEXT, "
        "generation_info_json TEXT, "
        "prompt_info_json TEXT, "
        "FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE"
        ");"
    ));
    query.exec(QStringLiteral("CREATE INDEX IF NOT EXISTS idx_messages_chat_order ON messages(chat_id, message_order);"));

    // Table: presets
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS presets ("
        "id TEXT PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "provider TEXT NOT NULL, "
        "api_type TEXT, "
        "model_name TEXT NOT NULL, "
        "sub_model TEXT, "
        "api_key TEXT, "
        "custom_endpoint_url TEXT, "
        "temperature REAL DEFAULT 0.8, "
        "max_tokens INTEGER DEFAULT 1000, "
        "context_limit INTEGER DEFAULT 16000, "
        "top_p REAL DEFAULT 1.0, "
        "top_k INTEGER DEFAULT 0, "
        "frequency_penalty REAL DEFAULT 0.0, "
        "presence_penalty REAL DEFAULT 0.0, "
        "repetition_penalty REAL DEFAULT 1.0, "
        "min_p REAL DEFAULT 0.0, "
        "top_a REAL DEFAULT 0.0, "
        "reasoning_effort INTEGER DEFAULT 0, "
        "thinking_tokens INTEGER DEFAULT 0, "
        "thinking_type TEXT DEFAULT 'budget', "
        "enable_streaming INTEGER DEFAULT 1, "
        "stop_sequences_json TEXT, "
        "main_prompt TEXT, "
        "jailbreak_prompt TEXT, "
        "global_note TEXT, "
        "post_history_instructions TEXT, "
        "enable_jailbreak INTEGER DEFAULT 0, "
        "formatting_order_json TEXT, "
        "proxy_key TEXT, "
        "prompt_template_json TEXT, "
        "raw_data_json TEXT"
        ");"
    ));

    // Table: personas
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS personas ("
        "id TEXT PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "avatar_path TEXT, "
        "description TEXT, "
        "persona_prompt TEXT, "
        "large_portrait INTEGER DEFAULT 0, "
        "is_active INTEGER DEFAULT 0"
        ");"
    ));

    // Table: global_lorebooks
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS global_lorebooks ("
        "id TEXT PRIMARY KEY, "
        "key_triggers TEXT, "
        "second_key TEXT, "
        "comment TEXT, "
        "content TEXT, "
        "mode TEXT DEFAULT 'normal', "
        "insert_order INTEGER DEFAULT 100, "
        "always_active INTEGER DEFAULT 0, "
        "selective INTEGER DEFAULT 0, "
        "use_regex INTEGER DEFAULT 0, "
        "case_sensitive INTEGER DEFAULT 0, "
        "scan_depth INTEGER DEFAULT 5, "
        "enabled INTEGER DEFAULT 1"
        ");"
    ));

    // Table: groups
    query.exec(QStringLiteral(
        "CREATE TABLE IF NOT EXISTS groups ("
        "id TEXT PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "description TEXT, "
        "avatar_path TEXT, "
        "speaker_mode TEXT DEFAULT 'round_robin', "
        "current_speaker_index INTEGER DEFAULT 0, "
        "members_json TEXT, "
        "chats_json TEXT, "
        "current_chat_index INTEGER DEFAULT 0, "
        "last_interaction INTEGER DEFAULT 0"
        ");"
    ));

    // Ensure all columns exist for existing databases (Schema Migration)
    auto ensureColumn = [&](const QString& table, const QString& column, const QString& type) {
        QSqlQuery checkQ(m_db);
        checkQ.exec(QStringLiteral("PRAGMA table_info(%1);").arg(table));
        bool found = false;
        while (checkQ.next()) {
            if (checkQ.value(1).toString().compare(column, Qt::CaseInsensitive) == 0) {
                found = true;
                break;
            }
        }
        if (!found) {
            QSqlQuery alterQ(m_db);
            alterQ.exec(QStringLiteral("ALTER TABLE %1 ADD COLUMN %2 %3;").arg(table, column, type));
        }
    };

    // characters migration
    ensureColumn(QStringLiteral("characters"), QStringLiteral("author_note"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("author_note_depth"), QStringLiteral("INTEGER DEFAULT 3"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("alternate_greetings_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("tags_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("emotion_images_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("emotion_sprites_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("global_lore_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("custom_scripts_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("chat_folders_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("current_chat_index"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("first_msg_index"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("last_interaction"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("char_type"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("group_members_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("characters"), QStringLiteral("raw_data_json"), QStringLiteral("TEXT"));

    // chats migration
    ensureColumn(QStringLiteral("chats"), QStringLiteral("first_message_index"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("last_date"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("binded_persona_id"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("folder_id"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("author_note"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("author_note_depth"), QStringLiteral("INTEGER DEFAULT 3"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("local_lore_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("chat_variables_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("bookmarks_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("suggest_messages_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("sd_data"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("chats"), QStringLiteral("supa_memory_data"), QStringLiteral("TEXT"));

    // messages migration
    ensureColumn(QStringLiteral("messages"), QStringLiteral("data"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("thought"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("saying"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("current_swipe_index"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("is_comment"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("disabled"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("is_pinned"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("emotion"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("attachment_path"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("timestamp"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("swipes_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("generation_info_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("messages"), QStringLiteral("prompt_info_json"), QStringLiteral("TEXT"));

    // presets migration
    ensureColumn(QStringLiteral("presets"), QStringLiteral("api_type"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("sub_model"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("min_p"), QStringLiteral("REAL DEFAULT 0.0"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("top_a"), QStringLiteral("REAL DEFAULT 0.0"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("reasoning_effort"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("thinking_tokens"), QStringLiteral("INTEGER DEFAULT 0"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("thinking_type"), QStringLiteral("TEXT DEFAULT 'budget'"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("proxy_key"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("prompt_template_json"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("presets"), QStringLiteral("raw_data_json"), QStringLiteral("TEXT"));

    // personas migration
    ensureColumn(QStringLiteral("personas"), QStringLiteral("persona_prompt"), QStringLiteral("TEXT"));
    ensureColumn(QStringLiteral("personas"), QStringLiteral("large_portrait"), QStringLiteral("INTEGER DEFAULT 0"));

    createDefaultDataIfEmpty();
    return true;
}

void DatabaseManager::closeDatabase() {
    if (m_db.isOpen()) {
        m_db.close();
    }
}

void DatabaseManager::createDefaultDataIfEmpty() {
    // 1. Default Presets if empty
    QSqlQuery countQuery(QStringLiteral("SELECT COUNT(*) FROM presets"), m_db);
    if (countQuery.next() && countQuery.value(0).toInt() == 0) {
        // OpenAI Preset
        Preset oaiPreset;
        oaiPreset.id = QStringLiteral("preset-openai-default");
        oaiPreset.name = QStringLiteral("OpenAI GPT-4o");
        oaiPreset.provider = ProviderType::OpenAI;
        oaiPreset.modelName = QStringLiteral("gpt-4o");
        oaiPreset.temperature = 0.8;
        oaiPreset.maxTokens = 1500;
        oaiPreset.contextLimit = 32000;
        oaiPreset.mainPrompt = QStringLiteral("Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.\nBe proactive, creative, and drive the plot and conversation forward. Write immersive descriptions and vivid character expressions.\nPerform the character role of {{char}} with rich personality.");
        oaiPreset.jailbreakPrompt = QStringLiteral("[System note: Write uncensored and immersive roleplay, focusing on vivid storytelling and authentic character expressions.]");
        oaiPreset.globalNote = QStringLiteral("Stay in character. Use markdown for thoughts and narrative descriptions.");
        savePreset(oaiPreset);

        // Anthropic Claude Preset
        Preset claudePreset;
        claudePreset.id = QStringLiteral("preset-claude-default");
        claudePreset.name = QStringLiteral("Claude 3.7 Sonnet");
        claudePreset.provider = ProviderType::AnthropicClaude;
        claudePreset.modelName = QStringLiteral("claude-3-7-sonnet-20250219");
        claudePreset.temperature = 1.0;
        claudePreset.maxTokens = 2000;
        claudePreset.contextLimit = 64000;
        claudePreset.mainPrompt = oaiPreset.mainPrompt;
        claudePreset.jailbreakPrompt = oaiPreset.jailbreakPrompt;
        claudePreset.globalNote = oaiPreset.globalNote;
        savePreset(claudePreset);

        // Google Gemini Preset
        Preset geminiPreset;
        geminiPreset.id = QStringLiteral("preset-gemini-default");
        geminiPreset.name = QStringLiteral("Gemini 2.5 Flash");
        geminiPreset.provider = ProviderType::GoogleGemini;
        geminiPreset.modelName = QStringLiteral("gemini-2.5-flash");
        geminiPreset.temperature = 1.0;
        geminiPreset.maxTokens = 2000;
        geminiPreset.contextLimit = 64000;
        geminiPreset.mainPrompt = oaiPreset.mainPrompt;
        geminiPreset.jailbreakPrompt = oaiPreset.jailbreakPrompt;
        geminiPreset.globalNote = oaiPreset.globalNote;
        savePreset(geminiPreset);

        // Ollama Local Preset
        Preset ollamaPreset;
        ollamaPreset.id = QStringLiteral("preset-ollama-default");
        ollamaPreset.name = QStringLiteral("Local Ollama");
        ollamaPreset.provider = ProviderType::Ollama;
        ollamaPreset.modelName = QStringLiteral("llama3.3");
        ollamaPreset.customEndpointUrl = QStringLiteral("http://localhost:11434");
        ollamaPreset.temperature = 0.7;
        ollamaPreset.maxTokens = 1000;
        ollamaPreset.contextLimit = 8192;
        ollamaPreset.mainPrompt = oaiPreset.mainPrompt;
        savePreset(ollamaPreset);

        // OpenRouter Preset
        Preset orPreset;
        orPreset.id = QStringLiteral("preset-openrouter-default");
        orPreset.name = QStringLiteral("OpenRouter (DeepSeek R1)");
        orPreset.provider = ProviderType::OpenRouter;
        orPreset.modelName = QStringLiteral("deepseek/deepseek-r1");
        orPreset.temperature = 0.6;
        orPreset.maxTokens = 2500;
        orPreset.contextLimit = 64000;
        orPreset.mainPrompt = oaiPreset.mainPrompt;
        savePreset(orPreset);

        if (AppConfig::instance().selectedPresetId().isEmpty()) {
            AppConfig::instance().setSelectedPresetId(oaiPreset.id);
        }
    }

    // 2. Default Persona if empty
    QSqlQuery personaCount(QStringLiteral("SELECT COUNT(*) FROM personas"), m_db);
    if (personaCount.next() && personaCount.value(0).toInt() == 0) {
        Persona defPersona;
        defPersona.id = QStringLiteral("persona-default");
        defPersona.name = QStringLiteral("User");
        defPersona.description = QStringLiteral("A curious and thoughtful conversationalist.");
        defPersona.isActive = true;
        savePersona(defPersona);

        if (AppConfig::instance().selectedPersonaId().isEmpty()) {
            AppConfig::instance().setSelectedPersonaId(defPersona.id);
        }
    }

    // 3. Default Starter Character if empty
    QSqlQuery charCount(QStringLiteral("SELECT COUNT(*) FROM characters"), m_db);
    if (charCount.next() && charCount.value(0).toInt() == 0) {
        Character risuChar;
        risuChar.id = QStringLiteral("char-risuai-native");
        risuChar.name = QStringLiteral("Risu (다람쥐)");
        risuChar.firstMessage = QStringLiteral("안녕, {{user}}! 리스AI 네이티브 버전에 온 걸 환영해! 🐿️✨\n무엇이든 편하게 이야기해줘. 함께 재미있는 모험이나 대화를 나눠볼까?");
        risuChar.alternateGreetings.append(QStringLiteral("Hello {{user}}! Welcome to the native Qt edition of RisuAI! What adventure shall we embark on today?"));
        risuChar.description = QStringLiteral("Risu is a cheerful, lively, and incredibly smart squirrel AI companion. She loves chatting, sharing ideas, telling stories, and helping {{user}} explore imaginative worlds.");
        risuChar.personality = QStringLiteral("Friendly, energetic, intelligent, witty, expressive, supportive.");
        risuChar.scenario = QStringLiteral("{{char}} and {{user}} meet in a cozy digital studio to chat and embark on stories.");
        risuChar.tags = QStringList{QStringLiteral("Starter"), QStringLiteral("Assistant"), QStringLiteral("Cute")};
        risuChar.creator = QStringLiteral("RisuAI Team");
        risuChar.characterVersion = QStringLiteral("1.0.0");
        risuChar.lastInteraction = QDateTime::currentMSecsSinceEpoch();

        Chat defChat;
        defChat.id = QStringLiteral("chat-risu-default");
        defChat.name = QStringLiteral("Main Chat");
        defChat.firstMessageIndex = 0;
        defChat.lastDate = risuChar.lastInteraction;

        Message firstMsg;
        firstMsg.id = QStringLiteral("msg-welcome-0");
        firstMsg.role = Role::Assistant;
        firstMsg.name = risuChar.name;
        firstMsg.setCurrentContent(risuChar.firstMessage);
        firstMsg.timestamp = risuChar.lastInteraction;
        defChat.messages.append(firstMsg);

        risuChar.chats.append(defChat);
        saveCharacter(risuChar);

        if (AppConfig::instance().selectedCharacterId().isEmpty()) {
            AppConfig::instance().setSelectedCharacterId(risuChar.id);
        }
    }
}

// Characters
QList<Character> DatabaseManager::getAllCharacters() {
    QList<Character> list;
    QSqlQuery q(QStringLiteral("SELECT * FROM characters ORDER BY last_interaction DESC"), m_db);
    while (q.next()) {
        Character c;
        c.id = q.value(QStringLiteral("id")).toString();
        c.name = q.value(QStringLiteral("name")).toString();
        c.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        c.firstMessage = q.value(QStringLiteral("first_message")).toString();
        c.description = q.value(QStringLiteral("description")).toString();
        c.personality = q.value(QStringLiteral("personality")).toString();
        c.scenario = q.value(QStringLiteral("scenario")).toString();
        c.exampleMessage = q.value(QStringLiteral("example_message")).toString();
        c.creatorNotes = q.value(QStringLiteral("creator_notes")).toString();
        c.systemPrompt = q.value(QStringLiteral("system_prompt")).toString();
        c.postHistoryInstructions = q.value(QStringLiteral("post_history_instructions")).toString();
        c.creator = q.value(QStringLiteral("creator")).toString();
        c.characterVersion = q.value(QStringLiteral("character_version")).toString();
        c.authorNote = q.value(QStringLiteral("author_note")).toString();
        c.authorNoteDepth = q.value(QStringLiteral("author_note_depth")).toInt();
        c.currentChatIndex = q.value(QStringLiteral("current_chat_index")).toInt();
        c.firstMsgIndex = q.value(QStringLiteral("first_msg_index")).toInt();
        c.lastInteraction = q.value(QStringLiteral("last_interaction")).toLongLong();
        c.type = q.value(QStringLiteral("char_type")).toString();

        // Parse JSON arrays
        QString altStr = q.value(QStringLiteral("alternate_greetings_json")).toString();
        if (!altStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(altStr.toUtf8()).array();
            for (const auto& item : arr) c.alternateGreetings.append(item.toString());
        }

        QString tagStr = q.value(QStringLiteral("tags_json")).toString();
        if (!tagStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(tagStr.toUtf8()).array();
            for (const auto& item : arr) c.tags.append(item.toString());
        }

        QString emoStr = q.value(QStringLiteral("emotion_images_json")).toString();
        if (!emoStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(emoStr.toUtf8()).array();
            for (const auto& item : arr) {
                if (item.isArray()) {
                    QJsonArray p = item.toArray();
                    if (p.size() >= 2) {
                        c.emotionImages.append(qMakePair(p[0].toString(), p[1].toString()));
                        c.emotionSprites[p[0].toString()] = p[1].toString();
                    }
                }
            }
        }

        QString loreStr = q.value(QStringLiteral("global_lore_json")).toString();
        if (!loreStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(loreStr.toUtf8()).array();
            for (const auto& item : arr) c.globalLore.append(LorebookEntry::fromJson(item.toObject()));
        }

        QString scrStr = q.value(QStringLiteral("custom_scripts_json")).toString();
        if (!scrStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(scrStr.toUtf8()).array();
            for (const auto& item : arr) c.customScripts.append(RegexScript::fromJson(item.toObject()));
        }

        QString fldStr = q.value(QStringLiteral("chat_folders_json")).toString();
        if (!fldStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(fldStr.toUtf8()).array();
            for (const auto& item : arr) c.chatFolders.append(ChatFolder::fromJson(item.toObject()));
        }

        QString grpStr = q.value(QStringLiteral("group_members_json")).toString();
        if (!grpStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(grpStr.toUtf8()).array();
            for (const auto& item : arr) c.groupMembers.append(item.toString());
        }

        QString rawStr = q.value(QStringLiteral("raw_data_json")).toString();
        if (!rawStr.isEmpty()) {
            c.rawData = QJsonDocument::fromJson(rawStr.toUtf8()).object();
        }

        c.chats = getChatsForCharacter(c.id);
        if (c.chats.isEmpty()) {
            Chat defChat;
            defChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            defChat.name = QStringLiteral("Main Chat");
            defChat.lastDate = c.lastInteraction > 0 ? c.lastInteraction : QDateTime::currentMSecsSinceEpoch();
            if (!c.firstMessage.isEmpty()) {
                Message m;
                m.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                m.role = Role::Assistant;
                m.name = c.name;
                m.setCurrentContent(c.firstMessage);
                m.timestamp = defChat.lastDate;
                defChat.messages.append(m);
            }
            saveChat(c.id, defChat);
            c.chats.append(defChat);
        }

        list.append(c);
    }
    return list;
}

bool DatabaseManager::saveCharacter(const Character& c) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO characters ("
        "id, name, avatar_path, first_message, description, personality, scenario, "
        "example_message, creator_notes, system_prompt, post_history_instructions, "
        "creator, character_version, author_note, author_note_depth, alternate_greetings_json, "
        "tags_json, emotion_images_json, emotion_sprites_json, global_lore_json, "
        "custom_scripts_json, chat_folders_json, current_chat_index, first_msg_index, "
        "last_interaction, char_type, group_members_json, raw_data_json"
        ") VALUES ("
        ":id, :name, :avatar_path, :first_message, :description, :personality, :scenario, "
        ":example_message, :creator_notes, :system_prompt, :post_history_instructions, "
        ":creator, :character_version, :author_note, :author_note_depth, :alternate_greetings_json, "
        ":tags_json, :emotion_images_json, :emotion_sprites_json, :global_lore_json, "
        ":custom_scripts_json, :chat_folders_json, :current_chat_index, :first_msg_index, "
        ":last_interaction, :char_type, :group_members_json, :raw_data_json"
        ") ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, avatar_path=excluded.avatar_path, first_message=excluded.first_message, "
        "description=excluded.description, personality=excluded.personality, scenario=excluded.scenario, "
        "example_message=excluded.example_message, creator_notes=excluded.creator_notes, "
        "system_prompt=excluded.system_prompt, post_history_instructions=excluded.post_history_instructions, "
        "creator=excluded.creator, character_version=excluded.character_version, "
        "author_note=excluded.author_note, author_note_depth=excluded.author_note_depth, "
        "alternate_greetings_json=excluded.alternate_greetings_json, tags_json=excluded.tags_json, "
        "emotion_images_json=excluded.emotion_images_json, emotion_sprites_json=excluded.emotion_sprites_json, "
        "global_lore_json=excluded.global_lore_json, custom_scripts_json=excluded.custom_scripts_json, "
        "chat_folders_json=excluded.chat_folders_json, current_chat_index=excluded.current_chat_index, "
        "first_msg_index=excluded.first_msg_index, last_interaction=excluded.last_interaction, "
        "char_type=excluded.char_type, group_members_json=excluded.group_members_json, raw_data_json=excluded.raw_data_json;"
    ));

    q.bindValue(QStringLiteral(":id"), c.id);
    q.bindValue(QStringLiteral(":name"), c.name);
    q.bindValue(QStringLiteral(":avatar_path"), c.avatarPath);
    q.bindValue(QStringLiteral(":first_message"), c.firstMessage);
    q.bindValue(QStringLiteral(":description"), c.description);
    q.bindValue(QStringLiteral(":personality"), c.personality);
    q.bindValue(QStringLiteral(":scenario"), c.scenario);
    q.bindValue(QStringLiteral(":example_message"), c.exampleMessage);
    q.bindValue(QStringLiteral(":creator_notes"), c.creatorNotes);
    q.bindValue(QStringLiteral(":system_prompt"), c.systemPrompt);
    q.bindValue(QStringLiteral(":post_history_instructions"), c.postHistoryInstructions);
    q.bindValue(QStringLiteral(":creator"), c.creator);
    q.bindValue(QStringLiteral(":character_version"), c.characterVersion);
    q.bindValue(QStringLiteral(":author_note"), c.authorNote);
    q.bindValue(QStringLiteral(":author_note_depth"), c.authorNoteDepth);

    QJsonArray altArr;
    for (const auto& alt : c.alternateGreetings) altArr.append(alt);
    q.bindValue(QStringLiteral(":alternate_greetings_json"), QString::fromUtf8(QJsonDocument(altArr).toJson(QJsonDocument::Compact)));

    QJsonArray tagArr;
    for (const auto& tag : c.tags) tagArr.append(tag);
    q.bindValue(QStringLiteral(":tags_json"), QString::fromUtf8(QJsonDocument(tagArr).toJson(QJsonDocument::Compact)));

    QJsonArray emoArr;
    for (const auto& pair : c.emotionImages) {
        QJsonArray p;
        p.append(pair.first);
        p.append(pair.second);
        emoArr.append(p);
    }
    q.bindValue(QStringLiteral(":emotion_images_json"), QString::fromUtf8(QJsonDocument(emoArr).toJson(QJsonDocument::Compact)));

    QJsonObject spriteObj;
    for (auto it = c.emotionSprites.constBegin(); it != c.emotionSprites.constEnd(); ++it) {
        spriteObj[it.key()] = it.value();
    }
    q.bindValue(QStringLiteral(":emotion_sprites_json"), QString::fromUtf8(QJsonDocument(spriteObj).toJson(QJsonDocument::Compact)));

    QJsonArray loreArr;
    for (const auto& lore : c.globalLore) loreArr.append(lore.toJson());
    q.bindValue(QStringLiteral(":global_lore_json"), QString::fromUtf8(QJsonDocument(loreArr).toJson(QJsonDocument::Compact)));

    QJsonArray scrArr;
    for (const auto& scr : c.customScripts) scrArr.append(scr.toJson());
    q.bindValue(QStringLiteral(":custom_scripts_json"), QString::fromUtf8(QJsonDocument(scrArr).toJson(QJsonDocument::Compact)));

    QJsonArray fldArr;
    for (const auto& fld : c.chatFolders) fldArr.append(fld.toJson());
    q.bindValue(QStringLiteral(":chat_folders_json"), QString::fromUtf8(QJsonDocument(fldArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":current_chat_index"), c.currentChatIndex);
    q.bindValue(QStringLiteral(":first_msg_index"), c.firstMsgIndex);
    q.bindValue(QStringLiteral(":last_interaction"), c.lastInteraction);
    q.bindValue(QStringLiteral(":char_type"), c.type);

    QJsonArray grpArr;
    for (const auto& m : c.groupMembers) grpArr.append(m);
    q.bindValue(QStringLiteral(":group_members_json"), QString::fromUtf8(QJsonDocument(grpArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":raw_data_json"), QString::fromUtf8(QJsonDocument(c.rawData).toJson(QJsonDocument::Compact)));

    if (!q.exec()) {
        qCritical() << "Failed to save character:" << q.lastError().text();
        return false;
    }

    // Save chats
    for (const auto& chat : c.chats) {
        saveChat(c.id, chat);
    }

    emit charactersChanged();
    return true;
}

bool DatabaseManager::deleteCharacter(const QString& characterId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM characters WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), characterId);
    if (q.exec()) {
        emit charactersChanged();
        return true;
    }
    return false;
}

std::optional<Character> DatabaseManager::getCharacter(const QString& characterId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT * FROM characters WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), characterId);
    if (q.exec() && q.next()) {
        Character c;
        c.id = q.value(QStringLiteral("id")).toString();
        c.name = q.value(QStringLiteral("name")).toString();
        c.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        c.firstMessage = q.value(QStringLiteral("first_message")).toString();
        c.description = q.value(QStringLiteral("description")).toString();
        c.personality = q.value(QStringLiteral("personality")).toString();
        c.scenario = q.value(QStringLiteral("scenario")).toString();
        c.exampleMessage = q.value(QStringLiteral("example_message")).toString();
        c.creatorNotes = q.value(QStringLiteral("creator_notes")).toString();
        c.systemPrompt = q.value(QStringLiteral("system_prompt")).toString();
        c.postHistoryInstructions = q.value(QStringLiteral("post_history_instructions")).toString();
        c.creator = q.value(QStringLiteral("creator")).toString();
        c.characterVersion = q.value(QStringLiteral("character_version")).toString();
        c.authorNote = q.value(QStringLiteral("author_note")).toString();
        c.authorNoteDepth = q.value(QStringLiteral("author_note_depth")).toInt();
        c.currentChatIndex = q.value(QStringLiteral("current_chat_index")).toInt();
        c.firstMsgIndex = q.value(QStringLiteral("first_msg_index")).toInt();
        c.lastInteraction = q.value(QStringLiteral("last_interaction")).toLongLong();
        c.type = q.value(QStringLiteral("char_type")).toString();

        QString altStr = q.value(QStringLiteral("alternate_greetings_json")).toString();
        if (!altStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(altStr.toUtf8()).array();
            for (const auto& item : arr) c.alternateGreetings.append(item.toString());
        }

        QString tagStr = q.value(QStringLiteral("tags_json")).toString();
        if (!tagStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(tagStr.toUtf8()).array();
            for (const auto& item : arr) c.tags.append(item.toString());
        }

        QString emoStr = q.value(QStringLiteral("emotion_images_json")).toString();
        if (!emoStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(emoStr.toUtf8()).array();
            for (const auto& item : arr) {
                if (item.isArray()) {
                    QJsonArray p = item.toArray();
                    if (p.size() >= 2) {
                        c.emotionImages.append(qMakePair(p[0].toString(), p[1].toString()));
                        c.emotionSprites[p[0].toString()] = p[1].toString();
                    }
                }
            }
        }

        QString loreStr = q.value(QStringLiteral("global_lore_json")).toString();
        if (!loreStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(loreStr.toUtf8()).array();
            for (const auto& item : arr) c.globalLore.append(LorebookEntry::fromJson(item.toObject()));
        }

        QString scrStr = q.value(QStringLiteral("custom_scripts_json")).toString();
        if (!scrStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(scrStr.toUtf8()).array();
            for (const auto& item : arr) c.customScripts.append(RegexScript::fromJson(item.toObject()));
        }

        QString fldStr = q.value(QStringLiteral("chat_folders_json")).toString();
        if (!fldStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(fldStr.toUtf8()).array();
            for (const auto& item : arr) c.chatFolders.append(ChatFolder::fromJson(item.toObject()));
        }

        QString grpStr = q.value(QStringLiteral("group_members_json")).toString();
        if (!grpStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(grpStr.toUtf8()).array();
            for (const auto& item : arr) c.groupMembers.append(item.toString());
        }

        QString rawStr = q.value(QStringLiteral("raw_data_json")).toString();
        if (!rawStr.isEmpty()) {
            c.rawData = QJsonDocument::fromJson(rawStr.toUtf8()).object();
        }

        c.chats = getChatsForCharacter(c.id);
        return c;
    }
    return std::nullopt;
}

// Chats & Messages
QList<Chat> DatabaseManager::getChatsForCharacter(const QString& characterId) {
    QList<Chat> list;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT * FROM chats WHERE character_id = :cid ORDER BY last_date DESC"));
    q.bindValue(QStringLiteral(":cid"), characterId);
    if (q.exec()) {
        while (q.next()) {
            Chat chat;
            chat.id = q.value(QStringLiteral("id")).toString();
            chat.name = q.value(QStringLiteral("name")).toString();
            chat.note = q.value(QStringLiteral("note")).toString();
            chat.firstMessageIndex = q.value(QStringLiteral("first_message_index")).toInt();
            chat.lastDate = q.value(QStringLiteral("last_date")).toLongLong();
            chat.bindedPersona = q.value(QStringLiteral("binded_persona_id")).toString();
            chat.folderId = q.value(QStringLiteral("folder_id")).toString();
            chat.authorNote = q.value(QStringLiteral("author_note")).toString();
            chat.authorNoteDepth = q.value(QStringLiteral("author_note_depth")).toInt();
            chat.sdData = q.value(QStringLiteral("sd_data")).toString();
            chat.supaMemoryData = q.value(QStringLiteral("supa_memory_data")).toString();

            QString loreStr = q.value(QStringLiteral("local_lore_json")).toString();
            if (!loreStr.isEmpty()) {
                QJsonArray arr = QJsonDocument::fromJson(loreStr.toUtf8()).array();
                for (const auto& item : arr) chat.localLore.append(LorebookEntry::fromJson(item.toObject()));
            }

            QString varsStr = q.value(QStringLiteral("chat_variables_json")).toString();
            if (!varsStr.isEmpty()) {
                QJsonObject obj = QJsonDocument::fromJson(varsStr.toUtf8()).object();
                for (auto it = obj.begin(); it != obj.end(); ++it) {
                    chat.chatVariables[it.key()] = it.value().toString();
                }
            }

            QString bkmStr = q.value(QStringLiteral("bookmarks_json")).toString();
            if (!bkmStr.isEmpty()) {
                QJsonArray arr = QJsonDocument::fromJson(bkmStr.toUtf8()).array();
                for (const auto& item : arr) chat.bookmarks.append(item.toString());
            }

            QString smStr = q.value(QStringLiteral("suggest_messages_json")).toString();
            if (!smStr.isEmpty()) {
                QJsonArray arr = QJsonDocument::fromJson(smStr.toUtf8()).array();
                for (const auto& item : arr) chat.suggestMessages.append(item.toString());
            }

            chat.messages = getMessagesForChat(chat.id);
            list.append(chat);
        }
    }
    return list;
}

bool DatabaseManager::saveChat(const QString& characterId, const Chat& chat) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO chats (id, character_id, name, note, first_message_index, last_date, binded_persona_id, folder_id, author_note, author_note_depth, local_lore_json, chat_variables_json, bookmarks_json, suggest_messages_json, sd_data, supa_memory_data) "
        "VALUES (:id, :cid, :name, :note, :first_message_index, :last_date, :binded_persona_id, :folder_id, :author_note, :author_note_depth, :local_lore_json, :chat_variables_json, :bookmarks_json, :suggest_messages_json, :sd_data, :supa_memory_data) "
        "ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, note=excluded.note, first_message_index=excluded.first_message_index, "
        "last_date=excluded.last_date, binded_persona_id=excluded.binded_persona_id, folder_id=excluded.folder_id, "
        "author_note=excluded.author_note, author_note_depth=excluded.author_note_depth, local_lore_json=excluded.local_lore_json, "
        "chat_variables_json=excluded.chat_variables_json, bookmarks_json=excluded.bookmarks_json, suggest_messages_json=excluded.suggest_messages_json, "
        "sd_data=excluded.sd_data, supa_memory_data=excluded.supa_memory_data;"
    ));
    q.bindValue(QStringLiteral(":id"), chat.id);
    q.bindValue(QStringLiteral(":cid"), characterId);
    q.bindValue(QStringLiteral(":name"), chat.name);
    q.bindValue(QStringLiteral(":note"), chat.note);
    q.bindValue(QStringLiteral(":first_message_index"), chat.firstMessageIndex);
    q.bindValue(QStringLiteral(":last_date"), chat.lastDate);
    q.bindValue(QStringLiteral(":binded_persona_id"), chat.bindedPersona);
    q.bindValue(QStringLiteral(":folder_id"), chat.folderId);
    q.bindValue(QStringLiteral(":author_note"), chat.authorNote);
    q.bindValue(QStringLiteral(":author_note_depth"), chat.authorNoteDepth);

    QJsonArray loreArr;
    for (const auto& item : chat.localLore) loreArr.append(item.toJson());
    q.bindValue(QStringLiteral(":local_lore_json"), QString::fromUtf8(QJsonDocument(loreArr).toJson(QJsonDocument::Compact)));

    QJsonObject varsObj;
    for (auto it = chat.chatVariables.constBegin(); it != chat.chatVariables.constEnd(); ++it) {
        varsObj[it.key()] = it.value();
    }
    q.bindValue(QStringLiteral(":chat_variables_json"), QString::fromUtf8(QJsonDocument(varsObj).toJson(QJsonDocument::Compact)));

    QJsonArray bmArr;
    for (const auto& b : chat.bookmarks) bmArr.append(b);
    q.bindValue(QStringLiteral(":bookmarks_json"), QString::fromUtf8(QJsonDocument(bmArr).toJson(QJsonDocument::Compact)));

    QJsonArray smArr;
    for (const auto& s : chat.suggestMessages) smArr.append(s);
    q.bindValue(QStringLiteral(":suggest_messages_json"), QString::fromUtf8(QJsonDocument(smArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":sd_data"), chat.sdData);
    q.bindValue(QStringLiteral(":supa_memory_data"), chat.supaMemoryData);

    if (!q.exec()) {
        qCritical() << "Failed to save chat:" << q.lastError().text();
        return false;
    }

    if (!chat.messages.isEmpty()) {
        saveMessages(chat.id, chat.messages);
    }
    return true;
}

bool DatabaseManager::deleteChat(const QString& chatId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM chats WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), chatId);
    return q.exec();
}

QList<Message> DatabaseManager::getMessagesForChat(const QString& chatId) {
    QList<Message> list;
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT * FROM messages WHERE chat_id = :cid ORDER BY message_order ASC"));
    q.bindValue(QStringLiteral(":cid"), chatId);
    if (q.exec()) {
        while (q.next()) {
            Message m;
            m.id = q.value(QStringLiteral("id")).toString();
            m.role = stringToRole(q.value(QStringLiteral("role")).toString());
            m.name = q.value(QStringLiteral("name")).toString();
            m.data = q.value(QStringLiteral("data")).toString();
            m.thought = q.value(QStringLiteral("thought")).toString();
            m.saying = q.value(QStringLiteral("saying")).toString();
            m.currentSwipeIndex = q.value(QStringLiteral("current_swipe_index")).toInt();
            m.isComment = q.value(QStringLiteral("is_comment")).toInt() != 0;
            m.disabled = q.value(QStringLiteral("disabled")).toInt() != 0;
            m.isPinned = q.value(QStringLiteral("is_pinned")).toInt() != 0;
            m.emotion = q.value(QStringLiteral("emotion")).toString();
            m.attachmentPath = q.value(QStringLiteral("attachment_path")).toString();
            m.timestamp = q.value(QStringLiteral("timestamp")).toLongLong();

            QString swStr = q.value(QStringLiteral("swipes_json")).toString();
            if (!swStr.isEmpty()) {
                QJsonArray arr = QJsonDocument::fromJson(swStr.toUtf8()).array();
                for (const auto& item : arr) m.swipes.append(MessageSwipe::fromJson(item.toObject()));
            }

            QString genStr = q.value(QStringLiteral("generation_info_json")).toString();
            if (!genStr.isEmpty()) {
                m.generationInfo = MessageGenerationInfo::fromJson(QJsonDocument::fromJson(genStr.toUtf8()).object());
            }

            QString prStr = q.value(QStringLiteral("prompt_info_json")).toString();
            if (!prStr.isEmpty()) {
                m.promptInfo = QJsonDocument::fromJson(prStr.toUtf8()).object();
            }

            if (m.swipes.isEmpty() && !m.data.isEmpty()) {
                MessageSwipe s;
                s.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                s.content = m.data;
                s.thought = m.thought;
                s.timestamp = m.timestamp;
                m.swipes.append(s);
                m.currentSwipeIndex = 0;
            }

            list.append(m);
        }
    }
    return list;
}

bool DatabaseManager::saveMessages(const QString& chatId, const QList<Message>& messages) {
    m_db.transaction();
    QSqlQuery delQ(m_db);
    delQ.prepare(QStringLiteral("DELETE FROM messages WHERE chat_id = :cid"));
    delQ.bindValue(QStringLiteral(":cid"), chatId);
    delQ.exec();

    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT OR REPLACE INTO messages (id, chat_id, message_order, role, name, data, thought, saying, current_swipe_index, is_comment, disabled, is_pinned, emotion, attachment_path, timestamp, swipes_json, generation_info_json, prompt_info_json) "
        "VALUES (:id, :cid, :order, :role, :name, :data, :thought, :saying, :swipe_idx, :is_comment, :disabled, :is_pinned, :emotion, :attachment_path, :timestamp, :swipes_json, :generation_info_json, :prompt_info_json);"
    ));

    for (int i = 0; i < messages.size(); ++i) {
        const auto& m = messages[i];
        QString msgId = m.id.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces) : m.id;
        q.bindValue(QStringLiteral(":id"), msgId);
        q.bindValue(QStringLiteral(":cid"), chatId);
        q.bindValue(QStringLiteral(":order"), i);
        q.bindValue(QStringLiteral(":role"), roleToString(m.role));
        q.bindValue(QStringLiteral(":name"), m.name);
        q.bindValue(QStringLiteral(":data"), m.currentContent());
        q.bindValue(QStringLiteral(":thought"), m.currentThought());
        q.bindValue(QStringLiteral(":saying"), m.saying);
        q.bindValue(QStringLiteral(":swipe_idx"), m.currentSwipeIndex);
        q.bindValue(QStringLiteral(":is_comment"), m.isComment ? 1 : 0);
        q.bindValue(QStringLiteral(":disabled"), m.disabled ? 1 : 0);
        q.bindValue(QStringLiteral(":is_pinned"), m.isPinned ? 1 : 0);
        q.bindValue(QStringLiteral(":emotion"), m.emotion);
        q.bindValue(QStringLiteral(":attachment_path"), m.attachmentPath);
        q.bindValue(QStringLiteral(":timestamp"), m.timestamp > 0 ? m.timestamp : QDateTime::currentMSecsSinceEpoch());

        QJsonArray swArr;
        for (const auto& s : m.swipes) swArr.append(s.toJson());
        q.bindValue(QStringLiteral(":swipes_json"), QString::fromUtf8(QJsonDocument(swArr).toJson(QJsonDocument::Compact)));
        q.bindValue(QStringLiteral(":generation_info_json"), QString::fromUtf8(QJsonDocument(m.generationInfo.toJson()).toJson(QJsonDocument::Compact)));
        q.bindValue(QStringLiteral(":prompt_info_json"), QString::fromUtf8(QJsonDocument(m.promptInfo).toJson(QJsonDocument::Compact)));

        if (!q.exec()) {
            qCritical() << "Failed to insert message:" << q.lastError().text();
            m_db.rollback();
            return false;
        }
    }
    return m_db.commit();
}

bool DatabaseManager::addMessage(const QString& chatId, const Message& message, int order) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT OR REPLACE INTO messages (id, chat_id, message_order, role, name, data, thought, saying, current_swipe_index, is_comment, disabled, is_pinned, emotion, attachment_path, timestamp, swipes_json, generation_info_json, prompt_info_json) "
        "VALUES (:id, :cid, :order, :role, :name, :data, :thought, :saying, :swipe_idx, :is_comment, :disabled, :is_pinned, :emotion, :attachment_path, :timestamp, :swipes_json, :generation_info_json, :prompt_info_json);"
    ));
    q.bindValue(QStringLiteral(":id"), message.id.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces) : message.id);
    q.bindValue(QStringLiteral(":cid"), chatId);
    q.bindValue(QStringLiteral(":order"), order);
    q.bindValue(QStringLiteral(":role"), roleToString(message.role));
    q.bindValue(QStringLiteral(":name"), message.name);
    q.bindValue(QStringLiteral(":data"), message.currentContent());
    q.bindValue(QStringLiteral(":thought"), message.currentThought());
    q.bindValue(QStringLiteral(":saying"), message.saying);
    q.bindValue(QStringLiteral(":swipe_idx"), message.currentSwipeIndex);
    q.bindValue(QStringLiteral(":is_comment"), message.isComment ? 1 : 0);
    q.bindValue(QStringLiteral(":disabled"), message.disabled ? 1 : 0);
    q.bindValue(QStringLiteral(":is_pinned"), message.isPinned ? 1 : 0);
    q.bindValue(QStringLiteral(":emotion"), message.emotion);
    q.bindValue(QStringLiteral(":attachment_path"), message.attachmentPath);
    q.bindValue(QStringLiteral(":timestamp"), message.timestamp > 0 ? message.timestamp : QDateTime::currentMSecsSinceEpoch());

    QJsonArray swArr;
    for (const auto& s : message.swipes) swArr.append(s.toJson());
    q.bindValue(QStringLiteral(":swipes_json"), QString::fromUtf8(QJsonDocument(swArr).toJson(QJsonDocument::Compact)));
    q.bindValue(QStringLiteral(":generation_info_json"), QString::fromUtf8(QJsonDocument(message.generationInfo.toJson()).toJson(QJsonDocument::Compact)));
    q.bindValue(QStringLiteral(":prompt_info_json"), QString::fromUtf8(QJsonDocument(message.promptInfo).toJson(QJsonDocument::Compact)));

    return q.exec();
}

bool DatabaseManager::updateMessage(const QString& chatId, const Message& message) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "UPDATE messages SET role=:role, name=:name, data=:data, thought=:thought, saying=:saying, "
        "current_swipe_index=:swipe_idx, is_comment=:is_comment, disabled=:disabled, is_pinned=:is_pinned, "
        "emotion=:emotion, attachment_path=:attachment_path, timestamp=:timestamp, swipes_json=:swipes_json, "
        "generation_info_json=:generation_info_json, prompt_info_json=:prompt_info_json "
        "WHERE id=:id AND chat_id=:cid;"
    ));
    q.bindValue(QStringLiteral(":id"), message.id);
    q.bindValue(QStringLiteral(":cid"), chatId);
    q.bindValue(QStringLiteral(":role"), roleToString(message.role));
    q.bindValue(QStringLiteral(":name"), message.name);
    q.bindValue(QStringLiteral(":data"), message.currentContent());
    q.bindValue(QStringLiteral(":thought"), message.currentThought());
    q.bindValue(QStringLiteral(":saying"), message.saying);
    q.bindValue(QStringLiteral(":swipe_idx"), message.currentSwipeIndex);
    q.bindValue(QStringLiteral(":is_comment"), message.isComment ? 1 : 0);
    q.bindValue(QStringLiteral(":disabled"), message.disabled ? 1 : 0);
    q.bindValue(QStringLiteral(":is_pinned"), message.isPinned ? 1 : 0);
    q.bindValue(QStringLiteral(":emotion"), message.emotion);
    q.bindValue(QStringLiteral(":attachment_path"), message.attachmentPath);
    q.bindValue(QStringLiteral(":timestamp"), message.timestamp);

    QJsonArray swArr;
    for (const auto& s : message.swipes) swArr.append(s.toJson());
    q.bindValue(QStringLiteral(":swipes_json"), QString::fromUtf8(QJsonDocument(swArr).toJson(QJsonDocument::Compact)));
    q.bindValue(QStringLiteral(":generation_info_json"), QString::fromUtf8(QJsonDocument(message.generationInfo.toJson()).toJson(QJsonDocument::Compact)));
    q.bindValue(QStringLiteral(":prompt_info_json"), QString::fromUtf8(QJsonDocument(message.promptInfo).toJson(QJsonDocument::Compact)));

    return q.exec();
}

bool DatabaseManager::deleteMessage(const QString& messageId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM messages WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), messageId);
    return q.exec();
}

// Presets
QList<Preset> DatabaseManager::getAllPresets() {
    QList<Preset> list;
    QSqlQuery q(QStringLiteral("SELECT * FROM presets"), m_db);
    while (q.next()) {
        Preset p;
        p.id = q.value(QStringLiteral("id")).toString();
        p.name = q.value(QStringLiteral("name")).toString();
        p.provider = stringToProviderType(q.value(QStringLiteral("provider")).toString());
        p.apiType = q.value(QStringLiteral("api_type")).toString();
        p.modelName = q.value(QStringLiteral("model_name")).toString();
        p.subModel = q.value(QStringLiteral("sub_model")).toString();
        p.apiKey = q.value(QStringLiteral("api_key")).toString();
        p.customEndpointUrl = q.value(QStringLiteral("custom_endpoint_url")).toString();
        p.temperature = q.value(QStringLiteral("temperature")).toDouble();
        p.maxTokens = q.value(QStringLiteral("max_tokens")).toInt();
        p.contextLimit = q.value(QStringLiteral("context_limit")).toInt();
        p.topP = q.value(QStringLiteral("top_p")).toDouble();
        p.topK = q.value(QStringLiteral("top_k")).toInt();
        p.frequencyPenalty = q.value(QStringLiteral("frequency_penalty")).toDouble();
        p.presencePenalty = q.value(QStringLiteral("presence_penalty")).toDouble();
        p.repetitionPenalty = q.value(QStringLiteral("repetition_penalty")).toDouble();
        p.minP = q.value(QStringLiteral("min_p")).toDouble();
        p.topA = q.value(QStringLiteral("top_a")).toDouble();
        p.reasoningEffort = q.value(QStringLiteral("reasoning_effort")).toInt();
        p.thinkingTokens = q.value(QStringLiteral("thinking_tokens")).toInt();
        p.thinkingType = q.value(QStringLiteral("thinking_type")).toString();
        p.enableStreaming = q.value(QStringLiteral("enable_streaming")).toInt() != 0;

        QString stopStr = q.value(QStringLiteral("stop_sequences_json")).toString();
        if (!stopStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(stopStr.toUtf8()).array();
            for (const auto& item : arr) p.stopSequences.append(item.toString());
        }

        p.mainPrompt = q.value(QStringLiteral("main_prompt")).toString();
        p.jailbreakPrompt = q.value(QStringLiteral("jailbreak_prompt")).toString();
        p.globalNote = q.value(QStringLiteral("global_note")).toString();
        p.postHistoryInstructions = q.value(QStringLiteral("post_history_instructions")).toString();
        p.enableJailbreak = q.value(QStringLiteral("enable_jailbreak")).toInt() != 0;

        QString orderStr = q.value(QStringLiteral("formatting_order_json")).toString();
        if (!orderStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(orderStr.toUtf8()).array();
            for (const auto& item : arr) p.formattingOrder.append(item.toString());
        }

        p.proxyKey = q.value(QStringLiteral("proxy_key")).toString();

        QString prTplStr = q.value(QStringLiteral("prompt_template_json")).toString();
        if (!prTplStr.isEmpty()) {
            p.promptTemplate = QJsonDocument::fromJson(prTplStr.toUtf8()).array();
        }

        QString rawStr = q.value(QStringLiteral("raw_data_json")).toString();
        if (!rawStr.isEmpty()) {
            p.rawData = QJsonDocument::fromJson(rawStr.toUtf8()).object();
        }

        list.append(p);
    }
    return list;
}

bool DatabaseManager::savePreset(const Preset& p) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO presets ("
        "id, name, provider, api_type, model_name, sub_model, api_key, custom_endpoint_url, temperature, max_tokens, "
        "context_limit, top_p, top_k, frequency_penalty, presence_penalty, repetition_penalty, min_p, top_a, "
        "reasoning_effort, thinking_tokens, thinking_type, enable_streaming, stop_sequences_json, main_prompt, jailbreak_prompt, "
        "global_note, post_history_instructions, enable_jailbreak, formatting_order_json, proxy_key, prompt_template_json, raw_data_json"
        ") VALUES ("
        ":id, :name, :provider, :api_type, :model_name, :sub_model, :api_key, :custom_endpoint_url, :temperature, :max_tokens, "
        ":context_limit, :top_p, :top_k, :frequency_penalty, :presence_penalty, :repetition_penalty, :min_p, :top_a, "
        ":reasoning_effort, :thinking_tokens, :thinking_type, :enable_streaming, :stop_sequences_json, :main_prompt, :jailbreak_prompt, "
        ":global_note, :post_history_instructions, :enable_jailbreak, :formatting_order_json, :proxy_key, :prompt_template_json, :raw_data_json"
        ") ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, provider=excluded.provider, api_type=excluded.api_type, model_name=excluded.model_name, "
        "sub_model=excluded.sub_model, api_key=excluded.api_key, custom_endpoint_url=excluded.custom_endpoint_url, "
        "temperature=excluded.temperature, max_tokens=excluded.max_tokens, "
        "context_limit=excluded.context_limit, top_p=excluded.top_p, top_k=excluded.top_k, "
        "frequency_penalty=excluded.frequency_penalty, presence_penalty=excluded.presence_penalty, "
        "repetition_penalty=excluded.repetition_penalty, min_p=excluded.min_p, top_a=excluded.top_a, "
        "reasoning_effort=excluded.reasoning_effort, thinking_tokens=excluded.thinking_tokens, "
        "thinking_type=excluded.thinking_type, enable_streaming=excluded.enable_streaming, "
        "stop_sequences_json=excluded.stop_sequences_json, main_prompt=excluded.main_prompt, "
        "jailbreak_prompt=excluded.jailbreak_prompt, global_note=excluded.global_note, "
        "post_history_instructions=excluded.post_history_instructions, enable_jailbreak=excluded.enable_jailbreak, "
        "formatting_order_json=excluded.formatting_order_json, proxy_key=excluded.proxy_key, "
        "prompt_template_json=excluded.prompt_template_json, raw_data_json=excluded.raw_data_json;"
    ));

    q.bindValue(QStringLiteral(":id"), p.id);
    q.bindValue(QStringLiteral(":name"), p.name);
    q.bindValue(QStringLiteral(":provider"), providerTypeToString(p.provider));
    q.bindValue(QStringLiteral(":api_type"), p.apiType);
    q.bindValue(QStringLiteral(":model_name"), p.modelName);
    q.bindValue(QStringLiteral(":sub_model"), p.subModel);
    q.bindValue(QStringLiteral(":api_key"), p.apiKey);
    q.bindValue(QStringLiteral(":custom_endpoint_url"), p.customEndpointUrl);
    q.bindValue(QStringLiteral(":temperature"), p.temperature);
    q.bindValue(QStringLiteral(":max_tokens"), p.maxTokens);
    q.bindValue(QStringLiteral(":context_limit"), p.contextLimit);
    q.bindValue(QStringLiteral(":top_p"), p.topP);
    q.bindValue(QStringLiteral(":top_k"), p.topK);
    q.bindValue(QStringLiteral(":frequency_penalty"), p.frequencyPenalty);
    q.bindValue(QStringLiteral(":presence_penalty"), p.presencePenalty);
    q.bindValue(QStringLiteral(":repetition_penalty"), p.repetitionPenalty);
    q.bindValue(QStringLiteral(":min_p"), p.minP);
    q.bindValue(QStringLiteral(":top_a"), p.topA);
    q.bindValue(QStringLiteral(":reasoning_effort"), p.reasoningEffort);
    q.bindValue(QStringLiteral(":thinking_tokens"), p.thinkingTokens);
    q.bindValue(QStringLiteral(":thinking_type"), p.thinkingType);
    q.bindValue(QStringLiteral(":enable_streaming"), p.enableStreaming ? 1 : 0);

    QJsonArray stopArr;
    for (const auto& s : p.stopSequences) stopArr.append(s);
    q.bindValue(QStringLiteral(":stop_sequences_json"), QString::fromUtf8(QJsonDocument(stopArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":main_prompt"), p.mainPrompt);
    q.bindValue(QStringLiteral(":jailbreak_prompt"), p.jailbreakPrompt);
    q.bindValue(QStringLiteral(":global_note"), p.globalNote);
    q.bindValue(QStringLiteral(":post_history_instructions"), p.postHistoryInstructions);
    q.bindValue(QStringLiteral(":enable_jailbreak"), p.enableJailbreak ? 1 : 0);

    QJsonArray orderArr;
    for (const auto& item : p.formattingOrder) orderArr.append(item);
    q.bindValue(QStringLiteral(":formatting_order_json"), QString::fromUtf8(QJsonDocument(orderArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":proxy_key"), p.proxyKey);
    q.bindValue(QStringLiteral(":prompt_template_json"), QString::fromUtf8(QJsonDocument(p.promptTemplate).toJson(QJsonDocument::Compact)));
    q.bindValue(QStringLiteral(":raw_data_json"), QString::fromUtf8(QJsonDocument(p.rawData).toJson(QJsonDocument::Compact)));

    if (q.exec()) {
        emit presetsChanged();
        return true;
    }
    qCritical() << "Failed to save preset:" << q.lastError().text();
    return false;
}

bool DatabaseManager::deletePreset(const QString& presetId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM presets WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), presetId);
    if (q.exec()) {
        emit presetsChanged();
        return true;
    }
    return false;
}

std::optional<Preset> DatabaseManager::getPreset(const QString& presetId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT * FROM presets WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), presetId);
    if (q.exec() && q.next()) {
        Preset p;
        p.id = q.value(QStringLiteral("id")).toString();
        p.name = q.value(QStringLiteral("name")).toString();
        p.provider = stringToProviderType(q.value(QStringLiteral("provider")).toString());
        p.apiType = q.value(QStringLiteral("api_type")).toString();
        p.modelName = q.value(QStringLiteral("model_name")).toString();
        p.subModel = q.value(QStringLiteral("sub_model")).toString();
        p.apiKey = q.value(QStringLiteral("api_key")).toString();
        p.customEndpointUrl = q.value(QStringLiteral("custom_endpoint_url")).toString();
        p.temperature = q.value(QStringLiteral("temperature")).toDouble();
        p.maxTokens = q.value(QStringLiteral("max_tokens")).toInt();
        p.contextLimit = q.value(QStringLiteral("context_limit")).toInt();
        p.topP = q.value(QStringLiteral("top_p")).toDouble();
        p.topK = q.value(QStringLiteral("top_k")).toInt();
        p.frequencyPenalty = q.value(QStringLiteral("frequency_penalty")).toDouble();
        p.presencePenalty = q.value(QStringLiteral("presence_penalty")).toDouble();
        p.repetitionPenalty = q.value(QStringLiteral("repetition_penalty")).toDouble();
        p.minP = q.value(QStringLiteral("min_p")).toDouble();
        p.topA = q.value(QStringLiteral("top_a")).toDouble();
        p.reasoningEffort = q.value(QStringLiteral("reasoning_effort")).toInt();
        p.thinkingTokens = q.value(QStringLiteral("thinking_tokens")).toInt();
        p.thinkingType = q.value(QStringLiteral("thinking_type")).toString();
        p.enableStreaming = q.value(QStringLiteral("enable_streaming")).toInt() != 0;

        QString stopStr = q.value(QStringLiteral("stop_sequences_json")).toString();
        if (!stopStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(stopStr.toUtf8()).array();
            for (const auto& item : arr) p.stopSequences.append(item.toString());
        }

        p.mainPrompt = q.value(QStringLiteral("main_prompt")).toString();
        p.jailbreakPrompt = q.value(QStringLiteral("jailbreak_prompt")).toString();
        p.globalNote = q.value(QStringLiteral("global_note")).toString();
        p.postHistoryInstructions = q.value(QStringLiteral("post_history_instructions")).toString();
        p.enableJailbreak = q.value(QStringLiteral("enable_jailbreak")).toInt() != 0;

        QString orderStr = q.value(QStringLiteral("formatting_order_json")).toString();
        if (!orderStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(orderStr.toUtf8()).array();
            for (const auto& item : arr) p.formattingOrder.append(item.toString());
        }

        p.proxyKey = q.value(QStringLiteral("proxy_key")).toString();

        QString prTplStr = q.value(QStringLiteral("prompt_template_json")).toString();
        if (!prTplStr.isEmpty()) {
            p.promptTemplate = QJsonDocument::fromJson(prTplStr.toUtf8()).array();
        }

        QString rawStr = q.value(QStringLiteral("raw_data_json")).toString();
        if (!rawStr.isEmpty()) {
            p.rawData = QJsonDocument::fromJson(rawStr.toUtf8()).object();
        }

        return p;
    }
    return std::nullopt;
}

// Personas
QList<Persona> DatabaseManager::getAllPersonas() {
    QList<Persona> list;
    QSqlQuery q(QStringLiteral("SELECT * FROM personas"), m_db);
    while (q.next()) {
        Persona p;
        p.id = q.value(QStringLiteral("id")).toString();
        p.name = q.value(QStringLiteral("name")).toString();
        p.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        p.description = q.value(QStringLiteral("description")).toString();
        p.personaPrompt = q.value(QStringLiteral("persona_prompt")).toString();
        p.largePortrait = q.value(QStringLiteral("large_portrait")).toInt() != 0;
        p.isActive = q.value(QStringLiteral("is_active")).toInt() != 0;
        list.append(p);
    }
    return list;
}

bool DatabaseManager::savePersona(const Persona& p) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO personas (id, name, avatar_path, description, persona_prompt, large_portrait, is_active) "
        "VALUES (:id, :name, :avatar_path, :description, :persona_prompt, :large_portrait, :is_active) "
        "ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, avatar_path=excluded.avatar_path, description=excluded.description, "
        "persona_prompt=excluded.persona_prompt, large_portrait=excluded.large_portrait, is_active=excluded.is_active;"
    ));
    q.bindValue(QStringLiteral(":id"), p.id);
    q.bindValue(QStringLiteral(":name"), p.name);
    q.bindValue(QStringLiteral(":avatar_path"), p.avatarPath);
    q.bindValue(QStringLiteral(":description"), p.description);
    q.bindValue(QStringLiteral(":persona_prompt"), p.personaPrompt);
    q.bindValue(QStringLiteral(":large_portrait"), p.largePortrait ? 1 : 0);
    q.bindValue(QStringLiteral(":is_active"), p.isActive ? 1 : 0);

    if (q.exec()) {
        emit personasChanged();
        return true;
    }
    return false;
}

bool DatabaseManager::deletePersona(const QString& personaId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM personas WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), personaId);
    if (q.exec()) {
        emit personasChanged();
        return true;
    }
    return false;
}

std::optional<Persona> DatabaseManager::getActivePersona() {
    QSqlQuery q(QStringLiteral("SELECT * FROM personas WHERE is_active = 1 LIMIT 1"), m_db);
    if (q.next()) {
        Persona p;
        p.id = q.value(QStringLiteral("id")).toString();
        p.name = q.value(QStringLiteral("name")).toString();
        p.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        p.description = q.value(QStringLiteral("description")).toString();
        p.personaPrompt = q.value(QStringLiteral("persona_prompt")).toString();
        p.largePortrait = q.value(QStringLiteral("large_portrait")).toInt() != 0;
        p.isActive = true;
        return p;
    }
    return std::nullopt;
}

bool DatabaseManager::setActivePersona(const QString& personaId) {
    m_db.transaction();
    QSqlQuery clearQ(QStringLiteral("UPDATE personas SET is_active = 0"), m_db);
    clearQ.exec();

    QSqlQuery setQ(m_db);
    setQ.prepare(QStringLiteral("UPDATE personas SET is_active = 1 WHERE id = :id"));
    setQ.bindValue(QStringLiteral(":id"), personaId);
    bool ok = setQ.exec();
    if (ok) {
        m_db.commit();
        AppConfig::instance().setSelectedPersonaId(personaId);
        emit personasChanged();
        return true;
    }
    m_db.rollback();
    return false;
}

// Global Lorebooks
QList<LorebookEntry> DatabaseManager::getAllGlobalLorebooks() {
    QList<LorebookEntry> list;
    QSqlQuery q(QStringLiteral("SELECT * FROM global_lorebooks ORDER BY insert_order ASC"), m_db);
    while (q.next()) {
        LorebookEntry e;
        e.id = q.value(QStringLiteral("id")).toString();
        e.key = q.value(QStringLiteral("key_triggers")).toString();
        e.secondKey = q.value(QStringLiteral("second_key")).toString();
        e.comment = q.value(QStringLiteral("comment")).toString();
        e.content = q.value(QStringLiteral("content")).toString();
        e.mode = q.value(QStringLiteral("mode")).toString();
        e.insertOrder = q.value(QStringLiteral("insert_order")).toInt();
        e.alwaysActive = q.value(QStringLiteral("always_active")).toInt() != 0;
        e.selective = q.value(QStringLiteral("selective")).toInt() != 0;
        e.useRegex = q.value(QStringLiteral("use_regex")).toInt() != 0;
        e.caseSensitive = q.value(QStringLiteral("case_sensitive")).toInt() != 0;
        e.scanDepth = q.value(QStringLiteral("scan_depth")).toInt();
        e.enabled = q.value(QStringLiteral("enabled")).toInt() != 0;
        list.append(e);
    }
    return list;
}

bool DatabaseManager::saveGlobalLorebook(const LorebookEntry& e) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO global_lorebooks ("
        "id, key_triggers, second_key, comment, content, mode, insert_order, "
        "always_active, selective, use_regex, case_sensitive, scan_depth, enabled"
        ") VALUES ("
        ":id, :key_triggers, :second_key, :comment, :content, :mode, :insert_order, "
        ":always_active, :selective, :use_regex, :case_sensitive, :scan_depth, :enabled"
        ") ON CONFLICT(id) DO UPDATE SET "
        "key_triggers=excluded.key_triggers, second_key=excluded.second_key, "
        "comment=excluded.comment, content=excluded.content, mode=excluded.mode, "
        "insert_order=excluded.insert_order, always_active=excluded.always_active, "
        "selective=excluded.selective, use_regex=excluded.use_regex, "
        "case_sensitive=excluded.case_sensitive, scan_depth=excluded.scan_depth, "
        "enabled=excluded.enabled;"
    ));

    q.bindValue(QStringLiteral(":id"), e.id);
    q.bindValue(QStringLiteral(":key_triggers"), e.key);
    q.bindValue(QStringLiteral(":second_key"), e.secondKey);
    q.bindValue(QStringLiteral(":comment"), e.comment);
    q.bindValue(QStringLiteral(":content"), e.content);
    q.bindValue(QStringLiteral(":mode"), e.mode);
    q.bindValue(QStringLiteral(":insert_order"), e.insertOrder);
    q.bindValue(QStringLiteral(":always_active"), e.alwaysActive ? 1 : 0);
    q.bindValue(QStringLiteral(":selective"), e.selective ? 1 : 0);
    q.bindValue(QStringLiteral(":use_regex"), e.useRegex ? 1 : 0);
    q.bindValue(QStringLiteral(":case_sensitive"), e.caseSensitive ? 1 : 0);
    q.bindValue(QStringLiteral(":scan_depth"), e.scanDepth);
    q.bindValue(QStringLiteral(":enabled"), e.enabled ? 1 : 0);

    if (q.exec()) {
        emit lorebooksChanged();
        return true;
    }
    return false;
}

bool DatabaseManager::deleteGlobalLorebook(const QString& entryId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM global_lorebooks WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), entryId);
    if (q.exec()) {
        emit lorebooksChanged();
        return true;
    }
    return false;
}

// Group Chat Rooms
QList<GroupChatRoom> DatabaseManager::getAllGroups() {
    QList<GroupChatRoom> list;
    QSqlQuery q(QStringLiteral("SELECT * FROM groups ORDER BY last_interaction DESC"), m_db);
    while (q.next()) {
        GroupChatRoom g;
        g.id = q.value(QStringLiteral("id")).toString();
        g.name = q.value(QStringLiteral("name")).toString();
        g.description = q.value(QStringLiteral("description")).toString();
        g.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        g.currentChatIndex = q.value(QStringLiteral("current_chat_index")).toInt();
        g.lastInteraction = q.value(QStringLiteral("last_interaction")).toLongLong();

        QString memStr = q.value(QStringLiteral("members_json")).toString();
        if (!memStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(memStr.toUtf8()).array();
            for (const auto& item : arr) g.members.append(GroupMember::fromJson(item.toObject()));
        }

        QString chatsStr = q.value(QStringLiteral("chats_json")).toString();
        if (!chatsStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(chatsStr.toUtf8()).array();
            for (const auto& item : arr) g.chats.append(Chat::fromJson(item.toObject()));
        }

        list.append(g);
    }
    return list;
}

bool DatabaseManager::saveGroup(const GroupChatRoom& g) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral(
        "INSERT INTO groups ("
        "id, name, description, avatar_path, members_json, chats_json, current_chat_index, last_interaction"
        ") VALUES ("
        ":id, :name, :description, :avatar_path, :members_json, :chats_json, :current_chat_index, :last_interaction"
        ") ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, description=excluded.description, avatar_path=excluded.avatar_path, "
        "members_json=excluded.members_json, chats_json=excluded.chats_json, "
        "current_chat_index=excluded.current_chat_index, last_interaction=excluded.last_interaction;"
    ));
    q.bindValue(QStringLiteral(":id"), g.id);
    q.bindValue(QStringLiteral(":name"), g.name);
    q.bindValue(QStringLiteral(":description"), g.description);
    q.bindValue(QStringLiteral(":avatar_path"), g.avatarPath);

    QJsonArray memArr;
    for (const auto& m : g.members) memArr.append(m.toJson());
    q.bindValue(QStringLiteral(":members_json"), QString::fromUtf8(QJsonDocument(memArr).toJson(QJsonDocument::Compact)));

    QJsonArray chatsArr;
    for (const auto& c : g.chats) chatsArr.append(c.toJson());
    q.bindValue(QStringLiteral(":chats_json"), QString::fromUtf8(QJsonDocument(chatsArr).toJson(QJsonDocument::Compact)));

    q.bindValue(QStringLiteral(":current_chat_index"), g.currentChatIndex);
    q.bindValue(QStringLiteral(":last_interaction"), g.lastInteraction);

    if (q.exec()) {
        emit groupsChanged();
        return true;
    }
    return false;
}

bool DatabaseManager::deleteGroup(const QString& groupId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("DELETE FROM groups WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), groupId);
    if (q.exec()) {
        emit groupsChanged();
        return true;
    }
    return false;
}

std::optional<GroupChatRoom> DatabaseManager::getGroup(const QString& groupId) {
    QSqlQuery q(m_db);
    q.prepare(QStringLiteral("SELECT * FROM groups WHERE id = :id"));
    q.bindValue(QStringLiteral(":id"), groupId);
    if (q.exec() && q.next()) {
        GroupChatRoom g;
        g.id = q.value(QStringLiteral("id")).toString();
        g.name = q.value(QStringLiteral("name")).toString();
        g.description = q.value(QStringLiteral("description")).toString();
        g.avatarPath = q.value(QStringLiteral("avatar_path")).toString();
        g.currentChatIndex = q.value(QStringLiteral("current_chat_index")).toInt();
        g.lastInteraction = q.value(QStringLiteral("last_interaction")).toLongLong();

        QString memStr = q.value(QStringLiteral("members_json")).toString();
        if (!memStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(memStr.toUtf8()).array();
            for (const auto& item : arr) g.members.append(GroupMember::fromJson(item.toObject()));
        }

        QString chatsStr = q.value(QStringLiteral("chats_json")).toString();
        if (!chatsStr.isEmpty()) {
            QJsonArray arr = QJsonDocument::fromJson(chatsStr.toUtf8()).array();
            for (const auto& item : arr) g.chats.append(Chat::fromJson(item.toObject()));
        }
        return g;
    }
    return std::nullopt;
}

QJsonObject DatabaseManager::exportFullDatabase() {
    QJsonObject root;
    root[QStringLiteral("version")] = QStringLiteral("2026.8.qt");

    QJsonArray charsArr;
    for (const auto& c : getAllCharacters()) {
        charsArr.append(c.toJson());
    }
    root[QStringLiteral("characters")] = charsArr;

    QJsonArray groupsArr;
    for (const auto& g : getAllGroups()) {
        groupsArr.append(g.toJson());
    }
    root[QStringLiteral("groups")] = groupsArr;

    QJsonArray presetsArr;
    for (const auto& p : getAllPresets()) {
        presetsArr.append(p.toJson());
    }
    root[QStringLiteral("presets")] = presetsArr;

    QJsonArray personasArr;
    for (const auto& p : getAllPersonas()) {
        personasArr.append(p.toJson());
    }
    root[QStringLiteral("personas")] = personasArr;

    QJsonArray loreArr;
    for (const auto& l : getAllGlobalLorebooks()) {
        loreArr.append(l.toJson());
    }
    root[QStringLiteral("globalLore")] = loreArr;

    return root;
}

bool DatabaseManager::importFullDatabase(const QJsonObject& rootObj) {
    m_db.transaction();
    try {
        if (rootObj.contains(QStringLiteral("characters")) && rootObj.value(QStringLiteral("characters")).isArray()) {
            QJsonArray arr = rootObj.value(QStringLiteral("characters")).toArray();
            for (const auto& item : arr) {
                Character c = Character::fromJson(item.toObject());
                saveCharacter(c);
            }
        }
        if (rootObj.contains(QStringLiteral("groups")) && rootObj.value(QStringLiteral("groups")).isArray()) {
            QJsonArray arr = rootObj.value(QStringLiteral("groups")).toArray();
            for (const auto& item : arr) {
                GroupChatRoom g = GroupChatRoom::fromJson(item.toObject());
                saveGroup(g);
            }
        }
        if (rootObj.contains(QStringLiteral("presets")) && rootObj.value(QStringLiteral("presets")).isArray()) {
            QJsonArray arr = rootObj.value(QStringLiteral("presets")).toArray();
            for (const auto& item : arr) {
                Preset p = Preset::fromJson(item.toObject());
                savePreset(p);
            }
        }
        if (rootObj.contains(QStringLiteral("personas")) && rootObj.value(QStringLiteral("personas")).isArray()) {
            QJsonArray arr = rootObj.value(QStringLiteral("personas")).toArray();
            for (const auto& item : arr) {
                Persona p = Persona::fromJson(item.toObject());
                savePersona(p);
            }
        }
        if (rootObj.contains(QStringLiteral("globalLore")) && rootObj.value(QStringLiteral("globalLore")).isArray()) {
            QJsonArray arr = rootObj.value(QStringLiteral("globalLore")).toArray();
            for (const auto& item : arr) {
                LorebookEntry l = LorebookEntry::fromJson(item.toObject());
                saveGlobalLorebook(l);
            }
        }
        m_db.commit();
        emit charactersChanged();
        emit groupsChanged();
        emit presetsChanged();
        emit personasChanged();
        emit lorebooksChanged();
        return true;
    } catch (...) {
        m_db.rollback();
        return false;
    }
}

} // namespace Risu
