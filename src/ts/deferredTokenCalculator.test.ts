import { describe, expect, it, vi } from 'vitest'
import { createDeferredTokenCalculator } from './deferredTokenCalculator'

describe('createDeferredTokenCalculator', () => {
    it('waits for a paint and idle callback before the initial calculation', async () => {
        let frame!: () => void
        let idle!: () => void
        const calculate = vi.fn(async (text: string) => text.length)
        const apply = vi.fn()
        const calculator = createDeferredTokenCalculator({
            calculate,
            apply,
            requestFrame: (callback) => {
                frame = callback
                return 1
            },
            requestIdle: (callback) => {
                idle = callback
                return 2
            },
        })

        calculator.update({ description: 'hello' })
        expect(calculate).not.toHaveBeenCalled()
        frame()
        expect(calculate).not.toHaveBeenCalled()
        idle()
        await vi.waitFor(() => expect(apply).toHaveBeenCalledWith({ description: 5 }))
    })

    it('debounces edits and applies the latest accurate result', async () => {
        vi.useFakeTimers()
        const calculate = vi.fn(async (text: string) => text.length)
        const apply = vi.fn()
        const calculator = createDeferredTokenCalculator({
            calculate,
            apply,
            requestFrame: (callback) => {
                callback()
                return 1
            },
            requestIdle: (callback) => {
                callback()
                return 2
            },
        })

        calculator.update({ description: 'a' })
        await vi.runAllTimersAsync()
        apply.mockClear()
        calculator.update({ description: 'ab' })
        calculator.update({ description: 'abcd' })

        await vi.advanceTimersByTimeAsync(149)
        expect(apply).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(apply).toHaveBeenCalledWith({ description: 4 })
        vi.useRealTimers()
    })

    it('ignores stale asynchronous results and updates after disposal', async () => {
        const resolvers: Array<(value: number) => void> = []
        const calculate = vi.fn(() => new Promise<number>((resolve) => resolvers.push(resolve)))
        const apply = vi.fn()
        let timer!: () => void
        const calculator = createDeferredTokenCalculator({
            calculate,
            apply,
            requestFrame: (callback) => {
                callback()
                return 1
            },
            requestIdle: (callback) => {
                callback()
                return 2
            },
            setTimer: (callback) => {
                timer = callback
                return 3 as unknown as ReturnType<typeof setTimeout>
            },
        })

        calculator.update({ description: 'old' })
        calculator.update({ description: 'new' })
        timer()
        resolvers[0](3)
        await Promise.resolve()
        expect(apply).not.toHaveBeenCalled()

        calculator.dispose()
        resolvers[1](3)
        await Promise.resolve()
        expect(apply).not.toHaveBeenCalled()
    })
})
