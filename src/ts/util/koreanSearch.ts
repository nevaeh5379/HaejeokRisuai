import {
  getChoseong,
  disassemble,
  convertQwertyToHangul,
  romanize,
} from "es-hangul";

const CHOSEONG_LIST = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
] as const;

const CHOSEONG_INDEX_MAP = new Map<string, number>(
  CHOSEONG_LIST.map((c, i) => [c, i]),
);

const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
const JONGSEONG_COUNT = 28;
const JUNGSEONG_COUNT = 21;

const BATCHIM_EXPANSIONS: Readonly<Record<number, readonly number[]>> =
  Object.freeze({
    1: [1, 2, 3], // ㄱ, ㄲ, ㄳ
    4: [4, 5, 6], // ㄴ, ㄵ,ㄶ
    8: [8, 9, 10, 11, 12, 13, 14, 15], // ㄹ and compounds
    17: [17, 18], // ㅂ, ㅄ
    19: [19, 20], // ㅅ, ㅆ
  });

/**
 * Escapes characters with special meaning in RegExp.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Creates a regular expression pattern for a single character in Korean search.
 * Handles choseong (e.g. 'ㄱ' -> [ㄱ가-깋]), in-progress syllables (e.g. '호' -> [호-홓]),
 * and standard characters.
 */
function charToPattern(ch: string, isLastChar: boolean): string {
  const code = ch.charCodeAt(0);

  // 1. Compatibility Choseong (ㄱ-ㅎ)
  const choseongIndex = CHOSEONG_INDEX_MAP.get(ch) ?? -1;
  if (choseongIndex !== -1) {
    const startCode =
      HANGUL_BASE + choseongIndex * JUNGSEONG_COUNT * JONGSEONG_COUNT;
    const endCode = startCode + JUNGSEONG_COUNT * JONGSEONG_COUNT - 1;
    const startChar = String.fromCharCode(startCode);
    const endChar = String.fromCharCode(endCode);
    return `[${ch}${startChar}-${endChar}]`;
  }

  // 2. Hangul Syllables (가-힣)
  if (code >= HANGUL_BASE && code <= HANGUL_END) {
    const jongseongIndex = (code - HANGUL_BASE) % JONGSEONG_COUNT;

    // If it has no batchim (e.g. '호'), match all 28 possible batchim syllables ('호'~'홓')
    if (jongseongIndex === 0) {
      const startChar = ch;
      const endChar = String.fromCharCode(code + JONGSEONG_COUNT - 1);
      return `[${startChar}-${endChar}]`;
    }

    // If it's the last character and has a batchim that can form a compound batchim
    if (isLastChar) {
      const extraIndices = BATCHIM_EXPANSIONS[jongseongIndex];
      if (extraIndices && extraIndices.length > 1) {
        const baseSyllableWithoutBatchim = code - jongseongIndex;
        const chars = extraIndices.map((idx) =>
          String.fromCharCode(baseSyllableWithoutBatchim + idx),
        );
        return `(?:${chars.join("|")})`;
      }
    }

    return escapeRegExp(ch);
  }

  // 3. Whitespace
  if (/\s/.test(ch)) {
    return "\\s*";
  }

  // 4. Other characters
  return escapeRegExp(ch);
}

/**
 * Builds a Korean search RegExp from a query string.
 * Supports flexible whitespace and in-progress syllable / choseong matching.
 */
export function buildKoreanSearchRegex(
  query: string,
  flags = "i",
): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const patterns: string[] = [];
  const len = trimmed.length;

  for (let i = 0; i < len; i++) {
    const isLast = i === len - 1;
    const pattern = charToPattern(trimmed[i], isLast);
    patterns.push(pattern);
  }

  // Allow optional spaces between characters
  const regexStr = patterns.join("\\s*");
  try {
    return new RegExp(regexStr, flags);
  } catch {
    return null;
  }
}

const RE_PHON_CLEAN = /[\s\-_.]+/g;
const RE_PHON_SOFT_C = /c(?=[eiy])/g;
const RE_PHON_HARD_C = /c/g;
const RE_PHON_Q = /q/g;
const RE_PHON_R = /r/g;
const RE_PHON_SH = /sh/g;
const RE_PHON_Z = /z/g;
const RE_PHON_OO = /oo/g;
const RE_PHON_EE = /ee/g;
const RE_PHON_AE = /ae/g;
const RE_PHON_EU_END = /eu$/;
const RE_PHON_E_END = /e$/;
const RE_PHON_NG_END = /ng$/;
const RE_PHON_DOUBLE = /([a-z])\1+/g;

/**
 * Normalizes phonetic variants between English and Korean Romanization
 * (e.g. l/r, soft/hard c/k, sh/s, ee/i, oo/u, double consonants, loanword filler vowels).
 */
