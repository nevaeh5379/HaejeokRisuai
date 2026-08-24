#include "SystemTrayManager.hpp"
#include <QGuiApplication>
#include <QIcon>
#include <QPixmap>
#include <QPainter>
#include <QDebug>

namespace Risu {

SystemTrayManager& SystemTrayManager::instance() {
    static SystemTrayManager inst;
    return inst;
}

SystemTrayManager::SystemTrayManager(QObject* parent) : QObject(parent) {
}

bool SystemTrayManager::isAvailable() const {
    return QSystemTrayIcon::isSystemTrayAvailable();
}

void SystemTrayManager::init(QWindow* mainWindow) {
    m_mainWindow = mainWindow;

    if (!isAvailable()) {
        qDebug() << "[SystemTrayManager] System tray not available on this platform/desktop session.";
        return;
    }

    if (!m_trayIcon) {
        m_trayIcon = new QSystemTrayIcon(this);

        // Generate a clean native icon if not provided
        QPixmap pix(64, 64);
        pix.fill(Qt::transparent);
        QPainter p(&pix);
        p.setRenderHint(QPainter::Antialiasing);
        p.setBrush(QColor(QStringLiteral("#cba6f7")));
        p.setPen(Qt::NoPen);
        p.drawRoundedRect(4, 4, 56, 56, 16, 16);
        p.setPen(QColor(QStringLiteral("#11111b")));
        p.setFont(QFont(QStringLiteral("sans-serif"), 28, QFont::Bold));
        p.drawText(pix.rect(), Qt::AlignCenter, QStringLiteral("R"));
        p.end();

        m_trayIcon->setIcon(QIcon(pix));
        m_trayIcon->setToolTip(QStringLiteral("RisuAI Native Desktop"));

        connect(m_trayIcon, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
            if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) {
                toggleWindowVisibility();
            }
        });

        m_trayIcon->show();
    }
}

void SystemTrayManager::showNotification(const QString& title, const QString& message) {
    if (m_trayIcon && m_trayIcon->isVisible()) {
        m_trayIcon->showMessage(title, message, QSystemTrayIcon::Information, 3000);
    } else {
        qDebug() << "[Notification]" << title << ":" << message;
    }
}

void SystemTrayManager::toggleWindowVisibility() {
    if (m_mainWindow) {
        if (m_mainWindow->isVisible()) {
            m_mainWindow->hide();
        } else {
            m_mainWindow->show();
            m_mainWindow->raise();
            m_mainWindow->requestActivate();
        }
    }
}

} // namespace Risu
