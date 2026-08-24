#include "ClaudeProvider.hpp"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QDebug>

namespace Risu {

ClaudeProvider::ClaudeProvider(QObject* parent) : AIProvider(parent) {
}

ClaudeProvider::~ClaudeProvider() {
    cancel();
}

bool ClaudeProvider::isRunning() const {
    return m_reply != nullptr && m_reply->isRunning();
}

void ClaudeProvider::cancel() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
}

void ClaudeProvider::sendRequest(const CompiledPrompt& prompt, const Preset& preset) {
    cancel();

    m_buffer.clear();
    m_fullResponse.clear();
    m_thoughtResponse.clear();
    m_inTokens = prompt.estimatedTokens;
    m_outTokens = 0;
    m_finishedEmitted = false;

    QString endpointUrl = preset.customEndpointUrl.isEmpty() ? QStringLiteral("https://api.anthropic.com/v1/messages") : preset.customEndpointUrl;
    if (!endpointUrl.startsWith(QStringLiteral("http://")) && !endpointUrl.startsWith(QStringLiteral("https://"))) {
        endpointUrl = QStringLiteral("https://") + endpointUrl;
    }
    if (!endpointUrl.contains(QStringLiteral("/messages"))) {
        if (endpointUrl.endsWith(QLatin1Char('/'))) {
            endpointUrl += QStringLiteral("messages");
        } else if (endpointUrl.endsWith(QStringLiteral("/v1"))) {
            endpointUrl += QStringLiteral("/messages");
        } else {
            endpointUrl += QStringLiteral("/v1/messages");
        }
    }

    QNetworkRequest request;
    request.setUrl(QUrl(endpointUrl));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    request.setRawHeader("x-api-key", preset.apiKey.toUtf8());
    request.setRawHeader("anthropic-version", "2023-06-01");

    // Build Payload
    QJsonObject root;
    root[QStringLiteral("model")] = preset.modelName.isEmpty() ? QStringLiteral("claude-3-7-sonnet-20250219") : preset.modelName;
    root[QStringLiteral("max_tokens")] = preset.maxTokens;
    root[QStringLiteral("stream")] = preset.enableStreaming;

    if (!prompt.systemPromptCombined.isEmpty()) {
        root[QStringLiteral("system")] = prompt.systemPromptCombined;
    }

    // Thinking mode support
    if (preset.reasoningEffort > 0) {
        QJsonObject thinkingObj;
        thinkingObj[QStringLiteral("type")] = QStringLiteral("enabled");
        thinkingObj[QStringLiteral("budget_tokens")] = qMax(1024, preset.maxTokens / 2);
        root[QStringLiteral("thinking")] = thinkingObj;
        root[QStringLiteral("temperature")] = 1.0; // Required by Anthropic when thinking is enabled
    } else {
        root[QStringLiteral("temperature")] = preset.temperature;
    }

    // Build alternating message array
    QJsonArray messagesArr;
    QString lastRole;
    for (const auto& msg : prompt.messages) {
        if (msg.role == QStringLiteral("system")) {
            continue; // Already handled in system field
        }

        QString currentRole = (msg.role == QStringLiteral("assistant") || msg.role == QStringLiteral("char")) ? QStringLiteral("assistant") : QStringLiteral("user");

        // Merge consecutive messages of the same role for Claude API strict requirements
        if (currentRole == lastRole && !messagesArr.isEmpty()) {
            QJsonObject lastObj = messagesArr.last().toObject();
            QString prevContent = lastObj.value(QStringLiteral("content")).toString();
            lastObj[QStringLiteral("content")] = prevContent + QStringLiteral("\n\n") + msg.content;
            messagesArr[messagesArr.size() - 1] = lastObj;
        } else {
            QJsonObject m;
            m[QStringLiteral("role")] = currentRole;
            m[QStringLiteral("content")] = msg.content;
            messagesArr.append(m);
            lastRole = currentRole;
        }
    }

    // Claude requires first message in messages to be 'user'
    if (!messagesArr.isEmpty() && messagesArr.first().toObject().value(QStringLiteral("role")).toString() != QStringLiteral("user")) {
        QJsonObject dummyUser;
        dummyUser[QStringLiteral("role")] = QStringLiteral("user");
        dummyUser[QStringLiteral("content")] = QStringLiteral("Hello.");
        messagesArr.prepend(dummyUser);
    }

    root[QStringLiteral("messages")] = messagesArr;

    QByteArray payloadData = QJsonDocument(root).toJson(QJsonDocument::Compact);

    m_reply = m_networkManager.post(request, payloadData);
    connect(m_reply, &QNetworkReply::readyRead, this, &ClaudeProvider::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &ClaudeProvider::onReplyFinished);
    connect(m_reply, &QNetworkReply::errorOccurred, this, &ClaudeProvider::onErrorOccurred);
}

