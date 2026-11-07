import type { RisuModule } from "./module.ts";
/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface RisuPersona {
  personaPrompt: string;
  name: string;
  icon: string;
  largePortrait?: boolean;
  id?: string;
  note?: string;
  embeddedModule?: RisuModule;
}
