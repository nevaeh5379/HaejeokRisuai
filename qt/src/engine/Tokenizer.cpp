#include "Tokenizer.hpp"

namespace Risu {

int Tokenizer::estimateTokens(const QString& text) {
    if (text.isEmpty()) {
        return 0;
    }

    // Advanced token estimation rule:
    // - English / Latin words: ~0.75 tokens per word or ~4 chars per token
    // - CJK / Korean Hangul: ~1.2 - 1.8 tokens per char
    // - Punctuation / spaces / symbols
    int tokens = 0;
    int latinChars = 0;
    int cjkChars = 0;
    int spacesAndPunct = 0;

    for (const QChar& ch : text) {
        ushort u = ch.unicode();
        if ((u >= 0xAC00 && u <= 0xD7AF) || // Korean Hangul Syllables
            (u >= 0x1100 && u <= 0x11FF) || // Hangul Jamo
            (u >= 0x3130 && u <= 0x318F) || // Hangul Compatibility Jamo
            (u >= 0x4E00 && u <= 0x9FFF) || // CJK Unified Ideographs
            (u >= 0x3040 && u <= 0x309F) || // Hiragana
            (u >= 0x30A0 && u <= 0x30FF)) {  // Katakana
            cjkChars++;
        } else if (ch.isLetterOrNumber()) {
            latinChars++;
        } else {
            spacesAndPunct++;
        }
    }

    tokens += (cjkChars * 15) / 10; // ~1.5 tokens per CJK char
    tokens += (latinChars + 3) / 4;  // ~4 chars per token
    tokens += (spacesAndPunct + 2) / 3;

    return qMax(1, tokens);
}

int Tokenizer::estimateTokens(const QStringList& texts) {
    int total = 0;
    for (const QString& t : texts) {
        total += estimateTokens(t);
    }
    return total;
}

} // namespace Risu
