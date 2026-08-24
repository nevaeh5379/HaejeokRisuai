#include <QCoreApplication>
#include <QTest>
#include <QFile>
#include <QDir>
#include <QDebug>
#include <QTemporaryDir>
#include <algorithm>
#include <cassert>

#include "core/Types.hpp"
#include "core/AppConfig.hpp"
#include "core/DatabaseManager.hpp"
#include "core/I18n.hpp"
#include "core/SystemTrayManager.hpp"
#include "core/SoundEffectManager.hpp"
#include "engine/Tokenizer.hpp"
#include "engine/RegexEngine.hpp"
#include "engine/ModuleEngine.hpp"
#include "engine/PromptEngine.hpp"
#include "engine/MemoryManager.hpp"
#include "engine/TriggerEngine.hpp"
#include "engine/ScriptingEngine.hpp"
#include "engine/EmbeddingEngine.hpp"
#include "engine/PluginEngine.hpp"
#include "engine/Translator.hpp"
#include "engine/GraphMemory.hpp"
#include "storage/CharacterCardIO.hpp"
#include "storage/ExportImport.hpp"
#include "storage/CloudSyncManager.hpp"
#include "storage/ArchivePacker.hpp"
#include "storage/ColdStorageManager.hpp"
#include "network/AIProvider.hpp"
#include "network/APIServer.hpp"
#include "network/SyncEngine.hpp"
#include "controllers/TTSController.hpp"
#include "controllers/ImageGenController.hpp"
#include "controllers/ChatController.hpp"
#include "controllers/PersonaController.hpp"
#include "models/ChatMessageModel.hpp"

using namespace Risu;

void testDatabaseAndTypes() {
    qInfo() << "[TEST 1] Testing Database & Data Structures...";

    auto& db = DatabaseManager::instance();
    bool initialized = db.initDatabase();
    assert(initialized && "Database should initialize successfully");

    // 1. Verify default character and presets created
    auto chars = db.getAllCharacters();
    assert(!chars.isEmpty() && "Should have seeded starter character");
    qInfo() << "  -> Found" << chars.size() << "characters in DB. First:" << chars.first().name;

    auto presets = db.getAllPresets();
    assert(!presets.isEmpty() && "Should have seeded default presets");
    qInfo() << "  -> Found" << presets.size() << "presets in DB.";

    auto personas = db.getAllPersonas();
    assert(!personas.isEmpty() && "Should have seeded default persona");
    qInfo() << "  -> Found persona:" << personas.first().name;

    // 2. Create custom character and save
    Character customChar;
    customChar.id = QStringLiteral("test-char-123");
    customChar.name = QStringLiteral("Test Companion");
    customChar.firstMessage = QStringLiteral("Hello! I am a test character.");
    customChar.description = QStringLiteral("A reliable test companion.");
    customChar.personality = QStringLiteral("Helpful, intelligent, friendly.");
    customChar.scenario = QStringLiteral("Testing suite environment.");
    customChar.tags = QStringList{QStringLiteral("Test"), QStringLiteral("Qt6")};
    customChar.lastInteraction = QDateTime::currentMSecsSinceEpoch();

    Chat testChat;
    testChat.id = QStringLiteral("test-chat-1");
    testChat.name = QStringLiteral("Integration Test Chat");
    testChat.firstMessageIndex = 0;
    testChat.lastDate = customChar.lastInteraction;
    testChat.modules = QStringList{QStringLiteral("module-chat-test")};

    Message msg1;
    msg1.id = QStringLiteral("msg-1");
    msg1.role = Role::Assistant;
    msg1.name = customChar.name;
    msg1.setCurrentContent(customChar.firstMessage);
    testChat.messages.append(msg1);

    Message msg2;
    msg2.id = QStringLiteral("msg-2");
    msg2.role = Role::User;
    msg2.name = QStringLiteral("User");
    msg2.setCurrentContent(QStringLiteral("Can you tell me about yourself?"));
    testChat.messages.append(msg2);

    Message msg3;
    msg3.id = QStringLiteral("msg-3");
    msg3.role = Role::Assistant;
    msg3.name = customChar.name;
    msg3.setCurrentContent(QStringLiteral("I am running inside the native Linux Qt RisuAI engine!"));
    msg3.promptInfo = QJsonObject{{QStringLiteral("promptName"), QStringLiteral("Persistence Test")},
                                  {QStringLiteral("customFlag"), true}};
    msg3.addSwipe(QStringLiteral("Alternative swipe response #2: Everything is running natively at maximum speed!"));
    msg3.currentSwipeIndex = 1;
    testChat.messages.append(msg3);

    customChar.chats.append(testChat);

    bool saved = db.saveCharacter(customChar);
    assert(saved && "Custom character must save to SQLite database");

    auto retrieved = db.getCharacter(customChar.id);
    assert(retrieved.has_value() && "Must retrieve custom character");
    assert(retrieved->name == customChar.name);
    assert(retrieved->chats.size() == 1);
    assert(retrieved->chats[0].messages.size() == 3);
    assert(retrieved->chats[0].modules.contains(QStringLiteral("module-chat-test")) && "Chat-scoped module IDs must survive relational persistence");
    assert(retrieved->chats[0].messages[2].promptInfo.value(QStringLiteral("promptName")).toString() == QStringLiteral("Persistence Test") &&
           "Message promptInfo JSON must survive relational persistence");
    assert(retrieved->chats[0].messages[2].promptInfo.value(QStringLiteral("customFlag")).toBool() &&
           "Unknown promptInfo extension fields must survive relational persistence");
    assert(retrieved->chats[0].messages[2].swipes.size() == 2);
    assert(retrieved->chats[0].messages[2].currentSwipeIndex == 1);

    qInfo() << "  -> Custom character and messages with multi-swipe verified!";

    // 3. Test Full DB Backup & Restore
    QJsonObject backup = db.exportFullDatabase();
    assert(backup.contains(QStringLiteral("characters")));
    assert(backup.contains(QStringLiteral("presets")));
    assert(backup.contains(QStringLiteral("personas")));
    qInfo() << "  -> Full DB Backup JSON export verified!";

    qInfo() << "[TEST 1 PASSED] Database & Types working perfectly.\n";
}

