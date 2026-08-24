#pragma once

#include <QString>
#include <QStringList>
#include <QList>
#include <QPair>
#include <QMap>
#include <QDateTime>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <QUuid>
#include <QRegularExpression>

namespace Risu {

// Message role
enum class Role {
    User,
    Assistant,
    System
};

inline QString roleToString(Role role) {
    switch (role) {
        case Role::User: return QStringLiteral("user");
        case Role::Assistant: return QStringLiteral("char");
        case Role::System: return QStringLiteral("system");
    }
    return QStringLiteral("user");
}

inline Role stringToRole(const QString& str) {
    QString lower = str.toLower().trimmed();
    if (lower == QStringLiteral("char") || lower == QStringLiteral("assistant") || 
        lower == QStringLiteral("bot") || lower == QStringLiteral("model")) {
        return Role::Assistant;
    }
    if (lower == QStringLiteral("system")) {
        return Role::System;
    }
    return Role::User;
}

// Single swipe variant of a message
struct MessageSwipe {
    QString id;
    QString content;
    QString thought;      // Chain of thought / reasoning content
    qint64 timestamp = 0;
    QString modelUsed;
    int inputTokens = 0;
    int outputTokens = 0;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("content")] = content;
        obj[QStringLiteral("thought")] = thought;
        obj[QStringLiteral("timestamp")] = timestamp;
        obj[QStringLiteral("modelUsed")] = modelUsed;
        obj[QStringLiteral("inputTokens")] = inputTokens;
        obj[QStringLiteral("outputTokens")] = outputTokens;
        return obj;
    }

    static MessageSwipe fromJson(const QJsonObject& obj) {
        MessageSwipe s;
        s.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        s.content = obj.value(QStringLiteral("content")).toString();
        s.thought = obj.value(QStringLiteral("thought")).toString();
        s.timestamp = obj.value(QStringLiteral("timestamp")).toVariant().toLongLong();
        s.modelUsed = obj.value(QStringLiteral("modelUsed")).toString();
        s.inputTokens = obj.value(QStringLiteral("inputTokens")).toInt(0);
        s.outputTokens = obj.value(QStringLiteral("outputTokens")).toInt(0);
        return s;
    }
};

// Message Generation Info
struct MessageGenerationInfo {
    QString model;
    QString generationId;
    int inputTokens = 0;
    int outputTokens = 0;
    int maxContext = 0;
    QMap<QString, int> stageTiming;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("model")] = model;
        obj[QStringLiteral("generationId")] = generationId;
        obj[QStringLiteral("inputTokens")] = inputTokens;
        obj[QStringLiteral("outputTokens")] = outputTokens;
        obj[QStringLiteral("maxContext")] = maxContext;
        QJsonObject st;
        for (auto it = stageTiming.constBegin(); it != stageTiming.constEnd(); ++it) {
            st[it.key()] = it.value();
        }
        obj[QStringLiteral("stageTiming")] = st;
        return obj;
    }

    static MessageGenerationInfo fromJson(const QJsonObject& obj) {
        MessageGenerationInfo gi;
        gi.model = obj.value(QStringLiteral("model")).toString();
        gi.generationId = obj.value(QStringLiteral("generationId")).toString();
        gi.inputTokens = obj.value(QStringLiteral("inputTokens")).toInt(0);
        gi.outputTokens = obj.value(QStringLiteral("outputTokens")).toInt(0);
        gi.maxContext = obj.value(QStringLiteral("maxContext")).toInt(0);
        if (obj.contains(QStringLiteral("stageTiming")) && obj.value(QStringLiteral("stageTiming")).isObject()) {
            QJsonObject st = obj.value(QStringLiteral("stageTiming")).toObject();
            for (auto it = st.begin(); it != st.end(); ++it) {
                gi.stageTiming[it.key()] = it.value().toInt();
            }
        }
        return gi;
    }
};

// Message structure - 100% compliant with RisuAI
struct Message {
    QString id;               // message unique ID or chatId
    Role role = Role::User;
    QString data;             // Primary text content (Risu format)
    QString name;             // Custom name override if any
    QString saying;           // Active speaker ID in group chat
    qint64 timestamp = 0;     // time in ms
    bool isComment = false;
    bool disabled = false;
    bool isPinned = false;
    QString emotion;          // Detected emotion tag or sprite identifier
    QString attachmentPath;   // Inlay / multi-modal image attachment
    QString thought;          // Chain of thought / reasoning content
    QList<MessageSwipe> swipes;
    int currentSwipeIndex = 0;
    MessageGenerationInfo generationInfo;
    QJsonObject promptInfo;

    // Helper methods
    QString currentContent() const {
        if (!swipes.isEmpty()) {
            if (currentSwipeIndex >= 0 && currentSwipeIndex < swipes.size()) {
                return swipes[currentSwipeIndex].content;
            }
            return swipes.last().content;
        }
        if (!data.isEmpty()) {
            return data;
        }
        return QString();
    }

    QString currentThought() const {
        if (!swipes.isEmpty()) {
            if (currentSwipeIndex >= 0 && currentSwipeIndex < swipes.size()) {
                const QString& t = swipes[currentSwipeIndex].thought;
                if (!t.isEmpty()) return t;
            }
        }
        if (!thought.isEmpty()) {
            return thought;
        }
        static const QRegularExpression thoughtRegex(QStringLiteral("<(?:Thoughts|thought|reasoning)>([\\s\\S]*?)</(?:Thoughts|thought|reasoning)>"), QRegularExpression::CaseInsensitiveOption);
        auto match = thoughtRegex.match(data);
        if (match.hasMatch()) {
            return match.captured(1).trimmed();
        }
        return QString();
    }

    void setCurrentContent(const QString& content, const QString& inThought = QString()) {
        data = content;
        if (!inThought.isEmpty()) {
            thought = inThought;
        }
        if (swipes.isEmpty()) {
            MessageSwipe s;
            s.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            s.content = content;
            s.thought = thought;
            s.timestamp = timestamp > 0 ? timestamp : QDateTime::currentMSecsSinceEpoch();
            swipes.append(s);
            currentSwipeIndex = 0;
        } else {
            if (currentSwipeIndex >= 0 && currentSwipeIndex < swipes.size()) {
                swipes[currentSwipeIndex].content = content;
                if (!inThought.isEmpty()) {
                    swipes[currentSwipeIndex].thought = inThought;
                }
            } else {
                swipes.last().content = content;
                if (!inThought.isEmpty()) {
                    swipes.last().thought = inThought;
                }
            }
        }
    }

