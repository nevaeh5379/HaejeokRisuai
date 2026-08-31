import type { RisuPersona } from "../../storage/database/schema";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { snapshotFingerprint, trackDeep } from "./reactiveUtils";
import { StoreCommitQueue } from "./storeCommitQueue";
import type {
  FlushableStore,
  InitializableStore,
} from "./storeContracts";

const createDefaultPersona = (): RisuPersona => ({
  name: "User",
  icon: "",
  personaPrompt: "",
  note: "",
  largePortrait: false,
});

class PersonaStore
  implements
    InitializableStore<[storage: ISqlStorage]>,
    FlushableStore
{
  personas = $state<RisuPersona[]>([]);
  activeIndex = $state(0);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observeDispose: (() => void) | null = null;
  private queue = new StoreCommitQueue();
  private personasDirty = false;
  private activeIndexDirty = false;
  private committedPersonasFingerprint = "";
  private committedActiveIndex = 0;

  get isLoaded(): boolean {
    return this.loaded;
  }

  get list(): RisuPersona[] {
    return this.personas;
  }

  get activePersona(): RisuPersona | undefined {
    return this.personas[this.activeIndex];
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.disposeObserver();
    this.storage = storage;
    const [storedPersonas, selected] = await Promise.all([
      storage.loadPersonas(),
      storage.loadSettingKey("selectedPersona"),
    ]);
    const personas = storedPersonas.length > 0
      ? storedPersonas.map((persona) => ({
          ...persona,
          largePortrait: persona.largePortrait ?? false,
        }))
      : [createDefaultPersona()];
    if (
      selected !== undefined &&
      selected !== null &&
      (!Number.isSafeInteger(selected) || selected < 0)
    ) {
      throw new TypeError(`Invalid selected persona index: ${String(selected)}`);
    }
    const index = typeof selected === "number" ? selected : 0;
    if (!personas[index]) {
      throw new RangeError(
        `[PersonaStore.init] Invalid persona index: ${index} (persona count: ${personas.length})`,
      );
    }
    this.personas = personas;
    this.activeIndex = index;
    this.loaded = true;
    this.personasDirty = false;
    this.activeIndexDirty = false;
    // Baseline from the synchronous assignment above; steady-state effect
    // runs only mark dirty — they must never serialise the persona array
    // (icons can hold MB-sized data URLs).  Content is verified once at
    // flush/backup time.
    this.committedPersonasFingerprint = snapshotFingerprint(
      $state.snapshot(this.personas),
    );
    this.committedActiveIndex = this.activeIndex;
    let initial = true;
    this.observeDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.personas);
        // Read so selection changes re-run this effect even when the
        // personas array itself did not change.
        void this.activeIndex;
        if (initial) {
          initial = false;
          return;
        }
        this.personasDirty = true;
        this.scheduleCommit();
      });
    });
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) throw new Error("Persona store is not loaded");
    if (!this.personas[this.activeIndex]) {
      throw new RangeError(
        `[ensureLoaded] Invalid persona index: ${this.activeIndex} (persona count: ${this.personas.length})`,
      );
    }
  }

  get(index: number): RisuPersona | undefined {
    return this.personas[index];
  }
  require(index: number, caller = "personaStore"): RisuPersona {
    const persona = this.get(index);
    if (!persona) {
      throw new RangeError(
        `[${caller}] Invalid persona index: ${index} (persona count: ${this.personas.length})`,
      );
    }
    return persona;
  }

  requireActive(caller = "personaStore"): RisuPersona {
    return this.require(this.activeIndex, caller);
  }

  add(persona: RisuPersona): number {
    this.assertLoaded();
    this.personas.push(persona);
    this.markPersonasDirty();
    return this.personas.length - 1;
  }

  replace(personas: RisuPersona[]): void {
    this.assertLoaded();
    this.personas = personas.length > 0 ? [...personas] : [createDefaultPersona()];
    if (!this.personas[this.activeIndex]) this.activeIndex = 0;
    this.markPersonasDirty();
  }

  select(index: number, caller = "personaStore"): void {
    this.require(index, caller);
    this.activeIndex = index;
    this.activeIndexDirty = true;
    this.scheduleCommit();
  }

  async savePersona(persona: RisuPersona, position?: number): Promise<void> {
    const target = position ?? this.activeIndex;
    this.require(target, "savePersona");
    this.personas[target] = persona;
    this.markPersonasDirty();
    await this.flush();
  }

  async removePersona(index: number): Promise<void> {
    this.require(index, "removePersona");
    const next = this.personas.filter((_, current) => current !== index);
    this.personas = next.length > 0 ? next : [createDefaultPersona()];
    if (this.activeIndex >= this.personas.length) {
      this.activeIndex = Math.max(0, this.personas.length - 1);
    } else if (index < this.activeIndex) {
      this.activeIndex -= 1;
    }
    this.markPersonasDirty();
    this.activeIndexDirty = true;
    await this.flush();
  }

  async setActiveIndex(index: number): Promise<void> {
    this.select(index, "setActiveIndex");
    await this.flush();
  }

  async flush(): Promise<void> {
    this.queue.cancel();
    // Verify dirty flags against content once at commit time — mutating and
    // awaiting flush() synchronously can beat effect-based detection.
    const personas = $state.snapshot(this.personas) as RisuPersona[];
    const personasFingerprint = snapshotFingerprint(personas);
    const activeIndex = this.activeIndex;
    const personasChanged =
      this.personasDirty || personasFingerprint !== this.committedPersonasFingerprint;
    const activeIndexChanged =
      this.activeIndexDirty || activeIndex !== this.committedActiveIndex;
    if (!personasChanged && !activeIndexChanged) return;

    const storage = this.storage;
    if (!storage) {
      this.committedPersonasFingerprint = personasFingerprint;
      this.committedActiveIndex = activeIndex;
      this.personasDirty = false;
      this.activeIndexDirty = false;
      return;
    }

    const commit = createEmptySqlCommit(0, "persona");
    if (personasChanged) {
      commit.root.upserts.push({ key: "personas", value: personas });
    }
    if (activeIndexChanged) {
      commit.root.upserts.push({ key: "selectedPersona", value: activeIndex });
    }
    await this.queue.enqueue(() => commitSqlChanges(storage, commit));
    this.committedPersonasFingerprint = personasFingerprint;
    this.committedActiveIndex = activeIndex;
    this.personasDirty = false;
    this.activeIndexDirty = false;
  }

  hasPendingWrites(): boolean {
    return (
      this.personasDirty ||
      this.activeIndexDirty ||
      snapshotFingerprint($state.snapshot(this.personas)) !==
        this.committedPersonasFingerprint ||
      this.activeIndex !== this.committedActiveIndex
    );
  }

  private scheduleCommit(): void {
    this.queue.schedule(() => this.flush());
  }

  private markPersonasDirty(): void {
    this.personasDirty = true;
    this.scheduleCommit();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Persona store is not loaded");
  }

  private disposeObserver(): void {
    this.observeDispose?.();
    this.observeDispose = null;
    this.queue.cancel();
  }

  resetForTesting(): void {
    this.disposeObserver();
    this.storage = null;
    this.personas = [];
    this.activeIndex = 0;
    this.loaded = false;
    this.committedPersonasFingerprint = "";
    this.committedActiveIndex = 0;
    this.personasDirty = false;
    this.activeIndexDirty = false;
    this.queue.reset();
  }
}

export const personaStore = new PersonaStore();
