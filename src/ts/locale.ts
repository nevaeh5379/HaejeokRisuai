/**
 * Safe locale helpers for environments (notably WebKitGTK on Linux) where
 * the system locale can be a POSIX tag like "C" or "C.UTF-8".
 * Such tags are not valid BCP47 language tags and make `Intl` constructors
 * throw `RangeError: invalid language tag`.
 */

function isUsableLocaleTag(tag: string): boolean {
    try {
        new Intl.Locale(tag);
        return true;
    } catch {
        return false;
    }
}

export function getSafeNavigatorLanguage(): string {
    const lang = navigator.language;
    if (lang && isUsableLocaleTag(lang)) {
        return lang;
    }
    return 'en';
}

export function getSafeNavigatorLanguages(): string[] {
    const languages = navigator.languages;
    if (!languages || languages.length === 0) {
        return ['en'];
    }
    const safe = languages.filter(isUsableLocaleTag);
    return safe.length > 0 ? safe : ['en'];
}