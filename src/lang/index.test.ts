import { afterEach, describe, expect, it } from 'vitest'
import { changeLanguage, language } from '.'
import { languageEnglish } from './en'

afterEach(async () => {
    await changeLanguage('en')
})

describe('changeLanguage', () => {
    it('loads only the selected dictionary and merges the English fallback', async () => {
        await changeLanguage('ko')

        expect(language.language).toBe('언어')
        expect(language.setup).toBeDefined()
    })

    it('restores the shared English dictionary without cloning it', async () => {
        await changeLanguage('en')
        expect(language).toBe(languageEnglish)
    })
})
