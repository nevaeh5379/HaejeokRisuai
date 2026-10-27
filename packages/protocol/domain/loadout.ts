export type Loadout = {
  name: string;
  id: string;
  lastUsed: number;
  favorite: boolean;
  characterIds: string[];
  modules: string[];
  globalVariables: { [key: string]: string };
  presetName: string;
  personaId: string;
  icons?: string[];
};
