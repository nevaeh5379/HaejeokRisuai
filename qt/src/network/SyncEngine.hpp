#pragma once

#include <QObject>
#include <QString>
#include <QJsonObject>
#include <QJsonDocument>
#include <QUuid>
#include "../core/Types.hpp"

namespace Risu {

struct SyncPacket {
    QString packetId;
    QString type;       // "character", "message", "preset", "lorebook"
    QString action;     // "upsert", "delete"
    QString entityId;
    QJsonObject payload;
    qint64 timestamp = 0;
    QString deviceId;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("packetId")] = packetId.isEmpty() ? QUuid::createUuid().toString(QUuid::WithoutBraces) : packetId;
        obj[QStringLiteral("type")] = type;
        obj[QStringLiteral("action")] = action;
        obj[QStringLiteral("entityId")] = entityId;
        obj[QStringLiteral("payload")] = payload;
        obj[QStringLiteral("timestamp")] = timestamp;
        obj[QStringLiteral("deviceId")] = deviceId;
        return obj;
    }

    static SyncPacket fromJson(const QJsonObject& obj) {
        SyncPacket p;
        p.packetId = obj.value(QStringLiteral("packetId")).toString();
        p.type = obj.value(QStringLiteral("type")).toString();
        p.action = obj.value(QStringLiteral("action")).toString();
        p.entityId = obj.value(QStringLiteral("entityId")).toString();
        p.payload = obj.value(QStringLiteral("payload")).toObject();
        p.timestamp = obj.value(QStringLiteral("timestamp")).toVariant().toLongLong();
        p.deviceId = obj.value(QStringLiteral("deviceId")).toString();
        return p;
    }
};

class SyncEngine : public QObject {
    Q_OBJECT

public:
    static SyncEngine& instance();

    QString localDeviceId() const { return m_localDeviceId; }

    // Generate outbound sync packet
    SyncPacket createOutboundPacket(
        const QString& type,
        const QString& action,
        const QString& entityId,
        const QJsonObject& payload
    );

    // Process and apply inbound sync packet to local SQLite database
    bool applyInboundPacket(const SyncPacket& packet);

signals:
    void syncApplied(const QString& type, const QString& entityId, const QString& action);

private:
    explicit SyncEngine(QObject* parent = nullptr);

    QString m_localDeviceId;
};

} // namespace Risu