    void addSwipe(const QString& content, const QString& inThought = QString(), const QString& model = QString(), int inTok = 0, int outTok = 0) {
        MessageSwipe s;
        s.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        s.content = content;
        s.thought = inThought;
        s.timestamp = QDateTime::currentMSecsSinceEpoch();
        s.modelUsed = model;
        s.inputTokens = inTok;
        s.outputTokens = outTok;
        swipes.append(s);
        currentSwipeIndex = swipes.size() - 1;
        data = content;
        if (!inThought.isEmpty()) thought = inThought;
    }

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("chatId")] = id;
        obj[QStringLiteral("role")] = roleToString(role);
        obj[QStringLiteral("data")] = currentContent();
        obj[QStringLiteral("name")] = name;
        if (!saying.isEmpty()) obj[QStringLiteral("saying")] = saying;
        obj[QStringLiteral("time")] = timestamp;
        obj[QStringLiteral("timestamp")] = timestamp;
        obj[QStringLiteral("isComment")] = isComment;
        obj[QStringLiteral("disabled")] = disabled;
        obj[QStringLiteral("isPinned")] = isPinned;
        obj[QStringLiteral("emotion")] = emotion;
        obj[QStringLiteral("attachmentPath")] = attachmentPath;
        obj[QStringLiteral("thought")] = currentThought();
        obj[QStringLiteral("currentSwipeIndex")] = currentSwipeIndex;
        obj[QStringLiteral("generationInfo")] = generationInfo.toJson();
        obj[QStringLiteral("promptInfo")] = promptInfo;

        QJsonArray swArr;
        for (const auto& sw : swipes) {
            swArr.append(sw.toJson());
        }
        obj[QStringLiteral("swipes")] = swArr;
        return obj;
    }

    static Message fromJson(const QJsonObject& obj) {
        Message m;
        m.id = obj.value(QStringLiteral("id")).toString(obj.value(QStringLiteral("chatId")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces)));
        m.role = stringToRole(obj.value(QStringLiteral("role")).toString(QStringLiteral("user")));
        m.name = obj.value(QStringLiteral("name")).toString();
        m.saying = obj.value(QStringLiteral("saying")).toString();
        m.data = obj.value(QStringLiteral("data")).toString(obj.value(QStringLiteral("content")).toString());
        m.thought = obj.value(QStringLiteral("thought")).toString();
        m.isComment = obj.value(QStringLiteral("isComment")).toBool(false);
        m.disabled = obj.value(QStringLiteral("disabled")).toBool(false);
        m.isPinned = obj.value(QStringLiteral("isPinned")).toBool(false);
        m.emotion = obj.value(QStringLiteral("emotion")).toString();
        m.attachmentPath = obj.value(QStringLiteral("attachmentPath")).toString();
        m.currentSwipeIndex = obj.value(QStringLiteral("currentSwipeIndex")).toInt(0);

        if (obj.contains(QStringLiteral("time"))) {
            m.timestamp = obj.value(QStringLiteral("time")).toVariant().toLongLong();
        } else if (obj.contains(QStringLiteral("timestamp"))) {
            m.timestamp = obj.value(QStringLiteral("timestamp")).toVariant().toLongLong();
        }
        if (m.timestamp == 0) m.timestamp = QDateTime::currentMSecsSinceEpoch();

        if (obj.contains(QStringLiteral("generationInfo")) && obj.value(QStringLiteral("generationInfo")).isObject()) {
            m.generationInfo = MessageGenerationInfo::fromJson(obj.value(QStringLiteral("generationInfo")).toObject());
        }
        if (obj.contains(QStringLiteral("promptInfo")) && obj.value(QStringLiteral("promptInfo")).isObject()) {
            m.promptInfo = obj.value(QStringLiteral("promptInfo")).toObject();
        }

        if (obj.contains(QStringLiteral("swipes")) && obj.value(QStringLiteral("swipes")).isArray()) {
            QJsonArray swArr = obj.value(QStringLiteral("swipes")).toArray();
            for (const auto& item : swArr) {
                if (item.isObject()) {
                    m.swipes.append(MessageSwipe::fromJson(item.toObject()));
                } else if (item.isString()) {
                    MessageSwipe s;
                    s.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                    s.content = item.toString();
                    s.timestamp = m.timestamp;
                    m.swipes.append(s);
                }
            }
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

        return m;
    }
};

// Lorebook entry definition (100% compatible with RisuAI loreBook)
struct LorebookEntry {
    QString id;
    QString key;                  // Primary trigger keys (comma separated)
    QString secondKey;            // Secondary keys for selective logic
    QString comment;              // Memo / title
    QString content;              // Content to inject
    QString mode = QStringLiteral("normal"); // "normal", "folder", "constant", "multiple", "child"
    int insertOrder = 100;        // Insertion priority order
    bool alwaysActive = false;    // Constant injection
    bool selective = false;       // Require secondKey matching
    bool useRegex = false;        // Regex matching for keys
    bool caseSensitive = false;
    int scanDepth = 5;            // How many messages back to scan
    bool enabled = true;
    double activationPercent = 1.0;
    int bookVersion = 1;
    QString folder;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces) : id;
        obj[QStringLiteral("key")] = key;
        obj[QStringLiteral("secondkey")] = secondKey;
        obj[QStringLiteral("comment")] = comment;
        obj[QStringLiteral("content")] = content;
        obj[QStringLiteral("mode")] = mode;
        obj[QStringLiteral("insertorder")] = insertOrder;
        obj[QStringLiteral("alwaysActive")] = alwaysActive;
        obj[QStringLiteral("selective")] = selective;
        obj[QStringLiteral("useRegex")] = useRegex;
        obj[QStringLiteral("caseSensitive")] = caseSensitive;
        obj[QStringLiteral("scanDepth")] = scanDepth;
        obj[QStringLiteral("enabled")] = enabled;
        obj[QStringLiteral("activationPercent")] = activationPercent;
        obj[QStringLiteral("bookVersion")] = bookVersion;
        obj[QStringLiteral("folder")] = folder;
        return obj;
    }

    static LorebookEntry fromJson(const QJsonObject& obj) {
        LorebookEntry e;
        e.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        
        if (obj.value(QStringLiteral("key")).isArray()) {
            QStringList keys;
            for (const auto& k : obj.value(QStringLiteral("key")).toArray()) keys.append(k.toString());
            e.key = keys.join(QStringLiteral(", "));
        } else {
            e.key = obj.value(QStringLiteral("key")).toString(obj.value(QStringLiteral("keys")).toString());
        }

        if (obj.value(QStringLiteral("secondkey")).isArray()) {
            QStringList keys;
            for (const auto& k : obj.value(QStringLiteral("secondkey")).toArray()) keys.append(k.toString());
            e.secondKey = keys.join(QStringLiteral(", "));
        } else {
            e.secondKey = obj.value(QStringLiteral("secondkey")).toString(obj.value(QStringLiteral("secondKey")).toString(obj.value(QStringLiteral("secondary_keys")).toString()));
        }

        e.comment = obj.value(QStringLiteral("comment")).toString();
        e.content = obj.value(QStringLiteral("content")).toString();
        e.mode = obj.value(QStringLiteral("mode")).toString(QStringLiteral("normal"));
        e.insertOrder = obj.value(QStringLiteral("insertorder")).toInt(obj.value(QStringLiteral("insertion_order")).toInt(100));
        e.alwaysActive = obj.value(QStringLiteral("alwaysActive")).toBool(false);
        e.selective = obj.value(QStringLiteral("selective")).toBool(false);
        e.useRegex = obj.value(QStringLiteral("useRegex")).toBool(false);
        e.caseSensitive = obj.value(QStringLiteral("caseSensitive")).toBool(false);
        e.scanDepth = obj.value(QStringLiteral("scanDepth")).toInt(5);
        e.enabled = obj.value(QStringLiteral("enabled")).toBool(true);
        e.activationPercent = obj.value(QStringLiteral("activationPercent")).toDouble(1.0);
        e.bookVersion = obj.value(QStringLiteral("bookVersion")).toInt(1);
        e.folder = obj.value(QStringLiteral("folder")).toString();
        return e;
    }
};

