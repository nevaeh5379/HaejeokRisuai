import Foundation

/// Lightweight token estimation.
/// Real BPE counts need the actual tokenizer files; this heuristic is tuned to be
/// close enough for context-window management (~±15%).
enum TokenEstimator {
    static func estimate(_ text: String) -> Int {
        guard !text.isEmpty else { return 0 }
        var asciiChars = 0
        var cjkChars = 0
        var otherChars = 0
        for scalar in text.unicodeScalars {
            if scalar.isASCII {
                asciiChars += 1
            } else if isCJK(scalar) {
                cjkChars += 1
            } else {
                otherChars += 1
            }
        }
        // English averages ~4 chars/token including whitespace;
        // CJK averages ~1.5 chars/token for common BPEs.
        let asciiTokens = Double(asciiChars) / 4.0
        let cjkTokens = Double(cjkChars) / 1.5
        let otherTokens = Double(otherChars) / 2.0
        return max(1, Int((asciiTokens + cjkTokens + otherTokens).rounded(.up)))
    }

    static func estimate(messages: [PromptMessage]) -> Int {
        messages.reduce(0) { $0 + estimate($1.content) + 4 }
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x11FF,   // Hangul Jamo
             0x2E80...0x9FFF,   // CJK radicals through unified ideographs & hangul
             0xAC00...0xD7AF,   // Hangul syllables
             0xF900...0xFAFF,   // CJK compatibility ideographs
             0xFF00...0xFFEF,   // fullwidth forms
             0x20000...0x2FA1F, // CJK ext-B+
             0x3000...0x303F:   // CJK punctuation
            return true
        default:
            return false
        }
    }
}
