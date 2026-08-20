import { describe, expect, it } from 'vitest'

const { paginateMessages } = require('./messagePagination.cjs')

describe('paginateMessages', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({ index }))

    it('returns the newest page by default', () => {
        expect(paginateMessages(messages, { limit: 12 })).toEqual({
            messages: messages.slice(88),
            offset: 88,
            total: 100,
            hasMore: true,
        })
    })

    it('returns an older page before an absolute offset', () => {
        expect(paginateMessages(messages, { before: 88, limit: 20 })).toEqual({
            messages: messages.slice(68, 88),
            offset: 68,
            total: 100,
            hasMore: true,
        })
    })

    it('clamps the oldest page without negative offsets', () => {
        expect(paginateMessages(messages.slice(0, 5), { before: 3, limit: 20 })).toEqual({
            messages: messages.slice(0, 3),
            offset: 0,
            total: 5,
            hasMore: false,
        })
    })
})
