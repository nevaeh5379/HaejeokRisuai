export type TokenSource = Record<string, string | null>

interface DeferredTokenCalculatorOptions<T extends TokenSource> {
    calculate: (text: string) => Promise<number>
    apply: (tokens: { [K in keyof T]: number | null }) => void
    requestFrame?: (callback: () => void) => number
    cancelFrame?: (handle: number) => void
    requestIdle?: (callback: () => void) => number | ReturnType<typeof setTimeout>
    cancelIdle?: (handle: number | ReturnType<typeof setTimeout>) => void
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
    debounceMs?: number
}

export interface DeferredTokenCalculator<T extends TokenSource> {
    update: (source: T) => (keyof T)[]
    dispose: () => void
}

export function createDeferredTokenCalculator<T extends TokenSource>({
    calculate,
    apply,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
    requestIdle = (callback) => {
        if ('requestIdleCallback' in globalThis) {
            return globalThis.requestIdleCallback(callback)
        }
        return globalThis.setTimeout(callback, 0)
    },
    cancelIdle = (handle) => {
        if ('cancelIdleCallback' in globalThis) {
            globalThis.cancelIdleCallback(handle as number)
        } else {
            globalThis.clearTimeout(handle)
        }
    },
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (handle) => globalThis.clearTimeout(handle),
    debounceMs = 150,
}: DeferredTokenCalculatorOptions<T>): DeferredTokenCalculator<T> {
    let desired: T | undefined
    let appliedSource: T | undefined
    let appliedTokens: { [K in keyof T]: number | null } | undefined
    let generation = 0
    let initialScheduled = false
    let initialStarted = false
    let disposed = false
    let frameHandle: number | undefined
    let idleHandle: number | ReturnType<typeof setTimeout> | undefined
    let timerHandle: ReturnType<typeof setTimeout> | undefined

    const run = async () => {
        if (disposed || !desired) return

        initialStarted = true
        const runGeneration = generation
        const source = { ...desired }
        const result = {} as { [K in keyof T]: number | null }

        for (const key of Object.keys(source) as (keyof T)[]) {
            if (disposed || runGeneration !== generation) return
            const text = source[key]
            if (appliedSource?.[key] === text && appliedTokens) {
                result[key] = appliedTokens[key]
            } else {
                result[key] = text === null ? null : await calculate(text)
            }
        }

        if (!disposed && runGeneration === generation) {
            appliedSource = source
            appliedTokens = result
            apply(result)
        }
    }

    const scheduleInitial = () => {
        initialScheduled = true
        frameHandle = requestFrame(() => {
            frameHandle = undefined
            if (disposed) return
            idleHandle = requestIdle(() => {
                idleHandle = undefined
                void run()
            })
        })
    }

    return {
        update(source) {
            if (disposed) return []
            const changedKeys = (Object.keys(source) as (keyof T)[]).filter(
                (key) => !desired || desired[key] !== source[key],
            )
            if (changedKeys.length === 0) return []

            desired = { ...source }
            generation += 1

            if (!initialScheduled) {
                scheduleInitial()
                return changedKeys
            }
            if (!initialStarted) return changedKeys

            if (timerHandle !== undefined) clearTimer(timerHandle)
            timerHandle = setTimer(() => {
                timerHandle = undefined
                void run()
            }, debounceMs)
            return changedKeys
        },
        dispose() {
            disposed = true
            generation += 1
            if (frameHandle !== undefined) cancelFrame(frameHandle)
            if (idleHandle !== undefined) cancelIdle(idleHandle)
            if (timerHandle !== undefined) clearTimer(timerHandle)
        },
    }
}
