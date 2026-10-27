export type PromptItem =
  | PromptItemPlain
  | PromptItemTyped
  | PromptItemChat
  | PromptItemAuthorNote
  | PromptItemChatML
  | PromptItemCache;
export type PromptType = PromptItem["type"];
export type PromptSettings = {
  assistantPrefill: string;
  postEndInnerFormat: string;
  sendChatAsSystem: boolean;
  sendName: boolean;
  utilOverride: boolean;
  customChainOfThought?: boolean;
  maxThoughtTagDepth?: number;
  trimStartNewChat?: boolean;
};

export type PromptRole = "user" | "bot" | "system";

export interface PromptItemPlain {
  type: "plain" | "jailbreak" | "cot";
  type2: "normal" | "globalNote" | "main";
  text: string;
  role: PromptRole;
  name?: string;
}

export interface PromptItemChatML {
  type: "chatML";
  text: string;
  name?: string;
}

export interface PromptItemTyped {
  type: "persona" | "description" | "lorebook" | "postEverything" | "memory";
  innerFormat?: string;
  role2?: PromptRole;
  name?: string;
}

export interface PromptItemAuthorNote {
  type: "authornote";
  innerFormat?: string;
  defaultText?: string;
  role2?: PromptRole;
  name?: string;
}

export interface PromptItemChat {
  type: "chat";
  rangeStart: number;
  rangeEnd: number | "end";
  chatAsOriginalOnSystem?: boolean;
  name?: string;
}

export interface PromptItemCache {
  type: "cache";
  name: string;
  depth: number;
  role: "user" | "assistant" | "system" | "all";
}