// Regex replacement script (customscript in Risu)
struct RegexScript {
    QString id;
    QString comment;
    QString findRegex;        // in
    QString replaceString;    // out
    QString type = QStringLiteral("editdisplay");
    QString flag;
    bool enabled = true;
    bool inChat = true;
    bool preGen = false;
    bool postGen = false;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces) : id;
        obj[QStringLiteral("comment")] = comment;
        obj[QStringLiteral("in")] = findRegex;
        obj[QStringLiteral("out")] = replaceString;
        obj[QStringLiteral("findRegex")] = findRegex;
        obj[QStringLiteral("replaceString")] = replaceString;
        obj[QStringLiteral("type")] = type;
        obj[QStringLiteral("flag")] = flag;
        obj[QStringLiteral("enabled")] = enabled;
        obj[QStringLiteral("inChat")] = inChat;
        obj[QStringLiteral("preGen")] = preGen;
        obj[QStringLiteral("postGen")] = postGen;
        return obj;
    }

    static RegexScript fromJson(const QJsonObject& obj) {
        RegexScript s;
        s.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        s.comment = obj.value(QStringLiteral("comment")).toString();
        s.findRegex = obj.value(QStringLiteral("in")).toString(obj.value(QStringLiteral("findRegex")).toString());
        s.replaceString = obj.value(QStringLiteral("out")).toString(obj.value(QStringLiteral("replaceString")).toString());
        s.type = obj.value(QStringLiteral("type")).toString(QStringLiteral("editdisplay"));
        s.flag = obj.value(QStringLiteral("flag")).toString();
        s.enabled = obj.value(QStringLiteral("enabled")).toBool(true);
        s.inChat = obj.value(QStringLiteral("inChat")).toBool(true);
        s.preGen = obj.value(QStringLiteral("preGen")).toBool(false);
        s.postGen = obj.value(QStringLiteral("postGen")).toBool(false);
        return s;
    }
};

// Chat Folder in Risu
struct ChatFolder {
    QString id;
    QString name;
    QString color;
    bool folded = false;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("color")] = color;
        obj[QStringLiteral("folded")] = folded;
        return obj;
    }

    static ChatFolder fromJson(const QJsonObject& obj) {
        ChatFolder f;
        f.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        f.name = obj.value(QStringLiteral("name")).toString();
        f.color = obj.value(QStringLiteral("color")).toString();
        f.folded = obj.value(QStringLiteral("folded")).toBool(false);
        return f;
    }
};

// Chat session
struct Chat {
    QString id;
    QString name = QStringLiteral("Main Chat");
    QList<Message> messages;
    QList<LorebookEntry> localLore;
    QString note;
    int firstMessageIndex = 0;    // fmIndex (-1 for default, 0..N for alternateGreetings)
    qint64 lastDate = 0;
    QString bindedPersona;        // bindedPersona / bindedPersonaId
    QString folderId;
    QStringList modules;          // Risu module IDs enabled only for this chat
    QStringList bookmarks;
    QString authorNote;
    int authorNoteDepth = 3;
    QMap<QString, QString> chatVariables;
    QString sdData;
    QString supaMemoryData;
    QStringList suggestMessages;
    QString lastMemory;
    bool isStreaming = false;
    QString streamingOptimizationMode;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("note")] = note;
        obj[QStringLiteral("fmIndex")] = firstMessageIndex;
        obj[QStringLiteral("firstMessageIndex")] = firstMessageIndex;
        obj[QStringLiteral("lastDate")] = lastDate;
        obj[QStringLiteral("bindedPersona")] = bindedPersona;
        obj[QStringLiteral("folderId")] = folderId;
        obj[QStringLiteral("authorNote")] = authorNote;
        obj[QStringLiteral("authorNoteDepth")] = authorNoteDepth;
        obj[QStringLiteral("sdData")] = sdData;
        obj[QStringLiteral("supaMemoryData")] = supaMemoryData;
        obj[QStringLiteral("lastMemory")] = lastMemory;
        obj[QStringLiteral("isStreaming")] = isStreaming;
        obj[QStringLiteral("streamingOptimizationMode")] = streamingOptimizationMode;

        QJsonArray moduleArr;
        for (const auto& moduleId : modules) moduleArr.append(moduleId);
        obj[QStringLiteral("modules")] = moduleArr;

        QJsonArray bmArr;
        for (const auto& b : bookmarks) bmArr.append(b);
        obj[QStringLiteral("bookmarks")] = bmArr;

        QJsonArray smArr;
        for (const auto& sm : suggestMessages) smArr.append(sm);
        obj[QStringLiteral("suggestMessages")] = smArr;

        QJsonObject varsObj;
        for (auto it = chatVariables.constBegin(); it != chatVariables.constEnd(); ++it) {
            varsObj[it.key()] = it.value();
        }
        obj[QStringLiteral("chatVariables")] = varsObj;

        QJsonArray msgArr;
        for (const auto& m : messages) {
            msgArr.append(m.toJson());
        }
        obj[QStringLiteral("message")] = msgArr;

        QJsonArray loreArr;
        for (const auto& l : localLore) {
            loreArr.append(l.toJson());
        }
        obj[QStringLiteral("localLore")] = loreArr;

        return obj;
    }

    static Chat fromJson(const QJsonObject& obj) {
        Chat c;
        c.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        c.name = obj.value(QStringLiteral("name")).toString(QStringLiteral("Main Chat"));
        c.note = obj.value(QStringLiteral("note")).toString();
        c.firstMessageIndex = obj.value(QStringLiteral("fmIndex")).toInt(obj.value(QStringLiteral("firstMessageIndex")).toInt(0));
        c.lastDate = obj.value(QStringLiteral("lastDate")).toVariant().toLongLong();
        c.bindedPersona = obj.value(QStringLiteral("bindedPersona")).toString(obj.value(QStringLiteral("bindedPersonaId")).toString());
        c.folderId = obj.value(QStringLiteral("folderId")).toString();
        c.authorNote = obj.value(QStringLiteral("authorNote")).toString(obj.value(QStringLiteral("author_note")).toString());
        c.authorNoteDepth = obj.value(QStringLiteral("authorNoteDepth")).toInt(obj.value(QStringLiteral("author_note_depth")).toInt(3));
        c.sdData = obj.value(QStringLiteral("sdData")).toString();
        c.supaMemoryData = obj.value(QStringLiteral("supaMemoryData")).toString();
        c.lastMemory = obj.value(QStringLiteral("lastMemory")).toString(obj.value(QStringLiteral("last_memory")).toString());
        c.isStreaming = obj.value(QStringLiteral("isStreaming")).toBool(obj.value(QStringLiteral("is_streaming")).toBool(false));
        c.streamingOptimizationMode = obj.value(QStringLiteral("streamingOptimizationMode")).toString(obj.value(QStringLiteral("streaming_optimization_mode")).toString());

        if (obj.contains(QStringLiteral("modules")) && obj.value(QStringLiteral("modules")).isArray()) {
            for (const auto& moduleId : obj.value(QStringLiteral("modules")).toArray()) {
                if (moduleId.isString() && !moduleId.toString().isEmpty()) c.modules.append(moduleId.toString());
            }
        }

        if (obj.contains(QStringLiteral("bookmarks")) && obj.value(QStringLiteral("bookmarks")).isArray()) {
            for (const auto& b : obj.value(QStringLiteral("bookmarks")).toArray()) c.bookmarks.append(b.toString());
        }

        if (obj.contains(QStringLiteral("suggestMessages")) && obj.value(QStringLiteral("suggestMessages")).isArray()) {
            for (const auto& sm : obj.value(QStringLiteral("suggestMessages")).toArray()) c.suggestMessages.append(sm.toString());
        }

        if (obj.contains(QStringLiteral("chatVariables")) && obj.value(QStringLiteral("chatVariables")).isObject()) {
            QJsonObject varsObj = obj.value(QStringLiteral("chatVariables")).toObject();
            for (auto it = varsObj.begin(); it != varsObj.end(); ++it) {
                c.chatVariables[it.key()] = it.value().toString();
            }
        }

        if (obj.contains(QStringLiteral("message")) && obj.value(QStringLiteral("message")).isArray()) {
            QJsonArray msgArr = obj.value(QStringLiteral("message")).toArray();
            for (const auto& item : msgArr) {
                c.messages.append(Message::fromJson(item.toObject()));
            }
        } else if (obj.contains(QStringLiteral("messages")) && obj.value(QStringLiteral("messages")).isArray()) {
            QJsonArray msgArr = obj.value(QStringLiteral("messages")).toArray();
            for (const auto& item : msgArr) {
                c.messages.append(Message::fromJson(item.toObject()));
            }
        }

        if (obj.contains(QStringLiteral("localLore")) && obj.value(QStringLiteral("localLore")).isArray()) {
            QJsonArray loreArr = obj.value(QStringLiteral("localLore")).toArray();
            for (const auto& item : loreArr) {
                c.localLore.append(LorebookEntry::fromJson(item.toObject()));
            }
        }

        return c;
    }
};

