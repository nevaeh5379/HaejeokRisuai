#include "OpenAIProvider.hpp"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QDebug>

namespace Risu {

OpenAIProvider::OpenAIProvider(QObject* parent) : AIProvider(parent) {
}

OpenAIProvider::~OpenAIProvider() {
    cancel();
}

bool OpenAIProvider::isRunning() const {
    return m_reply != nullptr && m_reply->isRunning();
}

void OpenAIProvider::cancel() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
}

void OpenAIProvider::sendRequest(const CompiledPrompt& prompt, const Preset& preset) {
    cancel();

    m_buffer.clear();
    m_fullResponse.clear();
    m_thoughtResponse.clear();
    m_inTokens = prompt.estimatedTokens;
    m_outTokens = 0;
    m_finishedEmitted = false;

    QString endpointUrl = preset.customEndpointUrl.isEmpty() ? QStringLiteral("https://api.openai.com/v1/chat/completions") : preset.customEndpointUrl;
    if (!endpointUrl.startsWith(QStringLiteral("http://")) && !endpointUrl.startsWith(QStringLiteral("https://"))) {
        endpointUrl = QStringLiteral("https://") + endpointUrl;
    }
    if (!endpointUrl.contains(QStringLiteral("/chat/completions"))) {
        if (endpointUrl.endsWith(QLatin1Char('/'))) {
            endpointUrl += QStringLiteral("chat/completions");
        } else if (endpointUrl.endsWith(QStringLiteral("/v1"))) {
            endpointUrl += QStringLiteral("/chat/completions");
        } else {
            endpointUrl += QStringLiteral("/v1/chat/completions");
        }
    }

    QNetworkRequest request;
    request.setUrl(QUrl(endpointUrl));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!preset.apiKey.isEmpty()) {
        request.setRawHeader("Authorization", "Bearer " + preset.apiKey.toUtf8());
    }

    // Build Payload
    QJsonObject root;
    root[QStringLiteral("model")] = preset.modelName.isEmpty() ? QStringLiteral("gpt-4o-mini") : preset.modelName;

    QJsonArray messagesArr;
    for (const auto& msg : prompt.messages) {
        QJsonObject m;
        m[QStringLiteral("role")] = msg.role;
        m[QStringLiteral("content")] = msg.content;
        if (!msg.name.isEmpty() && msg.role != QStringLiteral("system")) {
            m[QStringLiteral("name")] = msg.name;
        }
        messagesArr.append(m);
    }
    root[QStringLiteral("messages")] = messagesArr;

    // Reasoning effort if model is o1/o3
    if (preset.modelName.startsWith(QStringLiteral("o1")) || preset.modelName.startsWith(QStringLiteral("o3"))) {
        if (preset.reasoningEffort == 1) root[QStringLiteral("reasoning_effort")] = QStringLiteral("medium");
        else if (preset.reasoningEffort == 2) root[QStringLiteral("reasoning_effort")] = QStringLiteral("high");
        else if (preset.reasoningEffort == 0) root[QStringLiteral("reasoning_effort")] = QStringLiteral("low");
        root[QStringLiteral("max_completion_tokens")] = preset.maxTokens;
    } else {
        root[QStringLiteral("temperature")] = preset.temperature;
        root[QStringLiteral("max_tokens")] = preset.maxTokens;
        if (preset.topP < 1.0) root[QStringLiteral("top_p")] = preset.topP;
        if (preset.frequencyPenalty != 0.0) root[QStringLiteral("frequency_penalty")] = preset.frequencyPenalty;
        if (preset.presencePenalty != 0.0) root[QStringLiteral("presence_penalty")] = preset.presencePenalty;
    }

    if (!preset.stopSequences.isEmpty()) {
        QJsonArray stopArr;
        for (const auto& s : preset.stopSequences) stopArr.append(s);
        root[QStringLiteral("stop")] = stopArr;
    }

    root[QStringLiteral("stream")] = preset.enableStreaming;

    if (preset.enableStreaming) {
        QJsonObject streamOptions;
        streamOptions[QStringLiteral("include_usage")] = true;
        root[QStringLiteral("stream_options")] = streamOptions;
    }

    QByteArray payloadData = QJsonDocument(root).toJson(QJsonDocument::Compact);

    m_reply = m_networkManager.post(request, payloadData);
    connect(m_reply, &QNetworkReply::readyRead, this, &OpenAIProvider::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &OpenAIProvider::onReplyFinished);
    connect(m_reply, &QNetworkReply::errorOccurred, this, &OpenAIProvider::onErrorOccurred);
}

