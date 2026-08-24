#pragma once

#include "AIProvider.hpp"
#include <QNetworkAccessManager>
#include <QNetworkReply>

namespace Risu {

class ClaudeProvider : public AIProvider {
    Q_OBJECT

public:
    explicit ClaudeProvider(QObject* parent = nullptr);
    ~ClaudeProvider() override;

    void sendRequest(const CompiledPrompt& prompt, const Preset& preset) override;
    void cancel() override;
    bool isRunning() const override;

protected slots:
    void onReadyRead();
    void onReplyFinished();
    void onErrorOccurred(QNetworkReply::NetworkError code);

private:
    void processLine(const QString& line);

    QNetworkAccessManager m_networkManager;
    QNetworkReply* m_reply = nullptr;
    QByteArray m_buffer;
    QString m_fullResponse;
    QString m_thoughtResponse;
    int m_inTokens = 0;
    int m_outTokens = 0;
    bool m_finishedEmitted = false;
};

} // namespace Risu
