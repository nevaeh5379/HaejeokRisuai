import type { PromptItem, PromptSettings } from "../process/prompt";
import type { ChatGenerationOverrides } from "../process/chatGenerationContext";

/**
 * Risu Agent's own prompt configuration.
 *
 * Stored globally on the reserved agent character (`character.agentPrompt`),
 * not per conversation, and never copied into the shared presetStore. Absence
 * of this field means "no agent-specific prompt configuration", which keeps the
 * reserved utility-bot template and the ordinary preset settings: that is the
 * behavior Risu Agent had before this feature, so legacy characters need no
 * migration.
 */
export interface RisuAgentPromptConfig {
  promptTemplate: PromptItem[];
  promptSettings: PromptSettings;
}

/** Canonical prompt-setting defaults, independent of the active preset. */
export function createDefaultRisuAgentPromptSettings(): PromptSettings {
  return {
    assistantPrefill: "",
    postEndInnerFormat: "",
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
    customChainOfThought: false,
    maxThoughtTagDepth: -1,
    trimStartNewChat: false,
  };
}

export function createDefaultRisuAgentPromptConfig(
  promptTemplate: PromptItem[] = [],
): RisuAgentPromptConfig {
  return {
    promptTemplate: safeClone(promptTemplate),
    promptSettings: createDefaultRisuAgentPromptSettings(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Local deep clone so this module stays free of heavy runtime imports. */
function safeClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Falls through to the JSON path for non-cloneable values.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/** Keep only well-formed prompt cards; drop unknown or malformed entries. */
function normalizePromptTemplate(value: unknown): PromptItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PromptItem =>
      isRecord(item) && typeof item.type === "string" && item.type.length > 0,
  );
}

function normalizePromptSettings(value: unknown): PromptSettings {
  const defaults = createDefaultRisuAgentPromptSettings();
  if (!isRecord(value)) return defaults;
  return {
    assistantPrefill: asString(
      value.assistantPrefill,
      defaults.assistantPrefill,
    ),
    postEndInnerFormat: asString(
      value.postEndInnerFormat,
      defaults.postEndInnerFormat,
    ),
    sendChatAsSystem: asBoolean(
      value.sendChatAsSystem,
      defaults.sendChatAsSystem,
    ),
    sendName: asBoolean(value.sendName, defaults.sendName),
    utilOverride: asBoolean(value.utilOverride, defaults.utilOverride),
    customChainOfThought: asBoolean(
      value.customChainOfThought,
      defaults.customChainOfThought,
    ),
    maxThoughtTagDepth: asNumber(
      value.maxThoughtTagDepth,
      defaults.maxThoughtTagDepth ?? -1,
    ),
    trimStartNewChat: asBoolean(
      value.trimStartNewChat,
      defaults.trimStartNewChat ?? false,
    ),
  };
}

/**
 * Normalize persisted (possibly legacy, partial or malformed) agent prompt data
 * into a valid config, or `null` when there is nothing usable. A `null` result
 * means "keep the pre-feature behavior".
 */
export function normalizeRisuAgentPromptConfig(
  value: unknown,
): RisuAgentPromptConfig | null {
  if (!isRecord(value)) return null;
  const hasTemplate = Array.isArray(value.promptTemplate);
  const hasSettings = isRecord(value.promptSettings);
  if (!hasTemplate && !hasSettings) return null;
  return {
    promptTemplate: normalizePromptTemplate(value.promptTemplate),
    promptSettings: normalizePromptSettings(value.promptSettings),
  };
}

/** True when the agent config is active and must override the preset. */
export function isRisuAgentPromptEnabled(
  value: unknown,
): value is RisuAgentPromptConfig {
  const config = normalizeRisuAgentPromptConfig(value);
  return Boolean(config?.promptSettings.utilOverride);
}

/**
 * Build a request-local {@link ChatGenerationOverrides} value from the reserved
 * character's config. Returns `undefined` when the agent uses the default
 * utility-bot prompt, so the generation pipeline keeps reading the ordinary
 * preset values exactly as it did before this feature.
 *
 * The returned template/settings are deep clones: generation must never observe
 * later edits, and nothing here is ever written back into presetStore.
 */
export function buildRisuAgentGenerationOverrides(
  value: unknown,
): ChatGenerationOverrides | undefined {
  const config = normalizeRisuAgentPromptConfig(value);
  if (!config || !config.promptSettings.utilOverride) return undefined;
  return {
    // An empty template must become null, otherwise the pipeline would treat it
    // as a real (empty) template and drop the chat history.
    promptTemplate:
      config.promptTemplate.length > 0
        ? safeClone(config.promptTemplate)
        : null,
    promptSettings: safeClone(config.promptSettings),
  };
}
