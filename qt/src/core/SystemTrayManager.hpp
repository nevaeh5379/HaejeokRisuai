#pragma once

#include <QObject>
#include <QString>
#include <QSystemTrayIcon>
#include <QMenu>
#include <QPointer>
#include <QWindow>

namespace Risu {

class SystemTrayManager : public QObject {
    Q_OBJECT

    Q_PROPERTY(bool isAvailable READ isAvailable CONSTANT)

public:
    static SystemTrayManager& instance();

    bool isAvailable() const;
    void init(QWindow* mainWindow = nullptr);

    Q_INVOKABLE void showNotification(const QString& title, const QString& message);

public slots:
    void toggleWindowVisibility();

signals:
    void openChatRequested();
    void toggleApiServerRequested();

private:
    explicit SystemTrayManager(QObject* parent = nullptr);

    QSystemTrayIcon* m_trayIcon = nullptr;
    QMenu* m_trayMenu = nullptr;
    QPointer<QWindow> m_mainWindow;
};

} // namespace Risu
