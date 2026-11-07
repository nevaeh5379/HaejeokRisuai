import type { ProtocolSettingKeys } from "../settings.ts";
import type { DatabaseSettings } from "./database.ts";

/** The existing prompt-related root settings; this is one settings group, not an ID-based record. */
export type PromptFields = Pick<
  DatabaseSettings,
  ProtocolSettingKeys["PROMPT_SETTING_KEYS"]
>;

export type PromptUpdate = Partial<PromptFields>;