// Character Card & Group Definition (100% compliant with RisuAI)
struct Character {
    QString id;                   // chaId in Risu
    QString name;
    QString avatarPath;           // image in Risu (assets/... or absolute path)
    QString firstMessage;
    QString description;          // desc in Risu
    QString personality;
    QString scenario;
    QString exampleMessage;
    QString creatorNotes;         // notes or creatorNotes in Risu
    QString systemPrompt;
    QString postHistoryInstructions;
    QString creator;
    QString characterVersion;
    QString authorNote;
    int authorNoteDepth = 3;
    QStringList alternateGreetings;
    QStringList tags;
    QList<QPair<QString, QString>> emotionImages; // [ [emotionName, assetKey], ... ]
    QList<QPair<QString, QString>> additionalAssets;
    QMap<QString, QString> emotionSprites;        // Map representation
    QList<LorebookEntry> globalLore;
    QList<RegexScript> customScripts;
    QList<Chat> chats;
    QList<ChatFolder> chatFolders;
    int currentChatIndex = 0;     // chatPage in Risu
    int firstMsgIndex = 0;
    qint64 lastInteraction = 0;

    // Group chat properties
    QString type;                 // "character" (empty/null) or "group"
    QStringList groupMembers;     // characters array in Risu group
    QList<int> characterTalks;
    QList<bool> characterActive;
    bool autoMode = false;
    bool useCharacterLore = false;
    bool oneAtTime = false;
    bool utilityBot = false;
    bool supaMemory = false;
    bool largePortrait = false;
    QString depthPrompt;
    int depthPromptDepth = 4;
    QJsonObject vits;
    QJsonObject voicevoxConfig;
    QString ttsMode;
    QString backgroundHTML;
    QString backgroundCSS;
    QString replaceGlobalNote;
    QString additionalText;
    QJsonObject rawData;         // Extra fields preservation

    bool isGroup() const {
        return type == QStringLiteral("group");
    }

    Chat& currentChat() {
        if (chats.isEmpty()) {
            Chat c;
            c.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            c.name = QStringLiteral("Main Chat");
            c.lastDate = QDateTime::currentMSecsSinceEpoch();
            chats.append(c);
            currentChatIndex = 0;
        }
        if (currentChatIndex < 0 || currentChatIndex >= chats.size()) {
            currentChatIndex = 0;
        }
        return chats[currentChatIndex];
    }

    const Chat& currentChat() const {
        if (chats.isEmpty()) {
            static const Chat emptyChat;
            return emptyChat;
        }
        int idx = (currentChatIndex >= 0 && currentChatIndex < chats.size()) ? currentChatIndex : 0;
        return chats[idx];
    }

    QJsonObject toJson() const {
        QJsonObject obj = rawData;
        obj[QStringLiteral("chaId")] = id;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("image")] = avatarPath;
        obj[QStringLiteral("firstMessage")] = firstMessage;
        obj[QStringLiteral("desc")] = description;
        obj[QStringLiteral("personality")] = personality;
        obj[QStringLiteral("scenario")] = scenario;
        obj[QStringLiteral("exampleMessage")] = exampleMessage;
        obj[QStringLiteral("notes")] = creatorNotes;
        obj[QStringLiteral("creatorNotes")] = creatorNotes;
        obj[QStringLiteral("systemPrompt")] = systemPrompt;
        obj[QStringLiteral("postHistoryInstructions")] = postHistoryInstructions;
        obj[QStringLiteral("creator")] = creator;
        obj[QStringLiteral("characterVersion")] = characterVersion;
        obj[QStringLiteral("authorNote")] = authorNote;
        obj[QStringLiteral("authorNoteDepth")] = authorNoteDepth;
        obj[QStringLiteral("chatPage")] = currentChatIndex;
        obj[QStringLiteral("firstMsgIndex")] = firstMsgIndex;
        obj[QStringLiteral("lastInteraction")] = lastInteraction;
        obj[QStringLiteral("type")] = type.isEmpty() ? QJsonValue::Null : QJsonValue(type);
        obj[QStringLiteral("utilityBot")] = utilityBot;
        obj[QStringLiteral("supaMemory")] = supaMemory;
        obj[QStringLiteral("largePortrait")] = largePortrait;
        obj[QStringLiteral("backgroundHTML")] = backgroundHTML;
        obj[QStringLiteral("backgroundCSS")] = backgroundCSS;
        obj[QStringLiteral("replaceGlobalNote")] = replaceGlobalNote;
        obj[QStringLiteral("additionalText")] = additionalText;

        // alternateGreetings
        QJsonArray altArr;
        for (const auto& alt : alternateGreetings) altArr.append(alt);
        obj[QStringLiteral("alternateGreetings")] = altArr;

        // tags
        QJsonArray tagArr;
        for (const auto& tag : tags) tagArr.append(tag);
        obj[QStringLiteral("tags")] = tagArr;