export function normalizePhonetic(str: string): string {
  return str
    .toLowerCase()
    .replace(RE_PHON_CLEAN, "")
    .replace(RE_PHON_SOFT_C, "s") // soft c -> s (e.g. Alice -> Alise)
    .replace(RE_PHON_HARD_C, "k") // hard c -> k (e.g. Cat -> Kat)
    .replace(RE_PHON_Q, "k")
    .replace(RE_PHON_R, "l") // r and l interchangeability
    .replace(RE_PHON_SH, "s") // sh -> s (Shiroko -> Siroko)
    .replace(RE_PHON_Z, "j") // z -> j
    .replace(RE_PHON_OO, "u") // oo -> u
    .replace(RE_PHON_EE, "i") // ee -> i
    .replace(RE_PHON_AE, "a") // ae -> a (e.g. aelriseu / Alice)
    .replace(RE_PHON_EU_END, "") // trailing 'eu' in Korean loanword endings
    .replace(RE_PHON_E_END, "") // trailing silent 'e' in English words (e.g. Alice -> Alis)
    .replace(RE_PHON_NG_END, "n") // trailing ng/n variance (Meguming -> Megumin)
    .replace(RE_PHON_DOUBLE, "$1"); // collapse double consonants (ll -> l, ss -> s, etc.)
}

export interface MatchResult {
  matched: boolean;
  score: number;
  isQwertyConverted?: boolean;
  isRomanized?: boolean;
}

export interface KoreanMatcher {
  readonly query: string;
  readonly isQueryEmpty: boolean;
  matchText(target: string | undefined | null): MatchResult;
  matchCharacter(char: {
    name?: string;
    creator?: string;
    tags?: string[];
  }): MatchResult;
}

const RE_NON_SPACE = /[\s\-_]+/g;
const RE_WHITESPACE = /\s+/g;
const RE_HANGUL = /[가-힣]/;
const RE_ALPHA = /[a-zA-Z]/;

class CompiledKoreanMatcher implements KoreanMatcher {
  readonly query: string;
  readonly isQueryEmpty: boolean;

  private readonly queryLower: string;
  private readonly queryNoSpace: string;
  private readonly regex: RegExp | null;
  private readonly queryDisassembled: string | null;
  private readonly romanizedQuery: string | null;
  private readonly phonQuery: string | null;
  private readonly subMatcher: KoreanMatcher | null;

  constructor(query: string) {
    this.query = query;
    const queryNorm = query.normalize("NFC").trim();
    if (!queryNorm) {
      this.isQueryEmpty = true;
      this.queryLower = "";
      this.queryNoSpace = "";
      this.regex = null;
      this.queryDisassembled = null;
      this.romanizedQuery = null;
      this.phonQuery = null;
      this.subMatcher = null;
      return;
    }

    this.isQueryEmpty = false;
    this.queryLower = queryNorm.toLowerCase();
    this.queryNoSpace = this.queryLower.replace(RE_NON_SPACE, "");
    this.regex = buildKoreanSearchRegex(this.queryLower);

    let disassembled: string | null = null;
    try {
      disassembled = disassemble(this.queryLower).replace(RE_WHITESPACE, "");
    } catch {}
    this.queryDisassembled = disassembled;

    let romanized: string | null = null;
    let phon: string | null = null;
    if (RE_HANGUL.test(queryNorm)) {
      try {
        romanized = romanize(queryNorm)
          .toLowerCase()
          .replace(RE_WHITESPACE, "");
        if (romanized) {
          phon = normalizePhonetic(romanized);
        }
      } catch {}
    }
    this.romanizedQuery = romanized;
    this.phonQuery = phon;

    let sub: KoreanMatcher | null = null;
    if (RE_ALPHA.test(queryNorm)) {
      try {
        const convertedQuery = convertQwertyToHangul(queryNorm);
        if (convertedQuery && convertedQuery !== queryNorm) {
          sub = new CompiledKoreanMatcher(convertedQuery);
        }
      } catch {}
    }
    this.subMatcher = sub;
  }

