import type { PresetSettings } from "./presetSchema.ts";

/** Stored configuration; legacy export-only credentials belong to botPreset. */
export interface PresetFields extends PresetSettings {
  id: string;
  position: number;
  name: string;
  image?: string;
}

/** Identity and ordering are managed through the storage API. */
export type PresetUpdate = Partial<Omit<PresetFields, "id" | "position">>;

/** Stateless handle; large prompt/configuration fields are read only on request. */
export class Preset {
  readonly id: string;
  readonly #read: <K extends keyof PresetFields>(
    ...keys: [K, ...K[]]
  ) => Promise<Pick<PresetFields, K>>;
  readonly #write: (patch: PresetUpdate) => Promise<void>;

  constructor(
    id: string,
    read: <K extends keyof PresetFields>(
      ...keys: [K, ...K[]]
    ) => Promise<Pick<PresetFields, K>>,
    write: (patch: PresetUpdate) => Promise<void>,
  ) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get<K extends keyof PresetFields>(
    ...keys: [K, ...K[]]
  ): Promise<Pick<PresetFields, K>> {
    return this.#read(...keys);
  }

  update(patch: PresetUpdate): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
