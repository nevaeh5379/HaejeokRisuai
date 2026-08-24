#include "CloudSyncManager.hpp"
#include "../core/AppConfig.hpp"
#include "../core/DatabaseManager.hpp"
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QDateTime>
#include <QUrl>
#include <QNetworkRequest>
#include <QAuthenticator>
#include <QDebug>

namespace Risu {

CloudSyncManager& CloudSyncManager::instance() {
    static CloudSyncManager inst;
    return inst;
}

CloudSyncManager::CloudSyncManager(QObject* parent) : QObject(parent) {
}

QString CloudSyncManager::createLocalAutoBackup(const QString& targetDirectory) {
    QString backupDir = targetDirectory;
    if (backupDir.isEmpty()) {
        backupDir = AppConfig::instance().backupsDir();
    }

    QDir dir(backupDir);
    if (!dir.exists()) {
        dir.mkpath(QStringLiteral("."));
    }

    QString timestamp = QDateTime::currentDateTime().toString(QStringLiteral("yyyyMMdd_hhmmss"));
    QString filename = QStringLiteral("risu_autobackup_%1.risubackup").arg(timestamp);
    QString fullPath = dir.absoluteFilePath(filename);

    QJsonObject dbObj = DatabaseManager::instance().exportFullDatabase();
    QByteArray backupData = QJsonDocument(dbObj).toJson(QJsonDocument::Indented);
    if (backupData.isEmpty()) {
        qWarning() << "[CloudSyncManager] Database export was empty!";
        return QString();
    }

    QFile file(fullPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        qWarning() << "[CloudSyncManager] Failed to write backup to:" << fullPath;
        return QString();
    }

    file.write(backupData);
    file.close();

    qInfo() << "[CloudSyncManager] Auto-backup created at:" << fullPath;

    pruneOldBackups(backupDir, 10);
    return fullPath;
}

int CloudSyncManager::pruneOldBackups(const QString& targetDirectory, int keepCount) {
    QString backupDir = targetDirectory;
    if (backupDir.isEmpty()) {
        backupDir = AppConfig::instance().backupsDir();
    }

    QDir dir(backupDir);
    if (!dir.exists()) return 0;

    QStringList filters;
    filters << QStringLiteral("risu_autobackup_*.risubackup") << QStringLiteral("*.risubackup");
    dir.setNameFilters(filters);
    dir.setSorting(QDir::Name | QDir::Reversed);

    QFileInfoList fileList = dir.entryInfoList();
    int removedCount = 0;

    if (fileList.size() > keepCount) {
        for (qsizetype i = keepCount; i < fileList.size(); ++i) {
            if (QFile::remove(fileList[i].absoluteFilePath())) {
                removedCount++;
            }
        }
    }

    return removedCount;
}

void CloudSyncManager::uploadToWebDav(
    const QString& serverUrl,
    const QString& username,
    const QString& password,
    const QString& backupJsonContent,
    std::function<void(bool success, const QString& errorMsg)> callback
) {
    if (serverUrl.isEmpty()) {
        callback(false, QStringLiteral("Server URL is empty."));
        return;
    }

    QString targetUrl = serverUrl;
    if (!targetUrl.endsWith(QStringLiteral(".json")) && !targetUrl.endsWith(QStringLiteral(".risubackup"))) {
        if (!targetUrl.endsWith(QLatin1Char('/'))) targetUrl += QLatin1Char('/');
        targetUrl += QStringLiteral("risu_sync_backup.json");
    }

    QUrl url(targetUrl);
    QNetworkRequest req(url);
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));

    if (!username.isEmpty()) {
        QString auth = QStringLiteral("%1:%2").arg(username, password);
        QByteArray authHeader = "Basic " + auth.toUtf8().toBase64();
        req.setRawHeader("Authorization", authHeader);
    }

    QNetworkReply* reply = m_netManager.put(req, backupJsonContent.toUtf8());
    connect(reply, &QNetworkReply::finished, this, [reply, callback]() {
        reply->deleteLater();
        if (reply->error() == QNetworkReply::NoError || reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 201 || reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 204) {
            callback(true, QString());
        } else {
            callback(false, reply->errorString());
        }
    });
}

void CloudSyncManager::downloadFromWebDav(
    const QString& serverUrl,
    const QString& username,
    const QString& password,
    std::function<void(bool success, const QString& backupJsonContent, const QString& errorMsg)> callback
) {
    if (serverUrl.isEmpty()) {
        callback(false, QString(), QStringLiteral("Server URL is empty."));
        return;
    }

    QString targetUrl = serverUrl;
    if (!targetUrl.endsWith(QStringLiteral(".json")) && !targetUrl.endsWith(QStringLiteral(".risubackup"))) {
        if (!targetUrl.endsWith(QLatin1Char('/'))) targetUrl += QLatin1Char('/');
        targetUrl += QStringLiteral("risu_sync_backup.json");
    }

    QUrl url(targetUrl);
    QNetworkRequest req(url);

    if (!username.isEmpty()) {
        QString auth = QStringLiteral("%1:%2").arg(username, password);
        QByteArray authHeader = "Basic " + auth.toUtf8().toBase64();
        req.setRawHeader("Authorization", authHeader);
    }

    QNetworkReply* reply = m_netManager.get(req);
    connect(reply, &QNetworkReply::finished, this, [reply, callback]() {
        reply->deleteLater();
        if (reply->error() == QNetworkReply::NoError) {
            QByteArray data = reply->readAll();
            callback(true, QString::fromUtf8(data), QString());
        } else {
            callback(false, QString(), reply->errorString());
        }
    });
}

} // namespace Risu
