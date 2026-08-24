#pragma once

#include <QString>
#include <QList>
#include "../core/Types.hpp"

namespace Risu {

class RegexEngine {
public:
    static QString applyInChatRegex(const QString& input, const QList<RegexScript>& scripts);
    static QString applyPreGenRegex(const QString& input, const QList<RegexScript>& scripts);
    static QString applyPostGenRegex(const QString& input, const QList<RegexScript>& scripts);

private:
    static QString applyScripts(const QString& input, const QList<RegexScript>& scripts, auto filterPredicate);
};

} // namespace Risu