        // emotionImages [[name, path], ...]
        QJsonArray emoArr;
        for (const auto& pair : emotionImages) {
            QJsonArray p;
            p.append(pair.first);
            p.append(pair.second);
            emoArr.append(p);
        }
        obj[QStringLiteral("emotionImages")] = emoArr;

        // emotionSprites map
        QJsonObject spriteObj;
        for (auto it = emotionSprites.constBegin(); it != emotionSprites.constEnd(); ++it) {
            spriteObj[it.key()] = it.value();
        }
        obj[QStringLiteral("emotionSprites")] = spriteObj;

        // globalLore
        QJsonArray loreArr;
        for (const auto& lore : globalLore) loreArr.append(lore.toJson());
        obj[QStringLiteral("globalLore")] = loreArr;

        // customScripts
        QJsonArray scrArr;
        for (const auto& scr : customScripts) scrArr.append(scr.toJson());
        obj[QStringLiteral("customscript")] = scrArr;

        // chatFolders
        QJsonArray fldArr;
        for (const auto& fld : chatFolders) fldArr.append(fld.toJson());
        obj[QStringLiteral("chatFolders")] = fldArr;

        // chats
        QJsonArray chatArr;
        for (const auto& chat : chats) chatArr.append(chat.toJson());
        obj[QStringLiteral("chats")] = chatArr;

        // Group fields
        if (isGroup()) {
            QJsonArray charsArr;
            for (const auto& m : groupMembers) charsArr.append(m);
            obj[QStringLiteral("characters")] = charsArr;

            QJsonArray talkArr;
            for (int t : characterTalks) talkArr.append(t);
            obj[QStringLiteral("characterTalks")] = talkArr;

            QJsonArray actArr;
            for (bool a : characterActive) actArr.append(a);
            obj[QStringLiteral("characterActive")] = actArr;

            obj[QStringLiteral("autoMode")] = autoMode;
            obj[QStringLiteral("useCharacterLore")] = useCharacterLore;
            obj[QStringLiteral("oneAtTime")] = oneAtTime;
        }

        return obj;
    }

    static Character fromJson(const QJsonObject& obj) {
        Character c;
        c.rawData = obj;
        c.id = obj.value(QStringLiteral("chaId")).toString(obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces)));
        c.name = obj.value(QStringLiteral("name")).toString();
        c.avatarPath = obj.value(QStringLiteral("image")).toString(obj.value(QStringLiteral("avatarPath")).toString());
        c.firstMessage = obj.value(QStringLiteral("firstMessage")).toString(obj.value(QStringLiteral("first_mes")).toString());
        c.description = obj.value(QStringLiteral("desc")).toString(obj.value(QStringLiteral("description")).toString());
        c.personality = obj.value(QStringLiteral("personality")).toString();
        c.scenario = obj.value(QStringLiteral("scenario")).toString();
        c.exampleMessage = obj.value(QStringLiteral("exampleMessage")).toString(obj.value(QStringLiteral("mes_example")).toString());
        c.creatorNotes = obj.value(QStringLiteral("notes")).toString(obj.value(QStringLiteral("creatorNotes")).toString(obj.value(QStringLiteral("creator_notes")).toString()));
        c.systemPrompt = obj.value(QStringLiteral("systemPrompt")).toString(obj.value(QStringLiteral("system_prompt")).toString());
        c.postHistoryInstructions = obj.value(QStringLiteral("postHistoryInstructions")).toString(obj.value(QStringLiteral("post_history_instructions")).toString());
        c.creator = obj.value(QStringLiteral("creator")).toString();
        c.characterVersion = obj.value(QStringLiteral("characterVersion")).toString(obj.value(QStringLiteral("character_version")).toString());
        c.authorNote = obj.value(QStringLiteral("authorNote")).toString(obj.value(QStringLiteral("author_note")).toString());
        c.authorNoteDepth = obj.value(QStringLiteral("authorNoteDepth")).toInt(obj.value(QStringLiteral("author_note_depth")).toInt(3));
        c.currentChatIndex = obj.value(QStringLiteral("chatPage")).toInt(0);
        c.firstMsgIndex = obj.value(QStringLiteral("firstMsgIndex")).toInt(0);
        c.lastInteraction = obj.value(QStringLiteral("lastInteraction")).toVariant().toLongLong();
        c.type = obj.value(QStringLiteral("type")).toString();
        c.utilityBot = obj.value(QStringLiteral("utilityBot")).toBool(false);
        c.supaMemory = obj.value(QStringLiteral("supaMemory")).toBool(false);
        c.largePortrait = obj.value(QStringLiteral("largePortrait")).toBool(false);
        c.backgroundHTML = obj.value(QStringLiteral("backgroundHTML")).toString();
        c.backgroundCSS = obj.value(QStringLiteral("backgroundCSS")).toString();
        c.replaceGlobalNote = obj.value(QStringLiteral("replaceGlobalNote")).toString();
        c.additionalText = obj.value(QStringLiteral("additionalText")).toString();
        c.ttsMode = obj.value(QStringLiteral("ttsMode")).toString();

        if (obj.contains(QStringLiteral("depth_prompt")) && obj.value(QStringLiteral("depth_prompt")).isObject()) {
            QJsonObject dp = obj.value(QStringLiteral("depth_prompt")).toObject();
            c.depthPrompt = dp.value(QStringLiteral("prompt")).toString();
            c.depthPromptDepth = dp.value(QStringLiteral("depth")).toInt(4);
        }

        // alternateGreetings
        if (obj.contains(QStringLiteral("alternateGreetings")) && obj.value(QStringLiteral("alternateGreetings")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("alternateGreetings")).toArray()) c.alternateGreetings.append(item.toString());
        } else if (obj.contains(QStringLiteral("alternate_greetings")) && obj.value(QStringLiteral("alternate_greetings")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("alternate_greetings")).toArray()) c.alternateGreetings.append(item.toString());
        }

        // tags
        if (obj.contains(QStringLiteral("tags")) && obj.value(QStringLiteral("tags")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("tags")).toArray()) c.tags.append(item.toString());
        }

        // emotionImages [[name, path], ...]
        if (obj.contains(QStringLiteral("emotionImages")) && obj.value(QStringLiteral("emotionImages")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("emotionImages")).toArray()) {
                if (item.isArray()) {
                    QJsonArray p = item.toArray();
                    if (p.size() >= 2) {
                        QString name = p[0].toString();
                        QString path = p[1].toString();
                        c.emotionImages.append(qMakePair(name, path));
                        c.emotionSprites[name] = path;
                    }
                }
            }
        }

        // emotionSprites map
        if (obj.contains(QStringLiteral("emotionSprites")) && obj.value(QStringLiteral("emotionSprites")).isObject()) {
            QJsonObject spriteObj = obj.value(QStringLiteral("emotionSprites")).toObject();
            for (auto it = spriteObj.begin(); it != spriteObj.end(); ++it) {
                c.emotionSprites[it.key()] = it.value().toString();
                if (!c.emotionImages.contains(qMakePair(it.key(), it.value().toString()))) {
                    c.emotionImages.append(qMakePair(it.key(), it.value().toString()));
                }
            }
        }

        // globalLore
        if (obj.contains(QStringLiteral("globalLore")) && obj.value(QStringLiteral("globalLore")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("globalLore")).toArray()) {
                c.globalLore.append(LorebookEntry::fromJson(item.toObject()));
            }
        }

        // customscript
        if (obj.contains(QStringLiteral("customscript")) && obj.value(QStringLiteral("customscript")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("customscript")).toArray()) {
                c.customScripts.append(RegexScript::fromJson(item.toObject()));
            }
        }

        // chatFolders
        if (obj.contains(QStringLiteral("chatFolders")) && obj.value(QStringLiteral("chatFolders")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("chatFolders")).toArray()) {
                c.chatFolders.append(ChatFolder::fromJson(item.toObject()));
            }
        }

        // chats
        if (obj.contains(QStringLiteral("chats")) && obj.value(QStringLiteral("chats")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("chats")).toArray()) {
                c.chats.append(Chat::fromJson(item.toObject()));
            }
        }

        // Ensure at least one chat
        if (c.chats.isEmpty()) {
            Chat defChat;
            defChat.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            defChat.name = QStringLiteral("Main Chat");
            defChat.firstMessageIndex = 0;
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
            c.chats.append(defChat);
        }

        // Group fields
        if (c.isGroup()) {
            if (obj.contains(QStringLiteral("characters")) && obj.value(QStringLiteral("characters")).isArray()) {
                for (const auto& item : obj.value(QStringLiteral("characters")).toArray()) c.groupMembers.append(item.toString());
            }
            if (obj.contains(QStringLiteral("characterTalks")) && obj.value(QStringLiteral("characterTalks")).isArray()) {
                for (const auto& item : obj.value(QStringLiteral("characterTalks")).toArray()) c.characterTalks.append(item.toInt());
            }
            if (obj.contains(QStringLiteral("characterActive")) && obj.value(QStringLiteral("characterActive")).isArray()) {
                for (const auto& item : obj.value(QStringLiteral("characterActive")).toArray()) c.characterActive.append(item.toBool());
            }
            c.autoMode = obj.value(QStringLiteral("autoMode")).toBool(false);
            c.useCharacterLore = obj.value(QStringLiteral("useCharacterLore")).toBool(false);
            c.oneAtTime = obj.value(QStringLiteral("oneAtTime")).toBool(false);
        }

        return c;
    }
};

