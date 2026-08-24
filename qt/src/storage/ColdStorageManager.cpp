#include "ColdStorageManager.hpp"
#include "../core/AppConfig.hpp"
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QUuid>
#include <QDebug>

namespace Risu {

ColdStorageManager& ColdStorageManager::instance() {
    static ColdStorageManager inst;
    return inst;
}

ColdStorageManager::ColdStorageManager() {
    QDir().mkpath(coldStorageDir());
}

QString ColdStorageManager::coldStorageDir() const {
    return AppConfig::instance().appDataDir() + QStringLiteral("/coldstorage");
}

bool ColdStorageManager::isChatArchived(const Chat& chat) const {
    if (chat.messages.isEmpty()) return false;
    return chat.messages.first().currentContent().startsWith(COLD_STORAGE_HEADER);
}

bool ColdStorageManager::archiveChat(Chat& chat) {
    if (chat.messages.isEmpty() || isChatArchived(chat)) return false;

    QString key = QUuid::createUuid().toString(QUuid::WithoutBraces);
    if (!saveToColdStorage(key, chat.messages)) {
        qWarning() << "[ColdStorage] Failed to save chat messages to cold storage:" << key;
        return false;
    }

    // Replace with cold storage placeholder
    Message placeholder;
    placeholder.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    placeholder.role = Role::System;
    placeholder.setCurrentContent(COLD_STORAGE_HEADER + key);
    placeholder.timestamp = QDateTime::currentMSecsSinceEpoch();

    chat.messages.clear();
    chat.messages.append(placeholder);

    qInfo() << "[ColdStorage] Chat successfully archived into key:" << key;
    return true;
}

bool ColdStorageManager::restoreChat(Chat& chat) {
    if (!isChatArchived(chat)) return true;

    QString headerAndKey = chat.messages.first().currentContent();
    QString key = headerAndKey.mid(COLD_STORAGE_HEADER.length()).trimmed();

    auto loaded = loadFromColdStorage(key);
    if (!loaded.has_value()) {
        qWarning() << "[ColdStorage] Failed to restore chat from key:" << key;
        return false;
    }

    chat.messages = loaded.value();
    qInfo() << "[ColdStorage] Chat restored successfully from key:" << key << "Count:" << chat.messages.size();
    return true;
}

bool ColdStorageManager::saveToColdStorage(const QString& key, const QList<Message>& messages) {
    QJsonArray arr;
    for (const auto& m : messages) {
        arr.append(m.toJson());
    }

    QByteArray jsonBytes = QJsonDocument(arr).toJson(QJsonDocument::Compact);
    QByteArray compressed = qCompress(jsonBytes);

    QString filePath = coldStorageDir() + QStringLiteral("/") + key + QStringLiteral(".json");
    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }

    file.write(compressed);
    file.close();
    return true;
}

std::optional<QList<Message>> ColdStorageManager::loadFromColdStorage(const QString& key) {
    QString filePath = coldStorageDir() + QStringLiteral("/") + key + QStringLiteral(".json");
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) {
        return std::nullopt;
    }

    QByteArray compressed = file.readAll();
    file.close();

    QByteArray jsonBytes = qUncompress(compressed);
    QJsonDocument doc = QJsonDocument::fromJson(jsonBytes);
    if (!doc.isArray()) {
        return std::nullopt;
    }

    QList<Message> result;
    QJsonArray arr = doc.array();
    for (const auto& val : arr) {
        if (val.isObject()) {
            result.append(Message::fromJson(val.toObject()));
        }
    }

    return result;
}

bool ColdStorageManager::removeColdStorage(const QString& key) {
    QString filePath = coldStorageDir() + QStringLiteral("/") + key + QStringLiteral(".json");
    return QFile::remove(filePath);
}

} // namespace Risu
