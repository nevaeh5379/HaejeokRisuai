import merge from "lodash/merge";
import { languageEnglish } from "./en";

export let language:typeof languageEnglish = languageEnglish

const languageLoaders = {
    cn: () => import('./cn').then((module) => module.languageChinese),
    de: () => import('./de').then((module) => module.languageGerman),
    ko: () => import('./ko').then((module) => module.languageKorean),
    vi: () => import('./vi').then((module) => module.languageVietnamese),
    'zh-Hant': () => import('./zh-Hant').then((module) => module.languageChineseTraditional),
    es: () => import('./es').then((module) => module.languageSpanish),
} as const

let languageRequestId = 0

export async function changeLanguage(lang:string): Promise<void> {
    const requestId = ++languageRequestId
    const loader = languageLoaders[lang as keyof typeof languageLoaders]
    if (!loader) {
        language = languageEnglish
        return
    }

    const selectedLanguage = await loader()
    if (requestId !== languageRequestId) return
    language = merge(safeStructuredClone(languageEnglish), selectedLanguage)
}
