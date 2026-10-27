import type {
  customscript,
  loreBook,
  triggerscript,
} from "./database.ts";
import type { ModuleRequestRule } from "./moduleRequestRules.ts";

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
  folderId?: string;
  subModel?: string;
  subModelRequestRules?: ModuleRequestRule[];
}

export interface ModuleFolder {
  id: string;
  name: string;
  color: string;
}

export interface ModuleSandboxMember {
  /** Stable runtime identity for this placement of a module definition. */
  instanceId: string;
  moduleId: string;
  enabled?: boolean;
}

export interface ModuleSandboxGroup {
  id: string;
  name: string;
  members: ModuleSandboxMember[];
  /** Blank uses the active preset's global auxiliary model. */
  subModel?: string;
  /** Position of the bundle node on the editor canvas. */
  position?: { x: number; y: number };
}

export interface ResolvedModuleSandboxMember extends ModuleSandboxMember {
  module: RisuModule;
}

export interface ResolvedModuleSandbox {
  id: string;
  name: string;
  subModel?: string;
  members: ResolvedModuleSandboxMember[];
}

