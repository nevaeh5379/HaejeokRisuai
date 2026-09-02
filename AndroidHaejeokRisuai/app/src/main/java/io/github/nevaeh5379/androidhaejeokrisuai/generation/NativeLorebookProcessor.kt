package io.github.nevaeh5379.androidhaejeokrisuai.generation

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.LoreEntry
import io.github.nevaeh5379.androidhaejeokrisuai.data.MessageRecord
import kotlin.random.Random

internal data class ResolvedLore(
    val content: String,
    val role: String,
    val order: Int,
    val priority: Int,
    val estimatedTokens: Int,
)

internal object NativeLorebookProcessor {
    fun resolve(
        entries: List<LoreEntry>,
        history: List<MessageRecord>,
        settings: GenerationSettings,
        random: Random = Random.Default,
    ): List<ResolvedLore> {
        if (entries.isEmpty() || settings.loreBookToken <= 0) return emptyList()

        val candidates = entries.mapNotNull { entry ->
            resolveEntry(entry, history, settings, random)
        }
        var usedTokens = 0
        val withinBudget = candidates
            .sortedByDescending { it.priority }
            .filter { lore ->
                if (usedTokens + lore.estimatedTokens > settings.loreBookToken) return@filter false
                usedTokens += lore.estimatedTokens
                true
            }
        return withinBudget.sortedBy { it.order }
    }

    private fun resolveEntry(
        entry: LoreEntry,
        history: List<MessageRecord>,
        settings: GenerationSettings,
        random: Random,
    ): ResolvedLore? {
        var scanDepth = settings.loreBookDepth
        var fullWordMatching = false
        var probability = entry.activationPercent ?: 100.0
        var priority = entry.insertOrder
        var role = "system"
        var forceState: Boolean? = null

        val positiveQueries = mutableListOf<Query>()
        val negativeQueries = mutableListOf<Query>()
        if (!entry.alwaysActive && entry.key.isNotBlank()) {
            positiveQueries += Query(splitKeys(entry.key), all = false)
        }
        if (!entry.alwaysActive && entry.selective && entry.secondKey.isNotBlank()) {
            positiveQueries += Query(splitKeys(entry.secondKey), all = false)
        }

        val contentLines = mutableListOf<String>()
        for (line in entry.content.lines()) {
            val trimmed = line.trim()
            if (!trimmed.startsWith("@@") || trimmed.startsWith("@@@")) {
                contentLines += line
                continue
            }
            val body = trimmed.removePrefix("@@").trim()
            val name = body.substringBefore(' ').trim().lowercase()
            val rawArgs = body.substringAfter(' ', "").trim()
            val args = splitDecoratorArgs(rawArgs)
            val recognized = when (name) {
                "scan_depth" -> {
                    scanDepth = args.firstOrNull()?.toIntOrNull()?.coerceAtLeast(0) ?: scanDepth
                    true
                }
                "additional_keys" -> {
                    if (args.isNotEmpty()) positiveQueries += Query(args, all = false)
                    true
                }
                "exclude_keys" -> {
                    if (args.isNotEmpty()) negativeQueries += Query(args, all = false)
                    true
                }
                "exclude_keys_all" -> {
                    if (args.isNotEmpty()) negativeQueries += Query(args, all = true)
                    true
                }
                "match_full_word" -> {
                    fullWordMatching = true
                    true
                }
                "match_partial_word" -> {
                    fullWordMatching = false
                    true
                }
                "probability" -> {
                    probability = args.firstOrNull()?.toDoubleOrNull()?.coerceIn(0.0, 100.0) ?: probability
                    true
                }
                "priority" -> {
                    priority = args.firstOrNull()?.toIntOrNull() ?: priority
                    true
                }
                "role" -> {
                    val requested = args.firstOrNull()?.lowercase()
                    if (requested in setOf("system", "user", "assistant")) role = requested!!
                    true
                }
                "activate" -> {
                    forceState = true
                    true
                }
                "dont_activate" -> {
                    forceState = false
                    true
                }
                // Parsed by the web engine for recursive/depth injection. Keep them out of
                // prompt text even though this first native layer does not execute them yet.
                "recursive", "unrecursive", "no_recursive_search", "depth", "position" -> true
                else -> false
            }
            if (!recognized) contentLines += line
        }

        val content = contentLines.joinToString("\n").trim()
        if (content.isBlank()) return null
        if (forceState == false) return null

        var activated = entry.alwaysActive || forceState == true
        if (!activated) {
            if (positiveQueries.isEmpty()) return null
            val searchable = history.takeLast(scanDepth.coerceAtMost(history.size)).map { it.data }
            activated = positiveQueries.all { query ->
                matchQuery(searchable, query, entry.useRegex, fullWordMatching)
            }
            if (activated) {
                activated = negativeQueries.none { query ->
                    matchQuery(searchable, query, entry.useRegex, fullWordMatching)
                }
            }
        }
        if (!activated) return null
        if (probability <= 0.0) return null
        if (probability < 100.0 && random.nextDouble(100.0) > probability) return null

        val estimatedTokens = ((content.length + 3) / 4).coerceAtLeast(1)
        return ResolvedLore(content, role, entry.insertOrder, priority, estimatedTokens)
    }

    private fun matchQuery(
        messages: List<String>,
        query: Query,
        regex: Boolean,
        fullWordMatching: Boolean,
    ): Boolean {
        val keys = query.keys.filter(String::isNotBlank)
        if (keys.isEmpty()) return false
        val matchedKeys = keys.map { key ->
            messages.any { message ->
                when {
                    regex -> regexMatches(message, key)
                    fullWordMatching -> fullWordMatches(message, key)
                    else -> partialMatches(message, key)
                }
            }
        }
        return if (query.all) matchedKeys.all { it } else matchedKeys.any { it }
    }

    private fun partialMatches(message: String, key: String): Boolean =
        message.lowercase().replace(" ", "").contains(key.lowercase().replace(" ", ""))

    private fun fullWordMatches(message: String, key: String): Boolean {
        val words = message.lowercase().split(Regex("\\s+")).filter(String::isNotBlank)
        return key.lowercase() in words
    }

    private fun regexMatches(message: String, value: String): Boolean {
        if (!value.startsWith('/')) return false
        val lastSlash = value.lastIndexOf('/')
        if (lastSlash <= 0) return false
        val pattern = value.substring(1, lastSlash)
        val flags = value.substring(lastSlash + 1)
        val options = buildSet {
            if ('i' in flags) add(RegexOption.IGNORE_CASE)
            if ('m' in flags) add(RegexOption.MULTILINE)
            if ('s' in flags) add(RegexOption.DOT_MATCHES_ALL)
        }
        return runCatching { Regex(pattern, options).containsMatchIn(message) }.getOrDefault(false)
    }

    private fun splitKeys(value: String): List<String> =
        value.split(',').map(String::trim).filter(String::isNotBlank)

    private fun splitDecoratorArgs(value: String): List<String> =
        if (value.isBlank()) emptyList()
        else value.split(',').map(String::trim).filter(String::isNotBlank)

    private data class Query(val keys: List<String>, val all: Boolean)
}
