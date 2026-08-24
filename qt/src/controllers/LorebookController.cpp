#include "LorebookController.hpp"
#include "../core/DatabaseManager.hpp"
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QDebug>

namespace Risu {

LorebookController::LorebookController(QObject* parent) : QObject(parent) {
    connect(&DatabaseManager::instance(), &DatabaseManager::lorebooksChanged, this, &LorebookController::refreshLorebooks);
    refreshLorebooks();
}

void LorebookController::refreshLorebooks() {
    auto entries = DatabaseManager::instance().getAllGlobalLorebooks();
    m_loreModel.setEntries(entries);
}

QString LorebookController::createNewEntry() {
    LorebookEntry e;
    e.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    e.comment = QStringLiteral("New Lorebook Entry");
    e.key = QStringLiteral("keyword1, keyword2");
    e.content = QStringLiteral("Description of the lore or world concept...");
    e.insertOrder = 100;
    e.enabled = true;

    DatabaseManager::instance().saveGlobalLorebook(e);
    emit toastRequested(QStringLiteral("success"), QStringLiteral("Created lorebook entry."));
    return e.id;
}

bool LorebookController::saveEntry(const QVariantMap& data) {
    QString id = data.value(QStringLiteral("id")).toString();
    if (id.isEmpty()) return false;

    LorebookEntry e;
    e.id = id;
    e.key = data.value(QStringLiteral("key")).toString();
    e.secondKey = data.value(QStringLiteral("secondKey")).toString();
    e.comment = data.value(QStringLiteral("comment")).toString();
    e.content = data.value(QStringLiteral("content")).toString();
    e.mode = data.value(QStringLiteral("mode"), QStringLiteral("normal")).toString();
    e.insertOrder = data.value(QStringLiteral("insertOrder"), 100).toInt();
    e.alwaysActive = data.value(QStringLiteral("alwaysActive"), false).toBool();
    e.selective = data.value(QStringLiteral("selective"), false).toBool();
    e.useRegex = data.value(QStringLiteral("useRegex"), false).toBool();
    e.caseSensitive = data.value(QStringLiteral("caseSensitive"), false).toBool();
    e.scanDepth = data.value(QStringLiteral("scanDepth"), 5).toInt();
    e.enabled = data.value(QStringLiteral("enabled"), true).toBool();

    bool ok = DatabaseManager::instance().saveGlobalLorebook(e);
    if (ok) {
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Lorebook entry saved."));
    }
    return ok;
}

bool LorebookController::deleteEntry(const QString& entryId) {
    bool ok = DatabaseManager::instance().deleteGlobalLorebook(entryId);
    if (ok) {
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Lorebook entry deleted."));
    }
    return ok;
}

bool LorebookController::importLorebookFromJson(const QString& filePath) {
    QFile f(filePath);
    if (!f.open(QIODevice::ReadOnly)) {
        emit toastRequested(QStringLiteral("error"), QStringLiteral("Failed to open file."));
        return false;
    }
    QByteArray data = f.readAll();
    f.close();

    QJsonDocument doc = QJsonDocument::fromJson(data);
    if (doc.isNull()) {
        emit toastRequested(QStringLiteral("error"), QStringLiteral("Invalid JSON format."));
        return false;
    }

    if (doc.isArray()) {
        for (const auto& item : doc.array()) {
            LorebookEntry e = LorebookEntry::fromJson(item.toObject());
            DatabaseManager::instance().saveGlobalLorebook(e);
        }
    } else if (doc.isObject()) {
        QJsonObject root = doc.object();
        if (root.contains(QStringLiteral("entries")) && root.value(QStringLiteral("entries")).isArray()) {
            for (const auto& item : root.value(QStringLiteral("entries")).toArray()) {
                LorebookEntry e = LorebookEntry::fromJson(item.toObject());
                DatabaseManager::instance().saveGlobalLorebook(e);
            }
        }
    }

    emit toastRequested(QStringLiteral("success"), QStringLiteral("Lorebook imported successfully."));
    return true;
}

bool LorebookController::exportLorebookToJson(const QString& targetFilePath) {
    auto entries = DatabaseManager::instance().getAllGlobalLorebooks();
    QJsonArray arr;
    for (const auto& e : entries) arr.append(e.toJson());

    QJsonObject root;
    root[QStringLiteral("entries")] = arr;

    QFile f(targetFilePath);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
        f.close();
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Lorebook exported to JSON."));
        return true;
    }
    return false;
}

} // namespace Risu
