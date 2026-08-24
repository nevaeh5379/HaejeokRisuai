#include "ImageGenController.hpp"
#include <QSettings>

namespace Risu {

ImageGenController::ImageGenController(QObject* parent) : QObject(parent) {
    QSettings settings;
    m_provider = settings.value(QStringLiteral("imageGen/provider"), QStringLiteral("sd_a1111")).toString();
    m_apiKey = settings.value(QStringLiteral("imageGen/apiKey"), QString()).toString();
    m_endpointUrl = settings.value(QStringLiteral("imageGen/endpointUrl"), QStringLiteral("http://127.0.0.1:7860/sdapi/v1/txt2img")).toString();
    m_negativePrompt = settings.value(QStringLiteral("imageGen/negativePrompt"), QStringLiteral("low quality, bad anatomy, worst quality, blurry, distorted")).toString();
    m_width = settings.value(QStringLiteral("imageGen/width"), 512).toInt();
    m_height = settings.value(QStringLiteral("imageGen/height"), 768).toInt();
    m_steps = settings.value(QStringLiteral("imageGen/steps"), 25).toInt();
    m_cfgScale = settings.value(QStringLiteral("imageGen/cfgScale"), 7.0).toDouble();

    connect(&m_manager, &ImageGenManager::generationStarted, this, &ImageGenController::isGeneratingChanged);
    connect(&m_manager, &ImageGenManager::imageGenerated, this, [this](const QString& path) {
        emit isGeneratingChanged();
        emit imageReady(path);
        emit toastRequested(QStringLiteral("success"), QStringLiteral("Illustration generated successfully!"));
    });
    connect(&m_manager, &ImageGenManager::generationFailed, this, [this](const QString& err) {
        emit isGeneratingChanged();
        emit toastRequested(QStringLiteral("error"), err);
    });
}

void ImageGenController::setProvider(const QString& prov) {
    if (m_provider != prov) {
        m_provider = prov;
        QSettings().setValue(QStringLiteral("imageGen/provider"), prov);
        emit providerChanged();
    }
}

void ImageGenController::setApiKey(const QString& key) {
    if (m_apiKey != key) {
        m_apiKey = key;
        QSettings().setValue(QStringLiteral("imageGen/apiKey"), key);
        emit apiKeyChanged();
    }
}

void ImageGenController::setEndpointUrl(const QString& url) {
    if (m_endpointUrl != url) {
        m_endpointUrl = url;
        QSettings().setValue(QStringLiteral("imageGen/endpointUrl"), url);
        emit endpointUrlChanged();
    }
}

void ImageGenController::setNegativePrompt(const QString& neg) {
    if (m_negativePrompt != neg) {
        m_negativePrompt = neg;
        QSettings().setValue(QStringLiteral("imageGen/negativePrompt"), neg);
        emit negativePromptChanged();
    }
}

void ImageGenController::setWidth(int w) {
    if (m_width != w) {
        m_width = w;
        QSettings().setValue(QStringLiteral("imageGen/width"), w);
        emit dimensionsChanged();
    }
}

void ImageGenController::setHeight(int h) {
    if (m_height != h) {
        m_height = h;
        QSettings().setValue(QStringLiteral("imageGen/height"), h);
        emit dimensionsChanged();
    }
}

void ImageGenController::setSteps(int s) {
    if (m_steps != s) {
        m_steps = s;
        QSettings().setValue(QStringLiteral("imageGen/steps"), s);
        emit stepsChanged();
    }
}

void ImageGenController::setCfgScale(double s) {
    if (qAbs(m_cfgScale - s) > 0.001) {
        m_cfgScale = s;
        QSettings().setValue(QStringLiteral("imageGen/cfgScale"), s);
        emit cfgScaleChanged();
    }
}

void ImageGenController::generate(const QString& prompt) {
    if (prompt.trimmed().isEmpty()) return;

    ImageGenProvider prov = ImageGenProvider::Automatic1111;
    if (m_provider == QStringLiteral("dalle3")) prov = ImageGenProvider::OpenAIDallE3;
    else if (m_provider == QStringLiteral("novelai")) prov = ImageGenProvider::NovelAI;
    else if (m_provider == QStringLiteral("comfyui")) prov = ImageGenProvider::ComfyUI;

    m_manager.generateImage(prompt, m_negativePrompt, prov, m_apiKey, m_endpointUrl, m_width, m_height, m_steps, m_cfgScale);
}

void ImageGenController::cancel() {
    m_manager.cancel();
    emit isGeneratingChanged();
}

} // namespace Risu
