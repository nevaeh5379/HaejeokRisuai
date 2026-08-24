#include "ExportImport.hpp"
#include "../core/DatabaseManager.hpp"
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QDebug>

#include "BackupLoader.hpp"

namespace Risu {

bool ExportImport::exportFullBackup(const QString& targetFilePath) {
    QJsonObject root = DatabaseManager::instance().exportFullDatabase();
    QJsonDocument doc(root);
    QFile f(targetFilePath);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(doc.toJson(QJsonDocument::Indented));
        f.close();
        return true;
    }
    return false;
}

bool ExportImport::importFullBackup(const QString& sourceFilePath) {
    BackupLoader loader;
    auto res = loader.importBackupFile(sourceFilePath);
    return res.success;
}

bool ExportImport::exportChatToMarkdown(const Character& character, const Chat& chat, const QString& targetFilePath) {
    QFile f(targetFilePath);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        return false;
    }

    QString md;
    md += QStringLiteral("# Chat with %1\n\n").arg(character.name);
    md += QStringLiteral("> Chat Session: %1\n").arg(chat.name);
    md += QStringLiteral("> Exported: %1\n\n---\n\n").arg(QDateTime::currentDateTime().toString(Qt::ISODate));

    for (const auto& msg : chat.messages) {
        if (msg.disabled) continue;
        QString sender = msg.name.isEmpty() ? (msg.role == Role::User ? QStringLiteral("User") : character.name) : msg.name;
        QString timeStr = QDateTime::fromMSecsSinceEpoch(msg.timestamp > 0 ? msg.timestamp : QDateTime::currentMSecsSinceEpoch()).toString(QStringLiteral("yyyy-MM-dd hh:mm"));
        
        md += QStringLiteral("### %1 *(%2)*\n\n").arg(sender, timeStr);
        if (!msg.currentThought().isEmpty()) {
            md += QStringLiteral("> **[Reasoning / Thought]**\n> %1\n\n").arg(msg.currentThought());
        }
        md += msg.currentContent() + QStringLiteral("\n\n---\n\n");
    }

    f.write(md.toUtf8());
    f.close();
    return true;
}

bool ExportImport::exportChatToHtml(const Character& character, const Chat& chat, const QString& targetFilePath) {
    QFile f(targetFilePath);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        return false;
    }

    QString html;
    html += QStringLiteral("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n");
    html += QStringLiteral("<title>Chat with %1</title>\n").arg(character.name.toHtmlEscaped());
    html += QStringLiteral(R"(<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1e1f29; color: #f8f8f2; margin: 0; padding: 20px; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; }
    .header { text-align: center; border-bottom: 1px solid #44475a; padding-bottom: 20px; margin-bottom: 30px; }
    .msg { margin-bottom: 24px; padding: 16px 20px; border-radius: 12px; }
    .msg-user { background: #383a59; border-left: 4px solid #bd93f9; }
    .msg-char { background: #282a36; border-left: 4px solid #50fa7b; }
    .sender { font-weight: bold; margin-bottom: 8px; color: #ff79c6; }
    .time { font-size: 0.8em; color: #6272a4; margin-left: 8px; }
    .thought { background: rgba(0,0,0,0.2); padding: 10px 14px; border-radius: 8px; font-style: italic; color: #8be9fd; margin-bottom: 10px; }
    .content { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<div class="container">
)");

    html += QStringLiteral("<div class=\"header\"><h1>Chat with %1</h1><p>%2</p></div>\n")
            .arg(character.name.toHtmlEscaped(), chat.name.toHtmlEscaped());

    for (const auto& msg : chat.messages) {
        if (msg.disabled) continue;
        bool isUser = (msg.role == Role::User);
        QString sender = msg.name.isEmpty() ? (isUser ? QStringLiteral("User") : character.name) : msg.name;
        QString timeStr = QDateTime::fromMSecsSinceEpoch(msg.timestamp > 0 ? msg.timestamp : QDateTime::currentMSecsSinceEpoch()).toString(QStringLiteral("yyyy-MM-dd hh:mm"));
        
        html += QStringLiteral("<div class=\"msg %1\">\n").arg(isUser ? QStringLiteral("msg-user") : QStringLiteral("msg-char"));
        html += QStringLiteral("  <div class=\"sender\">%1<span class=\"time\">%2</span></div>\n").arg(sender.toHtmlEscaped(), timeStr);
        if (!msg.currentThought().isEmpty()) {
            html += QStringLiteral("  <div class=\"thought\">💭 %1</div>\n").arg(msg.currentThought().toHtmlEscaped());
        }
        html += QStringLiteral("  <div class=\"content\">%1</div>\n").arg(msg.currentContent().toHtmlEscaped());
        html += QStringLiteral("</div>\n");
    }

    html += QStringLiteral("</div>\n</body>\n</html>\n");

    f.write(html.toUtf8());
    f.close();
    return true;
}

bool ExportImport::exportChatToText(const Character& character, const Chat& chat, const QString& targetFilePath) {
    QFile f(targetFilePath);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
        return false;
    }

    QString txt;
    txt += QStringLiteral("=== Chat with %1 (%2) ===\n\n").arg(character.name, chat.name);

    for (const auto& msg : chat.messages) {
        if (msg.disabled) continue;
        QString sender = msg.name.isEmpty() ? (msg.role == Role::User ? QStringLiteral("User") : character.name) : msg.name;
        txt += QStringLiteral("[%1]:\n%2\n\n").arg(sender, msg.currentContent());
    }

    f.write(txt.toUtf8());
    f.close();
    return true;
}

bool ExportImport::exportChatToJson(const Character& character, const Chat& chat, const QString& targetFilePath) {
    QFile f(targetFilePath);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        return false;
    }

    QJsonObject obj = chat.toJson();
    obj[QStringLiteral("characterName")] = character.name;
    obj[QStringLiteral("characterId")] = character.id;

    QJsonDocument doc(obj);
    f.write(doc.toJson(QJsonDocument::Indented));
    f.close();
    return true;
}

} // namespace Risu
