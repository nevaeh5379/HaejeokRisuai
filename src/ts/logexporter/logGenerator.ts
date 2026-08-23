import type { ColorPalette, LogExporterSettings, LogMessageData, ThemeInfo } from './types'
import { THEMES, COLORS } from './constants'

/**
 * Markdown / plain-text log generators.
 * The themed HTML export path lives in htmlGenerator.ts (offscreen render).
 */

export interface GeneratorContext {
    settings: LogExporterSettings
}

function applyRulesToText(text: string, settings: LogExporterSettings): string {
    let result = text
    for (const rule of settings.replacementRules ?? []) {
        if (rule.isEnabled === false || !rule.pattern) continue
        try {
            if (rule.isRegex) {
                let flags = rule.flags ?? 'g'
                if (!flags.includes('g')) flags += 'g'
                result = result.replace(new RegExp(rule.pattern, flags), rule.replacement)
            } else {
                result = result.split(rule.pattern).join(rule.replacement)
            }
        } catch {
            // invalid pattern — skip
        }
    }
    return result
}

/** Generates a formatted markdown chat log. */
export function generateMarkdownLog(messages: LogMessageData[], settings: LogExporterSettings): string {
    return messages
        .map((msg) => {
            const text = applyRulesToText(msg.text, settings)
            const time = msg.time ? ` \`${new Date(msg.time).toLocaleString()}\`` : ''
            return `**${msg.name}**${time}\n\n${text}\n\n---\n\n`
        })
        .join('')
}

/** Generates a plain-text chat log. */
export function generateTextLog(messages: LogMessageData[], settings: LogExporterSettings): string {
    return messages
        .map((msg) => {
            const text = applyRulesToText(msg.text, settings)
            const time = msg.time ? ` [${new Date(msg.time).toLocaleString()}]` : ''
            return `${msg.name}${time}: ${text}\n\n`
        })
        .join('')
}

/** Resolves the palette used by the simple HTML fallback export. */
export function resolveSimplePalette(settings: LogExporterSettings): ColorPalette {
    if (settings.theme === 'basic' || settings.theme === 'custom') {
        return COLORS[settings.color] || COLORS.dark
    }
    const theme: ThemeInfo | undefined = THEMES[settings.theme as keyof typeof THEMES]
    return theme?.color || COLORS.dark
}
