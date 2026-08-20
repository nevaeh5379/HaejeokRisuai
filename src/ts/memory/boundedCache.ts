export interface BoundedCacheOptions<K, V> {
    maxEntries: number
    maxWeight?: number
    weigh?: (value: V, key: K) => number
    onEvict?: (value: V, key: K) => void
}

/** A compact LRU cache with deterministic entry and byte-like weight limits. */
export class BoundedCache<K, V> {
    private values = new Map<K, { value: V; weight: number }>()
    private totalWeight = 0

    constructor(private readonly options: BoundedCacheOptions<K, V>) {}

    get size() { return this.values.size }
    get weight() { return this.totalWeight }

    get(key: K): V | undefined {
        const item = this.values.get(key)
        if (!item) return undefined
        this.values.delete(key)
        this.values.set(key, item)
        return item.value
    }

    has(key: K) { return this.values.has(key) }

    set(key: K, value: V): void {
        this.delete(key)
        const weight = Math.max(0, this.options.weigh?.(value, key) ?? 1)
        this.values.set(key, { value, weight })
        this.totalWeight += weight
        this.trim()
    }

    delete(key: K): boolean {
        const item = this.values.get(key)
        if (!item) return false
        this.values.delete(key)
        this.totalWeight -= item.weight
        this.options.onEvict?.(item.value, key)
        return true
    }

    clear(): void {
        for (const [key, item] of this.values) this.options.onEvict?.(item.value, key)
        this.values.clear()
        this.totalWeight = 0
    }

    private trim(): void {
        while (this.values.size > this.options.maxEntries ||
            (this.options.maxWeight !== undefined && this.totalWeight > this.options.maxWeight)) {
            const oldest = this.values.keys().next().value as K | undefined
            if (oldest === undefined) break
            this.delete(oldest)
        }
    }
}
