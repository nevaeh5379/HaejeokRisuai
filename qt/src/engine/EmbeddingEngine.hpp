#pragma once

#include <QString>
#include <QStringList>
#include <QList>
#include <QPair>
#include <cmath>

namespace Risu {

class EmbeddingEngine {
public:
    static float cosineSimilarity(const QList<float>& vecA, const QList<float>& vecB);

    static QList<float> computeTfIdfVector(const QString& text, const QStringList& vocabulary);

    static QStringList buildVocabulary(const QStringList& corpus);

    static QList<int> rankSimilarEntries(
        const QString& query,
        const QStringList& entryTexts,
        float minSimilarity = 0.2f,
        int topK = 5
    );
};

} // namespace Risu