// User Persona Definition (100% compliant with RisuAI personas)
struct Persona {
    QString id;
    QString name = QStringLiteral("User");
    QString avatarPath;       // icon in Risu
    QString description;      // note in Risu
    QString personaPrompt;
    bool largePortrait = false;
    bool isActive = false;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("icon")] = avatarPath;
        obj[QStringLiteral("avatarPath")] = avatarPath;
        obj[QStringLiteral("note")] = description;
        obj[QStringLiteral("description")] = description;
        obj[QStringLiteral("personaPrompt")] = personaPrompt;
        obj[QStringLiteral("largePortrait")] = largePortrait;
        obj[QStringLiteral("isActive")] = isActive;
        return obj;
    }

    static Persona fromJson(const QJsonObject& obj) {
        Persona p;
        p.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        p.name = obj.value(QStringLiteral("name")).toString(QStringLiteral("User"));
        p.avatarPath = obj.value(QStringLiteral("icon")).toString(obj.value(QStringLiteral("avatarPath")).toString());
        p.description = obj.value(QStringLiteral("note")).toString(obj.value(QStringLiteral("description")).toString());
        p.personaPrompt = obj.value(QStringLiteral("personaPrompt")).toString();
        p.largePortrait = obj.value(QStringLiteral("largePortrait")).toBool(false);
        p.isActive = obj.value(QStringLiteral("isActive")).toBool(false);
        return p;
    }
};

// AI Provider enum
enum class ProviderType {
    OpenAI,
    AnthropicClaude,
    GoogleGemini,
    OpenRouter,
    Ollama,
    CustomOpenAICompatible
};

inline QString providerTypeToString(ProviderType type) {
    switch (type) {
        case ProviderType::OpenAI: return QStringLiteral("openai");
        case ProviderType::AnthropicClaude: return QStringLiteral("claude");
        case ProviderType::GoogleGemini: return QStringLiteral("gemini");
        case ProviderType::OpenRouter: return QStringLiteral("openrouter");
        case ProviderType::Ollama: return QStringLiteral("ollama");
        case ProviderType::CustomOpenAICompatible: return QStringLiteral("custom");
    }
    return QStringLiteral("openai");
}

inline ProviderType stringToProviderType(const QString& str) {
    QString lower = str.toLower();
    if (lower.contains(QStringLiteral("claude")) || lower.contains(QStringLiteral("anthropic"))) {
        return ProviderType::AnthropicClaude;
    }
    if (lower.contains(QStringLiteral("gemini")) || lower.contains(QStringLiteral("google"))) {
        return ProviderType::GoogleGemini;
    }
    if (lower.contains(QStringLiteral("openrouter"))) {
        return ProviderType::OpenRouter;
    }
    if (lower.contains(QStringLiteral("ollama"))) {
        return ProviderType::Ollama;
    }
    if (lower.contains(QStringLiteral("custom")) || lower.contains(QStringLiteral("proxy")) || 
        lower.contains(QStringLiteral("ooba")) || lower.contains(QStringLiteral("vllm")) || 
        lower.contains(QStringLiteral("kobold"))) {
        return ProviderType::CustomOpenAICompatible;
    }
    return ProviderType::OpenAI;
}

// Bot Preset & Generation Parameters (100% compliant with RisuAI botPreset)
struct Preset {
    QString id;
    QString name = QStringLiteral("Default Preset");
    ProviderType provider = ProviderType::OpenAI;
    QString apiType = QStringLiteral("openai");
    QString modelName = QStringLiteral("gpt-4o-mini");
    QString subModel;
    QString apiKey;
    QString customEndpointUrl;
    
    // Core parameters
    double temperature = 0.8;      // 0.0 - 2.0 (scaled if in 0-200)
    int maxTokens = 1000;          // maxResponse
    int contextLimit = 16000;      // maxContext
    double topP = 1.0;             // top_p
    int topK = 0;                  // top_k
    double frequencyPenalty = 0.0;
    double presencePenalty = 0.0;  // PresensePenalty
    double repetitionPenalty = 1.0;// repetition_penalty
    double minP = 0.0;             // min_p
    double topA = 0.0;             // top_a
    int reasoningEffort = 0;       // reasonEffort (0=off/low, 1=medium, 2=high)
    int thinkingTokens = 0;
    QString thinkingType = QStringLiteral("budget");
    bool enableStreaming = true;
    QStringList stopSequences;

    // Prompts
    QString mainPrompt;
    QString jailbreakPrompt;       // jailbreak
    QString globalNote;
    QString postHistoryInstructions;
    bool enableJailbreak = false;  // jailbreakToggle

    // Order of prompt injection
    QStringList formattingOrder;   // formatingOrder
    QString proxyKey;
    QString customAPIFormat;
    QJsonArray promptTemplate;
    QJsonObject rawData;

