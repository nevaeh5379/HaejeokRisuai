#include "GeminiProvider.hpp"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QUrlQuery>
#include <QDebug>

namespace Risu {

GeminiProvider::GeminiProvider(QObject* parent) : AIProvider(parent) {
}

GeminiProvider::~GeminiProvider() {
    cancel();
}

bool GeminiProvider::isRunning() const {
    return m_reply != nullptr && m_reply->isRunning();
}

void GeminiProvider::cancel() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
}

void GeminiProvider::sendRequest(const CompiledPrompt& prompt, const Preset& preset) {
    cancel();

    m_buffer.clear();
    m_fullResponse.clear();
    m_thoughtResponse.clear();
    m_inTokens = prompt.estimatedTokens;
    m_outTokens = 0;
    m_finishedEmitted = false;

    QString model = preset.modelName.isEmpty() ? QStringLiteral("gemini-2.5-flash") : preset.modelName;
    if (model.startsWith(QStringLiteral("models/"))) {
        model = model.mid(7);
    }

    QString endpointUrl;
    if (!preset.customEndpointUrl.isEmpty()) {
        endpointUrl = preset.customEndpointUrl;
    } else {
        endpointUrl = QStringLiteral("https://generativelanguage.googleapis.com/v1beta/models/") + model + (preset.enableStreaming ? QStringLiteral(":streamGenerateContent?alt=sse") : QStringLiteral(":generateContent"));
    }

    QUrl url(endpointUrl);
    if (!preset.apiKey.isEmpty()) {
        QUrlQuery query(url);
        query.addQueryItem(QStringLiteral("key"), preset.apiKey);
        url.setQuery(query);
    }

    QNetworkRequest request(url);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));

    // Build Gemini Payload
    QJsonObject root;

    // System instruction
    if (!prompt.systemPromptCombined.isEmpty()) {
        QJsonObject sysInst;
        QJsonArray partsArr;
        QJsonObject part;
        part[QStringLiteral("text")] = prompt.systemPromptCombined;
        partsArr.append(part);
        sysInst[QStringLiteral("parts")] = partsArr;
        root[QStringLiteral("systemInstruction")] = sysInst;
    }

    // Contents array
    QJsonArray contentsArr;
    for (const auto& msg : prompt.messages) {
        if (msg.role == QStringLiteral("system")) continue;

        QJsonObject contentObj;
        contentObj[QStringLiteral("role")] = (msg.role == QStringLiteral("assistant") || msg.role == QStringLiteral("char") || msg.role == QStringLiteral("model")) ? QStringLiteral("model") : QStringLiteral("user");

        QJsonArray parts;
        QJsonObject textPart;
        textPart[QStringLiteral("text")] = msg.content;
        parts.append(textPart);

        contentObj[QStringLiteral("parts")] = parts;
        contentsArr.append(contentObj);
    }

    // Must have at least one user content
    if (contentsArr.isEmpty()) {
        QJsonObject dummy;
        dummy[QStringLiteral("role")] = QStringLiteral("user");
        QJsonArray parts;
        QJsonObject textPart;
        textPart[QStringLiteral("text")] = QStringLiteral("Hello.");
        parts.append(textPart);
        dummy[QStringLiteral("parts")] = parts;
        contentsArr.append(dummy);
    }

    root[QStringLiteral("contents")] = contentsArr;

    // Generation config
    QJsonObject genConfig;
    genConfig[QStringLiteral("temperature")] = preset.temperature;
    genConfig[QStringLiteral("maxOutputTokens")] = preset.maxTokens;
    if (preset.topP < 1.0) genConfig[QStringLiteral("topP")] = preset.topP;
    if (preset.topK > 0) genConfig[QStringLiteral("topK")] = preset.topK;

    // Thinking / reasoning for Gemini 2.0 Flash Thinking
    if (preset.reasoningEffort > 0 || model.contains(QStringLiteral("thinking"))) {
        QJsonObject thinkingConfig;
        thinkingConfig[QStringLiteral("thinkingBudget")] = qMax(1024, preset.maxTokens / 2);
        genConfig[QStringLiteral("thinkingConfig")] = thinkingConfig;
    }

    root[QStringLiteral("generationConfig")] = genConfig;

    QByteArray payloadData = QJsonDocument(root).toJson(QJsonDocument::Compact);

    m_reply = m_networkManager.post(request, payloadData);
    connect(m_reply, &QNetworkReply::readyRead, this, &GeminiProvider::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &GeminiProvider::onReplyFinished);
    connect(m_reply, &QNetworkReply::errorOccurred, this, &GeminiProvider::onErrorOccurred);
}

void GeminiProvider::onReadyRead() {
    if (!m_reply) return;

    m_buffer.append(m_reply->readAll());

    int newlineIdx = m_buffer.indexOf('\n');
    while (newlineIdx >= 0) {
        QByteArray rawLine = m_buffer.left(newlineIdx).trimmed();
        m_buffer.remove(0, newlineIdx + 1);

        if (!rawLine.isEmpty()) {
            QString line = QString::fromUtf8(rawLine);
            processLine(line);
        }

        newlineIdx = m_buffer.indexOf('\n');
    }
}

