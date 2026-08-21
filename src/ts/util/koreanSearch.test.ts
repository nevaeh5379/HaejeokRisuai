import { describe, it, expect } from 'vitest'
import {
    matchKoreanText,
    matchCharacterKorean,
    buildKoreanSearchRegex,
    normalizePhonetic
} from './koreanSearch'

describe('koreanSearch unit tests', () => {
    describe('matchKoreanText', () => {
        it('handles exact and substring match', () => {
            expect(matchKoreanText('홍길동', '홍길동').matched).toBe(true)
            expect(matchKoreanText('홍길동전', '홍길동').matched).toBe(true)
            expect(matchKoreanText('홍길동', '김유신').matched).toBe(false)
        })

        it('handles pure choseong search (초성 검색)', () => {
            expect(matchKoreanText('홍길동', 'ㅎㄱㄷ').matched).toBe(true)
            expect(matchKoreanText('블루 아카이브', 'ㅂㄹㅇㅋㅇㅂ').matched).toBe(true)
            expect(matchKoreanText('리수AI', 'ㄹㅅ').matched).toBe(true)
            expect(matchKoreanText('메이드 로봇', 'ㅁㅇㄷ').matched).toBe(true)
            expect(matchKoreanText('홍길동', 'ㅅㄱㄷ').matched).toBe(false)
        })

        it('handles mixed choseong and syllable search (혼합 검색)', () => {
            expect(matchKoreanText('홍길동', '홍ㄱㄷ').matched).toBe(true)
            expect(matchKoreanText('홍길동', '홍길ㄷ').matched).toBe(true)
            expect(matchKoreanText('메이드 로봇', '메ㅇㄷ').matched).toBe(true)
            expect(matchKoreanText('블루 아카이브', '블ㄹ아카').matched).toBe(true)
        })

        it('handles in-progress syllable typing (진행형 음절 매칭)', () => {
            // Typing "홍" (intermediate: "호")
            expect(matchKoreanText('홍길동', '호').matched).toBe(true)
            // Typing "홍길" (intermediate: "홍기")
            expect(matchKoreanText('홍길동', '홍기').matched).toBe(true)
            // Typing "학교" (intermediate: "하")
            expect(matchKoreanText('학교', '하').matched).toBe(true)
            // Typing "각목" (intermediate: "가")
            expect(matchKoreanText('각목', '가').matched).toBe(true)
        })

        it('handles whitespace insensitivity (공백 무시)', () => {
            expect(matchKoreanText('메이드 로봇', '메이드로봇').matched).toBe(true)
            expect(matchKoreanText('메이드로봇', '메이드 로봇').matched).toBe(true)
            expect(matchKoreanText('블루 아카이브', '블루아카이브').matched).toBe(true)
            expect(matchKoreanText('블루 아카이브', 'ㅂㄹ ㅇㅋㅇㅂ').matched).toBe(true)
        })

        it('handles QWERTY-to-Hangul typo conversion (영한 오타 자동 변환)', () => {
            expect(matchKoreanText('홍길동', 'ghdrlfehd').matched).toBe(true)
            expect(matchKoreanText('리수', 'fltn').matched).toBe(true)
            expect(matchKoreanText('메이드', 'apdlem').matched).toBe(true)
        })

        it('handles English and alphanumeric search seamlessly', () => {
            expect(matchKoreanText('Rem & Ram', 'rem').matched).toBe(true)
            expect(matchKoreanText('GPT-4o Assistant', 'gpt-4o').matched).toBe(true)
            expect(matchKoreanText('2B (NieR:Automata)', '2b').matched).toBe(true)
        })

        it('handles searching English bot names with Korean pronunciation (한글 발음으로 영문 봇 이름 검색)', () => {
            expect(matchKoreanText('Arona', '아로나').matched).toBe(true)
            expect(matchKoreanText('Sakura Matou', '사쿠라').matched).toBe(true)
            expect(matchKoreanText('Rem', '렘').matched).toBe(true)
            expect(matchKoreanText('Megumin', '메구밍').matched).toBe(true)
            expect(matchKoreanText('Karin Kakudate', '카린').matched).toBe(true)
            expect(matchKoreanText('Makima', '마키마').matched).toBe(true)
            expect(matchKoreanText('Hina', '히나').matched).toBe(true)
            expect(matchKoreanText('Shiroko', '시로코').matched).toBe(true)
            expect(matchKoreanText('Alice', '앨리스').matched).toBe(true)
        })
    })

    describe('matchCharacterKorean', () => {
        const char1 = {
            name: '홍길동',
            creator: '허균',
            tags: ['조선', '의적', '도술']
        }
        const char2 = {
            name: 'Arona',
            creator: 'ShittimChest',
            tags: ['Blue Archive', 'AI', 'Maid']
        }

        it('matches by character name', () => {
            expect(matchCharacterKorean(char1, '홍길동').matched).toBe(true)
            expect(matchCharacterKorean(char1, 'ㅎㄱㄷ').matched).toBe(true)
            expect(matchCharacterKorean(char1, 'ghdrlfehd').matched).toBe(true)
            // English bot with Korean query
            expect(matchCharacterKorean(char2, '아로나').matched).toBe(true)
        })

        it('matches by creator', () => {
            expect(matchCharacterKorean(char1, '허균').matched).toBe(true)
            expect(matchCharacterKorean(char1, 'ㅎㄱ').matched).toBe(true)
            expect(matchCharacterKorean(char2, 'shittim').matched).toBe(true)
        })

        it('matches by tags', () => {
            expect(matchCharacterKorean(char1, '의적').matched).toBe(true)
            expect(matchCharacterKorean(char1, 'ㅇㅈ').matched).toBe(true)
        })

        it('ranks name match higher than creator or tag match', () => {
            const charNameMatch = { name: '의적 홍길동', creator: '작가', tags: ['기타'] }
            const charTagMatch = { name: '이순신', creator: '작가', tags: ['의적'] }

            const resName = matchCharacterKorean(charNameMatch, '의적')
            const resTag = matchCharacterKorean(charTagMatch, '의적')

            expect(resName.matched).toBe(true)
            expect(resTag.matched).toBe(true)
            expect(resName.score).toBeGreaterThan(resTag.score)
        })
    })
})