void ClaudeProvider::onReadyRead() {
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

void ClaudeProvider::processLine(const QString& line) {
    if (line.startsWith(QStringLiteral("data: "))) {
        QString dataStr = line.mid(6).trimmed();
        QJsonDocument doc = QJsonDocument::fromJson(dataStr.toUtf8());
        if (doc.isObject()) {
            QJsonObject obj = doc.object();
            QString type = obj.value(QStringLiteral("type")).toString();

            if (type == QStringLiteral("content_block_delta")) {
                QJsonObject delta = obj.value(QStringLiteral("delta")).toObject();
                QString deltaType = delta.value(QStringLiteral("type")).toString();

                if (deltaType == QStringLiteral("text_delta")) {
                    QString textChunk = delta.value(QStringLiteral("text")).toString();
                    m_fullResponse += textChunk;
                    emit chunkReceived(textChunk, QString());
                } else if (deltaType == QStringLiteral("thinking_delta")) {
                    QString thoughtChunk = delta.value(QStringLiteral("thinking")).toString();
                    m_thoughtResponse += thoughtChunk;
                    emit chunkReceived(QString(), thoughtChunk);
                }
            } else if (type == QStringLiteral("message_start")) {
                QJsonObject msg = obj.value(QStringLiteral("message")).toObject();
                QJsonObject usage = msg.value(QStringLiteral("usage")).toObject();
                m_inTokens = usage.value(QStringLiteral("input_tokens")).toInt(m_inTokens);
            } else if (type == QStringLiteral("message_delta")) {
                QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
                m_outTokens = usage.value(QStringLiteral("output_tokens")).toInt(m_outTokens);
            }
        }
    }
}

void ClaudeProvider::onReplyFinished() {
    if (!m_reply) return;

    if (m_reply->error() == QNetworkReply::NoError) {
        if (m_fullResponse.isEmpty()) {
            QByteArray data = m_reply->readAll();
            m_buffer.append(data);

            QJsonDocument doc = QJsonDocument::fromJson(m_buffer);
            if (doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.contains(QStringLiteral("usage")) && obj.value(QStringLiteral("usage")).isObject()) {
                    QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
                    m_inTokens = usage.value(QStringLiteral("input_tokens")).toInt(m_inTokens);
                    m_outTokens = usage.value(QStringLiteral("output_tokens")).toInt(m_outTokens);
                }
                if (obj.contains(QStringLiteral("content")) && obj.value(QStringLiteral("content")).isArray()) {
                    QJsonArray contentArr = obj.value(QStringLiteral("content")).toArray();
                    for (const auto& item : contentArr) {
                        QJsonObject block = item.toObject();
                        if (block.value(QStringLiteral("type")).toString() == QStringLiteral("text")) {
                            m_fullResponse += block.value(QStringLiteral("text")).toString();
                        } else if (block.value(QStringLiteral("type")).toString() == QStringLiteral("thinking")) {
                            m_thoughtResponse += block.value(QStringLiteral("thinking")).toString();
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

void ClaudeProvider::onErrorOccurred(QNetworkReply::NetworkError code) {
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
