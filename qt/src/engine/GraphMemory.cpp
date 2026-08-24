#include "GraphMemory.hpp"
#include <QDateTime>
#include <algorithm>

namespace Risu {

GraphMemory& GraphMemory::instance() {
    static GraphMemory inst;
    return inst;
}

GraphMemory::GraphMemory() {
}

void GraphMemory::addTriple(const KnowledgeTriple& triple) {
    if (triple.subject.trimmed().isEmpty() || triple.object.trimmed().isEmpty()) return;

    for (auto& t : m_triples) {
        if (t.subject.compare(triple.subject, Qt::CaseInsensitive) == 0 &&
            t.predicate.compare(triple.predicate, Qt::CaseInsensitive) == 0 &&
            t.object.compare(triple.object, Qt::CaseInsensitive) == 0) {
            t.confidence = triple.confidence;
            t.timestamp = triple.timestamp > 0 ? triple.timestamp : QDateTime::currentMSecsSinceEpoch();
            return;
        }
    }

    KnowledgeTriple newT = triple;
    if (newT.timestamp == 0) {
        newT.timestamp = QDateTime::currentMSecsSinceEpoch();
    }
    m_triples.append(newT);
}

void GraphMemory::removeTriples(const QString& subject) {
    m_triples.removeIf([&subject](const KnowledgeTriple& t) {
        return t.subject.compare(subject, Qt::CaseInsensitive) == 0;
    });
}

QList<KnowledgeTriple> GraphMemory::allTriples() const {
    return m_triples;
}

void GraphMemory::clear() {
    m_triples.clear();
}

QList<KnowledgeTriple> GraphMemory::findRelevantTriples(const QString& queryText, int maxTriples) const {
    QList<KnowledgeTriple> matched;
    if (queryText.trimmed().isEmpty() || m_triples.isEmpty()) return matched;

    for (const auto& t : m_triples) {
        bool subHit = queryText.contains(t.subject, Qt::CaseInsensitive);
        bool objHit = queryText.contains(t.object, Qt::CaseInsensitive);
        if (subHit || objHit) {
            matched.append(t);
        }
    }

    // Sort by timestamp descending
    std::sort(matched.begin(), matched.end(), [](const KnowledgeTriple& a, const KnowledgeTriple& b) {
        return a.timestamp > b.timestamp;
    });

    if (matched.size() > maxTriples) {
        matched = matched.mid(0, maxTriples);
    }

    return matched;
}

QString GraphMemory::formatKnowledgeContext(const QList<KnowledgeTriple>& triples) {
    if (triples.isEmpty()) return QString();

    QStringList lines;
    lines.append(QStringLiteral("[Knowledge Graph Memory:"));
    for (const auto& t : triples) {
        lines.append(QStringLiteral("- %1 %2 %3").arg(t.subject, t.predicate, t.object));
    }
    lines.append(QStringLiteral("]"));

    return lines.join(QLatin1Char('\n'));
}

} // namespace Risu
