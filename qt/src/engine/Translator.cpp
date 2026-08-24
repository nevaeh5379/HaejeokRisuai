#include "Translator.hpp"
#include <QUrl>
#include <QUrlQuery>
#include <QNetworkRequest>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QEventLoop>
#include <QCryptographicHash>
#include <QDebug>

namespace Risu {

Translator& Translator::instance() {
    static Translator inst;
    return inst;
}

Translator::Translator(QObject* parent) : QObject(parent) {
}

static QString makeCacheKey(const QString& sourceLang, const QString& targetLang, const QString& text) {
    QByteArray hash = QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Md5).toHex();
    return QStringLiteral("%1:%2:%3").arg(sourceLang, targetLang, QString::fromLatin1(hash));
}

QString Translator::translateSync(const QString& text, const QString& sourceLang, const QString& targetLang) {
    if (text.trimmed().isEmpty() || sourceLang == targetLang) return text;

    QString cacheKey = makeCacheKey(sourceLang, targetLang, text);
    if (m_cache.contains(cacheKey)) {
        return m_cache[cacheKey];
    }

    QEventLoop loop;
    QString resultText = text;
    bool reqSuccess = false;

    translateAsync(text, sourceLang, targetLang, [&](const QString& translated, bool ok) {
        if (ok) {
            resultText = translated;
            reqSuccess = true;
        }
        loop.quit();
    });

    loop.exec();
    return reqSuccess ? resultText : text;
}

void Translator::translateAsync(
    const QString& text,
    const QString& sourceLang,
    const QString& targetLang,
    std::function<void(const QString& translatedText, bool success)> callback
) {
    if (text.trimmed().isEmpty() || sourceLang == targetLang) {
        callback(text, true);
        return;
    }

    QString cacheKey = makeCacheKey(sourceLang, targetLang, text);
    if (m_cache.contains(cacheKey)) {
        callback(m_cache[cacheKey], true);
        return;
    }

    if (m_provider == TranslationProviderType::GoogleWeb) {
        QUrl url(QStringLiteral("https://translate.googleapis.com/translate_a/single"));
        QUrlQuery query;
        query.addQueryItem(QStringLiteral("client"), QStringLiteral("gtx"));
        query.addQueryItem(QStringLiteral("sl"), sourceLang.isEmpty() ? QStringLiteral("auto") : sourceLang);
        query.addQueryItem(QStringLiteral("tl"), targetLang);
        query.addQueryItem(QStringLiteral("dt"), QStringLiteral("t"));
        query.addQueryItem(QStringLiteral("q"), text);
        url.setQuery(query);

        QNetworkRequest request(url);
        request.setHeader(QNetworkRequest::UserAgentHeader, QStringLiteral("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"));

        QNetworkReply* reply = m_netManager.get(request);
        connect(reply, &QNetworkReply::finished, this, [this, reply, cacheKey, callback]() {
            reply->deleteLater();

            if (reply->error() != QNetworkReply::NoError) {
                qWarning() << "[Translator] Network error:" << reply->errorString();
                callback(QString(), false);
                return;
            }

            QByteArray data = reply->readAll();
            QJsonDocument doc = QJsonDocument::fromJson(data);
            if (doc.isArray()) {
                QJsonArray rootArr = doc.array();
                if (!rootArr.isEmpty() && rootArr[0].isArray()) {
                    QJsonArray segments = rootArr[0].toArray();
                    QString fullTranslated;
                    for (const auto& seg : segments) {
                        if (seg.isArray() && !seg.toArray().isEmpty()) {
                            fullTranslated += seg.toArray()[0].toString();
                        }
                    }

                    if (!fullTranslated.isEmpty()) {
                        m_cache[cacheKey] = fullTranslated;
                        callback(fullTranslated, true);
                        return;
                    }
                }
            }

            callback(QString(), false);
        });
    } else if (m_provider == TranslationProviderType::DeepL) {
        QUrl url(m_apiKey.endsWith(QStringLiteral(":fx")) ? 
                 QStringLiteral("https://api-free.deepl.com/v2/translate") : 
                 QStringLiteral("https://api.deepl.com/v2/translate"));

        QNetworkRequest request(url);
        request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
        request.setRawHeader("Authorization", QStringLiteral("DeepL-Auth-Key %1").arg(m_apiKey).toUtf8());

        QJsonObject body;
        QJsonArray textArr;
        textArr.append(text);
        body[QStringLiteral("text")] = textArr;
        body[QStringLiteral("target_lang")] = targetLang.toUpper();
        if (!sourceLang.isEmpty() && sourceLang != QStringLiteral("auto")) {
            body[QStringLiteral("source_lang")] = sourceLang.toUpper();
        }

        QNetworkReply* reply = m_netManager.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
        connect(reply, &QNetworkReply::finished, this, [this, reply, cacheKey, callback]() {
            reply->deleteLater();

            if (reply->error() != QNetworkReply::NoError) {
                qWarning() << "[Translator DeepL] Network error:" << reply->errorString();
                callback(QString(), false);
                return;
            }

            QByteArray data = reply->readAll();
            QJsonDocument doc = QJsonDocument::fromJson(data);
            if (doc.isObject()) {
                QJsonArray transArr = doc.object().value(QStringLiteral("translations")).toArray();
                if (!transArr.isEmpty()) {
                    QString transText = transArr[0].toObject().value(QStringLiteral("text")).toString();
                    m_cache[cacheKey] = transText;
                    callback(transText, true);
                    return;
                }
            }

            callback(QString(), false);
        });
    } else {
        callback(text, false);
    }
}

} // namespace Risu
