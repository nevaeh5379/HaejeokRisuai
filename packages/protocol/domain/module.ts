import type { RisuModule } from "./modules.ts";

export interface ModuleFields extends RisuModule {
  position: number;
}
export type ModuleUpdate = Partial<Omit<ModuleFields, "id" | "position">>;

/** Stateless module handle. The storage layer owns values and write serialization. */
export class Module {
  readonly id: string;
  readonly #read: () => Promise<ModuleFields>;
  readonly #write: (patch: ModuleUpdate) => Promise<void>;

  constructor(
    id: string,
    read: () => Promise<ModuleFields>,
    write: (patch: ModuleUpdate) => Promise<void>,
  ) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get(): Promise<ModuleFields> {
    return this.#read();
  }

  update(patch: ModuleUpdate): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
