#pragma once

#include <QObject>
#include <QString>
#include <QJsonObject>
#include <functional>

namespace Risu {

struct BackupImportResult {
    bool success = false;
    int charactersCount = 0;
    int presetsCount = 0;
    int personasCount = 0;
    int lorebooksCount = 0;
    int assetsCount = 0;
    int coldStorageCount = 0;
    QString errorMessage;
};

class BackupLoader : public QObject {
    Q_OBJECT

public:
    explicit BackupLoader(QObject* parent = nullptr);

    // Synchronous or asynchronous import
    BackupImportResult importBackupFile(const QString& filePath, std::function<void(int current, int total, const QString& status)> progressCb = nullptr);

    // Static helper to test and load
    static bool isBinaryBackup(const QString& filePath);
    static bool isJsonBackup(const QString& filePath);

signals:
    void progress(int current, int total, const QString& message);
    void finished(bool success, const QString& summary);

private:
    BackupImportResult importBinaryBackup(const QString& filePath, std::function<void(int, int, const QString&)> progressCb);
    BackupImportResult importJsonBackup(const QString& filePath, std::function<void(int, int, const QString&)> progressCb);
};

} // namespace Risu
