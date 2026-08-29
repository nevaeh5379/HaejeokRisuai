import type { RisuPersona, PersonaFolder } from "../../storage/database/schema";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { createEmptySqlCommit } from "../../storage/sql/sqlCommit";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { snapshotFingerprint, trackDeep } from "./reactiveUtils";
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
  personaFolders = $state<PersonaFolder[]>([]);
  activeIndex = $state(0);
  loaded = $state(false);

  private storage: ISqlStorage | null = null;
  private observeDispose: (() => void) | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private committedPersonas = "";
  private committedFolders = "";
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

  get folders(): PersonaFolder[] {
    return this.personaFolders;
  }

  async init(storage: ISqlStorage): Promise<void> {
    this.disposeObserver();
    this.storage = storage;
    const [storedPersonas, folders, selected] = await Promise.all([
      storage.loadPersonas(),
      storage.loadSettingKey("personaFolders"),
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
    this.personaFolders = Array.isArray(folders)
      ? folders as PersonaFolder[]
      : [];
    this.activeIndex = index;
    this.loaded = true;

    this.committedPersonas = snapshotFingerprint($state.snapshot(this.personas));
    this.committedFolders = snapshotFingerprint(
      $state.snapshot(this.personaFolders),
    );
    this.committedActiveIndex = this.activeIndex;
    this.observeDispose = $effect.root(() => {
      $effect(() => {
        trackDeep(this.personas);
        trackDeep(this.personaFolders);
        const personasFingerprint = snapshotFingerprint(
          $state.snapshot(this.personas),
        );
        const foldersFingerprint = snapshotFingerprint(
          $state.snapshot(this.personaFolders),
        );
        const activeIndex = this.activeIndex;
        if (
          personasFingerprint !== this.committedPersonas ||
          foldersFingerprint !== this.committedFolders ||
          activeIndex !== this.committedActiveIndex
        ) {
          this.scheduleCommit();
        }
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
    return this.personas.length - 1;
  }

  replace(personas: RisuPersona[]): void {
    this.assertLoaded();
    this.personas = personas.length > 0 ? [...personas] : [createDefaultPersona()];
    if (!this.personas[this.activeIndex]) this.activeIndex = 0;
  }

  select(index: number, caller = "personaStore"): void {
    this.require(index, caller);
    this.activeIndex = index;
  }

  async savePersona(persona: RisuPersona, position?: number): Promise<void> {
    const target = position ?? this.activeIndex;
    this.require(target, "savePersona");
    this.personas[target] = persona;
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
    await this.flush();
  }

  async setActiveIndex(index: number): Promise<void> {
    this.select(index, "setActiveIndex");
    await this.flush();
  }

  getPersonaFolderById(id: string): PersonaFolder | undefined {
    return this.personaFolders.find((folder) => folder.id === id);
  }

  /** Personas whose folder is explicit and still exists. */
  personasInFolder(folderId: string): RisuPersona[] {
    return this.personas.filter((persona) => persona.folderId === folderId);
  }

  /** Personas without a folder assignment (root or a deleted folder reference). */
  personasWithoutFolder(): RisuPersona[] {
    return this.personas.filter(
      (persona) =>
        !persona.folderId || !this.getPersonaFolderById(persona.folderId),
    );
  }

  async addFolder(name: string, color = ""): Promise<PersonaFolder> {
    this.assertLoaded();
    const folder: PersonaFolder = {
      id: crypto.randomUUID(),
      name,
      color,
    };
    this.personaFolders.push(folder);
    await this.flush();
    return folder;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    this.assertLoaded();
    const folder = this.getPersonaFolderById(id);
    if (!folder) throw new Error(`Persona folder not found: ${id}`);
    folder.name = name;
    await this.flush();
  }

  async removeFolder(id: string): Promise<void> {
    this.assertLoaded();
    this.personaFolders = this.personaFolders.filter(
      (folder) => folder.id !== id,
    );
    for (const persona of this.personas) {
      if (persona.folderId === id) persona.folderId = undefined;
    }
    await this.flush();
  }

  async movePersonaToFolder(
    personaId: string,
    folderId: string | undefined,
  ): Promise<void> {
    this.assertLoaded();
    const persona = this.personas.find((current) => current.id === personaId);
    if (!persona) {
      throw new Error(`Persona not found: ${personaId}`);
    }
    if (folderId !== undefined && !this.getPersonaFolderById(folderId)) {
      throw new Error(`Persona folder not found: ${folderId}`);
    }
    persona.folderId = folderId;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const personas = $state.snapshot(this.personas) as RisuPersona[];
    const personasFingerprint = snapshotFingerprint(personas);
    const folders = $state.snapshot(this.personaFolders) as PersonaFolder[];
    const foldersFingerprint = snapshotFingerprint(folders);
    const activeIndex = this.activeIndex;
    if (
      personasFingerprint === this.committedPersonas &&
      foldersFingerprint === this.committedFolders &&
      activeIndex === this.committedActiveIndex
    ) return;

    const storage = this.storage;
    if (!storage) {
      this.committedPersonas = personasFingerprint;
      this.committedFolders = foldersFingerprint;
      this.committedActiveIndex = activeIndex;
      return;
    }

    const commit = createEmptySqlCommit(0, "persona");
    if (personasFingerprint !== this.committedPersonas) {
      commit.root.upserts.push({ key: "personas", value: personas });
    }
    if (foldersFingerprint !== this.committedFolders) {
      commit.root.upserts.push({ key: "personaFolders", value: folders });
    }
    if (activeIndex !== this.committedActiveIndex) {
      commit.root.upserts.push({ key: "selectedPersona", value: activeIndex });
    }
    const operation = this.writeChain.then(() => commitSqlChanges(storage, commit));
    this.writeChain = operation.then(() => undefined, () => undefined);
    await operation;
    this.committedPersonas = personasFingerprint;
    this.committedFolders = foldersFingerprint;
    this.committedActiveIndex = activeIndex;
  }

  hasPendingWrites(): boolean {
    return (
      snapshotFingerprint($state.snapshot(this.personas)) !==
        this.committedPersonas ||
      snapshotFingerprint($state.snapshot(this.personaFolders)) !==
        this.committedFolders ||
      this.activeIndex !== this.committedActiveIndex
    );
  }

  private scheduleCommit(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.flush().catch((error) => {
        console.error("[PersonaStore] Failed to persist personas:", error);
      });
    }, 100);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Persona store is not loaded");
  }

  private disposeObserver(): void {
    this.observeDispose?.();
    this.observeDispose = null;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  resetForTesting(): void {
    this.disposeObserver();
    this.storage = null;
    this.personas = [];
    this.personaFolders = [];
    this.activeIndex = 0;
    this.loaded = false;
    this.committedPersonas = "";
    this.committedFolders = "";
    this.committedActiveIndex = 0;
    this.writeChain = Promise.resolve();
  }
}

export const personaStore = new PersonaStore();