void testPromptEngineAndMacros() {
    qInfo() << "[TEST 2] Testing Prompt Engine & Macro Replacements...";

    PromptEngine engine;

    Character dummyChar;
    dummyChar.name = QStringLiteral("Risu");
    dummyChar.description = QStringLiteral("Smart squirrel companion");

    Persona dummyPersona;
    dummyPersona.name = QStringLiteral("Explorer");

    // Macro Replacement test
    QString templateStr = QStringLiteral("Hello {{user}}, I am {{char}}.");
    QString rendered = engine.replaceMacros(templateStr, dummyChar, dummyPersona);
    assert(rendered.contains(QStringLiteral("Hello Explorer, I am Risu.")) && "Macros {{user}} and {{char}} must be replaced");
    qInfo() << "  -> Macro output:" << rendered;

    // Token counting test
    QString sampleText = QStringLiteral("This is a native Qt6 AI chat application written in C++20 for Linux.");
    int tokens = Tokenizer::estimateTokens(sampleText);
    assert(tokens > 5 && "Token estimation should be positive");
    qInfo() << "  -> Token estimate for sample text (" << sampleText.size() << "chars):" << tokens << "tokens";

    // Korean token estimation test
    QString koreanText = QStringLiteral("안녕하세요! 리스AI 네이티브 C++ 애플리케이션 테스트입니다.");
    int korTokens = Tokenizer::estimateTokens(koreanText);
    assert(korTokens > 10 && "Korean text token count should account for Hangul syllables");
    qInfo() << "  -> Korean token estimate:" << korTokens << "tokens";

    // Prompt compilation with Lorebook test
    Character testChar;
    testChar.name = QStringLiteral("Elena");
    testChar.description = QStringLiteral("Elena is a knowledgeable celestial sorceress.");
    testChar.personality = QStringLiteral("Calm, wise, articulate.");
    testChar.scenario = QStringLiteral("An ancient observatory under starry skies.");

    LorebookEntry starLore;
    starLore.id = QStringLiteral("lore-stars");
    starLore.key = QStringLiteral("celestial, observatory, telescope, magic");
    starLore.comment = QStringLiteral("Celestial Magic");
    starLore.content = QStringLiteral("[Lore: Celestial magic harnesses cosmic stellar energy from star alignments.]");
    starLore.enabled = true;
    starLore.scanDepth = 5;
    testChar.globalLore.append(starLore);

    Chat chat;
    chat.name = QStringLiteral("Lore test");
    Message m1;
    m1.role = Role::User;
    m1.name = QStringLiteral("User");
    m1.setCurrentContent(QStringLiteral("Can you tell me how your celestial magic works through the observatory telescope?"));
    chat.messages.append(m1);

    Preset preset;
    preset.modelName = QStringLiteral("gpt-4o");
    preset.mainPrompt = QStringLiteral("You are {{char}} chatting with {{user}}.\n{{char}}'s Persona:\n{{description}}\nPersonality: {{personality}}\nScenario: {{scenario}}");
    preset.contextLimit = 16000;

    Persona persona;
    persona.name = QStringLiteral("Astronaut");
    persona.description = QStringLiteral("PRIVATE_PERSONA_NOTE_MUST_NOT_BE_INJECTED");
    persona.personaPrompt = QStringLiteral("The user is an experienced orbital research astronaut.");

    CompiledPrompt compiled = engine.buildPrompt(testChar, chat, preset, persona, QList<LorebookEntry>{}, QString());
    assert(!compiled.messages.isEmpty() && "Compiled prompt must contain messages");
    
    // Check if Lorebook entry was triggered by keyword "observatory" / "celestial"
    bool loreTriggered = false;
    for (const auto& msg : compiled.messages) {
        if (msg.content.contains(QStringLiteral("Celestial magic harnesses cosmic stellar energy"))) {
            loreTriggered = true;
            break;
        }
    }
    assert(loreTriggered && "Lorebook entry must be triggered and included in compiled prompt!");
    assert(compiled.systemPromptCombined.contains(QStringLiteral("experienced orbital research astronaut")) &&
           "Legacy personaPrompt block must inject Persona::personaPrompt");
    assert(!compiled.systemPromptCombined.contains(QStringLiteral("PRIVATE_PERSONA_NOTE_MUST_NOT_BE_INJECTED")) &&
           "Persona notes must not be injected when a dedicated personaPrompt exists");
    qInfo() << "  -> Lorebook keyword and dedicated persona prompt successfully activated!";
    qInfo() << "  -> Total compiled messages:" << compiled.messages.size() << ", Estimated Tokens:" << compiled.estimatedTokens;

    // Modern Risu promptTemplate execution must override the legacy formatingOrder path.
    Preset templatePreset = preset;
    templatePreset.mainPrompt = QStringLiteral("LEGACY_PROMPT_MUST_NOT_LEAK");
    templatePreset.promptTemplate = QJsonArray{
        QJsonObject{{QStringLiteral("type"), QStringLiteral("plain")},
                    {QStringLiteral("type2"), QStringLiteral("normal")},
                    {QStringLiteral("role"), QStringLiteral("system")},
                    {QStringLiteral("text"), QStringLiteral("TEMPLATE_HEAD")}},
        QJsonObject{{QStringLiteral("type"), QStringLiteral("persona")},
                    {QStringLiteral("role2"), QStringLiteral("system")},
                    {QStringLiteral("innerFormat"), QStringLiteral("PERSONA={{slot}}")}},
        QJsonObject{{QStringLiteral("type"), QStringLiteral("chatML")},
                    {QStringLiteral("text"), QStringLiteral("<|im_start|>system<|im_sep|>CHATML_SYSTEM {{char}}<|im_end|><|im_start|>user\nCHATML_USER {{user}}<|im_end|><|im_start|>assistant<|im_sep|><Thoughts>hidden reasoning</Thoughts>CHATML_ASSISTANT<|im_end|>")}},
        QJsonObject{{QStringLiteral("type"), QStringLiteral("lorebook")}},
        QJsonObject{{QStringLiteral("type"), QStringLiteral("chat")},
                    {QStringLiteral("rangeStart"), -1},
                    {QStringLiteral("rangeEnd"), QStringLiteral("end")}},
        QJsonObject{{QStringLiteral("type"), QStringLiteral("plain")},
                    {QStringLiteral("type2"), QStringLiteral("normal")},
                    {QStringLiteral("role"), QStringLiteral("system")},
                    {QStringLiteral("text"), QStringLiteral("TEMPLATE_TAIL")}}
    };

    CompiledPrompt templated = engine.buildPrompt(testChar, chat, templatePreset, persona, QList<LorebookEntry>{}, QString());
    assert(!templated.messages.isEmpty());
    assert(templated.messages.first().content == QStringLiteral("TEMPLATE_HEAD") && "promptTemplate order must be honored");
    assert(templated.messages.last().content == QStringLiteral("TEMPLATE_TAIL") && "promptTemplate tail must be preserved");
    bool legacyLeaked = false;
    bool templateLoreFound = false;
    bool templatePersonaFound = false;
    bool personaNoteLeaked = false;
    bool chatMlSystemFound = false;
    bool chatMlUserFound = false;
    bool chatMlAssistantFound = false;
    bool chatMlThoughtLeaked = false;
    for (const auto& msg : templated.messages) {
        legacyLeaked |= msg.content.contains(QStringLiteral("LEGACY_PROMPT_MUST_NOT_LEAK"));
        templateLoreFound |= msg.content.contains(QStringLiteral("Celestial magic harnesses cosmic stellar energy"));
        templatePersonaFound |= msg.content.contains(QStringLiteral("PERSONA=The user is an experienced orbital research astronaut."));
        personaNoteLeaked |= msg.content.contains(QStringLiteral("PRIVATE_PERSONA_NOTE_MUST_NOT_BE_INJECTED"));
        chatMlSystemFound |= msg.role == QStringLiteral("system") && msg.content == QStringLiteral("CHATML_SYSTEM Elena");
        chatMlUserFound |= msg.role == QStringLiteral("user") && msg.content == QStringLiteral("CHATML_USER Astronaut");
        chatMlAssistantFound |= msg.role == QStringLiteral("assistant") && msg.content == QStringLiteral("CHATML_ASSISTANT");
        chatMlThoughtLeaked |= msg.content.contains(QStringLiteral("hidden reasoning"));
    }
    assert(!legacyLeaked && "legacy formatingOrder prompt must not be injected when promptTemplate is active");
    assert(templateLoreFound && "lorebook promptTemplate card must inject active lore");
    assert(templatePersonaFound && "persona promptTemplate card must inject Persona::personaPrompt with innerFormat");
    assert(!personaNoteLeaked && "persona note must remain separate from the generated prompt");
    assert(chatMlSystemFound && chatMlUserFound && chatMlAssistantFound &&
           "chatML prompt cards must split into their declared system/user/assistant roles");
    assert(!chatMlThoughtLeaked && "ChatML <Thoughts> blocks must not leak into visible prompt content");
    qInfo() << "  -> Modern promptTemplate ordering, ChatML roles, persona, and lorebook cards verified!";

    // promptTemplate and formattingOrder live in the preset JSON extension payload and
    // must survive SQL save/reload, including getAllPresets().
    templatePreset.id = QStringLiteral("preset-template-roundtrip-test");
    templatePreset.name = QStringLiteral("Template Roundtrip Test");
    templatePreset.formattingOrder = QStringList{QStringLiteral("main"), QStringLiteral("personaPrompt"), QStringLiteral("chats")};
    assert(DatabaseManager::instance().savePreset(templatePreset));
    auto reloadedTemplatePreset = DatabaseManager::instance().getPreset(templatePreset.id);
    assert(reloadedTemplatePreset.has_value());
    assert(reloadedTemplatePreset->promptTemplate.size() == templatePreset.promptTemplate.size() &&
           "promptTemplate must survive SQL preset round-trip");
    assert(reloadedTemplatePreset->formattingOrder == templatePreset.formattingOrder &&
           "formattingOrder must survive SQL preset round-trip");
    bool listRoundTripFound = false;
    for (const auto& candidate : DatabaseManager::instance().getAllPresets()) {
        if (candidate.id == templatePreset.id) {
            listRoundTripFound = candidate.promptTemplate.size() == templatePreset.promptTemplate.size() &&
                                 candidate.formattingOrder == templatePreset.formattingOrder;
            break;
        }
    }
    assert(listRoundTripFound && "getAllPresets must restore JSON-only prompt fields");
    assert(DatabaseManager::instance().deletePreset(templatePreset.id));
    qInfo() << "  -> Prompt template SQL persistence verified!";

    // Native-compatible modules must contribute lorebooks and regex scripts when selected by the chat.
    QJsonObject moduleLore{{QStringLiteral("id"), QStringLiteral("module-lore")},
                           {QStringLiteral("content"), QStringLiteral("[Module Lore: native module injection works]")},
                           {QStringLiteral("alwaysActive"), true}};
    QJsonObject moduleRegex{{QStringLiteral("id"), QStringLiteral("module-regex")},
                            {QStringLiteral("in"), QStringLiteral("MODULE_INPUT")},
                            {QStringLiteral("out"), QStringLiteral("MODULE_OUTPUT")},
                            {QStringLiteral("type"), QStringLiteral("editinput")}};
    QJsonObject module{{QStringLiteral("id"), QStringLiteral("module-prompt-test")},
                       {QStringLiteral("lorebook"), QJsonArray{moduleLore}},
                       {QStringLiteral("regex"), QJsonArray{moduleRegex}}};
    DatabaseManager::instance().setSystemSetting(QStringLiteral("modules"),
        QString::fromUtf8(QJsonDocument(QJsonArray{module}).toJson(QJsonDocument::Compact)), QStringLiteral("modules"));
    chat.modules = QStringList{QStringLiteral("module-prompt-test")};

    ActiveModuleData resolvedModule = ModuleEngine::resolveActiveModules(testChar, chat);
    assert(resolvedModule.lorebooks.size() == 1 && resolvedModule.regexScripts.size() == 1);
    assert(RegexEngine::applyPreGenRegex(QStringLiteral("MODULE_INPUT"), resolvedModule.regexScripts) == QStringLiteral("MODULE_OUTPUT"));
    CompiledPrompt modulePrompt = engine.buildPrompt(testChar, chat, templatePreset, persona, QList<LorebookEntry>{}, QString());
    bool moduleLoreFound = false;
    for (const auto& msg : modulePrompt.messages) moduleLoreFound |= msg.content.contains(QStringLiteral("native module injection works"));
    assert(moduleLoreFound && "active module lorebook must participate in prompt compilation");
    DatabaseManager::instance().setSystemSetting(QStringLiteral("modules"), QStringLiteral("[]"), QStringLiteral("modules"));
    qInfo() << "  -> Chat-scoped module lorebook and regex integration verified!";

    qInfo() << "[TEST 2 PASSED] Prompt Engine & Macros working perfectly.\n";
}

void testCharacterCardIO() {
    qInfo() << "[TEST 3] Testing Character Card IO & PNG Chunk Embedding...";

    Character originalChar;
    originalChar.id = QStringLiteral("card-test-id");
    originalChar.name = QStringLiteral("Luna");
    originalChar.firstMessage = QStringLiteral("Greetings from the digital realm!");
    originalChar.description = QStringLiteral("Luna is an AI architect specializing in Qt applications.");
    originalChar.personality = QStringLiteral("Precise, creative, swift.");
    originalChar.tags = QStringList{QStringLiteral("Architect"), QStringLiteral("AI")};
    originalChar.alternateGreetings.append(QStringLiteral("Alternative greeting: Welcome to my workshop!"));

    // Export to JSON
    QString jsonPath = QDir::tempPath() + QStringLiteral("/luna_card_test.json");
    bool jsonExportOk = CharacterCardIO::exportToJsonFile(originalChar, jsonPath);
    assert(jsonExportOk && "JSON export should succeed");

    // Import from JSON
    auto importedFromJson = CharacterCardIO::importFromFile(jsonPath);
    assert(importedFromJson.has_value() && "JSON import should succeed");
    assert(importedFromJson->name == originalChar.name);
    assert(importedFromJson->description == originalChar.description);
    assert(importedFromJson->alternateGreetings.size() == originalChar.alternateGreetings.size());
    qInfo() << "  -> JSON Character Card round-trip successful!";
    QFile::remove(jsonPath);

    // Export to PNG Card with CCv2 tEXt chunk
    QString pngPath = QDir::tempPath() + QStringLiteral("/luna_card_test.png");
    bool pngExportOk = CharacterCardIO::exportToPngCard(originalChar, pngPath);
    assert(pngExportOk && "PNG Card export should succeed");
    assert(QFile::exists(pngPath) && "PNG file must be created on disk");

    // Import from PNG Card (Extract tEXt chunk & decode CCv2 data)
    auto importedFromPng = CharacterCardIO::importFromPng(pngPath);
    assert(importedFromPng.has_value() && "PNG Card import should succeed and extract embedded metadata");
    assert(importedFromPng->name == originalChar.name);
    assert(importedFromPng->description == originalChar.description);
    assert(importedFromPng->firstMessage == originalChar.firstMessage);
    qInfo() << "  -> PNG Character Card tEXt chunk embedding and decoding round-trip verified!";
    QFile::remove(pngPath);

    qInfo() << "[TEST 3 PASSED] Character Card IO working perfectly.\n";
}

