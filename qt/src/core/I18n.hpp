#pragma once

#include <QObject>
#include <QString>
#include <QHash>

namespace Risu {

class I18n : public QObject {
    Q_OBJECT

    Q_PROPERTY(QString language READ language WRITE setLanguage NOTIFY languageChanged)

public:
    static I18n& instance();

    QString language() const { return m_language; }
    void setLanguage(const QString& lang);

    Q_INVOKABLE QString t(const QString& key, const QString& defaultText = QString()) const;

signals:
    void languageChanged();

private:
    explicit I18n(QObject* parent = nullptr);
    void initTranslations();

    QString m_language = QStringLiteral("ko"); // Default Korean
    QHash<QString, QHash<QString, QString>> m_dict;
};

} // namespace Risu
