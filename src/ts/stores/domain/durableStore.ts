/**
 * Contract for stores that buffer mutations before durable persistence.
 *
 * Implementations intentionally own their flush strategy: settings persist
 * dirty keys, characters coordinate manifests, and smaller domain stores use
 * fingerprints. This class standardizes the lifecycle without pretending
 * those write semantics are interchangeable.
 */
export abstract class DurableStore {
  abstract flush(): Promise<void>;
  abstract hasPendingWrites(): boolean;
}
