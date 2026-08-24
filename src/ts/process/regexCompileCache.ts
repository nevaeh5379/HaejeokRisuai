export class RegexCompileCache {
  private readonly cache = new Map<string, RegExp>();

  constructor(private readonly maxEntries = 256) {}

  get(source: string, flags: string): RegExp {
    const key = `${flags}\0${source}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Promote on access and reset stateful global/sticky regex cursors.
      this.cache.delete(key);
      this.cache.set(key, cached);
      cached.lastIndex = 0;
      return cached;
    }

    const compiled = new RegExp(source, flags);
    this.cache.set(key, compiled);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return compiled;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