void GeminiProvider::processLine(const QString& line) {
    if (line.startsWith(QStringLiteral("data: "))) {
        QString dataStr = line.mid(6).trimmed();
        QJsonDocument doc = QJsonDocument::fromJson(dataStr.toUtf8());
        if (doc.isObject()) {
            QJsonObject obj = doc.object();

            if (obj.contains(QStringLiteral("usageMetadata")) && obj.value(QStringLiteral("usageMetadata")).isObject()) {
                QJsonObject usage = obj.value(QStringLiteral("usageMetadata")).toObject();
                m_inTokens = usage.value(QStringLiteral("promptTokenCount")).toInt(m_inTokens);
                m_outTokens = usage.value(QStringLiteral("candidatesTokenCount")).toInt(m_outTokens);
            }

            if (obj.contains(QStringLiteral("candidates")) && obj.value(QStringLiteral("candidates")).isArray()) {
                QJsonArray candidates = obj.value(QStringLiteral("candidates")).toArray();
                if (!candidates.isEmpty()) {
                    QJsonObject firstCand = candidates[0].toObject();
                    if (firstCand.contains(QStringLiteral("content")) && firstCand.value(QStringLiteral("content")).isObject()) {
                        QJsonObject contentObj = firstCand.value(QStringLiteral("content")).toObject();
                        if (contentObj.contains(QStringLiteral("parts")) && contentObj.value(QStringLiteral("parts")).isArray()) {
                            for (const auto& partVal : contentObj.value(QStringLiteral("parts")).toArray()) {
                                QJsonObject partObj = partVal.toObject();
                                QString text = partObj.value(QStringLiteral("text")).toString();
                                bool isThought = partObj.value(QStringLiteral("thought")).toBool(false);

                                if (isThought) {
                                    m_thoughtResponse += text;
                                    emit chunkReceived(QString(), text);
                                } else if (!text.isEmpty()) {
                                    m_fullResponse += text;
                                    emit chunkReceived(text, QString());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

void GeminiProvider::onReplyFinished() {
    if (!m_reply) return;

    if (m_reply->error() == QNetworkReply::NoError) {
        if (m_fullResponse.isEmpty()) {
            QByteArray data = m_reply->readAll();
            m_buffer.append(data);

            QJsonDocument doc = QJsonDocument::fromJson(m_buffer);
            if (doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.contains(QStringLiteral("usageMetadata")) && obj.value(QStringLiteral("usageMetadata")).isObject()) {
                    QJsonObject usage = obj.value(QStringLiteral("usageMetadata")).toObject();
                    m_inTokens = usage.value(QStringLiteral("promptTokenCount")).toInt(m_inTokens);
                    m_outTokens = usage.value(QStringLiteral("candidatesTokenCount")).toInt(m_outTokens);
                }
                if (obj.contains(QStringLiteral("candidates")) && obj.value(QStringLiteral("candidates")).isArray()) {
                    QJsonArray candidates = obj.value(QStringLiteral("candidates")).toArray();
                    if (!candidates.isEmpty()) {
                        QJsonObject firstCand = candidates[0].toObject();
                        if (firstCand.contains(QStringLiteral("content")) && firstCand.value(QStringLiteral("content")).isObject()) {
                            QJsonObject contentObj = firstCand.value(QStringLiteral("content")).toObject();
                            for (const auto& partVal : contentObj.value(QStringLiteral("parts")).toArray()) {
                                QJsonObject partObj = partVal.toObject();
                                QString text = partObj.value(QStringLiteral("text")).toString();
                                bool isThought = partObj.value(QStringLiteral("thought")).toBool(false);
                                if (isThought) {
                                    m_thoughtResponse += text;
                                } else {
                                    m_fullResponse += text;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (!m_finishedEmitted) {
            m_finishedEmitted = true;
            emit finished(m_fullResponse, m_thoughtResponse, m_inTokens, m_outTokens);
        }
    }

    m_reply->deleteLater();
    m_reply = nullptr;
}

void GeminiProvider::onErrorOccurred(QNetworkReply::NetworkError code) {
    if (code == QNetworkReply::OperationCanceledError) {
        return;
    }

    QString errStr = m_reply ? m_reply->errorString() : QStringLiteral("Unknown Network Error");
    if (m_reply) {
        QByteArray resp = m_reply->readAll();
        if (!resp.isEmpty()) {
            QJsonDocument doc = QJsonDocument::fromJson(resp);
            if (doc.isObject() && doc.object().contains(QStringLiteral("error"))) {
                QJsonObject errObj = doc.object().value(QStringLiteral("error")).toObject();
                errStr = errObj.value(QStringLiteral("message")).toString(errStr);
            }
        }
    }

    emit errorOccurred(errStr);
}

} // namespace Risu
