#pragma once

#include <QString>
#include <QStringList>

namespace Risu {

class Tokenizer {
public:
    // Estimate token count with high accuracy for multi-language text (English, Korean, Japanese, Chinese, code)
    static int estimateTokens(const QString& text);
    static int estimateTokens(const QStringList& texts);
};

} // namespace Risu
