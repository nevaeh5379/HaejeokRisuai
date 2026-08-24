#pragma once

#include <QObject>
#include <QString>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <memory>

namespace Risu {

enum class ImageGenProvider {
    OpenAIDallE3,
    Automatic1111,
    ComfyUI,
    NovelAI,
    Custom
};

class ImageGenManager : public QObject {
    Q_OBJECT

public:
    explicit ImageGenManager(QObject* parent = nullptr);
    ~ImageGenManager() override = default;

    bool isGenerating() const { return m_isGenerating; }

    void generateImage(
        const QString& prompt,
        const QString& negativePrompt,
        ImageGenProvider provider,
        const QString& apiKey,
        const QString& endpointUrl,
        int width = 512,
        int height = 512,
        int steps = 20,
        double cfgScale = 7.0
    );

    void cancel();

signals:
    void generationStarted();
    void imageGenerated(const QString& localFilePath);
    void generationFailed(const QString& errorMessage);

private slots:
    void onReplyFinished(QNetworkReply* reply, ImageGenProvider provider);

private:
    QNetworkAccessManager m_netManager;
    bool m_isGenerating = false;
};

} // namespace Risu
