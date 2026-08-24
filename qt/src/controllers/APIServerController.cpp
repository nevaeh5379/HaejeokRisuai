#include "APIServerController.hpp"
#include <QSettings>

namespace Risu {

APIServerController::APIServerController(QObject* parent) : QObject(parent) {
    QSettings settings;
    int savedPort = settings.value(QStringLiteral("apiServer/port"), 6001).toInt();
    m_server.setPort(savedPort);

    connect(&m_server, &APIServer::runningChanged, this, &APIServerController::runningChanged);
    connect(&m_server, &APIServer::portChanged, this, &APIServerController::portChanged);
    connect(&m_server, &APIServer::logMessage, this, [this](const QString& msg) {
        emit toastRequested(QStringLiteral("info"), msg);
    });

    bool autoStart = settings.value(QStringLiteral("apiServer/autoStart"), false).toBool();
    if (autoStart) {
        m_server.startServer(savedPort);
    }
}

void APIServerController::setPort(int p) {
    m_server.setPort(p);
    QSettings().setValue(QStringLiteral("apiServer/port"), p);
    emit portChanged();
}

void APIServerController::toggleServer(bool enable) {
    if (enable) startServer();
    else stopServer();
}

void APIServerController::startServer() {
    bool ok = m_server.startServer(m_server.port());
    QSettings().setValue(QStringLiteral("apiServer/autoStart"), ok);
    emit runningChanged();
}

void APIServerController::stopServer() {
    m_server.stopServer();
    QSettings().setValue(QStringLiteral("apiServer/autoStart"), false);
    emit runningChanged();
}

} // namespace Risu
