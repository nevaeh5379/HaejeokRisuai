import type { CharacterFields } from "../../../packages/protocol/domain/character.ts";
import type { ChatFields } from "../../../packages/protocol/domain/chat.ts";
import type { Message } from "../../../packages/protocol/domain/database.ts";
import type { RisuPersona } from "../../../packages/protocol/domain/legacy/persona.ts";
import type { botPreset } from "../../../packages/protocol/domain/legacy/preset.ts";
import type { character } from "../../../packages/protocol/domain/legacy/character.ts";
import type {
  Chat as LegacyChat,
  Message as LegacyMessage,
} from "../../../packages/protocol/domain/legacy/chat.ts";
import type { LorebookFields } from "../../../packages/protocol/domain/lorebook.ts";
import type { ModuleFields } from "../../../packages/protocol/domain/module.ts";
import type { RisuModule as ModuleData } from "../../../packages/protocol/domain/modules.ts";
import type { RisuModule } from "../../../packages/protocol/domain/legacy/module.ts";
import type { Database } from "../../../packages/protocol/domain/legacy/database.ts";
import type { PersonaFields } from "../../../packages/protocol/domain/persona.ts";
import type { PresetFields } from "../../../packages/protocol/domain/preset.ts";
import type { PluginMetadata } from "../../../packages/protocol/domain/pluginTypes.ts";
import type { RisuPlugin } from "../../../packages/protocol/domain/legacy/plugin.ts";
import type { triggerscript } from "../../../packages/protocol/domain/database.ts";
import type { triggerscript as LegacyTrigger } from "../../../packages/protocol/domain/legacy/triggers.ts";

function legacyTrigger(value: triggerscript): LegacyTrigger {
  const {
    subModel: _subModel,
    sourceModuleId: _sourceModuleId,
    sandboxOwnerModuleIds: _sandboxOwnerModuleIds,
    sandboxGroupId: _sandboxGroupId,
    sandboxGroupName: _sandboxGroupName,
    sandboxInstanceId: _sandboxInstanceId,
    sandboxModuleIds: _sandboxModuleIds,
    ...trigger
  } = value;
  return trigger;
}

/** Converters accept materialized domain fields, not storage handles or reactive
 * store objects. Callers load only the object requested by the plugin.
 * Results are detached. These functions never save or merge persisted data.
 */
export function toLegacyMessage(value: Message): LegacyMessage {
  const { illustrations: _illustrations, ...message } = value;
  return structuredClone(message);
}

export function toLegacyChat(
  value: ChatFields,
  messages: readonly Message[],
): LegacyChat {
  const {
    characterId: _characterId,
    position: _position,
    activeBranchId: _activeBranchId,
    globalAuthorNoteId: _globalAuthorNoteId,
    btwSessions: _btwSessions,
    activeBtwSessionId: _activeBtwSessionId,
    ...chat
  } = value;
  // Clone the assembled graph once, including user-owned script/variable maps.
  return structuredClone({
    ...chat,
    message: messages.map(
      ({ illustrations: _illustrations, ...message }) => message,
    ),
  });
}

export function toLegacyCharacter(
  value: CharacterFields,
  chats: readonly LegacyChat[],
  chatFolders: character["chatFolders"],
  chatPage: number,
): character {
  const {
    illustration: _illustration,
    additionalAssetFolders: _additionalAssetFolders,
    additionalAssetFolderAssignments: _additionalAssetFolderAssignments,
    ...fields
  } = value;
  return structuredClone({
    ...fields,
    triggerscript: fields.triggerscript.map(legacyTrigger),
    chats: [...chats],
    chatFolders,
    chatPage,
  });
}

function legacyModuleFields(value: ModuleData): RisuModule {
  const {
    folderId: _folderId,
    subModel: _subModel,
    subModelRequestRules: _subModelRequestRules,
    ...module
  } = value;
  return {
    ...module,
    ...(module.trigger && { trigger: module.trigger.map(legacyTrigger) }),
  };
}

export function toLegacyModule(value: ModuleFields): RisuModule {
  const { position: _position, ...module } = value;
  return structuredClone(legacyModuleFields(module));
}

export function toLegacyPersona(value: PersonaFields): RisuPersona {
  const { position: _position, ...persona } = value;
  if (persona.embeddedModule) {
    persona.embeddedModule = legacyModuleFields(persona.embeddedModule);
  }
  return structuredClone(persona);
}

export function toLegacyPreset(value: PresetFields): botPreset {
  const {
    id: _id,
    position: _position,
    googleSafetySettings: _googleSafetySettings,
    openrouterSubRequestModel: _openrouterSubRequestModel,
    customProxySubRequestModel: _customProxySubRequestModel,
    providerModelOverrides: _providerModelOverrides,
    promptTemplate,
    thinkingTokens,
    ...preset
  } = value;
  return structuredClone({
    ...preset,
    ...(promptTemplate != null && { promptTemplate }),
    ...(thinkingTokens != null && { thinkingTokens }),
  });
}

export function toLegacyLorebook(
  value: LorebookFields,
): Database["loreBook"][number] {
  const { position: _position, ...lorebook } = value;
  return structuredClone(lorebook);
}

export function toLegacyPlugin(
  value: PluginMetadata,
  script: string,
): RisuPlugin {
  const { id: _id, position: _position, ...metadata } = value;
  return structuredClone({ ...metadata, script });
}
