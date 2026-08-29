import type { RisuPersona } from "../../storage/schema";
import { settingsStore } from "./settingsStore.svelte";

class PersonaStore {
  get isLoaded(): boolean {
    return settingsStore.isDeferredLoaded("personas");
  }

  get list(): RisuPersona[] {
    const personas = settingsStore.getStateRecord().personas;
    if (!this.isLoaded) {
      settingsStore.requestDeferredLoad("personas");
      return [];
    }
    return personas ?? [];
  }

  get activeIndex(): number {
    return settingsStore.get("selectedPersona") ?? 0;
  }

  get activePersona(): RisuPersona | undefined {
    return this.list[this.activeIndex];
  }

  async ensureLoaded(): Promise<void> {
    await settingsStore.ensureDeferredKey("personas");
    if (!this.isLoaded) {
      throw new Error("Failed to load personas");
    }
    if (!this.list[this.activeIndex]) {
      throw new RangeError(
        `[ensureLoaded] Invalid persona index: ${this.activeIndex} (persona count: ${this.list.length})`,
      );
    }
  }

  get(index: number): RisuPersona | undefined {
    return this.list[index];
  }

  require(index: number, caller = "personaStore"): RisuPersona {
    const persona = this.get(index);
    if (!persona) {
      throw new RangeError(
        `[${caller}] Invalid persona index: ${index} (persona count: ${this.list.length})`,
      );
    }
    return persona;
  }

  requireActive(caller = "personaStore"): RisuPersona {
    return this.require(this.activeIndex, caller);
  }

  add(persona: RisuPersona): number {
    if (!this.isLoaded) {
      throw new Error("Persona store is not loaded");
    }
    const personas = this.list;
    personas.push(persona);
    return personas.length - 1;
  }

  replace(personas: RisuPersona[]): void {
    if (!this.isLoaded) {
      throw new Error("Persona store is not loaded");
    }
    settingsStore.set("personas", personas);
  }

  select(index: number, caller = "personaStore"): void {
    this.require(index, caller);
    settingsStore.set("selectedPersona", index);
  }

  async savePersona(persona: RisuPersona, position?: number): Promise<void> {
    const targetPos = position !== undefined ? position : this.activeIndex;
    const current = [...this.list];
    if (!current[targetPos]) {
      throw new RangeError(`Invalid persona index: ${targetPos}`);
    }
    current[targetPos] = persona;
    settingsStore.set("personas", current);
    await settingsStore.flush();
  }

  async removePersona(index: number): Promise<void> {
    this.require(index, "removePersona");
    const current = this.list.filter((_, i) => i !== index);
    settingsStore.set("personas", current);
    await settingsStore.flush();
  }

  async setActiveIndex(index: number): Promise<void> {
    this.select(index, "setActiveIndex");
    await settingsStore.flush();
  }
}

export const personaStore = new PersonaStore();