    QJsonObject toJson() const {
        QJsonObject obj = rawData;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("provider")] = providerTypeToString(provider);
        obj[QStringLiteral("apiType")] = apiType;
        obj[QStringLiteral("aiModel")] = modelName;
        obj[QStringLiteral("modelName")] = modelName;
        obj[QStringLiteral("subModel")] = subModel;
        obj[QStringLiteral("openAIKey")] = apiKey;
        obj[QStringLiteral("apiKey")] = apiKey;
        obj[QStringLiteral("forceReplaceUrl")] = customEndpointUrl;
        obj[QStringLiteral("customEndpointUrl")] = customEndpointUrl;
        obj[QStringLiteral("temperature")] = temperature * 100.0;
        obj[QStringLiteral("maxResponse")] = maxTokens;
        obj[QStringLiteral("maxTokens")] = maxTokens;
        obj[QStringLiteral("maxContext")] = contextLimit;
        obj[QStringLiteral("contextLimit")] = contextLimit;
        obj[QStringLiteral("top_p")] = topP;
        obj[QStringLiteral("topP")] = topP;
        obj[QStringLiteral("top_k")] = topK;
        obj[QStringLiteral("topK")] = topK;
        obj[QStringLiteral("frequencyPenalty")] = frequencyPenalty * 100.0;
        obj[QStringLiteral("PresensePenalty")] = presencePenalty * 100.0;
        obj[QStringLiteral("presencePenalty")] = presencePenalty;
        obj[QStringLiteral("repetition_penalty")] = repetitionPenalty;
        obj[QStringLiteral("repetitionPenalty")] = repetitionPenalty;
        obj[QStringLiteral("min_p")] = minP;
        obj[QStringLiteral("top_a")] = topA;
        obj[QStringLiteral("reasonEffort")] = reasoningEffort;
        obj[QStringLiteral("reasoningEffort")] = reasoningEffort;
        obj[QStringLiteral("thinkingTokens")] = thinkingTokens;
        obj[QStringLiteral("thinkingType")] = thinkingType;
        obj[QStringLiteral("enableStreaming")] = enableStreaming;

        QJsonArray stopArr;
        for (const auto& s : stopSequences) stopArr.append(s);
        obj[QStringLiteral("stopSequences")] = stopArr;
        obj[QStringLiteral("localStopStrings")] = stopArr;

        obj[QStringLiteral("mainPrompt")] = mainPrompt;
        obj[QStringLiteral("jailbreak")] = jailbreakPrompt;
        obj[QStringLiteral("jailbreakPrompt")] = jailbreakPrompt;
        obj[QStringLiteral("globalNote")] = globalNote;
        obj[QStringLiteral("postHistoryInstructions")] = postHistoryInstructions;
        obj[QStringLiteral("jailbreakToggle")] = enableJailbreak;
        obj[QStringLiteral("enableJailbreak")] = enableJailbreak;

        QJsonArray orderArr;
        for (const auto& item : formattingOrder) orderArr.append(item);
        obj[QStringLiteral("formatingOrder")] = orderArr;
        obj[QStringLiteral("formattingOrder")] = orderArr;

        obj[QStringLiteral("proxyKey")] = proxyKey;
        obj[QStringLiteral("promptTemplate")] = promptTemplate;

        return obj;
    }

    static Preset fromJson(const QJsonObject& obj) {
        Preset p;
        p.rawData = obj;
        p.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        p.name = obj.value(QStringLiteral("name")).toString(QStringLiteral("Default Preset"));
        p.apiType = obj.value(QStringLiteral("apiType")).toString(obj.value(QStringLiteral("provider")).toString(QStringLiteral("openai")));
        p.provider = stringToProviderType(p.apiType);
        p.modelName = obj.value(QStringLiteral("aiModel")).toString(obj.value(QStringLiteral("modelName")).toString(QStringLiteral("gpt-4o-mini")));
        p.subModel = obj.value(QStringLiteral("subModel")).toString();
        p.apiKey = obj.value(QStringLiteral("openAIKey")).toString(obj.value(QStringLiteral("apiKey")).toString());
        p.customEndpointUrl = obj.value(QStringLiteral("forceReplaceUrl")).toString(obj.value(QStringLiteral("customEndpointUrl")).toString());
        
        if (obj.contains(QStringLiteral("temperature"))) {
            double temp = obj.value(QStringLiteral("temperature")).toDouble();
            p.temperature = temp > 10.0 ? (temp / 100.0) : temp;
        }
        p.maxTokens = obj.value(QStringLiteral("maxResponse")).toInt(obj.value(QStringLiteral("maxTokens")).toInt(1000));
        p.contextLimit = obj.value(QStringLiteral("maxContext")).toInt(obj.value(QStringLiteral("contextLimit")).toInt(16000));
        p.topP = obj.value(QStringLiteral("top_p")).toDouble(obj.value(QStringLiteral("topP")).toDouble(1.0));
        p.topK = obj.value(QStringLiteral("top_k")).toInt(obj.value(QStringLiteral("topK")).toInt(0));
        
        if (obj.contains(QStringLiteral("frequencyPenalty"))) {
            double fp = obj.value(QStringLiteral("frequencyPenalty")).toDouble();
            p.frequencyPenalty = fp > 10.0 ? (fp / 100.0) : fp;
        }
        if (obj.contains(QStringLiteral("PresensePenalty")) || obj.contains(QStringLiteral("presencePenalty"))) {
            double pp = obj.value(QStringLiteral("PresensePenalty")).toDouble(obj.value(QStringLiteral("presencePenalty")).toDouble());
            p.presencePenalty = pp > 10.0 ? (pp / 100.0) : pp;
        }
        p.repetitionPenalty = obj.value(QStringLiteral("repetition_penalty")).toDouble(obj.value(QStringLiteral("repetitionPenalty")).toDouble(1.0));
        p.minP = obj.value(QStringLiteral("min_p")).toDouble(0.0);
        p.topA = obj.value(QStringLiteral("top_a")).toDouble(0.0);
        p.reasoningEffort = obj.value(QStringLiteral("reasonEffort")).toInt(obj.value(QStringLiteral("reasoningEffort")).toInt(0));
        p.thinkingTokens = obj.value(QStringLiteral("thinkingTokens")).toInt(0);
        p.thinkingType = obj.value(QStringLiteral("thinkingType")).toString(QStringLiteral("budget"));
        p.enableStreaming = obj.value(QStringLiteral("enableStreaming")).toBool(true);

        if (obj.contains(QStringLiteral("localStopStrings")) && obj.value(QStringLiteral("localStopStrings")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("localStopStrings")).toArray()) p.stopSequences.append(item.toString());
        } else if (obj.contains(QStringLiteral("stopSequences")) && obj.value(QStringLiteral("stopSequences")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("stopSequences")).toArray()) p.stopSequences.append(item.toString());
        }

        p.mainPrompt = obj.value(QStringLiteral("mainPrompt")).toString();
        p.jailbreakPrompt = obj.value(QStringLiteral("jailbreak")).toString(obj.value(QStringLiteral("jailbreakPrompt")).toString());
        p.globalNote = obj.value(QStringLiteral("globalNote")).toString();
        p.postHistoryInstructions = obj.value(QStringLiteral("postHistoryInstructions")).toString();
        p.enableJailbreak = obj.value(QStringLiteral("jailbreakToggle")).toBool(obj.value(QStringLiteral("enableJailbreak")).toBool(false));
        p.proxyKey = obj.value(QStringLiteral("proxyKey")).toString();

        if (obj.contains(QStringLiteral("formatingOrder")) && obj.value(QStringLiteral("formatingOrder")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("formatingOrder")).toArray()) p.formattingOrder.append(item.toString());
        } else if (obj.contains(QStringLiteral("formattingOrder")) && obj.value(QStringLiteral("formattingOrder")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("formattingOrder")).toArray()) p.formattingOrder.append(item.toString());
        } else {
            p.formattingOrder = QStringList{
                QStringLiteral("main"),
                QStringLiteral("description"),
                QStringLiteral("personaPrompt"),
                QStringLiteral("lorebook"),
                QStringLiteral("chats"),
                QStringLiteral("lastChat"),
                QStringLiteral("jailbreak"),
                QStringLiteral("globalNote"),
                QStringLiteral("authorNote")
            };
        }

        if (obj.contains(QStringLiteral("promptTemplate")) && obj.value(QStringLiteral("promptTemplate")).isArray()) {
            p.promptTemplate = obj.value(QStringLiteral("promptTemplate")).toArray();
        }

        return p;
    }
};

