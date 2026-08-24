#include "EmbeddingEngine.hpp"
#include <QRegularExpression>
#include <QSet>
#include <QMap>
#include <algorithm>

namespace Risu {

float EmbeddingEngine::cosineSimilarity(const QList<float>& vecA, const QList<float>& vecB) {
    if (vecA.isEmpty() || vecB.isEmpty() || vecA.size() != vecB.size()) return 0.0f;

    double dot = 0.0;
    double normA = 0.0;
    double normB = 0.0;

    for (qsizetype i = 0; i < vecA.size(); ++i) {
        dot += static_cast<double>(vecA[i]) * static_cast<double>(vecB[i]);
        normA += static_cast<double>(vecA[i]) * static_cast<double>(vecA[i]);
        normB += static_cast<double>(vecB[i]) * static_cast<double>(vecB[i]);
    }

    if (normA <= 0.0 || normB <= 0.0) return 0.0f;
    return static_cast<float>(dot / (std::sqrt(normA) * std::sqrt(normB)));
}

static QStringList tokenizeWords(const QString& text) {
    static const QRegularExpression wordRegex(QStringLiteral(R"([\p{L}\p{N}]+)"));
    QStringList tokens;
    auto it = wordRegex.globalMatch(text.toLower());
    while (it.hasNext()) {
        tokens.append(it.next().captured(0));
    }
    return tokens;
}

QStringList EmbeddingEngine::buildVocabulary(const QStringList& corpus) {
    QSet<QString> vocabSet;
    for (const auto& doc : corpus) {
        auto words = tokenizeWords(doc);
        for (const auto& w : words) {
            if (w.length() >= 2) {
                vocabSet.insert(w);
            }
        }
    }
    QStringList vocab = vocabSet.values();
    std::sort(vocab.begin(), vocab.end());
    return vocab;
}

QList<float> EmbeddingEngine::computeTfIdfVector(const QString& text, const QStringList& vocabulary) {
    QList<float> vec(vocabulary.size(), 0.0f);
    if (vocabulary.isEmpty()) return vec;

    auto words = tokenizeWords(text);
    if (words.isEmpty()) return vec;

    QMap<QString, int> termFreq;
    for (const auto& w : words) {
        termFreq[w]++;
    }

    for (qsizetype i = 0; i < vocabulary.size(); ++i) {
        const QString& term = vocabulary[i];
        if (termFreq.contains(term)) {
            // TF normalized by document length
            float tf = static_cast<float>(termFreq[term]) / static_cast<float>(words.size());
            vec[i] = tf;
        }
    }

    return vec;
}

QList<int> EmbeddingEngine::rankSimilarEntries(
    const QString& query,
    const QStringList& entryTexts,
    float minSimilarity,
    int topK
) {
    QList<int> results;
    if (query.trimmed().isEmpty() || entryTexts.isEmpty()) return results;

    QStringList allCorpus = entryTexts;
    allCorpus.append(query);

    QStringList vocab = buildVocabulary(allCorpus);
    if (vocab.isEmpty()) return results;

    QList<float> queryVec = computeTfIdfVector(query, vocab);

    struct ScoredIndex {
        int index;
        float score;
    };
    QList<ScoredIndex> scored;

    for (int i = 0; i < entryTexts.size(); ++i) {
        QList<float> entryVec = computeTfIdfVector(entryTexts[i], vocab);
        float sim = cosineSimilarity(queryVec, entryVec);
        if (sim >= minSimilarity) {
            scored.append({i, sim});
        }
    }

    std::sort(scored.begin(), scored.end(), [](const ScoredIndex& a, const ScoredIndex& b) {
        return a.score > b.score;
    });

    for (int i = 0; i < std::min(static_cast<int>(scored.size()), topK); ++i) {
        results.append(scored[i].index);
    }

    return results;
}

} // namespace Risu
