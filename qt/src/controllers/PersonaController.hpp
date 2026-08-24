#pragma once

#include <QObject>
#include <QVariantList>
#include <QVariantMap>
#include "../core/Types.hpp"

namespace Risu {

class PersonaController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList personas READ personas NOTIFY personasChanged)
    Q_PROPERTY(QVariantMap activePersona READ activePersona NOTIFY personasChanged)
    Q_PROPERTY(QString activePersonaName READ activePersonaName NOTIFY personasChanged)

public:
    explicit PersonaController(QObject* parent = nullptr);

    QVariantList personas() const;
    QVariantMap activePersona() const;
    QString activePersonaName() const;

public slots:
    void refreshPersonas();
    QString createPersona(const QString& name, const QString& description);
    bool savePersona(const QVariantMap& data);
    bool deletePersona(const QString& personaId);
    bool setActivePersona(const QString& personaId);
    void setAvatarImage(const QString& personaId, const QString& sourceImagePath);

signals:
    void personasChanged();
    void toastRequested(const QString& type, const QString& message);

private:
    QList<Persona> m_personas;
    Persona m_activePersona;
};

} // namespace Risu
