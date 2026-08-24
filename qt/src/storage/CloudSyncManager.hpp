#pragma once

#include <QObject>
#include <QString>
#include <QStringList>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <functional>

namespace Risu {

class CloudSyncManager : public QObject {
    Q_OBJECT

public:
    static CloudSyncManager& instance();

    // Auto-backup to local disk with timestamp
    QString createLocalAutoBackup(const QString& targetDirectory = QString());

    // Prune older backup files, keeping the latest N backups
    int pruneOldBackups(const QString& targetDirectory = QString(), int keepCount = 10);

    // WebDAV Remote Backup Upload
    void uploadToWebDav(
        const QString& serverUrl,
        const QString& username,
        const QString& password,
        const QString& backupJsonContent,
        std::function<void(bool success, const QString& errorMsg)> callback
    );

    // WebDAV Remote Backup Download
    void downloadFromWebDav(
        const QString& serverUrl,
        const QString& username,
        const QString& password,
        std::function<void(bool success, const QString& backupJsonContent, const QString& errorMsg)> callback
    );

private:
    explicit CloudSyncManager(QObject* parent = nullptr);

    QNetworkAccessManager m_netManager;
};

} // namespace Risu
