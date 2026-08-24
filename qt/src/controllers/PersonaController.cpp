#include "PersonaController.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include <QFile>
#include <QFileInfo>
#include <QDebug>

namespace Risu {

PersonaController::PersonaController(QObject* parent) : QObject(parent) {
    connect(&DatabaseManager::instance(), &DatabaseManager::personasChanged, this, &PersonaController::refreshPersonas);
    refreshPersonas();
}

void PersonaController::refreshPersonas() {
    m_personas = DatabaseManager::instance().getAllPersonas();
    auto opt = DatabaseManager::instance().getActivePersona();
    if (opt) {
        m_activePersona = *opt;
    } else if (!m_personas.isEmpty()) {
        m_activePersona = m_personas.first();
        DatabaseManager::instance().setActivePersona(m_activePersona.id);
    }
    emit personasChanged();
}

QVariantList PersonaController::personas() const {
    QVariantList list;
    for (const auto& p : m_personas) {
        QVariantMap map;
        map[QStringLiteral("id")] = p.id;
        map[QStringLiteral("name")] = p.name;
        map[QStringLiteral("avatarPath")] = p.avatarPath;
        map[QStringLiteral("description")] = p.description;
        map[QStringLiteral("isActive")] = p.isActive;
        list.append(map);
    }
    return list;
}

QVariantMap PersonaController::activePersona() const {
    QVariantMap map;
    map[QStringLiteral("id")] = m_activePersona.id;
    map[QStringLiteral("name")] = m_activePersona.name;
    map[QStringLiteral("avatarPath")] = m_activePersona.avatarPath;
    map[QStringLiteral("description")] = m_activePersona.description;
    map[QStringLiteral("isActive")] = m_activePersona.isActive;
    return map;
}

QString PersonaController::activePersonaName() const {
    return m_activePersona.name.isEmpty() ? QStringLiteral("User") : m_activePersona.name;
}

QString PersonaController::createPersona(const QString& name, const QString& description) {
    Persona p;
    p.id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    p.name = name.isEmpty() ? QStringLiteral("User") : name;
    p.description = description;
    p.isActive = false;

    DatabaseManager::instance().savePersona(p);
    emit toastRequested(QStringLiteral("success"), QStringLiteral("Created persona: ") + p.name);
    return p.id;
}

bool PersonaController::savePersona(const QVariantMap& data) {
    QString id = data.value(QStringLiteral("id")).toString();
    if (id.isEmpty()) return false;

    Persona p;
    p.id = id;
    p.name = data.value(QStringLiteral("name")).toString();
    p.avatarPath = data.value(QStringLiteral("avatarPath")).toString();
    p.description = data.value(QStringLiteral("description")).toString();
    p.isActive = data.value(QStringLiteral("isActive")).toBool();

    bool ok = DatabaseManager::instance().savePersona(p);
    if (ok) {
        if (p.isActive) {
            DatabaseManager::instance().setActivePersona(p.id);
        }
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Persona saved."));
    }
    return ok;
}

bool PersonaController::deletePersona(const QString& personaId) {
    if (m_personas.size() <= 1) {
        emit toastRequested(QStringLiteral("warning"), QStringLiteral("Cannot delete the only persona."));
        return false;
    }

    bool ok = DatabaseManager::instance().deletePersona(personaId);
    if (ok) {
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Persona deleted."));
    }
    return ok;
}

bool PersonaController::setActivePersona(const QString& personaId) {
    bool ok = DatabaseManager::instance().setActivePersona(personaId);
    if (ok) {
        refreshPersonas();
        emit toastRequested(QStringLiteral("info"), QStringLiteral("Active persona switched."));
    }
    return ok;
}

void PersonaController::setAvatarImage(const QString& personaId, const QString& sourceImagePath) {
    QString ext = QFileInfo(sourceImagePath).suffix();
    if (ext.isEmpty()) ext = QStringLiteral("png");

    QString destPath = AppConfig::instance().avatarsDir() + QStringLiteral("/persona_") + personaId + QStringLiteral(".") + ext;
    QFile::remove(destPath);
    if (QFile::copy(sourceImagePath, destPath)) {
        for (auto& p : m_personas) {
            if (p.id == personaId) {
                p.avatarPath = destPath;
                DatabaseManager::instance().savePersona(p);
                break;
            }
        }
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Persona avatar updated."));
    }
}

} // namespace Risu
