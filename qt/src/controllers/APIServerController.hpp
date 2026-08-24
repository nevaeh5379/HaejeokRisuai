#pragma once

#include <QObject>
#include <QString>
#include "../network/APIServer.hpp"

namespace Risu {

class APIServerController : public QObject {
    Q_OBJECT

    Q_PROPERTY(bool isRunning READ isRunning NOTIFY runningChanged)
    Q_PROPERTY(int port READ port WRITE setPort NOTIFY portChanged)

public:
    explicit APIServerController(QObject* parent = nullptr);

    bool isRunning() const { return m_server.isRunning(); }
    int port() const { return m_server.port(); }
    void setPort(int p);

public slots:
    void toggleServer(bool enable);
    void startServer();
    void stopServer();

signals:
    void runningChanged();
    void portChanged();
    void toastRequested(const QString& type, const QString& message);

private:
    APIServer m_server;
};

} // namespace Risu
