#include "OllamaProvider.hpp"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QUrl>
#include <QDebug>

namespace Risu {

OllamaProvider::OllamaProvider(QObject* parent) : AIProvider(parent) {
}

OllamaProvider::~OllamaProvider() {
    cancel();
}

bool OllamaProvider::isRunning() const {
    return m_reply != nullptr && m_reply->isRunning();
}

void OllamaProvider::cancel() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
}

void OllamaProvider::sendRequest(const CompiledPrompt& prompt, const Preset& preset) {
    cancel();

    m_buffer.clear();
    m_fullResponse.clear();
    m_thoughtResponse.clear();
    m_inTokens = prompt.estimatedTokens;
    m_outTokens = 0;
    m_finishedEmitted = false;

    QString endpointUrl = preset.customEndpointUrl.isEmpty() ? QStringLiteral("http://localhost:11434/api/chat") : preset.customEndpointUrl;
    if (!endpointUrl.startsWith(QStringLiteral("http://")) && !endpointUrl.startsWith(QStringLiteral("https://"))) {
        endpointUrl = QStringLiteral("http://") + endpointUrl;
    }
    if (!endpointUrl.endsWith(QStringLiteral("/api/chat"))) {
        if (endpointUrl.endsWith(QLatin1Char('/'))) endpointUrl += QStringLiteral("api/chat");
        else endpointUrl += QStringLiteral("/api/chat");
    }

    QNetworkRequest request;
    request.setUrl(QUrl(endpointUrl));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    if (!preset.apiKey.isEmpty()) {
        request.setRawHeader("Authorization", "Bearer " + preset.apiKey.toUtf8());
    }

    // Build Ollama Payload
    QJsonObject root;
    root[QStringLiteral("model")] = preset.modelName.isEmpty() ? QStringLiteral("llama3.3") : preset.modelName;
    root[QStringLiteral("stream")] = preset.enableStreaming;

    QJsonArray messagesArr;
    for (const auto& msg : prompt.messages) {
        QJsonObject m;
        m[QStringLiteral("role")] = msg.role;
        m[QStringLiteral("content")] = msg.content;
        messagesArr.append(m);
    }
    root[QStringLiteral("messages")] = messagesArr;

    QJsonObject options;
    options[QStringLiteral("temperature")] = preset.temperature;
    options[QStringLiteral("num_predict")] = preset.maxTokens;
    if (preset.topP < 1.0) options[QStringLiteral("top_p")] = preset.topP;
    if (preset.topK > 0) options[QStringLiteral("top_k")] = preset.topK;
    if (preset.repetitionPenalty != 1.0) options[QStringLiteral("repeat_penalty")] = preset.repetitionPenalty;

    if (!preset.stopSequences.isEmpty()) {
        QJsonArray stopArr;
        for (const auto& s : preset.stopSequences) stopArr.append(s);
        options[QStringLiteral("stop")] = stopArr;
    }
    root[QStringLiteral("options")] = options;

    QByteArray payloadData = QJsonDocument(root).toJson(QJsonDocument::Compact);

    m_reply = m_networkManager.post(request, payloadData);
    connect(m_reply, &QNetworkReply::readyRead, this, &OllamaProvider::onReadyRead);
    connect(m_reply, &QNetworkReply::finished, this, &OllamaProvider::onReplyFinished);
    connect(m_reply, &QNetworkReply::errorOccurred, this, &OllamaProvider::onErrorOccurred);
}

void OllamaProvider::onReadyRead() {
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

void OllamaProvider::processLine(const QString& line) {
    QJsonDocument doc = QJsonDocument::fromJson(line.toUtf8());
    if (doc.isObject()) {
        QJsonObject obj = doc.object();

        if (obj.contains(QStringLiteral("prompt_eval_count"))) {
            m_inTokens = obj.value(QStringLiteral("prompt_eval_count")).toInt(m_inTokens);
        }
        if (obj.contains(QStringLiteral("eval_count"))) {
            m_outTokens = obj.value(QStringLiteral("eval_count")).toInt(m_outTokens);
        }

        if (obj.contains(QStringLiteral("message")) && obj.value(QStringLiteral("message")).isObject()) {
            QJsonObject msg = obj.value(QStringLiteral("message")).toObject();
            QString textChunk = msg.value(QStringLiteral("content")).toString();
            QString thoughtChunk = msg.value(QStringLiteral("thinking")).toString();

            if (!textChunk.isEmpty() || !thoughtChunk.isEmpty()) {
                m_fullResponse += textChunk;
                m_thoughtResponse += thoughtChunk;
                emit chunkReceived(textChunk, thoughtChunk);
            }
        }
    }
}

void OllamaProvider::onReplyFinished() {
    if (!m_reply) return;

    if (m_reply->error() == QNetworkReply::NoError) {
        if (!m_finishedEmitted) {
            m_finishedEmitted = true;
            emit finished(m_fullResponse, m_thoughtResponse, m_inTokens, m_outTokens);
        }
    }

    m_reply->deleteLater();
    m_reply = nullptr;
}

void OllamaProvider::onErrorOccurred(QNetworkReply::NetworkError code) {
    if (code == QNetworkReply::OperationCanceledError) {
        return;
    }

    QString errStr = m_reply ? m_reply->errorString() : QStringLiteral("Unknown Network Error");
    if (m_reply) {
        QByteArray resp = m_reply->readAll();
        if (!resp.isEmpty()) {
            QJsonDocument doc = QJsonDocument::fromJson(resp);
            if (doc.isObject() && doc.object().contains(QStringLiteral("error"))) {
                errStr = doc.object().value(QStringLiteral("error")).toString(errStr);
            }
        }
    }

    emit errorOccurred(errStr);
}

} // namespace Risu
