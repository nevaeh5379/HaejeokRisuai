#pragma once

#include <QAbstractListModel>
#include <QList>
#include <QVariantMap>
#include "../core/Types.hpp"

namespace Risu {

class CharacterListModel : public QAbstractListModel {
    Q_OBJECT
    Q_PROPERTY(int count READ rowCount NOTIFY countChanged)

public:
    enum CharacterRoles {
        IdRole = Qt::UserRole + 1,
        NameRole,
        AvatarPathRole,
        FirstMessageRole,
        DescriptionRole,
        PersonalityRole,
        ScenarioRole,
        LastInteractionRole,
        ChatCountRole,
        TagsRole
    };

    explicit CharacterListModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    QVariant data(const QModelIndex& index, int role = Qt::DisplayRole) const override;
    QHash<int, QByteArray> roleNames() const override;

    void setCharacters(const QList<Character>& characters);
    const QList<Character>& characters() const { return m_characters; }
    std::optional<Character> characterAt(int row) const;
    Q_INVOKABLE int indexOfId(const QString& id) const;
    Q_INVOKABLE QVariantMap getCharacterAt(int row) const;
    Q_INVOKABLE QVariantMap get(int row) const;

signals:
    void countChanged();

private:
    QList<Character> m_characters;
};

} // namespace Risu
