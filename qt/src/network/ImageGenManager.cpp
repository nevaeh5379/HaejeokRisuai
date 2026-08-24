#include "ImageGenManager.hpp"
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <QFile>
#include <QDir>
#include <QUrl>
#include <QUuid>
#include <QByteArray>
#include <QDebug>

namespace Risu {

ImageGenManager::ImageGenManager(QObject* parent) : QObject(parent) {
}

void ImageGenManager::cancel() {
    m_isGenerating = false;
}

void ImageGenManager::generateImage(
    const QString& prompt,
    const QString& negativePrompt,
    ImageGenProvider provider,
    const QString& apiKey,
    const QString& endpointUrl,
    int width,
    int height,
    int steps,
    double cfgScale
) {
    if (prompt.trimmed().isEmpty()) return;

    m_isGenerating = true;
    emit generationStarted();

    QNetworkRequest req;
    QByteArray payload;

    switch (provider) {
        case ImageGenProvider::OpenAIDallE3: {
            QString urlStr = endpointUrl.isEmpty() ? QStringLiteral("https://api.openai.com/v1/images/generations") : endpointUrl;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("model")] = QStringLiteral("dall-e-3");
            obj[QStringLiteral("prompt")] = prompt;
            obj[QStringLiteral("n")] = 1;
            obj[QStringLiteral("size")] = QStringLiteral("1024x1024");
            obj[QStringLiteral("response_format")] = QStringLiteral("b64_json");

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
        case ImageGenProvider::Automatic1111: {
            QString urlStr = endpointUrl.isEmpty() ? QStringLiteral("http://127.0.0.1:7860/sdapi/v1/txt2img") : endpointUrl;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            if (!apiKey.isEmpty()) req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("prompt")] = prompt;
            obj[QStringLiteral("negative_prompt")] = negativePrompt;
            obj[QStringLiteral("steps")] = steps;
            obj[QStringLiteral("width")] = width;
            obj[QStringLiteral("height")] = height;
            obj[QStringLiteral("cfg_scale")] = cfgScale;
            obj[QStringLiteral("sampler_name")] = QStringLiteral("Euler a");

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
        case ImageGenProvider::NovelAI: {
            QString urlStr = endpointUrl.isEmpty() ? QStringLiteral("https://api.novelai.net/ai/generate-image") : endpointUrl;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("input")] = prompt;
            obj[QStringLiteral("model")] = QStringLiteral("nai-diffusion-3");
            QJsonObject params;
            params[QStringLiteral("width")] = width;
            params[QStringLiteral("height")] = height;
            params[QStringLiteral("steps")] = steps;
            params[QStringLiteral("scale")] = cfgScale;
            params[QStringLiteral("negative_prompt")] = negativePrompt;
            obj[QStringLiteral("parameters")] = params;

            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
        case ImageGenProvider::ComfyUI:
        case ImageGenProvider::Custom:
        default: {
            QString urlStr = endpointUrl.isEmpty() ? QStringLiteral("http://127.0.0.1:8188/prompt") : endpointUrl;
            req.setUrl(QUrl(urlStr));
            req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
            if (!apiKey.isEmpty()) req.setRawHeader("Authorization", "Bearer " + apiKey.toUtf8());

            QJsonObject obj;
            obj[QStringLiteral("prompt")] = prompt;
            payload = QJsonDocument(obj).toJson(QJsonDocument::Compact);
            break;
        }
    }

    QNetworkReply* reply = m_netManager.post(req, payload);
    connect(reply, &QNetworkReply::finished, this, [this, reply, provider]() {
        this->onReplyFinished(reply, provider);
    });
}

void ImageGenManager::onReplyFinished(QNetworkReply* reply, ImageGenProvider provider) {
    reply->deleteLater();
    m_isGenerating = false;

    if (reply->error() != QNetworkReply::NoError) {
        emit generationFailed(QStringLiteral("Image Gen Network Error: ") + reply->errorString());
        return;
    }

    QByteArray responseData = reply->readAll();
    QByteArray imageBytes;

    if (provider == ImageGenProvider::OpenAIDallE3) {
        QJsonDocument doc = QJsonDocument::fromJson(responseData);
        if (!doc.isNull() && doc.isObject()) {
            QJsonArray dataArr = doc.object().value(QStringLiteral("data")).toArray();
            if (!dataArr.isEmpty()) {
                QString b64 = dataArr.first().toObject().value(QStringLiteral("b64_json")).toString();
                imageBytes = QByteArray::fromBase64(b64.toUtf8());
            }
        }
    } else if (provider == ImageGenProvider::Automatic1111) {
        QJsonDocument doc = QJsonDocument::fromJson(responseData);
        if (!doc.isNull() && doc.isObject()) {
            QJsonArray imagesArr = doc.object().value(QStringLiteral("images")).toArray();
            if (!imagesArr.isEmpty()) {
                QString b64 = imagesArr.first().toString();
                imageBytes = QByteArray::fromBase64(b64.toUtf8());
            }
        }
    } else {
        imageBytes = responseData;
    }

    if (imageBytes.isEmpty()) {
        emit generationFailed(QStringLiteral("Failed to parse image from response."));
        return;
    }

    // Save image to temp directory
    QString targetPath = QDir::tempPath() + QStringLiteral("/risu_img_") + QUuid::createUuid().toString(QUuid::WithoutBraces) + QStringLiteral(".png");
    QFile out(targetPath);
    if (out.open(QIODevice::WriteOnly)) {
        out.write(imageBytes);
        out.close();
        emit imageGenerated(targetPath);
    } else {
        emit generationFailed(QStringLiteral("Failed to write image file to disk."));
    }
}

} // namespace Risu
