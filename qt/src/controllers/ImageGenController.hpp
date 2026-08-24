#pragma once

#include <QObject>
#include <QString>
#include "../network/ImageGenManager.hpp"

namespace Risu {

class ImageGenController : public QObject {
    Q_OBJECT

    Q_PROPERTY(bool isGenerating READ isGenerating NOTIFY isGeneratingChanged)
    Q_PROPERTY(QString provider READ provider WRITE setProvider NOTIFY providerChanged)
    Q_PROPERTY(QString apiKey READ apiKey WRITE setApiKey NOTIFY apiKeyChanged)
    Q_PROPERTY(QString endpointUrl READ endpointUrl WRITE setEndpointUrl NOTIFY endpointUrlChanged)
    Q_PROPERTY(QString negativePrompt READ negativePrompt WRITE setNegativePrompt NOTIFY negativePromptChanged)
    Q_PROPERTY(int width READ width WRITE setWidth NOTIFY dimensionsChanged)
    Q_PROPERTY(int height READ height WRITE setHeight NOTIFY dimensionsChanged)
    Q_PROPERTY(int steps READ steps WRITE setSteps NOTIFY stepsChanged)
    Q_PROPERTY(double cfgScale READ cfgScale WRITE setCfgScale NOTIFY cfgScaleChanged)

public:
    explicit ImageGenController(QObject* parent = nullptr);

    bool isGenerating() const { return m_manager.isGenerating(); }

    QString provider() const { return m_provider; }
    void setProvider(const QString& prov);

    QString apiKey() const { return m_apiKey; }
    void setApiKey(const QString& key);

    QString endpointUrl() const { return m_endpointUrl; }
    void setEndpointUrl(const QString& url);

    QString negativePrompt() const { return m_negativePrompt; }
    void setNegativePrompt(const QString& neg);

    int width() const { return m_width; }
    void setWidth(int w);

    int height() const { return m_height; }
    void setHeight(int h);

    int steps() const { return m_steps; }
    void setSteps(int s);

    double cfgScale() const { return m_cfgScale; }
    void setCfgScale(double s);

public slots:
    void generate(const QString& prompt);
    void cancel();

signals:
    void isGeneratingChanged();
    void providerChanged();
    void apiKeyChanged();
    void endpointUrlChanged();
    void negativePromptChanged();
    void dimensionsChanged();
    void stepsChanged();
    void cfgScaleChanged();
    void imageReady(const QString& localFilePath);
    void toastRequested(const QString& type, const QString& message);

private:
    ImageGenManager m_manager;
    QString m_provider = QStringLiteral("sd_a1111");
    QString m_apiKey;
    QString m_endpointUrl = QStringLiteral("http://127.0.0.1:7860/sdapi/v1/txt2img");
    QString m_negativePrompt = QStringLiteral("low quality, bad anatomy, worst quality, blurry, distorted");
    int m_width = 512;
    int m_height = 768;
    int m_steps = 25;
    double m_cfgScale = 7.0;
};

} // namespace Risu
