#include "APIServer.hpp"
#include "../core/DatabaseManager.hpp"
#include "../core/AppConfig.hpp"
#include <QDebug>

namespace Risu {

APIServer::APIServer(QObject* parent) : QObject(parent) {
}

APIServer::~APIServer() {
    stopServer();
}

void APIServer::setPort(int p) {
    if (m_port != p) {
        m_port = p;
        emit portChanged();
    }
}

bool APIServer::startServer(int port) {
    stopServer();
    m_port = port;

    m_server = std::make_unique<QTcpServer>(this);
    connect(m_server.get(), &QTcpServer::newConnection, this, &APIServer::onNewConnection);

    const QHostAddress listenAddress = qEnvironmentVariableIsEmpty("RISUAI_ALLOW_REMOTE_API")
        ? QHostAddress::LocalHost : QHostAddress::Any;
    bool ok = m_server->listen(listenAddress, static_cast<quint16>(m_port));
    if (ok) {
        emit runningChanged();
        emit logMessage(QStringLiteral("REST API Server listening on port %1").arg(m_port));
        qInfo() << "REST API Server listening on port" << m_port;
    } else {
        emit logMessage(QStringLiteral("Failed to start REST API Server: ") + m_server->errorString());
        qWarning() << "Failed to start REST API Server on port" << m_port << ":" << m_server->errorString();
    }
    return ok;
}

void APIServer::stopServer() {
    if (m_server && m_server->isListening()) {
        m_server->close();
        emit runningChanged();
        emit logMessage(QStringLiteral("REST API Server stopped."));
    }
}

void APIServer::onNewConnection() {
    while (m_server && m_server->hasPendingConnections()) {
        QTcpSocket* socket = m_server->nextPendingConnection();
        connect(socket, &QTcpSocket::readyRead, this, &APIServer::onSocketReadyRead);
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
    }
}

void APIServer::onSocketReadyRead() {
    auto* socket = qobject_cast<QTcpSocket*>(sender());
    if (!socket) return;

    QByteArray requestData = socket->readAll();
    handleHttpRequest(socket, requestData);
}

void APIServer::sendOptionsResponse(QTcpSocket* socket) {
    QByteArray resp = "HTTP/1.1 204 No Content\r\n"
                      "Access-Control-Allow-Origin: *\r\n"
                      "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                      "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
                      "Content-Length: 0\r\n\r\n";
    socket->write(resp);
    socket->flush();
    socket->disconnectFromHost();
}

void APIServer::sendJsonResponse(QTcpSocket* socket, int statusCode, const QJsonObject& body) {
    QByteArray jsonBytes = QJsonDocument(body).toJson(QJsonDocument::Compact);
    QString statusMsg = (statusCode == 200) ? QStringLiteral("OK") : (statusCode == 404 ? QStringLiteral("Not Found") : QStringLiteral("Bad Request"));

    QByteArray resp;
    resp += "HTTP/1.1 " + QByteArray::number(statusCode) + " " + statusMsg.toUtf8() + "\r\n";
    resp += "Content-Type: application/json; charset=utf-8\r\n";
    resp += "Access-Control-Allow-Origin: *\r\n";
    resp += "Content-Length: " + QByteArray::number(jsonBytes.size()) + "\r\n";
    resp += "Connection: close\r\n\r\n";
    resp += jsonBytes;

    socket->write(resp);
    socket->flush();
    socket->disconnectFromHost();
}

void APIServer::handleHttpRequest(QTcpSocket* socket, const QByteArray& requestData) {
    QString reqStr = QString::fromUtf8(requestData);
    QStringList lines = reqStr.split(QStringLiteral("\r\n"));
    if (lines.isEmpty()) return;

    QStringList requestLine = lines[0].split(QLatin1Char(' '));
    if (requestLine.size() < 2) return;

    QString method = requestLine[0].toUpper();
    QString path = requestLine[1];

    if (method == QStringLiteral("OPTIONS")) {
        sendOptionsResponse(socket);
        return;
    }

    if (method == QStringLiteral("GET")) {
        if (path == QStringLiteral("/api/status") || path == QStringLiteral("/")) {
            QJsonObject res;
            res[QStringLiteral("status")] = QStringLiteral("online");
            res[QStringLiteral("server")] = QStringLiteral("RisuAI-Native-Qt");
            res[QStringLiteral("version")] = QStringLiteral("2026.8");
            sendJsonResponse(socket, 200, res);
            return;
        }

        if (path == QStringLiteral("/api/characters")) {
            auto chars = DatabaseManager::instance().getAllCharacters();
            QJsonArray arr;
            for (const auto& c : chars) {
                QJsonObject item;
                item[QStringLiteral("id")] = c.id;
                item[QStringLiteral("name")] = c.name;
                item[QStringLiteral("description")] = c.description;
                item[QStringLiteral("avatarPath")] = c.avatarPath;
                arr.append(item);
            }
            QJsonObject res;
            res[QStringLiteral("characters")] = arr;
            sendJsonResponse(socket, 200, res);
            return;
        }

        if (path == QStringLiteral("/api/presets")) {
            auto presets = DatabaseManager::instance().getAllPresets();
            QJsonArray arr;
            for (const auto& p : presets) {
                QJsonObject item;
                item[QStringLiteral("id")] = p.id;
                item[QStringLiteral("name")] = p.name;
                item[QStringLiteral("modelName")] = p.modelName;
                arr.append(item);
            }
            QJsonObject res;
            res[QStringLiteral("presets")] = arr;
            sendJsonResponse(socket, 200, res);
            return;
        }

        if (path == QStringLiteral("/api/backup")) {
            QJsonObject fullBackup = DatabaseManager::instance().exportFullDatabase();
            sendJsonResponse(socket, 200, fullBackup);
            return;
        }
    }

    QJsonObject err;
    err[QStringLiteral("error")] = QStringLiteral("Endpoint not found");
    sendJsonResponse(socket, 404, err);
}

} // namespace Risu
