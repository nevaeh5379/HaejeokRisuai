#pragma once

#include <QString>
#include <QList>
#include <QJsonObject>
#include <QJsonArray>

namespace Risu {

struct KnowledgeTriple {
    QString subject;
    QString predicate;
    QString object;
    float confidence = 1.0f;
    qint64 timestamp = 0;

    QJsonObject toJson() const {
        QJsonObject obj;
        obj[QStringLiteral("subject")] = subject;
        obj[QStringLiteral("predicate")] = predicate;
        obj[QStringLiteral("object")] = object;
        obj[QStringLiteral("confidence")] = confidence;
        obj[QStringLiteral("timestamp")] = timestamp;
        return obj;
    }

    static KnowledgeTriple fromJson(const QJsonObject& obj) {
        KnowledgeTriple t;
        t.subject = obj.value(QStringLiteral("subject")).toString();
        t.predicate = obj.value(QStringLiteral("predicate")).toString();
        t.object = obj.value(QStringLiteral("object")).toString();
        t.confidence = static_cast<float>(obj.value(QStringLiteral("confidence")).toDouble(1.0));
        t.timestamp = obj.value(QStringLiteral("timestamp")).toVariant().toLongLong();
        return t;
    }
};

class GraphMemory {
public:
    static GraphMemory& instance();

    void addTriple(const KnowledgeTriple& triple);
    void removeTriples(const QString& subject);
    QList<KnowledgeTriple> allTriples() const;
    void clear();

    // Query relevant knowledge triples mentioned in text
    QList<KnowledgeTriple> findRelevantTriples(const QString& queryText, int maxTriples = 6) const;

    // Format triples into LLM prompt context block
    static QString formatKnowledgeContext(const QList<KnowledgeTriple>& triples);

private:
    GraphMemory();
    QList<KnowledgeTriple> m_triples;
};

} // namespace Risu
