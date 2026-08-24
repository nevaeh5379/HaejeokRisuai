#include "RegexEngine.hpp"
#include <QRegularExpression>
#include <QDebug>

namespace Risu {

static QRegularExpression buildRegularExpression(const QString& rawPattern, const QString& explicitFlag) {
    QString pattern = rawPattern;
    QString flags = explicitFlag;

    // Check if pattern is in /pattern/flags format
    if (pattern.startsWith(QLatin1Char('/')) && pattern.length() > 2) {
        int lastSlash = pattern.lastIndexOf(QLatin1Char('/'));
        if (lastSlash > 0) {
            flags += pattern.mid(lastSlash + 1);
            pattern = pattern.mid(1, lastSlash - 1);
        }
    }

    QRegularExpression::PatternOptions options = QRegularExpression::NoPatternOption;
    if (flags.contains(QLatin1Char('i'), Qt::CaseInsensitive)) {
        options |= QRegularExpression::CaseInsensitiveOption;
    }
    if (flags.contains(QLatin1Char('m'), Qt::CaseInsensitive)) {
        options |= QRegularExpression::MultilineOption;
    }
    if (flags.contains(QLatin1Char('s'), Qt::CaseInsensitive)) {
        options |= QRegularExpression::DotMatchesEverythingOption;
    }

    return QRegularExpression(pattern, options);
}

static QString normalizeReplacementString(const QString& replaceStr) {
    QString result = replaceStr;
    // Replace $& or $0 with \0
    result.replace(QStringLiteral("$&"), QStringLiteral("\\0"));
    result.replace(QStringLiteral("$0"), QStringLiteral("\\0"));

    // Replace $1..$9 with \1..\9
    static const QRegularExpression dollarRe(QStringLiteral(R"(\$(\d+))"));
    result.replace(dollarRe, QStringLiteral("\\\\1")); // will be handled or replaced cleanly
    // More precisely:
    for (int i = 9; i >= 1; --i) {
        result.replace(QStringLiteral("$%1").arg(i), QStringLiteral("\\%1").arg(i));
    }

    return result;
}

QString RegexEngine::applyInChatRegex(const QString& input, const QList<RegexScript>& scripts) {
    return applyScripts(input, scripts, [](const RegexScript& s) {
        return s.enabled && (s.inChat || s.type == QStringLiteral("editdisplay") || s.type.isEmpty());
    });
}

QString RegexEngine::applyPreGenRegex(const QString& input, const QList<RegexScript>& scripts) {
    return applyScripts(input, scripts, [](const RegexScript& s) {
        return s.enabled && (s.preGen || s.type == QStringLiteral("editinput"));
    });
}

QString RegexEngine::applyPostGenRegex(const QString& input, const QList<RegexScript>& scripts) {
    return applyScripts(input, scripts, [](const RegexScript& s) {
        return s.enabled && (s.postGen || s.type == QStringLiteral("editoutput"));
    });
}

QString RegexEngine::applyScripts(const QString& input, const QList<RegexScript>& scripts, auto filterPredicate) {
    if (input.isEmpty() || scripts.isEmpty()) return input;

    QString result = input;
    for (const auto& s : scripts) {
        if (!filterPredicate(s)) continue;
        if (s.findRegex.isEmpty()) continue;

        try {
            QRegularExpression re = buildRegularExpression(s.findRegex, s.flag);
            if (re.isValid()) {
                QString replacement = normalizeReplacementString(s.replaceString);
                result.replace(re, replacement);
            } else {
                qWarning() << "Invalid regex script pattern:" << s.findRegex << re.errorString();
            }
        } catch (const std::exception& e) {
            qWarning() << "Regex error:" << e.what();
        } catch (...) {
            // Ignore invalid regex pattern
        }
    }
    return result;
}

} // namespace Risu