// Group chat definition compatibility wrapper
struct GroupMember {
    QString characterId;
    QString name;
    QString avatarPath;
    bool enabled = true;
    int order = 0;
    double talkWeight = 1.0;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("characterId")] = characterId;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("avatarPath")] = avatarPath;
        obj[QStringLiteral("enabled")] = enabled;
        obj[QStringLiteral("order")] = order;
        obj[QStringLiteral("talkWeight")] = talkWeight;
        return obj;
    }

    static GroupMember fromJson(const QJsonObject& obj) {
        GroupMember m;
        m.characterId = obj.value(QStringLiteral("characterId")).toString();
        m.name = obj.value(QStringLiteral("name")).toString();
        m.avatarPath = obj.value(QStringLiteral("avatarPath")).toString();
        m.enabled = obj.value(QStringLiteral("enabled")).toBool(true);
        m.order = obj.value(QStringLiteral("order")).toInt(0);
        m.talkWeight = obj.value(QStringLiteral("talkWeight")).toDouble(1.0);
        return m;
    }
};

enum class SpeakerSelectionMode {
    RoundRobin,
    Random,
    Manual,
    LLMDecide
};

inline QString speakerModeToString(SpeakerSelectionMode mode) {
    switch (mode) {
        case SpeakerSelectionMode::RoundRobin: return QStringLiteral("round_robin");
        case SpeakerSelectionMode::Random: return QStringLiteral("random");
        case SpeakerSelectionMode::Manual: return QStringLiteral("manual");
        case SpeakerSelectionMode::LLMDecide: return QStringLiteral("llm");
    }
    return QStringLiteral("round_robin");
}

inline QString speakerSelectionModeToString(SpeakerSelectionMode mode) {
    return speakerModeToString(mode);
}

inline SpeakerSelectionMode stringToSpeakerMode(const QString& str) {
    QString lower = str.toLower();
    if (lower.contains(QStringLiteral("random"))) return SpeakerSelectionMode::Random;
    if (lower.contains(QStringLiteral("manual"))) return SpeakerSelectionMode::Manual;
    if (lower.contains(QStringLiteral("llm"))) return SpeakerSelectionMode::LLMDecide;
    return SpeakerSelectionMode::RoundRobin;
}

inline SpeakerSelectionMode stringToSpeakerSelectionMode(const QString& str) {
    return stringToSpeakerMode(str);
}

struct GroupChatRoom {
    QString id;
    QString name = QStringLiteral("Group Chat");
    QString description;
    QString avatarPath;
    SpeakerSelectionMode speakerMode = SpeakerSelectionMode::RoundRobin;
    int currentSpeakerIndex = 0;
    QList<GroupMember> members;
    QList<Chat> chats;
    int currentChatIndex = 0;
    qint64 lastInteraction = 0;

    Chat& currentChat() {
        if (chats.isEmpty()) {
            Chat c;
            c.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            c.name = QStringLiteral("Main Chat");
            c.lastDate = QDateTime::currentMSecsSinceEpoch();
            chats.append(c);
            currentChatIndex = 0;
        }
        if (currentChatIndex < 0 || currentChatIndex >= chats.size()) {
            currentChatIndex = 0;
        }
        return chats[currentChatIndex];
    }

    const Chat& currentChat() const {
        if (chats.isEmpty()) {
            static const Chat emptyChat;
            return emptyChat;
        }
        int idx = (currentChatIndex >= 0 && currentChatIndex < chats.size()) ? currentChatIndex : 0;
        return chats[idx];
    }

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("id")] = id;
        obj[QStringLiteral("name")] = name;
        obj[QStringLiteral("description")] = description;
        obj[QStringLiteral("avatarPath")] = avatarPath;
        obj[QStringLiteral("speakerMode")] = static_cast<int>(speakerMode);
        obj[QStringLiteral("currentSpeakerIndex")] = currentSpeakerIndex;
        obj[QStringLiteral("currentChatIndex")] = currentChatIndex;
        obj[QStringLiteral("lastInteraction")] = lastInteraction;

        QJsonArray memArr;
        for (const auto& m : members) memArr.append(m.toJson());
        obj[QStringLiteral("members")] = memArr;

        QJsonArray chatArr;
        for (const auto& c : chats) chatArr.append(c.toJson());
        obj[QStringLiteral("chats")] = chatArr;
        return obj;
    }

    static GroupChatRoom fromJson(const QJsonObject& obj) {
        GroupChatRoom r;
        r.id = obj.value(QStringLiteral("id")).toString(QUuid::createUuid().toString(QUuid::WithoutBraces));
        r.name = obj.value(QStringLiteral("name")).toString(QStringLiteral("Group Chat"));
        r.description = obj.value(QStringLiteral("description")).toString();
        r.avatarPath = obj.value(QStringLiteral("avatarPath")).toString();
        r.speakerMode = static_cast<SpeakerSelectionMode>(obj.value(QStringLiteral("speakerMode")).toInt(0));
        r.currentSpeakerIndex = obj.value(QStringLiteral("currentSpeakerIndex")).toInt(0);
        r.currentChatIndex = obj.value(QStringLiteral("currentChatIndex")).toInt(0);
        r.lastInteraction = obj.value(QStringLiteral("lastInteraction")).toVariant().toLongLong();

        if (obj.contains(QStringLiteral("members")) && obj.value(QStringLiteral("members")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("members")).toArray()) {
                r.members.append(GroupMember::fromJson(item.toObject()));
            }
        }
        if (obj.contains(QStringLiteral("chats")) && obj.value(QStringLiteral("chats")).isArray()) {
            for (const auto& item : obj.value(QStringLiteral("chats")).toArray()) {
                r.chats.append(Chat::fromJson(item.toObject()));
            }
        }
        return r;
    }
};

} // namespace Risu