void OpenAIProvider::onReadyRead() {
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

void OpenAIProvider::processLine(const QString& line) {
    if (line.startsWith(QStringLiteral("data: "))) {
        QString dataStr = line.mid(6).trimmed();
        if (dataStr == QStringLiteral("[DONE]")) {
            return;
        }

        QJsonDocument doc = QJsonDocument::fromJson(dataStr.toUtf8());
        if (doc.isObject()) {
            QJsonObject obj = doc.object();

            if (obj.contains(QStringLiteral("usage")) && obj.value(QStringLiteral("usage")).isObject()) {
                QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
                m_inTokens = usage.value(QStringLiteral("prompt_tokens")).toInt(m_inTokens);
                m_outTokens = usage.value(QStringLiteral("completion_tokens")).toInt(m_outTokens);
            }

            if (obj.contains(QStringLiteral("choices")) && obj.value(QStringLiteral("choices")).isArray()) {
                QJsonArray choices = obj.value(QStringLiteral("choices")).toArray();
                if (!choices.isEmpty()) {
                    QJsonObject firstChoice = choices[0].toObject();
                    if (firstChoice.contains(QStringLiteral("delta")) && firstChoice.value(QStringLiteral("delta")).isObject()) {
                        QJsonObject delta = firstChoice.value(QStringLiteral("delta")).toObject();
                        QString textChunk = delta.value(QStringLiteral("content")).toString();
                        QString thoughtChunk = delta.value(QStringLiteral("reasoning_content")).toString();
                        if (thoughtChunk.isEmpty()) {
                            thoughtChunk = delta.value(QStringLiteral("reasoning")).toString();
                        }

                        if (!textChunk.isEmpty() || !thoughtChunk.isEmpty()) {
                            m_fullResponse += textChunk;
                            m_thoughtResponse += thoughtChunk;
                            emit chunkReceived(textChunk, thoughtChunk);
                        }
                    }
                }
            }
        }
    }
}

void OpenAIProvider::onReplyFinished() {
    if (!m_reply) return;

    if (m_reply->error() == QNetworkReply::NoError) {
        // In non-streaming mode, parse the full response JSON
        if (m_fullResponse.isEmpty()) {
            QByteArray data = m_reply->readAll();
            m_buffer.append(data);

            QJsonDocument doc = QJsonDocument::fromJson(m_buffer);
            if (doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.contains(QStringLiteral("usage")) && obj.value(QStringLiteral("usage")).isObject()) {
                    QJsonObject usage = obj.value(QStringLiteral("usage")).toObject();
                    m_inTokens = usage.value(QStringLiteral("prompt_tokens")).toInt(m_inTokens);
                    m_outTokens = usage.value(QStringLiteral("completion_tokens")).toInt(m_outTokens);
                }
                if (obj.contains(QStringLiteral("choices")) && obj.value(QStringLiteral("choices")).isArray()) {
                    QJsonArray choices = obj.value(QStringLiteral("choices")).toArray();
                    if (!choices.isEmpty()) {
                        QJsonObject first = choices[0].toObject();
                        if (first.contains(QStringLiteral("message")) && first.value(QStringLiteral("message")).isObject()) {
                            QJsonObject msg = first.value(QStringLiteral("message")).toObject();
                            m_fullResponse = msg.value(QStringLiteral("content")).toString();
                            m_thoughtResponse = msg.value(QStringLiteral("reasoning_content")).toString();
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

void OpenAIProvider::onErrorOccurred(QNetworkReply::NetworkError code) {
    if (code == QNetworkReply::OperationCanceledError) {
        return; // Normal cancellation
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
