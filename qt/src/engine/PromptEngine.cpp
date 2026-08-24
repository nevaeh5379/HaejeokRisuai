#include "PromptEngine.hpp"
#include "Tokenizer.hpp"
#include "ScriptingEngine.hpp"
#include "EmbeddingEngine.hpp"
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
    const Chat* chat
) {
    if (text.isEmpty()) return QString();

    QString result = text;
    QString charName = character.name.isEmpty() ? QStringLiteral("Character") : character.name;
    QString userName = persona.name.isEmpty() ? QStringLiteral("User") : persona.name;
    QString personaDesc = persona.description;

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

        bool triggered = false;
        if (entry.alwaysActive || entry.mode == QStringLiteral("constant")) {
            triggered = true;
        } else {
            int depth = qMax(1, qMin(entry.scanDepth, msgCount));
            QString scanText;
            for (int i = qMax(0, msgCount - depth); i < msgCount; ++i) {
                scanText += QLatin1Char('\n') + messages[i].currentContent();
            }

            if (entry.mode == QStringLiteral("vector") || entry.mode == QStringLiteral("embedding")) {
                QString entryCorpus = entry.key + QStringLiteral(" ") + entry.content;
                auto ranked = EmbeddingEngine::rankSimilarEntries(scanText, QStringList{entryCorpus}, 0.15f, 1);
                triggered = !ranked.isEmpty();
            } else {
                bool primaryMatch = checkKeysMatch(entry.key, scanText, entry.useRegex, entry.caseSensitive);
                if (primaryMatch) {
                    if (entry.selective && !entry.secondKey.isEmpty()) {
                        triggered = checkKeysMatch(entry.secondKey, scanText, entry.useRegex, entry.caseSensitive);
                    } else {
                        triggered = true;
                    }
                }
            }
        }

        if (triggered && !entry.content.isEmpty() && !activeIds.contains(entry.id)) {
            QString processedContent = replaceMacros(entry.content, character, persona, chat);
            activeList.append({entry.insertOrder, entry.id, processedContent});
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

        bool primaryMatch = checkKeysMatch(entry.key, cascadeScanText, entry.useRegex, entry.caseSensitive);
        if (primaryMatch) {
            if (entry.selective && !entry.secondKey.isEmpty()) {
                if (checkKeysMatch(entry.secondKey, cascadeScanText, entry.useRegex, entry.caseSensitive)) {
                    QString processedContent = replaceMacros(entry.content, character, persona, chat);
                    activeList.append({entry.insertOrder, entry.id, processedContent});
                    activeIds.insert(entry.id);
                }
            } else {
                QString processedContent = replaceMacros(entry.content, character, persona, chat);
                activeList.append({entry.insertOrder, entry.id, processedContent});
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

    // Build system sections
    QString mainPrompt = replaceMacros(preset.mainPrompt.isEmpty() ? character.systemPrompt : preset.mainPrompt, character, persona, &chat);
    QString charDesc = replaceMacros(character.description, character, persona, &chat);
    QString charPersonality = replaceMacros(character.personality, character, persona, &chat);
    QString charScenario = replaceMacros(character.scenario, character, persona, &chat);
    QString personaPrompt = replaceMacros(persona.description, character, persona, &chat);
    QString jailbreakPrompt = preset.enableJailbreak ? replaceMacros(preset.jailbreakPrompt, character, persona, &chat) : QString();
    QString globalNote = replaceMacros(preset.globalNote, character, persona, &chat);
    QString postHistoryInstructions = replaceMacros(character.postHistoryInstructions.isEmpty() ? preset.postHistoryInstructions : character.postHistoryInstructions, character, persona, &chat);

    // Lorebook injection
    QString loreContent = scanAndInjectLorebooks(allLore, chat.messages, character, persona, &chat);
    result.breakdown.lorebookTokens = Tokenizer::estimateTokens(loreContent);

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

    QString systemPromptCombined = replaceMacros(systemBlocks.join(QStringLiteral("\n\n")), character, persona, &chat);
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
        QString processedExamples = replaceMacros(character.exampleMessage, character, persona, &chat);
        CompiledPromptMessage exMsg;
        exMsg.role = QStringLiteral("system");
        exMsg.content = QStringLiteral("<START>\n") + processedExamples;
        result.messages.append(exMsg);
        result.breakdown.systemTokens += Tokenizer::estimateTokens(exMsg.content);
    }

    // First greeting message
    QString greeting;
    if (chat.firstMessageIndex >= 0 && chat.firstMessageIndex < character.alternateGreetings.size()) {
        greeting = character.alternateGreetings[chat.firstMessageIndex];
    } else {
        greeting = character.firstMessage;
    }
    if (!greeting.isEmpty()) {
        greeting = replaceMacros(greeting, character, persona, &chat);
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
        m.content = replaceMacros(msg.currentContent(), character, persona, &chat);
        chatHistory.append(m);
    }

    // Add extra user message if generating
    if (!extraUserMessage.isEmpty()) {
        CompiledPromptMessage extra;
        extra.role = QStringLiteral("user");
        extra.name = persona.name;
        extra.content = replaceMacros(extraUserMessage, character, persona, &chat);
        chatHistory.append(extra);
    }

    // Author's Note Injection (Chat author note overrides Character author note)
    QString anText = chat.authorNote.isEmpty() ? character.authorNote : chat.authorNote;
    int anDepth = chat.authorNote.isEmpty() ? character.authorNoteDepth : chat.authorNoteDepth;
    if (anDepth <= 0) anDepth = 3;

    if (!anText.isEmpty()) {
        QString formattedAN = QStringLiteral("[Author's Note: ") + replaceMacros(anText, character, persona, &chat) + QStringLiteral("]");
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
    if (!postHistoryInstructions.isEmpty()) {
        CompiledPromptMessage postMsg;
        postMsg.role = QStringLiteral("system");
        postMsg.content = postHistoryInstructions;
        result.messages.append(postMsg);
        result.breakdown.systemTokens += Tokenizer::estimateTokens(postMsg.content);
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