  matchText(target: string | undefined | null): MatchResult {
    if (!target) return { matched: false, score: 0 };
    if (this.isQueryEmpty) return { matched: true, score: 0 };

    const targetNorm = target.normalize("NFC").trim();
    const targetLower = targetNorm.toLowerCase();

    // 1. Exact Match
    if (targetLower === this.queryLower) {
      return { matched: true, score: 1000 };
    }

    // 2. Prefix Match
    if (targetLower.startsWith(this.queryLower)) {
      return { matched: true, score: 800 };
    }

    // 3. Standard Substring Match
    if (targetLower.includes(this.queryLower)) {
      return { matched: true, score: 600 };
    }

    // 4. Whitespace-insensitive Match
    const targetNoSpace = targetLower.replace(RE_NON_SPACE, "");
    if (targetNoSpace.includes(this.queryNoSpace)) {
      return { matched: true, score: 550 };
    }

    // 5. Dynamic Regex Match (Choseong, Mixed, In-progress typing)
    if (this.regex && this.regex.test(targetNorm)) {
      const isStart = this.regex.test(
        targetNorm.slice(0, Math.max(this.queryLower.length + 2, 4)),
      );
      return { matched: true, score: isStart ? 500 : 450 };
    }

    // 6. Jamo Disassembly Match (via es-hangul disassemble)
    if (this.queryDisassembled) {
      try {
        const targetDisassembled = disassemble(targetLower).replace(
          RE_WHITESPACE,
          "",
        );
        if (targetDisassembled.includes(this.queryDisassembled)) {
          const isStart = targetDisassembled.startsWith(this.queryDisassembled);
          return { matched: true, score: isStart ? 420 : 380 };
        }
      } catch {}
    }

    // 7. Pure Choseong Substring Match (via es-hangul getChoseong)
    try {
      const targetChoseong = getChoseong(targetLower, {
        keepNonHangul: true,
      }).replace(RE_WHITESPACE, "");
      if (targetChoseong && targetChoseong.includes(this.queryNoSpace)) {
        const isStart = targetChoseong.startsWith(this.queryNoSpace);
        return { matched: true, score: isStart ? 400 : 350 };
      }
    } catch {}

    // 8. Hangul -> Romanization Matching
    if (this.romanizedQuery) {
      if (targetNoSpace === this.romanizedQuery) {
        return { matched: true, score: 480, isRomanized: true };
      }
      if (targetNoSpace.startsWith(this.romanizedQuery)) {
        return { matched: true, score: 440, isRomanized: true };
      }
      if (targetNoSpace.includes(this.romanizedQuery)) {
        return { matched: true, score: 400, isRomanized: true };
      }

      // Phonetic comparison
      if (this.phonQuery) {
        const phonTarget = normalizePhonetic(targetNoSpace);
        if (phonTarget) {
          if (phonTarget === this.phonQuery) {
            return { matched: true, score: 460, isRomanized: true };
          }
          if (phonTarget.startsWith(this.phonQuery)) {
            return { matched: true, score: 420, isRomanized: true };
          }
          if (phonTarget.includes(this.phonQuery)) {
            return { matched: true, score: 380, isRomanized: true };
          }
        }
      }
    }

    // 9. QWERTY-to-Hangul Conversion Fallback
    if (this.subMatcher) {
      const subResult = this.subMatcher.matchText(target);
      if (subResult.matched) {
        return {
          matched: true,
          score: Math.max(subResult.score - 150, 200),
          isQwertyConverted: true,
        };
      }
    }

    return { matched: false, score: 0 };
  }

  matchCharacter(char: {
    name?: string;
    creator?: string;
    tags?: string[];
  }): MatchResult {
    if (this.isQueryEmpty) return { matched: true, score: 0 };

    // Check name (highest weight: 1.0)
    const nameResult = this.matchText(char.name);

    // Check creator (weight: 0.6)
    const creatorResult = this.matchText(char.creator);
    const creatorScore = creatorResult.matched ? creatorResult.score * 0.6 : 0;

    // Check tags (weight: 0.7)
    let bestTagScore = 0;
    let tagMatched = false;
    if (Array.isArray(char.tags)) {
      for (let i = 0; i < char.tags.length; i++) {
        const res = this.matchText(char.tags[i]);
        if (res.matched) {
          const score = res.score * 0.7;
          if (score > bestTagScore) {
            bestTagScore = score;
            tagMatched = true;
          }
        }
      }
    }

    const isMatched = nameResult.matched || creatorResult.matched || tagMatched;
    if (!isMatched) {
      return { matched: false, score: 0 };
    }

    const finalScore = Math.max(nameResult.score, creatorScore, bestTagScore);
    return {
      matched: true,
      score: finalScore,
      isQwertyConverted:
        nameResult.isQwertyConverted || creatorResult.isQwertyConverted,
      isRomanized: nameResult.isRomanized || creatorResult.isRomanized,
    };
  }
}

/**
 * Creates a reusable, precompiled KoreanMatcher for a given query string.
 * This precomputes regexes, phonetic normalizations, and decompositions once,
 * eliminating massive GC allocations when filtering large lists of items.
 */
export function createKoreanMatcher(query: string): KoreanMatcher {
  return new CompiledKoreanMatcher(query);
}

/**
 * Matches a single target string against a search query with scoring.
 * Higher score indicates a better/closer match.
 */
export function matchKoreanText(
  target: string | undefined | null,
  query: string,
): MatchResult {
  return createKoreanMatcher(query).matchText(target);
}

/**
 * Evaluates whether a character matches the query across its name, creator, and tags,
 * and calculates an overall relevance score.
 */
export function matchCharacterKorean(
  char: { name?: string; creator?: string; tags?: string[] },
  queryOrMatcher: string | KoreanMatcher,
): MatchResult {
  const matcher =
    typeof queryOrMatcher === "string"
      ? createKoreanMatcher(queryOrMatcher)
      : queryOrMatcher;
  return matcher.matchCharacter(char);
}
