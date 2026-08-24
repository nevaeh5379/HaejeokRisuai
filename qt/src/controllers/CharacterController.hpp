#pragma once

#include <QObject>
#include <QJsonObject>
#include <QVariantMap>
#include "../core/Types.hpp"
#include "../models/CharacterListModel.hpp"

namespace Risu {

class CharacterController : public QObject {
    Q_OBJECT
    Q_PROPERTY(CharacterListModel* characterModel READ characterModel CONSTANT)
    Q_PROPERTY(QVariantMap selectedCharacter READ selectedCharacter NOTIFY selectedCharacterChanged)
    Q_PROPERTY(bool hasSelectedCharacter READ hasSelectedCharacter NOTIFY selectedCharacterChanged)
    Q_PROPERTY(int characterCount READ characterCount NOTIFY characterCountChanged)

public:
    explicit CharacterController(QObject* parent = nullptr);

    CharacterListModel* characterModel() { return &m_charModel; }
    QVariantMap selectedCharacter() const;
    bool hasSelectedCharacter() const { return !m_selectedCharId.isEmpty(); }
    int characterCount() const { return m_charModel.rowCount(); }

public slots:
    void refreshCharacters();
    void selectCharacter(const QString& characterId);
    void clearSelection();
    QString createNewCharacter(const QString& name);
    QString createCharacter(const QString& name) { return createNewCharacter(name); }
    bool saveCharacterDetails(const QVariantMap& data);
    bool deleteCharacter(const QString& characterId);
    bool importCardFromFile(const QString& filePath);
    bool importCard(const QString& filePath) { return importCardFromFile(filePath); }
    bool exportCardToPng(const QString& characterId, const QString& targetFilePath);
    bool exportCardToJson(const QString& characterId, const QString& targetFilePath);
    void setAvatarImage(const QString& characterId, const QString& sourceImagePath);

signals:
    void selectedCharacterChanged();
    void characterCountChanged();
    void toastRequested(const QString& type, const QString& message);

private:
    CharacterListModel m_charModel;
    QString m_selectedCharId;
    Character m_selectedChar;
};

} // namespace Risu
