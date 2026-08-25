#include "PromptEngine.hpp"
#include "Tokenizer.hpp"
#include "ScriptingEngine.hpp"
#include "EmbeddingEngine.hpp"
#include "ModuleEngine.hpp"
#include "../core/AppConfig.hpp"
#include <QDateTime>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <algorithm>
#include <QSet>

namespace Risu {

// Helper: Format DateTime with tokens
static QString formatDateTimePattern(const QDateTime& dt, const QString& pattern) {
    QString res = pattern;
    res.replace(QStringLiteral("YYYY"), dt.toString(QStringLiteral("yyyy")));
    res.replace(QStringLiteral("YY"), dt.toString(QStringLiteral("yy")));
    res.replace(QStringLiteral("MMMM"), dt.toString(QStringLiteral("MMMM")));
    res.replace(QStringLiteral("MMM"), dt.toString(QStringLiteral("MMM")));
    res.replace(QStringLiteral("MM"), dt.toString(QStringLiteral("MM")));
    res.replace(QStringLiteral("DD"), dt.toString(QStringLiteral("dd")));
    res.replace(QStringLiteral("dddd"), dt.toString(QStringLiteral("dddd")));
    res.replace(QStringLiteral("ddd"), dt.toString(QStringLiteral("ddd")));
    res.replace(QStringLiteral("HH"), dt.toString(QStringLiteral("HH")));
    res.replace(QStringLiteral("hh"), dt.toString(QStringLiteral("hh")));
    res.replace(QStringLiteral("mm"), dt.toString(QStringLiteral("mm")));
    res.replace(QStringLiteral("ss"), dt.toString(QStringLiteral("ss")));
    res.replace(QStringLiteral("A"), dt.toString(QStringLiteral("AP")));
    return res;
}

QString PromptEngine::replaceMacros(
    const QString& text,
    const Character& character,
    const Persona& persona,
    const Chat* chat,
    const Preset* preset
) {
    if (text.isEmpty()) return QString();

    static const Preset emptyPreset;
    const Preset& promptPreset = preset ? *preset : emptyPreset;
    QString result = text;
    QString charName = character.name.isEmpty() ? QStringLiteral("Character") : character.name;
    QString userName = persona.name.isEmpty() ? QStringLiteral("User") : persona.name;
    QString personaDesc = persona.personaPrompt.isEmpty() ? persona.description : persona.personaPrompt;
    QString mainPromptSource = promptPreset.mainPrompt.isEmpty() ? character.systemPrompt : promptPreset.mainPrompt;
    QString jailbreakSource = promptPreset.jailbreakPrompt;
    QString globalNoteSource = character.replaceGlobalNote;
    if (!globalNoteSource.isEmpty()) {
        globalNoteSource.replace(QStringLiteral("{{original}}"), promptPreset.globalNote, Qt::CaseInsensitive);
    } else {
        globalNoteSource = promptPreset.globalNote;
    }

    // Basic Character & User macros
    result.replace(QStringLiteral("{{char}}"), charName, Qt::CaseInsensitive);
    result.replace(QStringLiteral("<CHAR>"), charName, Qt::CaseInsensitive);
    result.replace(QStringLiteral("<char>"), charName, Qt::CaseInsensitive);

    result.replace(QStringLiteral("{{user}}"), userName, Qt::CaseInsensitive);
    result.replace(QStringLiteral("<USER>"), userName, Qt::CaseInsensitive);
    result.replace(QStringLiteral("<user>"), userName, Qt::CaseInsensitive);

    result.replace(QStringLiteral("{{persona}}"), personaDesc, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{user_persona}}"), personaDesc, Qt::CaseInsensitive);

    result.replace(QStringLiteral("{{description}}"), character.description, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{personality}}"), character.personality, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{scenario}}"), character.scenario, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{creator}}"), character.creator, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{creator_notes}}"), character.creatorNotes, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{char_version}}"), character.characterVersion, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{exampledialogue}}"), character.exampleMessage, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{mainprompt}}"), mainPromptSource, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{jb}}"), jailbreakSource, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{globalnote}}"), globalNoteSource, Qt::CaseInsensitive);

    // Date / Time macros
    QDateTime now = QDateTime::currentDateTime();
    result.replace(QStringLiteral("{{time}}"), now.toString(QStringLiteral("hh:mm")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{date}}"), now.toString(QStringLiteral("yyyy-MM-dd")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{isotime}}"), now.toString(Qt::ISODate), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{isodate}}"), now.toString(QStringLiteral("yyyy-MM-dd")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{year}}"), now.toString(QStringLiteral("yyyy")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{month}}"), now.toString(QStringLiteral("MM")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{day}}"), now.toString(QStringLiteral("dd")), Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{weekday}}"), now.toString(QStringLiteral("dddd")), Qt::CaseInsensitive);

    // Custom Datetime: {{datetime:YYYY-MM-DD HH:mm:ss}}
    static QRegularExpression dtRe(QStringLiteral(R"(\{\{datetime:([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto dtMatch = dtRe.match(result);
    while (dtMatch.hasMatch()) {
        QString pattern = dtMatch.captured(1);
        QString formatted = formatDateTimePattern(now, pattern);
        result.replace(dtMatch.captured(0), formatted);
        dtMatch = dtRe.match(result);
    }

    // Message History context macros: {{lastMessage}}, {{lastUserMessage}}, {{lastCharMessage}}
    if (chat && !chat->messages.isEmpty()) {
        QString lastMsg = chat->messages.last().currentContent();
        QString lastUserMsg;
        QString lastCharMsg;
        for (int i = chat->messages.size() - 1; i >= 0; --i) {
            if (chat->messages[i].role == Role::User && lastUserMsg.isEmpty()) {
                lastUserMsg = chat->messages[i].currentContent();
            }
            if (chat->messages[i].role == Role::Assistant && lastCharMsg.isEmpty()) {
                lastCharMsg = chat->messages[i].currentContent();
            }
            if (!lastUserMsg.isEmpty() && !lastCharMsg.isEmpty()) break;
        }
        result.replace(QStringLiteral("{{lastMessage}}"), lastMsg, Qt::CaseInsensitive);
        result.replace(QStringLiteral("{{lastUserMessage}}"), lastUserMsg, Qt::CaseInsensitive);
        result.replace(QStringLiteral("{{lastCharMessage}}"), lastCharMsg, Qt::CaseInsensitive);
    } else {
        result.replace(QStringLiteral("{{lastMessage}}"), QString(), Qt::CaseInsensitive);
        result.replace(QStringLiteral("{{lastUserMessage}}"), QString(), Qt::CaseInsensitive);
        result.replace(QStringLiteral("{{lastCharMessage}}"), QString(), Qt::CaseInsensitive);
    }

    // Random macro: {{random:opt1,opt2,opt3}} or {{pick:opt1,opt2,opt3}}
    static QRegularExpression randRe(QStringLiteral(R"(\{\{(?:random|pick):([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto match = randRe.match(result);
    while (match.hasMatch()) {
        QStringList options = match.captured(1).split(QLatin1Char(','));
        QString picked;
        if (!options.isEmpty()) {
            int idx = QRandomGenerator::global()->bounded(options.size());
            picked = options[idx].trimmed();
        }
        result.replace(match.captured(0), picked);
        match = randRe.match(result);
    }

    // Dice roll macro: {{roll:1d20}} or {{roll:2d6}} or {{roll:1d100}}
    static QRegularExpression rollRe(QStringLiteral(R"(\{\{roll:(\d+)d(\d+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto rollMatch = rollRe.match(result);
    while (rollMatch.hasMatch()) {
        int count = qMax(1, qMin(100, rollMatch.captured(1).toInt()));
        int sides = qMax(1, qMin(1000, rollMatch.captured(2).toInt()));
        int total = 0;
        for (int i = 0; i < count; ++i) {
            total += (QRandomGenerator::global()->bounded(sides) + 1);
        }
        result.replace(rollMatch.captured(0), QString::number(total));
        rollMatch = rollRe.match(result);
    }

    // Chat variables: {{setvar::key::value}}
    static QRegularExpression setVarRe(QStringLiteral(R"(\{\{setvar::([^:]+)::([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto setVarMatch = setVarRe.match(result);
    while (setVarMatch.hasMatch()) {
        QString key = setVarMatch.captured(1).trimmed();
        QString val = setVarMatch.captured(2).trimmed();
        if (chat) {
            const_cast<Chat*>(chat)->chatVariables[key] = val;
        }
        result.replace(setVarMatch.captured(0), QString()); // Silent set
        setVarMatch = setVarRe.match(result);
    }

    // Chat variables: {{getvar::key}} or {{getvar:key}}
    static QRegularExpression getVarRe(QStringLiteral(R"(\{\{getvar(?:::|:)([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto getVarMatch = getVarRe.match(result);
    while (getVarMatch.hasMatch()) {
        QString key = getVarMatch.captured(1).trimmed();
        QString val;
        if (chat && chat->chatVariables.contains(key)) {
            val = chat->chatVariables.value(key);
        }
        result.replace(getVarMatch.captured(0), val);
        getVarMatch = getVarRe.match(result);
    }

    // Helper lambda to find asset URL/path for a given asset name
    auto resolveAssetSrc = [&](const QString& assetName) -> QString {
        QString cleanName = assetName.trimmed();
        QString lowerName = cleanName.toLower();

        // 1. Check emotionSprites
        if (character.emotionSprites.contains(lowerName)) {
            QString path = character.emotionSprites.value(lowerName);
            QString resolved = AppConfig::instance().resolveAssetPath(path);
            return resolved.startsWith(QLatin1String("file://")) ? resolved : (QStringLiteral("file://") + resolved);
        }

        // 2. Check emotionImages pairs
        for (const auto& pair : character.emotionImages) {
            if (pair.first.compare(cleanName, Qt::CaseInsensitive) == 0 || pair.first.compare(lowerName, Qt::CaseInsensitive) == 0) {
                QString resolved = AppConfig::instance().resolveAssetPath(pair.second);
                return resolved.startsWith(QLatin1String("file://")) ? resolved : (QStringLiteral("file://") + resolved);
            }
        }

        // 3. Check AppConfig assets directory directly
        QString directPath = AppConfig::instance().resolveAssetPath(cleanName);
        if (!directPath.isEmpty()) {
            return directPath.startsWith(QLatin1String("file://")) ? directPath : (QStringLiteral("file://") + directPath);
        }
        return QString();
    };

    // CBS Asset path macros: {{raw::assetName}}, {{raw:assetName}}, {{path::assetName}}, {{path:assetName}}
    static QRegularExpression rawAssetRe(QStringLiteral(R"(\{\{(?:raw|path)(?:::|:)([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto rawMatch = rawAssetRe.match(result);
    while (rawMatch.hasMatch()) {
        QString assetName = rawMatch.captured(1).trimmed();
        QString src = resolveAssetSrc(assetName);
        result.replace(rawMatch.captured(0), src);
        rawMatch = rawAssetRe.match(result);
    }

    // CBS Image element macros: {{image::assetName}}, {{img::assetName}}, {{image:assetName}}, {{img:assetName}}, {{asset::assetName}}, {{emotion::assetName}}
    static QRegularExpression imgAssetRe(QStringLiteral(R"(\{\{(?:image|img|asset|emotion)(?:::|:)([^}]+)\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto imgMatch = imgAssetRe.match(result);
    while (imgMatch.hasMatch()) {
        QString assetName = imgMatch.captured(1).trimmed();
        QString src = resolveAssetSrc(assetName);
        if (!src.isEmpty()) {
            result.replace(imgMatch.captured(0), QStringLiteral("<img src=\"%1\" alt=\"%2\" style=\"max-width:100%; border-radius:8px; margin:4px 0;\"/>").arg(src, assetName));
        } else {
            result.replace(imgMatch.captured(0), QString());
        }
        imgMatch = imgAssetRe.match(result);
    }

    // CBS Source macros: {{source::char}}, {{source::user}}
    QString charAvatarUrl = AppConfig::instance().resolveAssetPath(character.avatarPath);
    if (!charAvatarUrl.startsWith(QLatin1String("file://")) && !charAvatarUrl.isEmpty()) {
        charAvatarUrl = QStringLiteral("file://") + charAvatarUrl;
    }
    QString userAvatarUrl = AppConfig::instance().resolveAssetPath(persona.avatarPath);
    if (!userAvatarUrl.startsWith(QLatin1String("file://")) && !userAvatarUrl.isEmpty()) {
        userAvatarUrl = QStringLiteral("file://") + userAvatarUrl;
    }
    result.replace(QStringLiteral("{{source::char}}"), charAvatarUrl, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{source:char}}"), charAvatarUrl, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{source::user}}"), userAvatarUrl, Qt::CaseInsensitive);
    result.replace(QStringLiteral("{{source:user}}"), userAvatarUrl, Qt::CaseInsensitive);

    // Conditional blocks: {{#if var}}content{{/if}} and {{#if !var}}content{{/if}}
    static QRegularExpression ifBlockRe(QStringLiteral(R"(\{\{#if\s+(!?)([^}]+)\}\}([\s\S]*?)\{\{/if\}\})"), QRegularExpression::CaseInsensitiveOption);
    auto ifMatch = ifBlockRe.match(result);
    while (ifMatch.hasMatch()) {
        bool isNegated = (ifMatch.captured(1) == QStringLiteral("!"));
        QString varName = ifMatch.captured(2).trimmed();
        QString content = ifMatch.captured(3);

        bool varTruth = false;
        if (chat && chat->chatVariables.contains(varName)) {
            QString val = chat->chatVariables.value(varName).trimmed();
            varTruth = (!val.isEmpty() && val != QStringLiteral("0") && val != QStringLiteral("false"));
        } else if (varName.compare(QStringLiteral("true"), Qt::CaseInsensitive) == 0 || varName == QStringLiteral("1")) {
            varTruth = true;
        }

        bool conditionPassed = isNegated ? !varTruth : varTruth;
        result.replace(ifMatch.captured(0), conditionPassed ? content : QString());
        ifMatch = ifBlockRe.match(result);
    }

    if (chat) {
        Chat mutChat = *chat;
        result = ScriptingEngine::processScriptBlocks(result, mutChat, character, persona);
    } else {
        Chat emptyChat;
        result = ScriptingEngine::processScriptBlocks(result, emptyChat, character, persona);
    }

    return result;
}

QString PromptEngine::scanAndInjectLorebooks(
    const QList<LorebookEntry>& lorebooks,
    const QList<Message>& messages,
    const Character& character,
    const Persona& persona,
    const Chat* chat
) {
    if (lorebooks.isEmpty()) return QString();

    int msgCount = messages.size();
    const int chatLength = msgCount + 1;

    struct LoreDirective {
        bool activated = true;
        bool forceActivate = false;
        bool forceDeactivate = false;
        int scanDepth = 0;
        int priority = 0;
        int probability = -1;
        int activateAfter = -1;
    };

    auto parseLoreDirective = [](const QString& rawContent, LoreDirective& directive) {
        QString content;
        static const QRegularExpression lineRe(QStringLiteral("(?m)^@@@?([^\\n]+)(?:\\n|$)"));
        qsizetype offset = 0;
        while (true) {
            const QRegularExpressionMatch match = lineRe.match(rawContent, offset);
            if (!match.hasMatch()) break;
            content += rawContent.mid(offset, match.capturedStart() - offset);
            offset = match.capturedEnd();

            const QString directiveText = match.captured(1).trimmed();
            const QStringList args = directiveText.split(QRegularExpression(QStringLiteral("\\s+")), Qt::SkipEmptyParts);
            if (args.isEmpty()) continue;
            const QString name = args.first().toLower();
            const int value = args.size() > 1 ? args.value(1).toInt() : 0;

            if (name == QStringLiteral("probability")) {
                directive.probability = qBound(0, value, 100);
            } else if (name == QStringLiteral("activate_only_after")) {
                directive.activateAfter = qMax(1, value);
            } else if (name == QStringLiteral("priority") || name == QStringLiteral("ignore_on_max_context")) {
                directive.priority = name == QStringLiteral("ignore_on_max_context") ? -1000 : value;
            } else if (name == QStringLiteral("scan_depth")) {
                directive.scanDepth = qMax(0, value);
            } else if (name == QStringLiteral("dont_activate")) {
                directive.forceDeactivate = true;
            } else if (name == QStringLiteral("activate")) {
                directive.forceActivate = true;
            }
        }
        content += rawContent.mid(offset);
        return content.trimmed();
    };

    struct ActiveEntry {
        int order;
        QString id;
        QString content;
    };
    QList<ActiveEntry> activeList;
    QSet<QString> activeIds;

    auto checkKeysMatch = [](const QString& keyString, const QString& scanText, bool useRegex, bool caseSensitive) -> bool {
        if (keyString.isEmpty()) return false;
        QStringList keys = keyString.split(QLatin1Char(','), Qt::SkipEmptyParts);
        for (QString k : keys) {
            k = k.trimmed();
            if (k.isEmpty()) continue;
            
            // Check for negative trigger: !keyword
            if (k.startsWith(QLatin1Char('!'))) {
                QString negKey = k.mid(1).trimmed();
                if (!negKey.isEmpty()) {
                    if (useRegex) {
                        QRegularExpression re(negKey, caseSensitive ? QRegularExpression::NoPatternOption : QRegularExpression::CaseInsensitiveOption);
                        if (re.match(scanText).hasMatch()) return false; // Negative trigger hit!
                    } else {
                        if (scanText.contains(negKey, caseSensitive ? Qt::CaseSensitive : Qt::CaseInsensitive)) {
                            return false; // Negative trigger hit!
                        }
                    }
                }
                continue;
            }

            if (useRegex) {
                QRegularExpression re(k, caseSensitive ? QRegularExpression::NoPatternOption : QRegularExpression::CaseInsensitiveOption);
                if (re.match(scanText).hasMatch()) return true;
            } else {
                if (scanText.contains(k, caseSensitive ? Qt::CaseSensitive : Qt::CaseInsensitive)) {
                    return true;
                }
            }
        }
        return false;
    };

    // First pass: scan messages
    for (const auto& entry : lorebooks) {
        if (!entry.enabled) continue;

        LoreDirective directive;
        directive.scanDepth = entry.scanDepth;
        directive.priority = entry.insertOrder;
        QString content = parseLoreDirective(entry.content, directive);
        if (directive.probability >= 0 && QRandomGenerator::global()->bounded(100) >= directive.probability)
            directive.activated = false;
        if (directive.forceDeactivate) directive.activated = false;
        if (directive.forceActivate) {
            directive.activated = true;
            directive.forceDeactivate = false;
        }

        bool forced = entry.alwaysActive || entry.mode == QStringLiteral("constant");
        if (forced) {
            directive.forceDeactivate = false;
            directive.activateAfter = -1;
            directive.probability = -1;
        } else {
            int depth = qMax(1, qMin(directive.scanDepth, msgCount));
            QString scanText;
            for (int i = qMax(0, msgCount - depth); i < msgCount; ++i) {
                scanText += QLatin1Char('\n') + messages[i].currentContent();
            }

            if (entry.mode == QStringLiteral("vector") || entry.mode == QStringLiteral("embedding")) {
                QString entryCorpus = entry.key + QStringLiteral(" ") + entry.content;
                auto ranked = EmbeddingEngine::rankSimilarEntries(scanText, QStringList{entryCorpus}, 0.15f, 1);
                directive.activated = !ranked.isEmpty();
            } else {
                bool primaryMatch = checkKeysMatch(entry.key, scanText, entry.useRegex, entry.caseSensitive);
                if (primaryMatch) {
                    if (entry.selective && !entry.secondKey.isEmpty()) {
                        directive.activated = checkKeysMatch(entry.secondKey, scanText, entry.useRegex, entry.caseSensitive);
                    } else {
                        directive.activated = true;
                    }
                }
            }
        }

        if (directive.activated && !content.isEmpty() && !activeIds.contains(entry.id)) {
            activeList.append({directive.priority, entry.id, replaceMacros(content, character, persona, chat)});
            activeIds.insert(entry.id);
        }
    }

    // Second pass: Cascade / Recursive activation
    QString cascadeScanText;
    for (const auto& a : activeList) {
        cascadeScanText += QLatin1Char('\n') + a.content;
    }

    for (const auto& entry : lorebooks) {
        if (!entry.enabled || activeIds.contains(entry.id)) continue;
        if (entry.alwaysActive || entry.mode == QStringLiteral("constant")) continue;

        LoreDirective directive;
        directive.scanDepth = entry.scanDepth;
        directive.priority = entry.insertOrder;
        QString content = parseLoreDirective(entry.content, directive);
        if (directive.activateAfter >= 0 && chatLength < directive.activateAfter)
            continue;
        if (directive.forceDeactivate)
            continue;

        bool primaryMatch = checkKeysMatch(entry.key, cascadeScanText, entry.useRegex, entry.caseSensitive);
        if (primaryMatch) {
            if (entry.selective && !entry.secondKey.isEmpty()) {
                if (checkKeysMatch(entry.secondKey, cascadeScanText, entry.useRegex, entry.caseSensitive)) {
                    activeList.append({directive.priority, entry.id, replaceMacros(content, character, persona, chat)});
                    activeIds.insert(entry.id);
                }
            } else {
                activeList.append({directive.priority, entry.id, replaceMacros(content, character, persona, chat)});
                activeIds.insert(entry.id);
            }
        }
    }

    // Sort by insertOrder
    std::sort(activeList.begin(), activeList.end(), [](const ActiveEntry& a, const ActiveEntry& b) {
        return a.order < b.order;
    });

    QStringList resultParts;
    for (const auto& item : activeList) {
        resultParts.append(item.content);
    }

    return resultParts.join(QStringLiteral("\n\n"));
}

CompiledPrompt PromptEngine::buildPrompt(
    const Character& character,
    const Chat& chat,
    const Preset& preset,
    const Persona& persona,
    const QList<LorebookEntry>& globalLorebooks,
    const QString& extraUserMessage
) {
    CompiledPrompt result;

    // Combine all lorebooks (character global lore + chat local lore + global db lore)
    QList<LorebookEntry> allLore;
    allLore.append(globalLorebooks);
    allLore.append(character.globalLore);
    allLore.append(chat.localLore);
    const ActiveModuleData moduleData = ModuleEngine::resolveActiveModules(character, chat);
    allLore.append(moduleData.lorebooks);

    // Build system sections
    const Preset* promptPreset = &preset;
    QString mainPrompt = replaceMacros(preset.mainPrompt.isEmpty() ? character.systemPrompt : preset.mainPrompt, character, persona, &chat, promptPreset);
    QString charDesc = replaceMacros(character.description, character, persona, &chat, promptPreset);
    QString charPersonality = replaceMacros(character.personality, character, persona, &chat, promptPreset);
    QString charScenario = replaceMacros(character.scenario, character, persona, &chat, promptPreset);
    // In Risu, Persona::description maps to the persona "note" field while
    // Persona::personaPrompt is the text that is actually injected into prompts.
    // Fall back to description only for older native-Qt data created before the
    // personaPrompt field was wired through the editor/controller.
    const QString personaPromptSource = persona.personaPrompt.isEmpty() ? persona.description : persona.personaPrompt;
    QString personaPrompt = replaceMacros(personaPromptSource, character, persona, &chat, promptPreset);
    QString jailbreakPrompt = preset.enableJailbreak ? replaceMacros(preset.jailbreakPrompt, character, persona, &chat, promptPreset) : QString();
    QString globalNote = character.replaceGlobalNote;
    if (!globalNote.isEmpty()) {
        globalNote.replace(QStringLiteral("{{original}}"), preset.globalNote, Qt::CaseInsensitive);
    } else {
        globalNote = preset.globalNote;
    }
    globalNote = replaceMacros(globalNote, character, persona, &chat, promptPreset);
    QString postHistoryInstructions = replaceMacros(preset.postHistoryInstructions, character, persona, &chat, promptPreset);

    // Lorebook injection
    QString loreContent = scanAndInjectLorebooks(allLore, chat.messages, character, persona, &chat);
    result.breakdown.lorebookTokens = Tokenizer::estimateTokens(loreContent);

    // Legacy presets use formatingOrder. Modern Risu presets use promptTemplate,
    // which is an executable sequence and must be assembled after chatHistory exists.
    if (preset.promptTemplate.isEmpty()) {
    // Assemble system prompt in specified formatting order
    QStringList systemBlocks;
    QStringList order = preset.formattingOrder;
    if (order.isEmpty()) {
        order = QStringList{
            QStringLiteral("main"),
            QStringLiteral("description"),
            QStringLiteral("personality"),
            QStringLiteral("scenario"),
            QStringLiteral("personaPrompt"),
            QStringLiteral("lorebook"),
            QStringLiteral("jailbreak"),
            QStringLiteral("globalNote")
        };
    }

    for (const QString& item : order) {
        if (item == QStringLiteral("main") && !mainPrompt.isEmpty()) {
            systemBlocks.append(mainPrompt);
        } else if (item == QStringLiteral("description") && !charDesc.isEmpty()) {
            systemBlocks.append(QStringLiteral("[Description of {{char}}:\n") + charDesc + QStringLiteral("]"));
        } else if (item == QStringLiteral("personality") && !charPersonality.isEmpty()) {
            systemBlocks.append(QStringLiteral("[Personality of {{char}}:\n") + charPersonality + QStringLiteral("]"));
        } else if (item == QStringLiteral("scenario") && !charScenario.isEmpty()) {
            systemBlocks.append(QStringLiteral("[Scenario:\n") + charScenario + QStringLiteral("]"));
        } else if (item == QStringLiteral("personaPrompt") && !personaPrompt.isEmpty()) {
            systemBlocks.append(QStringLiteral("[User Persona:\n") + personaPrompt + QStringLiteral("]"));
        } else if (item == QStringLiteral("lorebook") && !loreContent.isEmpty()) {
            systemBlocks.append(QStringLiteral("[World & Context Info:\n") + loreContent + QStringLiteral("]"));
        } else if (item == QStringLiteral("jailbreak") && !jailbreakPrompt.isEmpty()) {
            systemBlocks.append(jailbreakPrompt);
        } else if (item == QStringLiteral("globalNote") && !globalNote.isEmpty()) {
            systemBlocks.append(globalNote);
        }
    }

    QString systemPromptCombined = replaceMacros(systemBlocks.join(QStringLiteral("\n\n")), character, persona, &chat, promptPreset);
    result.systemPromptCombined = systemPromptCombined;
    result.breakdown.systemTokens = Tokenizer::estimateTokens(systemPromptCombined);

    // Add System Message to compiled list
    if (!systemPromptCombined.trimmed().isEmpty()) {
        CompiledPromptMessage sysMsg;
        sysMsg.role = QStringLiteral("system");
        sysMsg.content = systemPromptCombined;
        result.messages.append(sysMsg);
    }

    // Add Example Dialogue if provided
    if (!character.exampleMessage.isEmpty()) {
        QString processedExamples = replaceMacros(character.exampleMessage, character, persona, &chat, promptPreset);
        CompiledPromptMessage exMsg;
        exMsg.role = QStringLiteral("system");
        exMsg.content = QStringLiteral("<START>\n") + processedExamples;
        result.messages.append(exMsg);
        result.breakdown.systemTokens += Tokenizer::estimateTokens(exMsg.content);
    }
    } // legacy formatingOrder assembly

    // First greeting message
    QString greeting;
    if (chat.firstMessageIndex >= 0 && chat.firstMessageIndex < character.alternateGreetings.size()) {
        greeting = character.alternateGreetings[chat.firstMessageIndex];
    } else {
        greeting = character.firstMessage;
    }
    if (!greeting.isEmpty()) {
        greeting = replaceMacros(greeting, character, persona, &chat, promptPreset);
    }

    // Build dialogue turns from messages
    QList<CompiledPromptMessage> chatHistory;

    if (chat.messages.isEmpty() && !greeting.isEmpty()) {
        CompiledPromptMessage fm;
        fm.role = QStringLiteral("assistant");
        fm.name = character.name;
        fm.content = greeting;
        chatHistory.append(fm);
    }

    for (const auto& msg : chat.messages) {
        if (msg.disabled) continue;
        if (msg.isComment) continue;

        CompiledPromptMessage m;
        m.role = (msg.role == Role::User) ? QStringLiteral("user") : QStringLiteral("assistant");
        m.name = msg.name.isEmpty() ? (msg.role == Role::User ? persona.name : character.name) : msg.name;
        m.content = replaceMacros(msg.currentContent(), character, persona, &chat, promptPreset);
        chatHistory.append(m);
    }

    // Add extra user message if generating
    if (!extraUserMessage.isEmpty()) {
        CompiledPromptMessage extra;
        extra.role = QStringLiteral("user");
        extra.name = persona.name;
        extra.content = replaceMacros(extraUserMessage, character, persona, &chat, promptPreset);
        chatHistory.append(extra);
    }

    // Modern Risu promptTemplate execution. The old port loaded this JSON but then
    // completely ignored it, so imported presets silently generated a different prompt.
    if (!preset.promptTemplate.isEmpty()) {
        QList<CompiledPromptMessage> templatedMessages;
        QList<bool> removableHistory;

        auto normalizeTemplateRole = [](QString role) {
            role = role.trimmed().toLower();
            if (role == QStringLiteral("user")) return QStringLiteral("user");
            if (role == QStringLiteral("bot") || role == QStringLiteral("assistant") || role == QStringLiteral("char")) {
                return QStringLiteral("assistant");
            }
            return QStringLiteral("system");
        };

        auto appendTemplateMessage = [&](const QString& role, const QString& content,
                                         const QString& name = QString(), bool isHistory = false) {
            if (content.trimmed().isEmpty()) return;
            CompiledPromptMessage msg;
            msg.role = role;
            msg.content = content;
            msg.name = name;
            templatedMessages.append(msg);
            removableHistory.append(isHistory);
        };

        auto wrapSlot = [&](QString format, const QString& slot) {
            if (format.isEmpty()) return slot;
            format = replaceMacros(format, character, persona, &chat, promptPreset);
            format.replace(QStringLiteral("{{slot}}"), slot);
            return format;
        };

        auto parseChatML = [&](QString data) {
            QList<CompiledPromptMessage> parsed;
            const QString starter = QStringLiteral("<|im_start|>");
            const QString separator = QStringLiteral("<|im_sep|>");
            const QString ender = QStringLiteral("<|im_end|>");
            data = data.trimmed();
            if (!data.startsWith(starter)) return parsed;

            const QStringList blocks = data.split(starter, Qt::SkipEmptyParts);
            static const QRegularExpression thoughtsRe(
                QStringLiteral(R"(<Thoughts>(.+)</Thoughts>)"),
                QRegularExpression::DotMatchesEverythingOption);

            for (QString block : blocks) {
                QString role = QStringLiteral("user");
                auto consumeRole = [&](const QString& prefix, const QString& resolvedRole) {
                    if (!block.startsWith(prefix)) return false;
                    role = resolvedRole;
                    block = block.mid(prefix.size());
                    return true;
                };

                if (!consumeRole(QStringLiteral("user") + separator, QStringLiteral("user")) &&
                    !consumeRole(QStringLiteral("system") + separator, QStringLiteral("system")) &&
                    !consumeRole(QStringLiteral("assistant") + separator, QStringLiteral("assistant")) &&
                    !consumeRole(QStringLiteral("user "), QStringLiteral("user")) &&
                    !consumeRole(QStringLiteral("user\n"), QStringLiteral("user")) &&
                    !consumeRole(QStringLiteral("system "), QStringLiteral("system")) &&
                    !consumeRole(QStringLiteral("system\n"), QStringLiteral("system")) &&
                    !consumeRole(QStringLiteral("assistant "), QStringLiteral("assistant"))) {
                    consumeRole(QStringLiteral("assistant\n"), QStringLiteral("assistant"));
                }

                block = block.trimmed();
                if (block.endsWith(ender)) block.chop(ender.size());
                block.remove(thoughtsRe);
                block = replaceMacros(block, character, persona, &chat, promptPreset).trimmed();

                CompiledPromptMessage message;
                message.role = role;
                message.content = block;
                parsed.append(message);
            }
            return parsed;
        };

        QString descriptionBlock = charDesc;
        if (!charPersonality.isEmpty()) {
            if (!descriptionBlock.isEmpty()) descriptionBlock += QStringLiteral("\n\n");
            descriptionBlock += QStringLiteral("Description of %1: %2").arg(character.name, charPersonality);
        }
        if (!charScenario.isEmpty()) {
            if (!descriptionBlock.isEmpty()) descriptionBlock += QStringLiteral("\n\n");
            descriptionBlock += QStringLiteral("Circumstances and context of the dialogue: ") + charScenario;
        }

        QString templatePersona = personaPrompt;
        QString authorNoteRaw = chat.authorNote.isEmpty() ? character.authorNote : chat.authorNote;
        authorNoteRaw = replaceMacros(authorNoteRaw, character, persona, &chat, promptPreset);

        int includedLoreTokens = 0;
        int includedAuthorNoteTokens = 0;
        bool hasPostEverything = false;

        if (!character.exampleMessage.isEmpty()) {
            appendTemplateMessage(QStringLiteral("system"),
                                  QStringLiteral("<START>\n") + replaceMacros(character.exampleMessage, character, persona, &chat, promptPreset));
        }

        for (const QJsonValue& value : preset.promptTemplate) {
            if (!value.isObject()) continue;
            const QJsonObject card = value.toObject();
            const QString type = card.value(QStringLiteral("type")).toString().trimmed();

            if (type == QStringLiteral("plain") || type == QStringLiteral("jailbreak") || type == QStringLiteral("cot")) {
                if (type == QStringLiteral("jailbreak") && !preset.enableJailbreak) continue;

                QString content = card.value(QStringLiteral("text")).toString();
                const QString type2 = card.value(QStringLiteral("type2")).toString();
                // Compatibility fallback for older preset exports where main/globalNote
                // lived beside an otherwise-empty template card.
                if (content.isEmpty() && type == QStringLiteral("plain") && type2 == QStringLiteral("main")) {
                    content = mainPrompt;
                } else if (content.isEmpty() && type == QStringLiteral("plain") && type2 == QStringLiteral("globalNote")) {
                    content = globalNote;
                } else if (content.isEmpty() && type == QStringLiteral("jailbreak")) {
                    content = jailbreakPrompt;
                } else {
                    content = replaceMacros(content, character, persona, &chat, promptPreset);
                }
                appendTemplateMessage(normalizeTemplateRole(card.value(QStringLiteral("role")).toString()), content);
                continue;
            }

            if (type == QStringLiteral("description")) {
                QString content = descriptionBlock;
                const QString inner = card.value(QStringLiteral("innerFormat")).toString();
                if (!inner.isEmpty()) content = wrapSlot(inner, content);
                appendTemplateMessage(normalizeTemplateRole(card.value(QStringLiteral("role2")).toString()), content);
                continue;
            }

            if (type == QStringLiteral("persona")) {
                QString content = templatePersona;
                const QString inner = card.value(QStringLiteral("innerFormat")).toString();
                if (!inner.isEmpty()) content = wrapSlot(inner, content);
                appendTemplateMessage(normalizeTemplateRole(card.value(QStringLiteral("role2")).toString()), content);
                continue;
            }

            if (type == QStringLiteral("lorebook")) {
                if (!loreContent.isEmpty()) {
                    appendTemplateMessage(QStringLiteral("system"), loreContent);
                    includedLoreTokens += Tokenizer::estimateTokens(loreContent);
                }
                continue;
            }

            if (type == QStringLiteral("authornote")) {
                QString content = authorNoteRaw;
                if (content.isEmpty()) content = card.value(QStringLiteral("defaultText")).toString();
                const QString inner = card.value(QStringLiteral("innerFormat")).toString();
                if (!inner.isEmpty()) content = wrapSlot(inner, content);
                if (!content.isEmpty()) {
                    content = replaceMacros(content, character, persona, &chat, promptPreset);
                    result.authorNoteText = content;
                    includedAuthorNoteTokens += Tokenizer::estimateTokens(content);
                    appendTemplateMessage(normalizeTemplateRole(card.value(QStringLiteral("role2")).toString()), content);
                }
                continue;
            }

            if (type == QStringLiteral("chat")) {
                int start = card.contains(QStringLiteral("rangeStart"))
                                ? card.value(QStringLiteral("rangeStart")).toInt(0) : 0;
                int end = chatHistory.size();
                const QJsonValue rangeEnd = card.value(QStringLiteral("rangeEnd"));
                if (rangeEnd.isDouble()) end = rangeEnd.toInt(chatHistory.size());
                else if (rangeEnd.isString() && rangeEnd.toString() != QStringLiteral("end")) end = rangeEnd.toString().toInt();

                if (start == -1000) {
                    start = 0;
                    end = chatHistory.size();
                }
                if (start < 0) start = qMax(0, chatHistory.size() + start);
                if (end < 0) end = qMax(0, chatHistory.size() + end);
                start = qBound(0, start, chatHistory.size());
                end = qBound(0, end, chatHistory.size());
                if (start >= end) continue;

                for (int i = start; i < end; ++i) {
                    const auto& historyMsg = chatHistory[i];
                    appendTemplateMessage(historyMsg.role, historyMsg.content, historyMsg.name, true);
                }
                continue;
            }

            if (type == QStringLiteral("postEverything")) {
                hasPostEverything = true;
                if (!postHistoryInstructions.isEmpty()) {
                    appendTemplateMessage(QStringLiteral("system"), postHistoryInstructions);
                }
                continue;
            }

            if (type == QStringLiteral("chatML")) {
                const QString rawChatML = card.value(QStringLiteral("text")).toString();
                const auto parsed = parseChatML(rawChatML);
                if (!parsed.isEmpty()) {
                    for (const auto& msg : parsed) {
                        appendTemplateMessage(msg.role, msg.content, msg.name);
                    }
                } else {
                    // Preserve malformed/legacy content rather than silently dropping it.
                    appendTemplateMessage(QStringLiteral("system"),
                                          replaceMacros(rawChatML, character, persona, &chat, promptPreset));
                }
                continue;
            }

            // memory/cache cards require Risu's separate memory/cache subsystems; preserving
            // ordering by ignoring only those special control cards is safer than inventing text.
        }

        // Risu appends postEverything when the template omitted it.
        if (!hasPostEverything && !postHistoryInstructions.isEmpty()) {
            appendTemplateMessage(QStringLiteral("system"), postHistoryInstructions);
        }

        int maxContext = preset.contextLimit > 0 ? preset.contextLimit : 16000;
        int reservedResponseTokens = preset.maxTokens > 0 ? preset.maxTokens : 1000;
        int availableTokensForPrompt = qMax(500, maxContext - reservedResponseTokens);

        int totalTokens = 0;
        int historyCount = 0;
        for (int i = 0; i < templatedMessages.size(); ++i) {
            totalTokens += Tokenizer::estimateTokens(templatedMessages[i].content);
            if (removableHistory.value(i)) ++historyCount;
        }

        while (totalTokens > availableTokensForPrompt && historyCount > 1) {
            int removeIndex = -1;
            for (int i = 0; i < removableHistory.size(); ++i) {
                if (removableHistory[i]) {
                    removeIndex = i;
                    break;
                }
            }
            if (removeIndex < 0) break;
            totalTokens -= Tokenizer::estimateTokens(templatedMessages[removeIndex].content);
            templatedMessages.removeAt(removeIndex);
            removableHistory.removeAt(removeIndex);
            --historyCount;
        }

        int historyTokens = 0;
        int fixedTokens = 0;
        QStringList systemPieces;
        for (int i = 0; i < templatedMessages.size(); ++i) {
            const int tokens = Tokenizer::estimateTokens(templatedMessages[i].content);
            if (removableHistory.value(i)) historyTokens += tokens;
            else fixedTokens += tokens;
            if (!removableHistory.value(i) && templatedMessages[i].role == QStringLiteral("system")) {
                systemPieces.append(templatedMessages[i].content);
            }
        }

        result.messages = templatedMessages;
        result.systemPromptCombined = systemPieces.join(QStringLiteral("\n\n"));
        result.breakdown.historyTokens = historyTokens;
        result.breakdown.lorebookTokens = includedLoreTokens;
        result.breakdown.authorNoteTokens = includedAuthorNoteTokens;
        result.breakdown.systemTokens = qMax(0, fixedTokens - includedLoreTokens - includedAuthorNoteTokens);
        result.estimatedTokens = historyTokens + fixedTokens;
        result.breakdown.totalTokens = result.estimatedTokens;
        return result;
    }

    // Author's Note Injection (Chat author note overrides Character author note)
    QString anText = chat.authorNote.isEmpty() ? character.authorNote : chat.authorNote;
    int anDepth = chat.authorNote.isEmpty() ? character.authorNoteDepth : chat.authorNoteDepth;
    if (anDepth <= 0) anDepth = 3;

    if (!anText.isEmpty()) {
        QString formattedAN = QStringLiteral("[Author's Note: ") + replaceMacros(anText, character, persona, &chat, promptPreset) + QStringLiteral("]");
        result.authorNoteText = formattedAN;
        result.breakdown.authorNoteTokens = Tokenizer::estimateTokens(formattedAN);

        CompiledPromptMessage anMsg;
        anMsg.role = QStringLiteral("system");
        anMsg.content = formattedAN;

        int insertPos = qMax(0, chatHistory.size() - anDepth);
        if (insertPos >= chatHistory.size()) {
            chatHistory.append(anMsg);
        } else {
            chatHistory.insert(insertPos, anMsg);
        }
    }

    // Context limit token budget calculation & trimming
    int maxContext = preset.contextLimit > 0 ? preset.contextLimit : 16000;
    int reservedResponseTokens = preset.maxTokens > 0 ? preset.maxTokens : 1000;
    int availableTokensForPrompt = qMax(500, maxContext - reservedResponseTokens);

    int remainingBudget = availableTokensForPrompt - result.breakdown.systemTokens - result.breakdown.authorNoteTokens;

    int totalChatTokens = 0;
    for (const auto& item : chatHistory) {
        totalChatTokens += Tokenizer::estimateTokens(item.content);
    }

    while (chatHistory.size() > 1 && totalChatTokens > remainingBudget) {
        int removedTokens = Tokenizer::estimateTokens(chatHistory.first().content);
        chatHistory.removeFirst();
        totalChatTokens -= removedTokens;
    }
    result.breakdown.historyTokens = totalChatTokens;

    // Append chat history to result messages
    for (const auto& item : chatHistory) {
        result.messages.append(item);
    }

    // Post history instructions injection
    if (!character.replaceGlobalNote.isEmpty()) {
        CompiledPromptMessage postMsg;
        postMsg.role = QStringLiteral("system");
        postMsg.content = replaceMacros(character.replaceGlobalNote, character, persona, &chat, promptPreset);
        result.messages.append(postMsg);
        result.breakdown.systemTokens += Tokenizer::estimateTokens(postMsg.content);
    }

    if (!character.depthPrompt.isEmpty()) {
        int depthPos = qBound(0, character.depthPromptDepth, result.messages.size());
        CompiledPromptMessage depthMsg;
        depthMsg.role = QStringLiteral("system");
        depthMsg.content = replaceMacros(character.depthPrompt, character, persona, &chat, promptPreset);
        result.messages.insert(depthPos, depthMsg);
        result.estimatedTokens += Tokenizer::estimateTokens(depthMsg.content);
    }

    // Total estimated tokens
    int totalTokens = 0;
    for (const auto& item : result.messages) {
        totalTokens += Tokenizer::estimateTokens(item.content);
    }
    result.estimatedTokens = totalTokens;
    result.breakdown.totalTokens = totalTokens;

    return result;
}

} // namespace Risu
