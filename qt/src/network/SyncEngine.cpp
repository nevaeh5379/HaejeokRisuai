#include "SyncEngine.hpp"
#include "../core/DatabaseManager.hpp"
#include <QDateTime>
#include <QHostInfo>
#include <QSysInfo>
#include <QDebug>

namespace Risu {

SyncEngine& SyncEngine::instance() {
    static SyncEngine inst;
    return inst;
}

SyncEngine::SyncEngine(QObject* parent) : QObject(parent) {
    m_localDeviceId = QStringLiteral("%1-%2").arg(
        QSysInfo::machineHostName(),
        QUuid::createUuid().toString(QUuid::WithoutBraces).left(8)
    );
}

SyncPacket SyncEngine::createOutboundPacket(
    const QString& type,
    const QString& action,
    const QString& entityId,
    const QJsonObject& payload
) {
    SyncPacket pkt;
    pkt.packetId = QUuid::createUuid().toString(QUuid::WithoutBraces);
    pkt.type = type;
    pkt.action = action;
    pkt.entityId = entityId;
    pkt.payload = payload;
    pkt.timestamp = QDateTime::currentMSecsSinceEpoch();
    pkt.deviceId = m_localDeviceId;
    return pkt;
}

bool SyncEngine::applyInboundPacket(const SyncPacket& packet) {
    // Prevent echo loops from own device
    if (packet.deviceId == m_localDeviceId && !packet.deviceId.isEmpty()) {
        return false;
    }

    bool success = false;
    DatabaseManager& db = DatabaseManager::instance();

    if (packet.type == QStringLiteral("character")) {
        if (packet.action == QStringLiteral("upsert")) {
            Character c = Character::fromJson(packet.payload);
            success = db.saveCharacter(c);
        } else if (packet.action == QStringLiteral("delete")) {
            success = db.deleteCharacter(packet.entityId);
        }
    } else if (packet.type == QStringLiteral("preset")) {
        if (packet.action == QStringLiteral("upsert")) {
            Preset p = Preset::fromJson(packet.payload);
            success = db.savePreset(p);
        } else if (packet.action == QStringLiteral("delete")) {
            success = db.deletePreset(packet.entityId);
        }
    } else if (packet.type == QStringLiteral("persona")) {
        if (packet.action == QStringLiteral("upsert")) {
            Persona p = Persona::fromJson(packet.payload);
            success = db.savePersona(p);
        } else if (packet.action == QStringLiteral("delete")) {
            success = db.deletePersona(packet.entityId);
        }
    } else if (packet.type == QStringLiteral("lorebook")) {
        if (packet.action == QStringLiteral("upsert")) {
            LorebookEntry lb = LorebookEntry::fromJson(packet.payload);
            success = db.saveGlobalLorebook(lb);
        } else if (packet.action == QStringLiteral("delete")) {
            success = db.deleteGlobalLorebook(packet.entityId);
        }
    }

    if (success) {
        emit syncApplied(packet.type, packet.entityId, packet.action);
    }

    return success;
}

} // namespace Risu
