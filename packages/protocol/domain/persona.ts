import type { RisuPersona } from "./database.ts";

export interface PersonaFields extends Omit<RisuPersona, "id"> {
  id: string;
  position: number;
}

/** Identity and ordering are managed through the storage API. */
export type PersonaUpdate = Partial<Omit<PersonaFields, "id" | "position">>;

/** Stateless handle; field values and caches belong to the storage layer. */
export class Persona {
  readonly id: string;
  readonly #read: () => Promise<PersonaFields>;
  readonly #write: (patch: PersonaUpdate) => Promise<void>;

  constructor(
    id: string,
    read: () => Promise<PersonaFields>,
    write: (patch: PersonaUpdate) => Promise<void>,
  ) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get(): Promise<PersonaFields> {
    return this.#read();
  }

  update(patch: PersonaUpdate): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }
}