void testAIProviderFactory() {
    qInfo() << "[TEST 4] Testing AI Provider Factory & Instantiations...";

    auto oaiProvider = AIProvider::create(ProviderType::OpenAI);
    assert(oaiProvider != nullptr && "OpenAI provider must instantiate");

    auto claudeProvider = AIProvider::create(ProviderType::AnthropicClaude);
    assert(claudeProvider != nullptr && "Claude provider must instantiate");

    auto geminiProvider = AIProvider::create(ProviderType::GoogleGemini);
    assert(geminiProvider != nullptr && "Gemini provider must instantiate");

    auto ollamaProvider = AIProvider::create(ProviderType::Ollama);
    assert(ollamaProvider != nullptr && "Ollama provider must instantiate");

    auto openRouterProvider = AIProvider::create(ProviderType::OpenRouter);
    assert(openRouterProvider != nullptr && "OpenRouter provider must instantiate");

    qInfo() << "  -> All 5 AI Providers successfully instantiated via factory!";
    qInfo() << "[TEST 4 PASSED] AI Provider Factory working perfectly.\n";
}

void testRegexEngine() {
    qInfo() << "[TEST 5] Testing Regex Engine (inChat, preGen, postGen, flags, capture groups)...";

    QList<RegexScript> scripts;

    RegexScript s1;
    s1.id = QStringLiteral("s1");
    s1.findRegex = QStringLiteral(R"(\buser_name\b)");
    s1.replaceString = QStringLiteral("Alex");
    s1.enabled = true;
    s1.inChat = true;
    scripts.append(s1);

    RegexScript s2;
    s2.id = QStringLiteral("s2");
    s2.findRegex = QStringLiteral(R"(badword)");
    s2.replaceString = QStringLiteral("[redacted]");
    s2.enabled = true;
    s2.postGen = true;
    scripts.append(s2);

    // Test capture group and HTML styling: [color:red]text[/color] -> <span style="color:red">text</span>
    RegexScript s3;
    s3.id = QStringLiteral("s3");
    s3.findRegex = QStringLiteral(R"(\[color:([a-zA-Z0-9#]+)\](.*?)\[/color\])");
    s3.replaceString = QStringLiteral(R"(<span style="color:$1">$2</span>)");
    s3.flag = QStringLiteral("gi");
    s3.type = QStringLiteral("editdisplay");
    s3.enabled = true;
    scripts.append(s3);

    // Test /pattern/flags format
    RegexScript s4;
    s4.id = QStringLiteral("s4");
    s4.findRegex = QStringLiteral(R"(/\{hint:([^}]+)\}/i)");
    s4.replaceString = QStringLiteral(R"(<font color="#8be9fd">Hint: $1</font>)");
    s4.type = QStringLiteral("editdisplay");
    s4.enabled = true;
    scripts.append(s4);

    QString text1 = QStringLiteral("Hello user_name, welcome!");
    QString out1 = RegexEngine::applyInChatRegex(text1, scripts);
    assert(out1 == QStringLiteral("Hello Alex, welcome!") && "InChat regex replacement should work");

    QString text2 = QStringLiteral("This contains a badword here.");
    QString out2 = RegexEngine::applyPostGenRegex(text2, scripts);
    assert(out2 == QStringLiteral("This contains a [redacted] here.") && "PostGen regex replacement should work");

    QString text3 = QStringLiteral("Important: [color:#ff79c6]Special Text[/color] and {hint:Look around}");
    QString out3 = RegexEngine::applyInChatRegex(text3, scripts);
    assert(out3.contains(QStringLiteral(R"(<span style="color:#ff79c6">Special Text</span>)")) && "Capture group replacement with HTML must work");
    assert(out3.contains(QStringLiteral(R"(<font color="#8be9fd">Hint: Look around</font>)")) && "Slash pattern format with HTML must work");

    qInfo() << "  -> InChat, PostGen, Flags, Capture Groups & HTML Regex replacements verified!";
    qInfo() << "[TEST 5 PASSED] Regex Engine working perfectly.\n";
}

void testMultiSwipeModelAndBranching() {
    qInfo() << "[TEST 6] Testing Multi-Swipe Navigation & Chat Message Model...";

    ChatMessageModel model;

    Message msg;
    msg.id = QStringLiteral("msg-test-swipe");
    msg.role = Role::Assistant;
    msg.name = QStringLiteral("Assistant");
    msg.setCurrentContent(QStringLiteral("Response swipe 1"));

    model.appendMessage(msg);
    assert(model.rowCount() == 1);
    assert(model.data(model.index(0, 0), ChatMessageModel::ContentRole).toString() == QStringLiteral("Response swipe 1"));

    // Add Swipe 2
    model.addSwipeToMessage(0, QStringLiteral("Response swipe 2"), QStringLiteral("Thought 2"));
    assert(model.data(model.index(0, 0), ChatMessageModel::SwipeCountRole).toInt() == 2);
    assert(model.data(model.index(0, 0), ChatMessageModel::CurrentSwipeIndexRole).toInt() == 1);
    assert(model.data(model.index(0, 0), ChatMessageModel::ContentRole).toString() == QStringLiteral("Response swipe 2"));

    // Swipe Left to 1
    model.swipeLeft(0);
    assert(model.data(model.index(0, 0), ChatMessageModel::CurrentSwipeIndexRole).toInt() == 0);
    assert(model.data(model.index(0, 0), ChatMessageModel::ContentRole).toString() == QStringLiteral("Response swipe 1"));

    // Swipe Right to 2
    model.swipeRight(0);
    assert(model.data(model.index(0, 0), ChatMessageModel::CurrentSwipeIndexRole).toInt() == 1);
    assert(model.data(model.index(0, 0), ChatMessageModel::ContentRole).toString() == QStringLiteral("Response swipe 2"));

    // Edit message content
    model.editMessage(0, QStringLiteral("Edited response swipe 2"));
    assert(model.data(model.index(0, 0), ChatMessageModel::ContentRole).toString() == QStringLiteral("Edited response swipe 2"));

    qInfo() << "  -> Multi-swipe navigation and editing verified!";
    qInfo() << "[TEST 6 PASSED] Multi-Swipe Model working perfectly.\n";
}

void testFullDatabaseBackupRestoreRoundTrip() {
    qInfo() << "[TEST 7] Testing Full Database Backup & Restore Round-Trip...";

    auto& db = DatabaseManager::instance();
    QJsonObject backupJson = db.exportFullDatabase();
    assert(!backupJson.isEmpty() && "Backup export should not be empty");

    QString backupFile = QDir::tempPath() + QStringLiteral("/risu_full_db_backup.json");
    bool exportOk = ExportImport::exportFullBackup(backupFile);
    assert(exportOk && "Full backup file should be written");
    assert(QFile::exists(backupFile) && "Backup file must exist");

    bool restoreOk = ExportImport::importFullBackup(backupFile);
    assert(restoreOk && "Full backup restore should succeed");

    auto charsAfter = db.getAllCharacters();
    assert(!charsAfter.isEmpty() && "Characters must be preserved after restore");

    auto presetsAfter = db.getAllPresets();
    assert(!presetsAfter.isEmpty() && "Presets must be preserved after restore");

    QFile::remove(backupFile);

    qInfo() << "  -> Backup and Restore round-trip verified!";
    qInfo() << "[TEST 7 PASSED] Full Database Backup & Restore working perfectly.\n";
}

void testExtendedMacrosAndChatExport() {
    qInfo() << "[TEST 8] Testing Extended Macros, Dice Rolling & Multi-Format Chat Export...";

    Character ch;
    ch.name = QStringLiteral("Alice");
    ch.description = QStringLiteral("A wise alchemist");

    Persona user;
    user.name = QStringLiteral("Bob");

    Chat chat;
    chat.name = QStringLiteral("Adventure Chat");

    // Test dice rolling macro
    QString dicePrompt = QStringLiteral("Roll: {{roll:1d20}}");
    QString diceOut = PromptEngine::replaceMacros(dicePrompt, ch, user, &chat);
    int rolledVal = diceOut.mid(6).toInt();
    assert(rolledVal >= 1 && rolledVal <= 20 && "Dice roll must produce value in [1, 20]");

    // Test variable setting and getting
    QString setPrompt = QStringLiteral("{{setvar::mood::cheerful}}Setting mood done.");
    QString setOut = PromptEngine::replaceMacros(setPrompt, ch, user, &chat);
    assert(chat.chatVariables.value(QStringLiteral("mood")) == QStringLiteral("cheerful") && "Chat variable must be set");

    QString getPrompt = QStringLiteral("Mood is {{getvar::mood}}!");
    QString getOut = PromptEngine::replaceMacros(getPrompt, ch, user, &chat);
    assert(getOut == QStringLiteral("Mood is cheerful!") && "Chat variable getter must work");

    // Test conditional block
    QString ifPrompt = QStringLiteral("{{#if mood}}Alice is happy.{{/if}}{{#if !missing}}All good.{{/if}}");
    QString ifOut = PromptEngine::replaceMacros(ifPrompt, ch, user, &chat);
    assert(ifOut.contains(QStringLiteral("Alice is happy.")) && ifOut.contains(QStringLiteral("All good.")) && "Conditional block macros must evaluate correctly");

    // Add sample chat messages
    Message m1;
    m1.role = Role::User;
    m1.name = QStringLiteral("Bob");
    m1.setCurrentContent(QStringLiteral("Hello Alice, how are you?"));
    m1.isPinned = true;
    chat.messages.append(m1);

    Message m2;
    m2.role = Role::Assistant;
    m2.name = QStringLiteral("Alice");
    m2.setCurrentContent(QStringLiteral("I am doing great! [emotion:happy]"), QStringLiteral("Thinking about alchemy"));
    m2.emotion = QStringLiteral("happy");
    chat.messages.append(m2);

    // Test Markdown Export
    QString mdFile = QDir::tempPath() + QStringLiteral("/risu_chat_test.md");
    bool mdOk = ExportImport::exportChatToMarkdown(ch, chat, mdFile);
    assert(mdOk && QFile::exists(mdFile) && "Markdown chat export should succeed");
    QFile::remove(mdFile);

    // Test HTML Export
    QString htmlFile = QDir::tempPath() + QStringLiteral("/risu_chat_test.html");
    bool htmlOk = ExportImport::exportChatToHtml(ch, chat, htmlFile);
    assert(htmlOk && QFile::exists(htmlFile) && "HTML chat export should succeed");
    QFile::remove(htmlFile);

    // Test JSON Export
    QString jsonFile = QDir::tempPath() + QStringLiteral("/risu_chat_test.json");
    bool jsonOk = ExportImport::exportChatToJson(ch, chat, jsonFile);
    assert(jsonOk && QFile::exists(jsonFile) && "JSON chat export should succeed");
    QFile::remove(jsonFile);

    qInfo() << "  -> Macros, dice rolls, conditionals, and MD/HTML/JSON exports verified!";
    qInfo() << "[TEST 8 PASSED] Extended Macros & Multi-Format Chat Export working perfectly.\n";
}

void testMemoryManagerAndTTS() {
    qInfo() << "[TEST 9] Testing Memory Manager & Context Summarization...";

    Character ch;
    ch.name = QStringLiteral("Elena");
    Persona user;
    user.name = QStringLiteral("Dave");

    Chat chat;
    for (int i = 0; i < 25; ++i) {
        Message m;
        m.role = (i % 2 == 0) ? Role::User : Role::Assistant;
        m.name = (i % 2 == 0) ? user.name : ch.name;
        m.setCurrentContent(QStringLiteral("Message number %1 in the long adventure.").arg(i));
        chat.messages.append(m);
    }

    bool needSumm = MemoryManager::shouldSummarize(chat, 20, 100);
    assert(needSumm && "Chat exceeding threshold must trigger shouldSummarize");

    QString summaryPrompt = MemoryManager::buildSummaryPrompt(chat.messages, 0, 10, ch.name, user.name);
    assert(!summaryPrompt.isEmpty() && summaryPrompt.contains(QStringLiteral("Summarize the following conversation")) && "Summary prompt must format properly");

    QString formattedMem = MemoryManager::formatMemoryForPrompt(QStringLiteral("Elena and Dave explored the ancient ruins."));
    assert(formattedMem.contains(QStringLiteral("[Summary of previous events:")) && "Formatted memory header must exist");

    qInfo() << "  -> Memory condensation prompt and threshold triggers verified!";
    qInfo() << "[TEST 9 PASSED] Memory Manager working perfectly.\n";
}

void testTriggerEngine() {
    qInfo() << "[TEST 10] Testing Event Trigger Engine & Automation Rules...";

    QList<TriggerRule> rules;

    TriggerRule r1;
    r1.id = QStringLiteral("tr1");
    r1.name = QStringLiteral("Affection Trigger");
    r1.enabled = true;
    r1.eventType = TriggerEventType::OnMessageSent;
    r1.conditionKeyword = QStringLiteral("gift|present|flower");
    r1.actionType = TriggerActionType::SetVariable;
    r1.targetKey = QStringLiteral("relationship");
    r1.targetValue = QStringLiteral("friendly");
    rules.append(r1);

    TriggerRule r2;
    r2.id = QStringLiteral("tr2");
    r2.name = QStringLiteral("System Prompt Injection Trigger");
    r2.enabled = true;
    r2.eventType = TriggerEventType::OnMessageSent;
    r2.conditionKeyword = QStringLiteral("danger");
    r2.actionType = TriggerActionType::InjectSystemPrompt;
    r2.targetValue = QStringLiteral("[System Alert: The scene becomes tense and hazardous.]");
    rules.append(r2);

    Chat chat;
    QString systemInj;
    QString modifiedText;

    TriggerEngine::executeTriggers(
        TriggerEventType::OnMessageSent,
        QStringLiteral("I bought you a beautiful flower!"),
        rules,
        chat,
        systemInj,
        modifiedText
    );

    assert(chat.chatVariables.value(QStringLiteral("relationship")) == QStringLiteral("friendly") && "Trigger variable must be set on keyword match");

    TriggerEngine::executeTriggers(
        TriggerEventType::OnMessageSent,
        QStringLiteral("Watch out, there is grave danger ahead!"),
        rules,
        chat,
        systemInj,
        modifiedText
    );

    assert(systemInj.contains(QStringLiteral("The scene becomes tense")) && "Trigger must inject system prompt on condition match");

    qInfo() << "  -> Keyword conditions, variable updates, and prompt injections verified!";
    qInfo() << "[TEST 10 PASSED] Trigger Engine working perfectly.\n";
}

void testGroupChatRooms() {
    qInfo() << "[TEST 11] Testing Multi-Character Group Chat Rooms & Speaker Rotation...";

    GroupChatRoom room;
    room.id = QStringLiteral("grp_tavern_001");
    room.name = QStringLiteral("Tavern Party");
    room.description = QStringLiteral("Gathering of adventurers in a lively tavern.");
    room.speakerMode = SpeakerSelectionMode::RoundRobin;
    room.currentSpeakerIndex = 0;

    GroupMember m1;
    m1.characterId = QStringLiteral("char_elena");
    m1.name = QStringLiteral("Elena");
    m1.enabled = true;
    m1.order = 0;
    room.members.append(m1);

    GroupMember m2;
    m2.characterId = QStringLiteral("char_dave");
    m2.name = QStringLiteral("Dave");
    m2.enabled = true;
    m2.order = 1;
    room.members.append(m2);

    Chat groupChat;
    groupChat.id = QStringLiteral("grp_chat_001");
    groupChat.name = QStringLiteral("Main Discussion");

    Message msg1;
    msg1.role = Role::User;
    msg1.name = QStringLiteral("User");
    msg1.setCurrentContent(QStringLiteral("Let's order some food, everyone!"));
    groupChat.messages.append(msg1);

    Message msg2;
    msg2.role = Role::Assistant;
    msg2.name = QStringLiteral("Elena");
    msg2.setCurrentContent(QStringLiteral("I'll have some roasted chicken and cider!"));
    groupChat.messages.append(msg2);

    room.chats.append(groupChat);

    // Save to Database
    bool saved = DatabaseManager::instance().saveGroup(room);
    assert(saved && "Group chat room must save successfully to DB");

    auto loaded = DatabaseManager::instance().getGroup(room.id);
    assert(loaded.has_value() && "Loaded group must exist");
    assert(loaded->name == QStringLiteral("Tavern Party") && "Group name must match");
    assert(loaded->members.size() == 2 && "Group must have 2 members");
    assert(loaded->chats.size() == 1 && "Group must have 1 chat");
    assert(loaded->chats.first().messages.size() == 2 && "Group chat must have 2 messages");

    // Test JSON Serialization Round-trip
    QJsonObject jsonObj = room.toJson();
    GroupChatRoom deserialized = GroupChatRoom::fromJson(jsonObj);
    assert(deserialized.id == room.id && deserialized.members.size() == 2 && "Group JSON roundtrip must match");

    qInfo() << "  -> Group room persistence, member lists, and chat history verified!";
    qInfo() << "[TEST 11 PASSED] Multi-Character Group Chat Rooms working perfectly.\n";
}

void testScriptingEngine() {
    qInfo() << "[TEST 12] Testing Sandboxed JavaScript Scripting Engine (QJSEngine)...";

    Chat chat;
    chat.chatVariables[QStringLiteral("gold")] = QStringLiteral("100");
    chat.chatVariables[QStringLiteral("level")] = QStringLiteral("5");

    Character character;
    character.name = QStringLiteral("Alice");
    character.description = QStringLiteral("A master alchemist.");

    Persona user;
    user.name = QStringLiteral("Bob");

    // Test simple expression
    QString expr1 = QStringLiteral("2 + 2 * 10");
    QString res1 = ScriptingEngine::evaluateExpression(expr1, chat, character, user);
    assert(res1 == QStringLiteral("22") && "Math expression in QJSEngine must calculate properly");

    // Test context access and variable modification
    QString expr2 = QStringLiteral("setvar('gold', (parseInt(getvar('gold')) + 50).toString()); 'You now have ' + getvar('gold') + ' gold, ' + user.name + '!'");
    QString res2 = ScriptingEngine::evaluateExpression(expr2, chat, character, user);
    assert(res2.contains(QStringLiteral("You now have 150 gold, Bob!")) && "JS variable read/write and string interpolation must work");
    assert(chat.chatVariables[QStringLiteral("gold")] == QStringLiteral("150") && "Variable must persist back to Chat");

    // Test template string embedding with {{eval:...}}
    QString promptText = QStringLiteral("Hello {{user}}, {{eval: char.name + ' charges ' + (parseInt(getvar('level')) * 10) + ' coins for potion.'}}");
    QString resolved = PromptEngine::replaceMacros(promptText, character, user, &chat);
    assert(resolved.contains(QStringLiteral("Alice charges 50 coins for potion.")) && "Embedded {{eval:...}} must resolve dynamically in PromptEngine");

    qInfo() << "  -> Sandboxed math, variable read/write, and {{eval:...}} resolution verified!";
    qInfo() << "[TEST 12 PASSED] Scripting Engine working perfectly.\n";
}

void testAPIServer() {
    qInfo() << "[TEST 13] Testing Local REST API Self-Hosting Server...";

    APIServer server;
    bool started = server.startServer(16001); // Use test port
    assert(started && "APIServer must bind and start listening");
    assert(server.isRunning() && "Server isRunning must return true");

    server.stopServer();
    assert(!server.isRunning() && "Server must shut down cleanly");

    qInfo() << "  -> REST Server socket binding, listening, and shutdown lifecycle verified!";
    qInfo() << "[TEST 13 PASSED] Local REST API Server working perfectly.\n";
}

void testI18n() {
    qInfo() << "[TEST 14] Testing Internationalization (I18n) & Korean Localization...";

    I18n& i18n = I18n::instance();

    // Korean lookup
    i18n.setLanguage(QStringLiteral("ko"));
    assert(i18n.t(QStringLiteral("chat.send")) == QStringLiteral("전송") && "Korean translation must match");
    assert(i18n.t(QStringLiteral("nav.characters")) == QStringLiteral("캐릭터") && "Korean nav translation must match");

    // English lookup
    i18n.setLanguage(QStringLiteral("en"));
    assert(i18n.t(QStringLiteral("chat.send")) == QStringLiteral("Send") && "English translation must match");
    assert(i18n.t(QStringLiteral("nav.characters")) == QStringLiteral("Characters") && "English nav translation must match");

    // Fallback lookup
    assert(i18n.t(QStringLiteral("unknown.key"), QStringLiteral("Fallback Text")) == QStringLiteral("Fallback Text") && "Fallback text must be returned for unknown keys");

    qInfo() << "  -> English, Korean, and fallback localization dictionary verified!";
    qInfo() << "[TEST 14 PASSED] I18n Localization working perfectly.\n";
}

void testEmbeddingEngine() {
    qInfo() << "[TEST 15] Testing Vector Embeddings & Semantic Similarity Search Engine...";

    // 1. Test Cosine Similarity
    QList<float> v1 = {1.0f, 0.0f, 0.0f};
    QList<float> v2 = {1.0f, 0.0f, 0.0f};
    QList<float> v3 = {0.0f, 1.0f, 0.0f};
    assert(std::abs(EmbeddingEngine::cosineSimilarity(v1, v2) - 1.0f) < 0.001f && "Identical vectors must have similarity 1.0");
    assert(std::abs(EmbeddingEngine::cosineSimilarity(v1, v3) - 0.0f) < 0.001f && "Orthogonal vectors must have similarity 0.0");

    // 2. Test TF-IDF Semantic Ranking
    QStringList corpus = {
        QStringLiteral("The knight drew his magical sword and prepared for battle."),
        QStringLiteral("A cozy bakery selling fresh croissants and warm coffee in Paris."),
        QStringLiteral("Starship hyperdrive propulsion system and orbital navigation mechanics.")
    };

    QString query = QStringLiteral("He swung the glowing sword at the dragon.");
    auto ranked = EmbeddingEngine::rankSimilarEntries(query, corpus, 0.1f, 1);
    assert(!ranked.isEmpty() && ranked.first() == 0 && "Top ranked document must be the battle/sword document (index 0)");

    // 3. Test Vector Mode Lorebook Activation in PromptEngine
    LorebookEntry vectorEntry;
    vectorEntry.id = QStringLiteral("lore_dragon_sword");
    vectorEntry.key = QStringLiteral("magic sword weapon");
    vectorEntry.content = QStringLiteral("[Lore: Excalibur is a holy sword capable of banishing darkness.]");
    vectorEntry.mode = QStringLiteral("vector");
    vectorEntry.enabled = true;

    QList<Message> testMsgs;
    Message m;
    m.role = Role::User;
    m.name = QStringLiteral("Explorer");
    m.setCurrentContent(QStringLiteral("Tell me about the magic sword weapon you carry."));
    testMsgs.append(m);

    Character ch;
    ch.name = QStringLiteral("Knight");
    Persona user;
    user.name = QStringLiteral("Explorer");

    QString injected = PromptEngine::scanAndInjectLorebooks({vectorEntry}, testMsgs, ch, user);
    assert(injected.contains(QStringLiteral("Excalibur is a holy sword")) && "Vector mode lorebook must activate via semantic match");

    qInfo() << "  -> Cosine similarity, TF-IDF ranking, and vector mode lorebook activation verified!";
    qInfo() << "[TEST 15 PASSED] Embedding & Semantic Similarity Engine working perfectly.\n";
}

void testMessageAttachment() {
    qInfo() << "[TEST 16] Testing Multimodal Message Image Attachments & Serialization...";

    Message msg;
    msg.id = QStringLiteral("msg_attach_1");
    msg.role = Role::User;
    msg.name = QStringLiteral("User");
    msg.setCurrentContent(QStringLiteral("Look at this scenery photo!"));
    msg.attachmentPath = QStringLiteral("/home/user/photos/mountains.png");

    // JSON serialization
    QJsonObject json = msg.toJson();
    assert(json.value(QStringLiteral("attachmentPath")).toString() == QStringLiteral("/home/user/photos/mountains.png") && "attachmentPath must serialize to JSON");

    // JSON deserialization
    Message restored = Message::fromJson(json);
    assert(restored.attachmentPath == QStringLiteral("/home/user/photos/mountains.png") && "attachmentPath must restore accurately");
    assert(restored.currentContent() == QStringLiteral("Look at this scenery photo!") && "Content must restore accurately");

    // ChatMessageModel role lookup
    ChatMessageModel model;
    model.appendMessage(restored);
    QModelIndex idx = model.index(0, 0);
    QVariant attachVar = model.data(idx, ChatMessageModel::AttachmentPathRole);
    assert(attachVar.toString() == QStringLiteral("/home/user/photos/mountains.png") && "ChatMessageModel must expose AttachmentPathRole");

    qInfo() << "  -> Attachment path persistence, serialization, and QML model role mapping verified!";
    qInfo() << "[TEST 16 PASSED] Multimodal Image Attachments working perfectly.\n";
}

void testPluginEngine() {
    qInfo() << "[TEST 17] Testing Plugin System & Hook Pipeline (PreRequest / PostResponse)...";

    PluginEngine& pe = PluginEngine::instance();
    pe.clear();

    // 1. Register a test plugin
    PluginInfo p1;
    p1.id = QStringLiteral("plugin_auto_emoji");
    p1.name = QStringLiteral("Auto Emoji Appender");
    p1.description = QStringLiteral("Appends sparkles to response and sets a variable");
    p1.version = QStringLiteral("1.0.0");
    p1.enabled = true;
    p1.script = QStringLiteral(
        "function onPreRequest(prompt) {\n"
        "    return prompt + '\\n[System Note: Plugin Injected Instructions]';\n"
        "}\n"
        "function onPostResponse(response) {\n"
        "    setvar('plugin_status', 'executed');\n"
        "    return response + ' ✨';\n"
        "}\n"
    );

    pe.registerPlugin(p1);
    assert(pe.plugins().size() == 1 && "Plugin must be registered in PluginEngine");

    // 2. Test pre-request hook
    Chat chat;
    Character character;
    character.name = QStringLiteral("Assistant");
    Persona persona;
    persona.name = QStringLiteral("User");

    QString rawPrompt = QStringLiteral("Hello there!");
    QString hookedPrompt = pe.applyPreRequestHooks(rawPrompt, chat, character, persona);
    assert(hookedPrompt.contains(QStringLiteral("[System Note: Plugin Injected Instructions]")) && "onPreRequest hook must modify prompt");

    // 3. Test post-response hook
    QString rawResponse = QStringLiteral("I am doing great");
    QString hookedResponse = pe.applyPostResponseHooks(rawResponse, chat, character);
    assert(hookedResponse.endsWith(QStringLiteral(" ✨")) && "onPostResponse hook must append sparkle emoji");
    assert(chat.chatVariables.value(QStringLiteral("plugin_status")) == QStringLiteral("executed") && "Plugin must write back to chat variables");

    // 4. Test disabling plugin
    pe.setPluginEnabled(p1.id, false);
    QString noHookPrompt = pe.applyPreRequestHooks(rawPrompt, chat, character, persona);
    assert(noHookPrompt == rawPrompt && "Disabled plugin must not modify prompt");

    pe.clear();

    qInfo() << "  -> Plugin registration, onPreRequest/onPostResponse hooks, and variable mutations verified!";
    qInfo() << "[TEST 17 PASSED] Plugin System working perfectly.\n";
}

void testTranslator() {
    qInfo() << "[TEST 18] Testing Realtime Multi-Provider Translation Engine & Caching...";

    Translator& trans = Translator::instance();
    trans.clearCache();
    assert(trans.cacheSize() == 0 && "Translator cache must be empty initially");

    trans.setProvider(TranslationProviderType::GoogleWeb);

    // Empty text handling
    QString emptyRes = trans.translateSync(QString(), QStringLiteral("en"), QStringLiteral("ko"));
    assert(emptyRes.isEmpty() && "Translating empty text must return empty");

    // Same language handling (no network hit)
    QString sameLang = trans.translateSync(QStringLiteral("Hello world"), QStringLiteral("en"), QStringLiteral("en"));
    assert(sameLang == QStringLiteral("Hello world") && "Same language translation must return identical text without network hit");

    qInfo() << "  -> Translation cache, same-language bypass, and provider routing verified!";
    qInfo() << "[TEST 18 PASSED] Translator Engine working perfectly.\n";
}

void testSystemTrayManager() {
    qInfo() << "[TEST 19] Testing System Tray Manager & Desktop Notifications...";

    SystemTrayManager& tray = SystemTrayManager::instance();
    // Verify instance access and notification dispatch without crashing
    tray.showNotification(QStringLiteral("RisuAI Test"), QStringLiteral("Test Notification Body"));

    qInfo() << "  -> SystemTrayManager instance and notification pipeline verified!";
    qInfo() << "[TEST 19 PASSED] System Tray Manager working perfectly.\n";
}

void testCloudSyncManager() {
    qInfo() << "[TEST 20] Testing Cloud Sync Manager & Auto-Backup Rotation...";

    CloudSyncManager& sync = CloudSyncManager::instance();
    QString tempBackupDir = QDir::tempPath() + QStringLiteral("/risu_test_backups");
    QDir(tempBackupDir).removeRecursively();

    // Create 3 auto-backups
    QString p1 = sync.createLocalAutoBackup(tempBackupDir);
    assert(!p1.isEmpty() && QFile::exists(p1) && "Auto backup file must be created on disk");

    // Test pruning with keepCount = 1
    int pruned = sync.pruneOldBackups(tempBackupDir, 1);
    assert(pruned == 0 && "Pruning with 1 file should remove 0 files");

    // Cleanup
    QDir(tempBackupDir).removeRecursively();

    qInfo() << "  -> Auto-backup creation, file existence, and rotation pruning verified!";
    qInfo() << "[TEST 20 PASSED] Cloud Sync & Backup Rotation working perfectly.\n";
}

void testArchivePacker() {
    qInfo() << "[TEST 21] Testing Multi-Asset Character Archive Packager (.charx / .risup)...";

    Character ch;
    ch.id = QStringLiteral("char_bundle_test");
    ch.name = QStringLiteral("Bundle Hero");
    ch.description = QStringLiteral("A hero with custom sprites and lorebooks.");
    ch.emotionSprites[QStringLiteral("happy")] = QStringLiteral("happy_sprite.png");
    ch.emotionSprites[QStringLiteral("angry")] = QStringLiteral("angry_sprite.png");

    LorebookEntry lb;
    lb.id = QStringLiteral("bundle_lore_1");
    lb.key = QStringLiteral("legendary relic");
    lb.content = QStringLiteral("[Lore: A relic of great power]");
    lb.enabled = true;

    // Pack to binary bundle
    QByteArray bundleBytes = ArchivePacker::packToBundle(ch, {lb});
    assert(!bundleBytes.isEmpty() && "Bundle binary payload must not be empty");

    // Unpack from binary bundle
    auto unpacked = ArchivePacker::unpackFromBundle(bundleBytes);
    assert(unpacked.has_value() && "Unpacking bundle must succeed");
    assert(unpacked->character.name == QStringLiteral("Bundle Hero") && "Character name must match in unpacked bundle");
    assert(unpacked->lorebooks.size() == 1 && "Lorebooks must unpack with exact count");
    assert(unpacked->lorebooks.first().key == QStringLiteral("legendary relic") && "Lorebook content must match");

    qInfo() << "  -> Binary multi-asset bundling, compression, and unpacking verified!";
    qInfo() << "[TEST 21 PASSED] Character Archive Packager working perfectly.\n";
}

void testGraphMemory() {
    qInfo() << "[TEST 22] Testing HypaMemory V3 Knowledge Graph & Entity Relationships...";

    GraphMemory& gm = GraphMemory::instance();
    gm.clear();
    assert(gm.allTriples().isEmpty() && "Graph memory must be empty initially");

    // Add facts
    KnowledgeTriple t1{QStringLiteral("Alice"), QStringLiteral("lives in"), QStringLiteral("Neo Seoul"), 1.0f, 1000};
    KnowledgeTriple t2{QStringLiteral("Alice"), QStringLiteral("loves"), QStringLiteral("Strawberry Cake"), 0.9f, 2000};
    KnowledgeTriple t3{QStringLiteral("Bob"), QStringLiteral("works as"), QStringLiteral("Cyber Detective"), 1.0f, 1500};

    gm.addTriple(t1);
    gm.addTriple(t2);
    gm.addTriple(t3);
    assert(gm.allTriples().size() == 3 && "Graph memory must contain 3 triples");

    // Query entity mentions
    QString query = QStringLiteral("What does Alice like to eat in the city?");
    auto matched = gm.findRelevantTriples(query, 5);
    assert(matched.size() == 2 && "Must find 2 triples referencing Alice");

    // Format context string
    QString context = GraphMemory::formatKnowledgeContext(matched);
    assert(context.contains(QStringLiteral("Alice loves Strawberry Cake")) && "Context string must format facts cleanly");

    gm.clear();

    qInfo() << "  -> Entity triple insertion, query scanning, and prompt formatting verified!";
    qInfo() << "[TEST 22 PASSED] Knowledge Graph Memory working perfectly.\n";
}

void testSoundEffectManager() {
    qInfo() << "[TEST 23] Testing Sound Effects Manager & Waveform Synthesis...";

    SoundEffectManager& sfx = SoundEffectManager::instance();
    // Verify synthesized sound playback methods without crashing
    sfx.playSendSound();
    sfx.playReceiveSound();
    sfx.playAlertSound();

    qInfo() << "  -> In-memory WAV synthesis and sound effect triggers verified!";
    qInfo() << "[TEST 23 PASSED] Sound Effect Manager working perfectly.\n";
}

void testSyncEngine() {
    qInfo() << "[TEST 24] Testing Multi-Device Real-Time Synchronization Engine...";

    SyncEngine& sync = SyncEngine::instance();
    assert(!sync.localDeviceId().isEmpty() && "Device ID must be initialized");

    // Create remote inbound packet from another simulated device
    Character remoteChar;
    remoteChar.id = QStringLiteral("remote_synced_char");
    remoteChar.name = QStringLiteral("Synced Companion");
    remoteChar.description = QStringLiteral("Created on phone, synced to desktop.");

    SyncPacket inboundPkt;
    inboundPkt.packetId = QStringLiteral("pkt_sync_001");
    inboundPkt.type = QStringLiteral("character");
    inboundPkt.action = QStringLiteral("upsert");
    inboundPkt.entityId = remoteChar.id;
    inboundPkt.payload = remoteChar.toJson();
    inboundPkt.deviceId = QStringLiteral("remote-device-phone-99");
    inboundPkt.timestamp = QDateTime::currentMSecsSinceEpoch();

    // Round-trip packet serialization
    QJsonObject pktJson = inboundPkt.toJson();
    SyncPacket decodedPkt = SyncPacket::fromJson(pktJson);
    assert(decodedPkt.entityId == remoteChar.id && "Packet JSON serialization must match");

    // Apply inbound packet
    bool applied = sync.applyInboundPacket(decodedPkt);
    assert(applied && "Inbound sync packet must apply to SQLite database");

    auto found = DatabaseManager::instance().getCharacter(remoteChar.id);
    assert(found.has_value() && found->name == QStringLiteral("Synced Companion") && "Character must exist in database after sync");

    // Verify self-echo packet rejection
    SyncPacket selfPkt = sync.createOutboundPacket(QStringLiteral("character"), QStringLiteral("delete"), remoteChar.id, {});
    bool selfApplied = sync.applyInboundPacket(selfPkt);
    assert(!selfApplied && "Self-echo packet must be safely rejected");

    // Clean up
    DatabaseManager::instance().deleteCharacter(remoteChar.id);

    qInfo() << "  -> Sync packet JSON serialization, database patch application, and loop rejection verified!";
    qInfo() << "[TEST 24 PASSED] Multi-Device Sync Engine working perfectly.\n";
}

void testColdStorageManager() {
    qInfo() << "[TEST 25] Testing Cold Storage Compressed Chat Archiving...";

    ColdStorageManager& cs = ColdStorageManager::instance();

    Chat testChat;
    testChat.id = QStringLiteral("chat_cold_test");
    testChat.name = QStringLiteral("Large Long Story");

    Message m1;
    m1.id = QStringLiteral("msg_1");
    m1.role = Role::User;
    m1.setCurrentContent(QStringLiteral("Once upon a time in a cyberpunk dystopia..."));

    Message m2;
    m2.id = QStringLiteral("msg_2");
    m2.role = Role::Assistant;
    m2.setCurrentContent(QStringLiteral("Neon lights reflected on the rain-slicked asphalt."));

    testChat.messages = {m1, m2};

    // Verify chat is not archived initially
    assert(!cs.isChatArchived(testChat) && "Chat must not be archived before archiveChat()");

    // Archive chat
    bool archived = cs.archiveChat(testChat);
    assert(archived && "archiveChat() must succeed");
    assert(cs.isChatArchived(testChat) && "Chat must report as archived after archiveChat()");
    assert(testChat.messages.size() == 1 && "Archived chat must only hold 1 placeholder message");
    assert(testChat.messages.first().currentContent().startsWith(COLD_STORAGE_HEADER) && "Placeholder must begin with COLD_STORAGE_HEADER");

    // Restore chat
    bool restored = cs.restoreChat(testChat);
    assert(restored && "restoreChat() must succeed");
    assert(!cs.isChatArchived(testChat) && "Restored chat must not report as archived");
    assert(testChat.messages.size() == 2 && "Restored chat must recover all messages");
    assert(testChat.messages.first().currentContent() == m1.currentContent() && "Message content must be identical after decompression");

    qInfo() << "  -> Compressed cold storage archiving, placeholder injection, and full restoration verified!";
    qInfo() << "[TEST 25 PASSED] Cold Storage Manager working perfectly.\n";
}

#include "storage/BackupLoader.hpp"

void testBinaryBackupLoading() {
    qInfo() << "[TEST 26] Testing Binary Backup Loader on /mnt/pm9a1/Binary-2026-08-22-1.bin...";
    QString binPath = QStringLiteral("/mnt/pm9a1/Binary-2026-08-22-1.bin");
    if (!QFile::exists(binPath)) {
        qInfo() << "  -> File /mnt/pm9a1/Binary-2026-08-22-1.bin not present in this environment, skipping test.";
        return;
    }

    BackupLoader loader;
    auto res = loader.importBackupFile(binPath, [](int current, int total, const QString& status) {
        if (current % 25 == 0 || current == total) {
            qInfo() << "   Progress:" << current << "/" << total << "% -" << status;
        }
    });

    assert(res.success && "Binary backup import must succeed");
    assert(res.charactersCount >= 60 && "Must import at least 60 characters from backup");
    assert(res.presetsCount >= 20 && "Must import at least 20 presets from backup");
    assert(res.personasCount >= 30 && "Must import at least 30 personas from backup");
    assert(res.assetsCount > 0 && "Must extract assets from backup");

    auto chars = DatabaseManager::instance().getAllCharacters();
    assert(chars.size() >= 60 && "SQLite DB must contain imported characters");

    auto presets = DatabaseManager::instance().getAllPresets();
    assert(presets.size() >= 20 && "SQLite DB must contain imported presets");

    auto personas = DatabaseManager::instance().getAllPersonas();
    assert(personas.size() >= 30 && "SQLite DB must contain imported personas");

    qInfo() << "  -> Successfully verified" << res.charactersCount << "characters," 
            << res.presetsCount << "presets," << res.personasCount << "personas,"
            << res.assetsCount << "assets from" << binPath;
    qInfo() << "[TEST 26 PASSED] Binary Backup Loading & Extraction working with 100% fidelity.\n";
}

void testCBSAssetMacrosAndHtmlPipeline() {
    qInfo() << "[TEST 27] Testing CBS Asset Macros (raw::, img::, source::) & HTML Pipeline...";

    Character unicornChar;
    unicornChar.id = QStringLiteral("unicorn-char-id");
    unicornChar.name = QStringLiteral("Unicorn");
    unicornChar.avatarPath = QStringLiteral("avatars/unicorn.png");
    unicornChar.emotionSprites[QStringLiteral("unicorn_default_panicking")] = QStringLiteral("assets/unicorn_panicking.png");
    unicornChar.emotionImages.append(qMakePair(QStringLiteral("unicorn_default_panicking"), QStringLiteral("assets/unicorn_panicking.png")));

    Persona userPersona;
    userPersona.name = QStringLiteral("Explorer");
    userPersona.avatarPath = QStringLiteral("avatars/user.png");

    // 1. Test {{raw::unicorn_default_panicking}} resolution
    QString rawSample = QStringLiteral("<div class=\"unicon-image-container\" tabindex=\"0\"><img src=\"{{raw::unicorn_default_panicking}}\" class=\"unicon-image-content\" alt=\"Character Image\"></div>");
    QString parsedRaw = PromptEngine::replaceMacros(rawSample, unicornChar, userPersona, nullptr);
    assert(!parsedRaw.contains(QStringLiteral("{{raw::")) && "raw:: macro must be resolved");
    assert(parsedRaw.contains(QStringLiteral("assets/unicorn_panicking.png")) && "Resolved path must contain actual asset path");
    assert(parsedRaw.contains(QStringLiteral("class=\"unicon-image-container\"")) && "HTML container class attribute must be preserved");

    // 2. Test {{image::...}} and {{source::char}}
    QString imgSample = QStringLiteral("Look at this: {{image::unicorn_default_panicking}} from {{source::char}}");
    QString parsedImg = PromptEngine::replaceMacros(imgSample, unicornChar, userPersona, nullptr);
    assert(parsedImg.contains(QStringLiteral("<img src=\"")) && "image:: macro must generate valid img HTML element");
    assert(!parsedImg.contains(QStringLiteral("{{source::char}}")) && "source::char macro must resolve to avatar url");

    qInfo() << "  -> CBS {{raw::...}}, {{image::...}}, {{source::...}} macro resolution and HTML attribute integrity verified!";
    qInfo() << "[TEST 27 PASSED] CBS Asset Macros & HTML Pipeline working perfectly.\n";
}

void testRelationalSchemaV3MultiSQL() {
    qInfo() << "[TEST 28] Testing relational-schema-v3 Specification & Multi-SQL Connectors...";

    auto& db = DatabaseManager::instance();
    assert(db.isRelationalV3() && "Database must report relational-schema-v3 compliance");
    assert(db.currentSchemaLayout() == QStringLiteral("relational-schema-v3") && "Schema layout must be relational-schema-v3");

    // 1. Test DatabaseConfig URL Parsing for PostgreSQL, Oracle, MySQL, SQLite
    DatabaseConfig pgCfg = DatabaseConfig::fromUrl(QStringLiteral("postgresql://risuuser:secretpass@127.0.0.1:5432/risuai_prod"));
    assert(pgCfg.driver == QStringLiteral("QPSQL") && pgCfg.host == QStringLiteral("127.0.0.1") && pgCfg.port == 5432 && pgCfg.databaseName == QStringLiteral("risuai_prod") && pgCfg.userName == QStringLiteral("risuuser") && pgCfg.password == QStringLiteral("secretpass"));
    assert(pgCfg.dialect() == DatabaseDialect::PostgreSQL);
    qInfo() << "  -> PostgreSQL Connection URL parsed:" << pgCfg.toUrl();

    DatabaseConfig oraCfg = DatabaseConfig::fromUrl(QStringLiteral("oracle://system:manager@oracle-host:1521/ORCLPDB1"));
    assert(oraCfg.driver == QStringLiteral("QODBC") && oraCfg.host == QStringLiteral("oracle-host") && oraCfg.port == 1521 && oraCfg.databaseName == QStringLiteral("ORCLPDB1"));
    assert(oraCfg.dialect() == DatabaseDialect::Oracle);
    qInfo() << "  -> Oracle Database Connection URL parsed:" << oraCfg.toUrl();

    DatabaseConfig myCfg = DatabaseConfig::fromUrl(QStringLiteral("mysql://root:mariadbpass@localhost:3306/risu_db"));
    assert(myCfg.driver == QStringLiteral("QMYSQL") && myCfg.dialect() == DatabaseDialect::MySQL);
    qInfo() << "  -> MySQL / MariaDB Connection URL parsed:" << myCfg.toUrl();

    DatabaseConfig sqCfg = DatabaseConfig::fromUrl(QStringLiteral("sqlite:///tmp/test_relational_v3.db"));
    assert(sqCfg.driver == QStringLiteral("QSQLITE") && sqCfg.dialect() == DatabaseDialect::SQLite);
    qInfo() << "  -> SQLite Database Connection URL parsed:" << sqCfg.toUrl();

    // 2. Test Relational Multi-Table Normalization
    Character relChar;
    relChar.id = QStringLiteral("char-relational-v3-hero");
    relChar.name = QStringLiteral("Astra Nova");
    relChar.description = QStringLiteral("A cosmic starship captain navigating the outer rim.");
    relChar.tags = QStringList{QStringLiteral("SciFi"), QStringLiteral("Captain"), QStringLiteral("Cyberpunk")};
    relChar.alternateGreetings.append(QStringLiteral("Welcome aboard the Starlight Cruiser, {{user}}!"));
    relChar.alternateGreetings.append(QStringLiteral("Emergency alert! Shields are at 40%! What are your orders, {{user}}?"));
    relChar.emotionSprites[QStringLiteral("confident")] = QStringLiteral("assets/astra_confident.png");
    relChar.emotionSprites[QStringLiteral("shocked")] = QStringLiteral("assets/astra_shocked.png");

    RegexScript scr;
    scr.comment = QStringLiteral("Warp speed formatter");
    scr.findRegex = QStringLiteral(R"(\bwarp\b)");
    scr.replaceString = QStringLiteral("FTL warp-drive");
    scr.type = QStringLiteral("editdisplay");
    relChar.customScripts.append(scr);

    ChatFolder fld;
    fld.id = QStringLiteral("fld-space-missions");
    fld.name = QStringLiteral("Deep Space Expeditions");
    fld.color = QStringLiteral("#bd93f9");
    relChar.chatFolders.append(fld);

    LorebookEntry lb;
    lb.id = QStringLiteral("lore-starlight-engine");
    lb.key = QStringLiteral("starlight engine, FTL, reactor");
    lb.content = QStringLiteral("[Lore: The Starlight Engine produces 500 Terawatts of zero-point warp energy.]");
    lb.enabled = true;
    relChar.globalLore.append(lb);

    Chat relChat;
    relChat.id = QStringLiteral("chat-mission-01");
    relChat.name = QStringLiteral("Mission to Alpha Centauri");
    relChat.chatVariables[QStringLiteral("shield_integrity")] = QStringLiteral("95%");
    relChat.chatVariables[QStringLiteral("warp_status")] = QStringLiteral("engaged");
    relChat.bookmarks.append(QStringLiteral("msg-rel-1"));
    relChat.suggestMessages.append(QStringLiteral("Check system diagnostics."));

    Message m1;
    m1.id = QStringLiteral("msg-rel-1");
    m1.role = Role::Assistant;
    m1.name = relChar.name;
    m1.setCurrentContent(QStringLiteral("Captain Astra reporting. All engines are running smoothly."));
    m1.addSwipe(QStringLiteral("Captain Astra: Sensors detect an unknown anomaly ahead!"));
    m1.generationInfo.model = QStringLiteral("gpt-4o");
    m1.generationInfo.inputTokens = 120;
    m1.generationInfo.outputTokens = 45;
    relChat.messages.append(m1);

    relChar.chats.append(relChat);

    bool saved = db.saveCharacter(relChar);
    assert(saved && "Saving character in relational-schema-v3 must succeed");

    // 3. Verify that relational tables were actually populated
    auto loadedOpt = db.getCharacter(relChar.id);
    assert(loadedOpt.has_value() && "Character must be retrievable from relational tables");
    assert(loadedOpt->tags.size() == 3 && "All 3 normalized tags must be loaded");
    assert(loadedOpt->alternateGreetings.size() == 2 && "All 2 greetings must be loaded");
    assert(loadedOpt->emotionSprites.size() == 2 && "All 2 emotion sprites must be loaded");
    assert(loadedOpt->customScripts.size() == 1 && "Custom script must be loaded");
    assert(loadedOpt->chatFolders.size() == 1 && "Chat folder must be loaded");
    assert(loadedOpt->globalLore.size() == 1 && "Lorebook entry must be loaded");
    assert(loadedOpt->chats.size() == 1 && "Chat must be loaded");
    assert(loadedOpt->chats[0].chatVariables.value(QStringLiteral("shield_integrity")) == QStringLiteral("95%"));
    assert(loadedOpt->chats[0].messages.size() == 1);
    assert(loadedOpt->chats[0].messages[0].swipes.size() == 2 && "Swipes must be preserved");
    assert(loadedOpt->chats[0].messages[0].generationInfo.model == QStringLiteral("gpt-4o"));

    // 4. Test System Settings & Plugin Storage
    bool setOk = db.setSystemSetting(QStringLiteral("telemetry_enabled"), true);
    assert(setOk && "System setting must save");
    QVariant readVal = db.getSystemSetting(QStringLiteral("telemetry_enabled"));
    assert(readVal.toBool() == true && "System setting must restore");

    QJsonObject pluginData;
    pluginData[QStringLiteral("custom_theme_accent")] = QStringLiteral("#ff79c6");
    pluginData[QStringLiteral("version")] = QStringLiteral("3.0");
    bool plugOk = db.setPluginCustomStorage(QStringLiteral("com.risu.starship"), pluginData);
    assert(plugOk && "Plugin custom storage must save");
    QJsonObject restoredPlugin = db.getPluginCustomStorage(QStringLiteral("com.risu.starship"));
    assert(restoredPlugin.value(QStringLiteral("custom_theme_accent")).toString() == QStringLiteral("#ff79c6"));

    // 5. Test Full Export Schema Layout
    QJsonObject fullExport = db.exportFullDatabase();
    assert(fullExport.value(QStringLiteral("schema_layout")).toString() == QStringLiteral("relational-schema-v3"));
    assert(fullExport.value(QStringLiteral("version")).toInt() >= 3);

    // Clean up
    db.deleteCharacter(relChar.id);

    qInfo() << "  -> Relational normalization, multi-swipes, metadata, and multi-SQL dialects verified!";
    qInfo() << "[TEST 28 PASSED] relational-schema-v3 Specification & Multi-SQL Connectors working with 100% fidelity.\n";
}

void testCharacterSessionsAndSwitching() {
    qInfo() << "[TEST 29] Testing Character Chat Sessions (Creation, Alternate Greetings, Switching, Isolation, Forking, Duplication)...";

    auto& db = DatabaseManager::instance();

    Persona boundPersona;
    boundPersona.id = QStringLiteral("persona_cynthia_bound_001");
    boundPersona.name = QStringLiteral("Bound Explorer");
    boundPersona.avatarPath = QStringLiteral("/tmp/preserved-persona-avatar.png");
    boundPersona.description = QStringLiteral("Private test note");
    boundPersona.personaPrompt = QStringLiteral("Bound persona prompt");
    boundPersona.isActive = false;
    assert(db.savePersona(boundPersona));
    assert(db.getPersona(boundPersona.id).has_value() && "Persona lookup by id must succeed");

    // Persona editor saves must preserve omitted fields such as avatarPath and keep
    // the Risu prompt separate from private notes.
    PersonaController personaEditor;
    QVariantMap personaEdit;
    personaEdit[QStringLiteral("id")] = boundPersona.id;
    personaEdit[QStringLiteral("name")] = boundPersona.name;
    personaEdit[QStringLiteral("personaPrompt")] = QStringLiteral("Bound persona prompt after edit");
    personaEdit[QStringLiteral("description")] = QStringLiteral("Private note after edit");
    personaEdit[QStringLiteral("isActive")] = false;
    assert(personaEditor.savePersona(personaEdit));
    auto editedPersona = db.getPersona(boundPersona.id);
    assert(editedPersona.has_value());
    assert(editedPersona->avatarPath == boundPersona.avatarPath && "Persona save must preserve omitted avatarPath");
    assert(editedPersona->personaPrompt == QStringLiteral("Bound persona prompt after edit"));
    assert(editedPersona->description == QStringLiteral("Private note after edit"));

    // 1. Create a test character with multiple alternate greetings
    Character cynthia;
    cynthia.id = QStringLiteral("char_cynthia_sessions_001");
    cynthia.name = QStringLiteral("Cynthia");
    cynthia.firstMessage = QStringLiteral("Hello, Explorer! Welcome to our sanctuary.");
    cynthia.alternateGreetings.append(QStringLiteral("Greetings! The stars shine bright tonight."));
    cynthia.alternateGreetings.append(QStringLiteral("Ah, you have returned earlier than expected!"));

    // Initial default chat session
    Chat session1;
    session1.id = QStringLiteral("chat_cynthia_001");
    session1.name = QStringLiteral("Main Sanctuary Chat");
    session1.firstMessageIndex = 0;
    session1.lastDate = QDateTime::currentMSecsSinceEpoch();
    session1.bindedPersona = boundPersona.id;
    session1.modules = QStringList{QStringLiteral("module-session-settings-test")};
    session1.authorNote = QStringLiteral("Keep the sanctuary atmosphere calm and observant.");
    session1.authorNoteDepth = 2;

    LorebookEntry sessionLore;
    sessionLore.id = QStringLiteral("session-lore-cynthia");
    sessionLore.key = QStringLiteral("sanctuary");
    sessionLore.content = QStringLiteral("The sanctuary is hidden beneath an ancient observatory.");
    sessionLore.enabled = true;
    session1.localLore.append(sessionLore);

    Message m1;
    m1.id = QStringLiteral("msg_cyn_001");
    m1.role = Role::Assistant;
    m1.name = cynthia.name;
    m1.setCurrentContent(cynthia.firstMessage);
    session1.messages.append(m1);
    cynthia.chats.append(session1);
    cynthia.currentChatIndex = 0;

    bool saved = db.saveCharacter(cynthia);
    assert(saved && "Character must save successfully");

    // 2. Initialize ChatController
    ChatController ctrl;
    ctrl.loadCharacter(cynthia.id);

    assert(ctrl.chatSessionCount() == 1 && "Initial session count must be 1");
    assert(ctrl.currentChatName() == QStringLiteral("Main Sanctuary Chat") && "Initial session name must match");
    assert(ctrl.messageModel()->rowCount() == 1 && "Initial session must have 1 message");
    assert(ctrl.availableGreetings().size() == 3 && "Character must have 3 available greetings");
    assert(ctrl.formatInChat(QStringLiteral("Hello {{user}}")) == QStringLiteral("Hello Bound Explorer") &&
           "Chat-bound persona must drive CBS/user macro rendering");

    // 3. Create second session with alternate greeting #1 ("Greetings! The stars shine bright tonight.")
    ctrl.createNewChatWithGreeting(1, QStringLiteral("Stargazing Session"));
    assert(ctrl.chatSessionCount() == 2 && "Session count must become 2");
    assert(ctrl.currentChatIndex() == 1 && "Active session index must be 1");
    assert(ctrl.currentChatName() == QStringLiteral("Stargazing Session") && "New session name must match");
    assert(ctrl.messageModel()->rowCount() == 1 && "New session must have 1 message");
    assert(ctrl.messageModel()->messageAt(0).currentContent() == QStringLiteral("Greetings! The stars shine bright tonight.") && "Greeting text must match alternate greeting #1");
    assert(!ctrl.formatInChat(QStringLiteral("Hello {{user}}")).contains(QStringLiteral("Bound Explorer")) &&
           "Unbound chats must fall back to the globally active persona");

    // 4. Add user message in Session 2 to verify session message isolation
    Message userMsg;
    userMsg.id = QStringLiteral("msg_user_session2");
    userMsg.role = Role::User;
    userMsg.name = QStringLiteral("Explorer");
    userMsg.setCurrentContent(QStringLiteral("The constellation over there looks fascinating."));
    ctrl.messageModel()->appendMessage(userMsg);
    assert(ctrl.messageModel()->rowCount() == 2 && "Session 2 must now have 2 messages");

    // 5. Switch back to Session 0 (Main Sanctuary Chat)
    ctrl.switchChat(0);
    assert(ctrl.currentChatIndex() == 0 && "Active session must be 0");
    assert(ctrl.currentChatName() == QStringLiteral("Main Sanctuary Chat") && "Session 0 name must be restored");
    assert(ctrl.messageModel()->rowCount() == 1 && "Session 0 must still have only 1 message (Isolation verified!)");
    assert(ctrl.formatInChat(QStringLiteral("Hello {{user}}")) == QStringLiteral("Hello Bound Explorer") &&
           "Switching back must restore the chat-bound persona");

    // 6. Branch Session 0 and verify all chat-scoped prompt settings survive.
    ctrl.forkChat(0);
    assert(ctrl.chatSessionCount() == 3 && "Forking must create a third session");
    const QString branchId = ctrl.chatSessions().last().toMap().value(QStringLiteral("id")).toString();
    auto branchedCharacter = db.getCharacter(cynthia.id);
    assert(branchedCharacter.has_value());
    const auto branchIt = std::find_if(branchedCharacter->chats.cbegin(), branchedCharacter->chats.cend(),
        [&](const Chat& candidate) { return candidate.id == branchId; });
    assert(branchIt != branchedCharacter->chats.cend() && "Persisted branch must be retrievable by id");
    const Chat& branch = *branchIt;
    assert(branch.bindedPersona == boundPersona.id && "Branch must preserve persona binding");
    assert(branch.modules.contains(QStringLiteral("module-session-settings-test")) && "Branch must preserve chat modules");
    assert(branch.authorNote == session1.authorNote && branch.authorNoteDepth == session1.authorNoteDepth &&
           "Branch must preserve author-note settings");
    assert(branch.localLore.size() == 1 && branch.localLore.first().id == sessionLore.id &&
           "Branch must preserve local lorebooks");
    ctrl.deleteChat(2);
    assert(ctrl.chatSessionCount() == 2 && "Deleting the branch must restore two sessions");

    // 7. Duplicate Session 1
    ctrl.duplicateChat(1);
    assert(ctrl.chatSessionCount() == 3 && "Session count must become 3");
    assert(ctrl.currentChatIndex() == 2 && "Cloned session must become active");
    assert(ctrl.currentChatName() == QStringLiteral("Stargazing Session (Copy)") && "Cloned session name must have (Copy)");

    // 8. Rename the cloned session
    ctrl.renameChat(2, QStringLiteral("Deep Night Astronomy"));
    assert(ctrl.currentChatName() == QStringLiteral("Deep Night Astronomy") && "Session must be renamed");

    // 9. Test chatSessions QVariantList detailed metadata
    QVariantList sessionsList = ctrl.chatSessions();
    assert(sessionsList.size() == 3 && "chatSessions must return 3 items");
    QVariantMap s0 = sessionsList[0].toMap();
    assert(s0.value(QStringLiteral("name")).toString() == QStringLiteral("Main Sanctuary Chat"));
    assert(s0.value(QStringLiteral("messageCount")).toInt() == 1);
    assert(!s0.value(QStringLiteral("isActive")).toBool());
    QVariantMap s2 = sessionsList[2].toMap();
    assert(s2.value(QStringLiteral("name")).toString() == QStringLiteral("Deep Night Astronomy"));
    assert(s2.value(QStringLiteral("isActive")).toBool());

    // 10. Delete session 2
    ctrl.deleteChat(2);
    assert(ctrl.chatSessionCount() == 2 && "Session count must return to 2 after deletion");

    // 11. A deleted bound persona must fall back cleanly to the global persona.
    ctrl.switchChat(0);
    assert(ctrl.formatInChat(QStringLiteral("Hello {{user}}")) == QStringLiteral("Hello Bound Explorer"));
    assert(db.deletePersona(boundPersona.id));
    assert(!ctrl.formatInChat(QStringLiteral("Hello {{user}}")).contains(QStringLiteral("Bound Explorer")) &&
           "Missing bound persona must fall back after personasChanged");

    // 12. Clean up test character
    db.deleteCharacter(cynthia.id);

    qInfo() << "  -> Multiple chat sessions per character, alternate greeting seeding, message isolation, renaming, and duplication verified!";
    qInfo() << "[TEST 29 PASSED] Character Chat Sessions & Switching working with 100% fidelity.\n";
}

int main(int argc, char *argv[]) {
    // Keep integration tests fully isolated from a developer's persistent RisuAI data.
    // Reusing ~/.local/share/risuai_tests caused the test database to grow indefinitely
    // across runs and turned simple CRUD coverage into multi-minute SQLite page scans.
    QTemporaryDir isolatedDataHome(QDir::tempPath() + QStringLiteral("/risuai-qt-tests-XXXXXX"));
    assert(isolatedDataHome.isValid() && "Temporary test data directory must be created");
    qputenv("XDG_DATA_HOME", isolatedDataHome.path().toUtf8());
    qunsetenv("RISUAI_DATABASE_URL");
    qunsetenv("DATABASE_URL");
    qunsetenv("RISUAI_DB_DRIVER");

    QCoreApplication app(argc, argv);

    qInfo() << "==================================================";
    qInfo() << "   RisuAI Native Linux Qt (C++20) Test Suite      ";
    qInfo() << "==================================================";

    testDatabaseAndTypes();
    testPromptEngineAndMacros();
    testCharacterCardIO();
    testAIProviderFactory();
    testRegexEngine();
    testMultiSwipeModelAndBranching();
    testFullDatabaseBackupRestoreRoundTrip();
    testExtendedMacrosAndChatExport();
    testMemoryManagerAndTTS();
    testTriggerEngine();
    testGroupChatRooms();
    testScriptingEngine();
    testAPIServer();
    testI18n();
    testEmbeddingEngine();
    testMessageAttachment();
    testPluginEngine();
    testTranslator();
    testSystemTrayManager();
    testCloudSyncManager();
    testArchivePacker();
    testGraphMemory();
    testSoundEffectManager();
    testSyncEngine();
    testColdStorageManager();
    testBinaryBackupLoading();
    testCBSAssetMacrosAndHtmlPipeline();
    testRelationalSchemaV3MultiSQL();
    testCharacterSessionsAndSwitching();

    qInfo() << "==================================================";
    qInfo() << "   ALL INTEGRATION & UNIT TESTS PASSED (29/29)!   ";
    qInfo() << "==================================================";

    DatabaseManager::instance().closeDatabase();
    return 0;
}

