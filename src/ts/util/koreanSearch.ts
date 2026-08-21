import {
    getChoseong,
    disassemble,
    convertQwertyToHangul,
    canBeChoseong
} from 'es-hangul'

const CHOSEONG_LIST = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
] as const

const HANGUL_BASE = 0xAC00
const HANGUL_END = 0xD7A3
const JONGSEONG_COUNT = 28
const JUNGSEONG_COUNT = 21

/**
 * Escapes characters with special meaning in RegExp.
 */
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Creates a regular expression pattern for a single character in Korean search.
 * Handles choseong (e.g. 'ㄱ' -> [ㄱ가-깋]), in-progress syllables (e.g. '호' -> [호-홓]),
 * and standard characters.
 */
function charToPattern(ch: string, isLastChar: boolean): string {
    const code = ch.charCodeAt(0)

    // 1. Compatibility Choseong (ㄱ-ㅎ)
    const choseongIndex = CHOSEONG_LIST.indexOf(ch as typeof CHOSEONG_LIST[number])
    if (choseongIndex !== -1) {
        const startCode = HANGUL_BASE + choseongIndex * JUNGSEONG_COUNT * JONGSEONG_COUNT
        const endCode = startCode + JUNGSEONG_COUNT * JONGSEONG_COUNT - 1
        const startChar = String.fromCharCode(startCode)
        const endChar = String.fromCharCode(endCode)
        return `[${ch}${startChar}-${endChar}]`
    }

    // 2. Hangul Syllables (가-힣)
    if (code >= HANGUL_BASE && code <= HANGUL_END) {
        const jongseongIndex = (code - HANGUL_BASE) % JONGSEONG_COUNT

        // If it has no batchim (e.g. '호'), match all 28 possible batchim syllables ('호'~'홓')
        if (jongseongIndex === 0) {
            const startChar = ch
            const endChar = String.fromCharCode(code + JONGSEONG_COUNT - 1)
            return `[${startChar}-${endChar}]`
        }

        // If it's the last character and has a batchim that can form a compound batchim
        if (isLastChar) {
            const batchimExpansions: Record<number, number[]> = {
                1: [1, 2, 3], // ㄱ, ㄲ, ㄳ
                4: [4, 5, 6], // ㄴ, ㄵ, ㄶ
                8: [8, 9, 10, 11, 12, 13, 14, 15], // ㄹ and compounds
                17: [17, 18], // ㅂ, ㅄ
                19: [19, 20], // ㅅ, ㅆ
            }
            const extraIndices = batchimExpansions[jongseongIndex]
            if (extraIndices && extraIndices.length > 1) {
                const baseSyllableWithoutBatchim = code - jongseongIndex
                const chars = extraIndices.map(idx => String.fromCharCode(baseSyllableWithoutBatchim + idx))
                return `(?:${chars.join('|')})`
            }
        }

        return escapeRegExp(ch)
    }

    // 3. Whitespace
    if (/\s/.test(ch)) {
        return '\\s*'
    }

    // 4. Other characters
    return escapeRegExp(ch)
}

/**
 * Builds a Korean search RegExp from a query string.
 * Supports flexible whitespace and in-progress syllable / choseong matching.
 */
export function buildKoreanSearchRegex(query: string, flags = 'i'): RegExp | null {
    const trimmed = query.trim()
    if (!trimmed) return null

    const chars = Array.from(trimmed)
    const patterns: string[] = []

    for (let i = 0; i < chars.length; i++) {
        const isLast = i === chars.length - 1
        const pattern = charToPattern(chars[i], isLast)
        patterns.push(pattern)
    }

    // Allow optional spaces between characters
    const regexStr = patterns.join('\\s*')
    try {
        return new RegExp(regexStr, flags)
    } catch {
        return null
    }
}

export interface MatchResult {
    matched: boolean
    score: number
    isQwertyConverted?: boolean
}

/**
 * Matches a single target string against a search query with scoring.
 * Higher score indicates a better/closer match.
 */
