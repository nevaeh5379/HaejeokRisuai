#include "CharacterListModel.hpp"
#include "../core/AppConfig.hpp"

namespace Risu {

CharacterListModel::CharacterListModel(QObject* parent) : QAbstractListModel(parent) {
}

int CharacterListModel::rowCount(const QModelIndex& parent) const {
    if (parent.isValid()) return 0;
    return m_characters.size();
}

QVariant CharacterListModel::data(const QModelIndex& index, int role) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_characters.size()) {
        return QVariant();
    }

    const auto& c = m_characters[index.row()];
    switch (role) {
        case IdRole: return c.id;
        case NameRole: return c.name;
        case AvatarPathRole: {
            QString resolved = AppConfig::instance().resolveAssetPath(c.avatarPath);
            return resolved.isEmpty() ? c.avatarPath : resolved;
        }
        case FirstMessageRole: return c.firstMessage;
        case DescriptionRole: return c.description;
        case PersonalityRole: return c.personality;
        case ScenarioRole: return c.scenario;
        case LastInteractionRole: return c.lastInteraction;
        case ChatCountRole: return c.chats.size();
        case TagsRole: return c.tags.join(QStringLiteral(", "));
        default: return QVariant();
    }
}

QHash<int, QByteArray> CharacterListModel::roleNames() const {
    QHash<int, QByteArray> roles;
    roles[IdRole] = "charId";
    roles[NameRole] = "name";
    roles[AvatarPathRole] = "avatarPath";
    roles[FirstMessageRole] = "firstMessage";
    roles[DescriptionRole] = "description";
    roles[PersonalityRole] = "personality";
    roles[ScenarioRole] = "scenario";
    roles[LastInteractionRole] = "lastInteraction";
    roles[ChatCountRole] = "chatCount";
    roles[TagsRole] = "tags";
    return roles;
}

void CharacterListModel::setCharacters(const QList<Character>& characters) {
    beginResetModel();
    m_characters = characters;
    endResetModel();
    emit countChanged();
}

std::optional<Character> CharacterListModel::characterAt(int row) const {
    if (row >= 0 && row < m_characters.size()) {
        return m_characters[row];
    }
    return std::nullopt;
}

int CharacterListModel::indexOfId(const QString& id) const {
    for (int i = 0; i < m_characters.size(); ++i) {
        if (m_characters[i].id == id) return i;
    }
    return -1;
}

QVariantMap CharacterListModel::getCharacterAt(int row) const {
    QVariantMap map;
    if (row >= 0 && row < m_characters.size()) {
        const auto& c = m_characters[row];
        map[QStringLiteral("charId")] = c.id;
        map[QStringLiteral("id")] = c.id;
        map[QStringLiteral("name")] = c.name;
        map[QStringLiteral("avatarPath")] = c.avatarPath;
        map[QStringLiteral("firstMessage")] = c.firstMessage;
        map[QStringLiteral("description")] = c.description;
        map[QStringLiteral("personality")] = c.personality;
        map[QStringLiteral("scenario")] = c.scenario;
        map[QStringLiteral("tags")] = c.tags.join(QStringLiteral(", "));
    }
    return map;
}

QVariantMap CharacterListModel::get(int row) const {
    return getCharacterAt(row);
}

} // namespace Risu
