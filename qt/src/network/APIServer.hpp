#pragma once

#include <QObject>
#include <QTcpServer>
#include <QTcpSocket>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonDocument>
#include <memory>

namespace Risu {

class APIServer : public QObject {
    Q_OBJECT

    Q_PROPERTY(bool isRunning READ isRunning NOTIFY runningChanged)
    Q_PROPERTY(int port READ port WRITE setPort NOTIFY portChanged)

public:
    explicit APIServer(QObject* parent = nullptr);
    ~APIServer() override;

    bool isRunning() const { return m_server && m_server->isListening(); }
    int port() const { return m_port; }
    void setPort(int p);

public slots:
    bool startServer(int port = 6001);
    void stopServer();

signals:
    void runningChanged();
    void portChanged();
    void logMessage(const QString& msg);

private slots:
    void onNewConnection();
    void onSocketReadyRead();

private:
    void handleHttpRequest(QTcpSocket* socket, const QByteArray& requestData);
    void sendJsonResponse(QTcpSocket* socket, int statusCode, const QJsonObject& body);
    void sendOptionsResponse(QTcpSocket* socket);

    std::unique_ptr<QTcpServer> m_server;
    int m_port = 6001;
};

} // namespace Risu
