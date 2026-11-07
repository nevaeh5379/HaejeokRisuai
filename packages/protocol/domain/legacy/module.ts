import type { loreBook } from "./lorebook.ts";
import type { customscript, triggerscript } from "./script.ts";

/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface MCPModule {
  url: string;
}

export interface RisuModule {
  name: string;
  description: string;
  lorebook?: loreBook[];
  regex?: customscript[];
  cjs?: string;
  trigger?: triggerscript[];
  id: string;
  lowLevelAccess?: boolean;
  hideIcon?: boolean;
  backgroundEmbedding?: string;
  assets?: [string, string, string][];
  namespace?: string;
  customModuleToggle?: string;
  mcp?: MCPModule;
  icon?: string;
}
