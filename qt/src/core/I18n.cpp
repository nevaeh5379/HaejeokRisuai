#include "I18n.hpp"
#include <QSettings>

namespace Risu {

I18n& I18n::instance() {
    static I18n inst;
    return inst;
}

I18n::I18n(QObject* parent) : QObject(parent) {
    QSettings settings;
    m_language = settings.value(QStringLiteral("general/language"), QStringLiteral("ko")).toString();
    initTranslations();
}

void I18n::setLanguage(const QString& lang) {
    if (m_language != lang) {
        m_language = lang;
        QSettings().setValue(QStringLiteral("general/language"), lang);
        emit languageChanged();
    }
}

QString I18n::t(const QString& key, const QString& defaultText) const {
    if (m_dict.contains(m_language) && m_dict[m_language].contains(key)) {
        return m_dict[m_language][key];
    }
    if (m_dict.contains(QStringLiteral("en")) && m_dict[QStringLiteral("en")].contains(key)) {
        return m_dict[QStringLiteral("en")][key];
    }
    return defaultText.isEmpty() ? key : defaultText;
}

void I18n::initTranslations() {
    // English
    m_dict[QStringLiteral("en")][QStringLiteral("app.title")] = QStringLiteral("RisuAI Native Desktop");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.chat")] = QStringLiteral("Chat");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.characters")] = QStringLiteral("Characters");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.presets")] = QStringLiteral("Presets");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.lorebook")] = QStringLiteral("Lorebook");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.personas")] = QStringLiteral("Personas");
    m_dict[QStringLiteral("en")][QStringLiteral("nav.settings")] = QStringLiteral("Settings");
    m_dict[QStringLiteral("en")][QStringLiteral("chat.send")] = QStringLiteral("Send");
    m_dict[QStringLiteral("en")][QStringLiteral("chat.reroll")] = QStringLiteral("Reroll");
    m_dict[QStringLiteral("en")][QStringLiteral("chat.continue")] = QStringLiteral("Continue");
    m_dict[QStringLiteral("en")][QStringLiteral("chat.search")] = QStringLiteral("Search in chat...");
    m_dict[QStringLiteral("en")][QStringLiteral("chat.export")] = QStringLiteral("Export Chat");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.main")] = QStringLiteral("Main Prompt");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.jailbreak")] = QStringLiteral("Jailbreak Prompt");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.chats")] = QStringLiteral("Past Chats");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.lorebook")] = QStringLiteral("Lorebook");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.globalNote")] = QStringLiteral("Global Note");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.authorNote")] = QStringLiteral("Author's Note");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.description")] = QStringLiteral("Character Description");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.personaPrompt")] = QStringLiteral("Persona Prompt");
    m_dict[QStringLiteral("en")][QStringLiteral("formating.memory")] = QStringLiteral("Long-term Memory");

    // Korean (Exact strings from src/lang/ko.ts)
    m_dict[QStringLiteral("ko")][QStringLiteral("app.title")] = QStringLiteral("RisuAI 네이티브 데스크톱");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.chat")] = QStringLiteral("대화");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.characters")] = QStringLiteral("캐릭터");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.presets")] = QStringLiteral("프리셋");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.lorebook")] = QStringLiteral("로어북");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.personas")] = QStringLiteral("페르소나");
    m_dict[QStringLiteral("ko")][QStringLiteral("nav.settings")] = QStringLiteral("설정");
    m_dict[QStringLiteral("ko")][QStringLiteral("chat.send")] = QStringLiteral("전송");
    m_dict[QStringLiteral("ko")][QStringLiteral("chat.reroll")] = QStringLiteral("다시 생성");
    m_dict[QStringLiteral("ko")][QStringLiteral("chat.continue")] = QStringLiteral("이어쓰기");
    m_dict[QStringLiteral("ko")][QStringLiteral("chat.search")] = QStringLiteral("대화 내 검색...");
    m_dict[QStringLiteral("ko")][QStringLiteral("chat.export")] = QStringLiteral("대화 내보내기");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.main")] = QStringLiteral("메인 프롬프트");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.jailbreak")] = QStringLiteral("탈옥 프롬프트");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.chats")] = QStringLiteral("과거 채팅");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.lorebook")] = QStringLiteral("로어북");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.globalNote")] = QStringLiteral("글로벌 노트");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.authorNote")] = QStringLiteral("작가의 노트");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.description")] = QStringLiteral("캐릭터 설명");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.personaPrompt")] = QStringLiteral("페르소나 프롬프트");
    m_dict[QStringLiteral("ko")][QStringLiteral("formating.memory")] = QStringLiteral("장기 기억");
}

} // namespace Risu
