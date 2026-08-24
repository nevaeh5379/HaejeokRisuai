#pragma once

#include <QObject>
#include <QString>
#include <QHash>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <functional>

namespace Risu {

enum class TranslationProviderType {
    GoogleWeb,
    DeepL,
    LibreTranslate
};

class Translator : public QObject {
    Q_OBJECT

public:
    static Translator& instance();

    QString translateSync(const QString& text, const QString& sourceLang, const QString& targetLang);

    void translateAsync(
        const QString& text,
        const QString& sourceLang,
        const QString& targetLang,
        std::function<void(const QString& translatedText, bool success)> callback
    );

    void setApiKey(const QString& apiKey) { m_apiKey = apiKey; }
    void setProvider(TranslationProviderType provider) { m_provider = provider; }
    void setCustomEndpoint(const QString& url) { m_customEndpoint = url; }

    void clearCache() { m_cache.clear(); }
    int cacheSize() const { return m_cache.size(); }

private:
    explicit Translator(QObject* parent = nullptr);

    TranslationProviderType m_provider = TranslationProviderType::GoogleWeb;
    QString m_apiKey;
    QString m_customEndpoint;
    QNetworkAccessManager m_netManager;
    QHash<QString, QString> m_cache; // Cache key: sourceLang:targetLang:hash(text) -> translated
};

} // namespace Risu