export function matchKoreanText(target: string | undefined | null, query: string): MatchResult {
    if (!target) return { matched: false, score: 0 }

    const targetNorm = target.normalize('NFC').trim()
    const queryNorm = query.normalize('NFC').trim()
    if (!queryNorm) return { matched: true, score: 0 }

    const targetLower = targetNorm.toLowerCase()
    const queryLower = queryNorm.toLowerCase()

    // 1. Exact Match
    if (targetLower === queryLower) {
        return { matched: true, score: 1000 }
    }

    // 2. Prefix Match
    if (targetLower.startsWith(queryLower)) {
        return { matched: true, score: 800 }
    }

    // 3. Standard Substring Match
    if (targetLower.includes(queryLower)) {
        return { matched: true, score: 600 }
    }

    // 4. Whitespace-insensitive Match
    const targetNoSpace = targetLower.replace(/\s+/g, '')
    const queryNoSpace = queryLower.replace(/\s+/g, '')
    if (targetNoSpace.includes(queryNoSpace)) {
        return { matched: true, score: 550 }
    }

    // 5. Dynamic Regex Match (Choseong, Mixed, In-progress typing)
    const regex = buildKoreanSearchRegex(queryLower)
    if (regex && regex.test(targetNorm)) {
        const isStart = regex.test(targetNorm.slice(0, Math.max(queryLower.length + 2, 4)))
        return { matched: true, score: isStart ? 500 : 450 }
    }

    // 6. Jamo Disassembly Match (via es-hangul disassemble)
    try {
        const targetDisassembled = disassemble(targetLower).replace(/\s+/g, '')
        const queryDisassembled = disassemble(queryLower).replace(/\s+/g, '')
        if (queryDisassembled && targetDisassembled.includes(queryDisassembled)) {
            const isStart = targetDisassembled.startsWith(queryDisassembled)
            return { matched: true, score: isStart ? 420 : 380 }
        }
    } catch {
        // Fallthrough if disassemble fails on unusual characters
    }

    // 7. Pure Choseong Substring Match (via es-hangul getChoseong)
    try {
        const targetChoseong = getChoseong(targetLower, { keepNonHangul: true }).replace(/\s+/g, '')
        if (targetChoseong && targetChoseong.includes(queryNoSpace)) {
            const isStart = targetChoseong.startsWith(queryNoSpace)
            return { matched: true, score: isStart ? 400 : 350 }
        }
    } catch {
        // Fallthrough
    }

    // 8. QWERTY-to-Hangul Conversion Fallback (영한 오타 자동 변환)
    if (/[a-zA-Z]/.test(queryNorm)) {
        try {
            const convertedQuery = convertQwertyToHangul(queryNorm)
            if (convertedQuery && convertedQuery !== queryNorm) {
                const subResult = matchKoreanText(target, convertedQuery)
                if (subResult.matched) {
                    return {
                        matched: true,
                        score: Math.max(subResult.score - 150, 200),
                        isQwertyConverted: true
                    }
                }
            }
        } catch {
            // Fallthrough
        }
    }

    return { matched: false, score: 0 }
}

/**
 * Evaluates whether a character matches the query across its name, creator, and tags,
 * and calculates an overall relevance score.
 */
export function matchCharacterKorean(
    char: { name?: string; creator?: string; tags?: string[] },
    query: string
): MatchResult {
    const q = query.trim()
    if (!q) return { matched: true, score: 0 }

    // Check name (highest weight: 1.0)
    const nameResult = matchKoreanText(char.name, q)

    // Check creator (weight: 0.6)
    const creatorResult = matchKoreanText(char.creator, q)
    const creatorScore = creatorResult.matched ? creatorResult.score * 0.6 : 0

    // Check tags (weight: 0.7)
    let bestTagScore = 0
    let tagMatched = false
    if (Array.isArray(char.tags)) {
        for (const tag of char.tags) {
            const res = matchKoreanText(tag, q)
            if (res.matched && res.score * 0.7 > bestTagScore) {
                bestTagScore = res.score * 0.7
                tagMatched = true
            }
        }
    }

    const isMatched = nameResult.matched || creatorResult.matched || tagMatched
    if (!isMatched) {
        return { matched: false, score: 0 }
    }

    const finalScore = Math.max(nameResult.score, creatorScore, bestTagScore)
    return {
        matched: true,
        score: finalScore,
        isQwertyConverted: nameResult.isQwertyConverted || creatorResult.isQwertyConverted
    }
}
