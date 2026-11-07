import type { CharacterFields } from "@risuai/protocol/domain/character.ts";
import type { ChatFields } from "@risuai/protocol/domain/chat.ts";
import type {
  ChatState,
  groupChat,
  Message,
  RisuPersona as DomainPersona,
  triggerscript,
} from "@risuai/protocol/domain/database.ts";
import type {
  character,
  groupChat as LegacyGroup,
} from "@risuai/protocol/domain/legacy/character.ts";
import type {
  Chat as LegacyChat,
  Message as LegacyMessage,
} from "@risuai/protocol/domain/legacy/chat.ts";
import type { RisuModule } from "@risuai/protocol/domain/legacy/module.ts";
import type { RisuPersona } from "@risuai/protocol/domain/legacy/persona.ts";
import type { RisuPlugin } from "@risuai/protocol/domain/legacy/plugin.ts";
import type { botPreset } from "@risuai/protocol/domain/legacy/preset.ts";
import type { loreBook } from "@risuai/protocol/domain/legacy/lorebook.ts";
import type { triggerscript as LegacyTrigger } from "@risuai/protocol/domain/legacy/triggers.ts";
import type { RisuModule as DomainModule } from "@risuai/protocol/domain/modules.ts";
import type { PluginMetadata } from "@risuai/protocol/domain/pluginTypes.ts";
import type { PresetFields } from "@risuai/protocol/domain/preset.ts";

export type LegacyCharacter = character | LegacyGroup;
export type CharacterSnapshot = character | groupChat;

function legacyMessage(value: Message): LegacyMessage {
  return {
    role: value.role,
    data: value.data,
    saying: value.saying,
    chatId: value.chatId,
    time: value.time,
    generationInfo: value.generationInfo && {
      model: value.generationInfo.model,
      generationId: value.generationInfo.generationId,
      inputTokens: value.generationInfo.inputTokens,
      outputTokens: value.generationInfo.outputTokens,
      maxContext: value.generationInfo.maxContext,
      stageTiming: value.generationInfo.stageTiming && {
        stage1: value.generationInfo.stageTiming.stage1,
        stage2: value.generationInfo.stageTiming.stage2,
        stage3: value.generationInfo.stageTiming.stage3,
        stage4: value.generationInfo.stageTiming.stage4,
      },
    },
    promptInfo: value.promptInfo && {
      promptName: value.promptInfo.promptName,
      promptToggles: value.promptInfo.promptToggles?.map((toggle) => ({
        key: toggle.key,
        value: toggle.value,
      })),
      promptText: value.promptInfo.promptText,
    },
    name: value.name,
    otherUser: value.otherUser,
    disabled: value.disabled,
    isComment: value.isComment,
  };
}

function legacyChat(
  value: ChatState,
  messages = (value.message ?? []).map(legacyMessage),
): LegacyChat {
  return {
    message: messages,
    note: value.note,
    name: value.name,
    localLore: (value.localLore ?? []).map(legacyLorebook),
    sdData: value.sdData,
    supaMemoryData: value.supaMemoryData,
    hypaV2Data: value.hypaV2Data,
    lastMemory: value.lastMemory,
    suggestMessages: value.suggestMessages,
    isStreaming: value.isStreaming,
    activeStreamingDisplayOptimizationMode:
      value.activeStreamingDisplayOptimizationMode,
    scriptstate: value.scriptstate,
    modules: value.modules,
    id: value.id,
    bindedPersona: value.bindedPersona,
    fmIndex: value.fmIndex,
    hypaV3Data: value.hypaV3Data,
    folderId: value.folderId,
    lastDate: value.lastDate,
    bookmarks: value.bookmarks,
    bookmarkNames: value.bookmarkNames,
    useLocallySetGlobalVariables: value.useLocallySetGlobalVariables,
    GLGlobalVariables: value.GLGlobalVariables,
    onboardingDone: value.onboardingDone,
  };
}

function legacyCharacter(
  value: character,
  chats = (value.chats ?? []).map((chat) => legacyChat(chat)),
  triggers = (value.triggerscript ?? []).map(legacyTrigger),
): character {
  return {
    type: value.type,
    name: value.name,
    image: value.image,
    firstMessage: value.firstMessage,
    desc: value.desc,
    notes: value.notes,
    chats,
    chatFolders: value.chatFolders,
    chatPage: value.chatPage,
    viewScreen: value.viewScreen,
    bias: value.bias,
    emotionImages: value.emotionImages,
    globalLore: (value.globalLore ?? []).map(legacyLorebook),
    chaId: value.chaId,
    sdData: value.sdData,
    newGenData: value.newGenData,
    customscript: value.customscript,
    triggerscript: triggers,
    utilityBot: value.utilityBot,
    exampleMessage: value.exampleMessage,
    removedQuotes: value.removedQuotes,
    creatorNotes: value.creatorNotes,
    systemPrompt: value.systemPrompt,
    postHistoryInstructions: value.postHistoryInstructions,
    alternateGreetings: value.alternateGreetings,
    tags: value.tags,
    creator: value.creator,
    characterVersion: value.characterVersion,
    personality: value.personality,
    scenario: value.scenario,
    firstMsgIndex: value.firstMsgIndex,
    loreSettings: value.loreSettings,
    loreExt: value.loreExt,
    additionalData: value.additionalData,
    ttsMode: value.ttsMode,
    ttsSpeech: value.ttsSpeech,
    voicevoxConfig: value.voicevoxConfig,
    naittsConfig: value.naittsConfig,
    gptSoVitsConfig: value.gptSoVitsConfig,
    fishSpeechConfig: value.fishSpeechConfig,
    supaMemory: value.supaMemory,
    additionalAssets: value.additionalAssets,
    ttsReadOnlyQuoted: value.ttsReadOnlyQuoted,
    replaceGlobalNote: value.replaceGlobalNote,
    backgroundHTML: value.backgroundHTML,
    reloadKeys: value.reloadKeys,
    backgroundCSS: value.backgroundCSS,
    license: value.license,
    private: value.private,
    additionalText: value.additionalText,
    oaiVoice: value.oaiVoice,
    oaiTTSConfig: value.oaiTTSConfig,
    virtualscript: value.virtualscript,
    scriptstate: value.scriptstate,
    depth_prompt: value.depth_prompt,
    extentions: value.extentions,
    largePortrait: value.largePortrait,
    lorePlus: value.lorePlus,
    inlayViewScreen: value.inlayViewScreen,
    hfTTS: value.hfTTS,
    vits: value.vits,
    realmId: value.realmId,
    imported: value.imported,
    trashTime: value.trashTime,
    nickname: value.nickname,
    source: value.source,
    group_only_greetings: value.group_only_greetings,
    creation_date: value.creation_date,
    modification_date: value.modification_date,
    ccAssets: value.ccAssets,
    defaultVariables: value.defaultVariables,
    onboarding: value.onboarding,
    lowLevelAccess: value.lowLevelAccess,
    hideChatIcon: value.hideChatIcon,
    lastInteraction: value.lastInteraction,
    translatorNote: value.translatorNote,
    doNotChangeSeperateModels: value.doNotChangeSeperateModels,
    escapeOutput: value.escapeOutput,
    prebuiltAssetCommand: value.prebuiltAssetCommand,
    prebuiltAssetStyle: value.prebuiltAssetStyle,
    prebuiltAssetExclude: value.prebuiltAssetExclude,
    modules: value.modules,
    moduleNamespace: value.moduleNamespace,
    coldstorage: value.coldstorage,
    coldStoragedChats: value.coldStoragedChats,
    customModuleToggle: value.customModuleToggle,
  };
}

function legacyGroup(
  value: groupChat,
  chats = (value.chats ?? []).map((chat) => legacyChat(chat)),
): LegacyGroup {
  return {
    type: value.type,
    image: value.image,
    firstMessage: value.firstMessage,
    chats,
    chatFolders: value.chatFolders,
    chatPage: value.chatPage,
    name: value.name,
    viewScreen: value.viewScreen,
    characters: value.characters,
    characterTalks: value.characterTalks,
    characterActive: value.characterActive,
    globalLore: (value.globalLore ?? []).map(legacyLorebook),
    autoMode: value.autoMode,
    useCharacterLore: value.useCharacterLore,
    emotionImages: value.emotionImages,
    customscript: value.customscript,
    chaId: value.chaId,
    alternateGreetings: value.alternateGreetings,
    creatorNotes: value.creatorNotes,
    removedQuotes: value.removedQuotes,
    firstMsgIndex: value.firstMsgIndex,
    loreSettings: value.loreSettings,
    supaMemory: value.supaMemory,
    ttsMode: value.ttsMode,
    suggestMessages: value.suggestMessages,
    orderByOrder: value.orderByOrder,
    backgroundHTML: value.backgroundHTML,
    reloadKeys: value.reloadKeys,
    backgroundCSS: value.backgroundCSS,
    oneAtTime: value.oneAtTime,
    virtualscript: value.virtualscript,
    lorePlus: value.lorePlus,
    trashTime: value.trashTime,
    nickname: value.nickname,
    defaultVariables: value.defaultVariables,
    lowLevelAccess: value.lowLevelAccess,
    hideChatIcon: value.hideChatIcon,
    lastInteraction: value.lastInteraction,
    voicevoxConfig: value.voicevoxConfig,
    ttsSpeech: value.ttsSpeech,
    naittsConfig: value.naittsConfig,
    oaiVoice: value.oaiVoice,
    oaiTTSConfig: value.oaiTTSConfig,
    hfTTS: value.hfTTS,
    vits: value.vits,
    gptSoVitsConfig: value.gptSoVitsConfig,
    fishSpeechConfig: value.fishSpeechConfig,
    ttsReadOnlyQuoted: value.ttsReadOnlyQuoted,
    exampleMessage: value.exampleMessage,
    systemPrompt: value.systemPrompt,
    replaceGlobalNote: value.replaceGlobalNote,
    additionalText: value.additionalText,
    personality: value.personality,
    scenario: value.scenario,
    translatorNote: value.translatorNote,
    additionalData: value.additionalData,
    depth_prompt: value.depth_prompt,
    additionalAssets: value.additionalAssets,
    utilityBot: value.utilityBot,
    license: value.license,
    realmId: value.realmId,
    prebuiltAssetCommand: value.prebuiltAssetCommand,
    prebuiltAssetStyle: value.prebuiltAssetStyle,
    prebuiltAssetExclude: value.prebuiltAssetExclude,
    modules: value.modules,
    coldstorage: value.coldstorage,
    coldStoragedChats: value.coldStoragedChats,
  };
}

function legacyModule(
  value: DomainModule,
  triggers = value.trigger?.map(legacyTrigger),
): RisuModule {
  return {
    name: value.name,
    description: value.description,
    lorebook: value.lorebook?.map(legacyLorebook),
    regex: value.regex,
    cjs: value.cjs,
    trigger: triggers,
    id: value.id,
    lowLevelAccess: value.lowLevelAccess,
    hideIcon: value.hideIcon,
    backgroundEmbedding: value.backgroundEmbedding,
    assets: value.assets,
    namespace: value.namespace,
    customModuleToggle: value.customModuleToggle,
    mcp: value.mcp && { url: value.mcp.url },
    icon: value.icon,
  };
}

function legacyPersona(
  value: DomainPersona,
  embeddedModule = value.embeddedModule && legacyModule(value.embeddedModule),
): RisuPersona {
  return {
    personaPrompt: value.personaPrompt,
    name: value.name,
    icon: value.icon,
    largePortrait: value.largePortrait,
    id: value.id,
    note: value.note,
    embeddedModule,
  };
}

function legacyPreset(value: PresetFields): botPreset {
  return {
    name: value.name,
    apiType: value.apiType,
    localNetworkMode: value.localNetworkMode,
    localNetworkTimeoutSec: value.localNetworkTimeoutSec,
    mainPrompt: value.mainPrompt,
    jailbreak: value.jailbreak,
    globalNote: value.globalNote,
    temperature: value.temperature,
    maxContext: value.maxContext,
    maxResponse: value.maxResponse,
    frequencyPenalty: value.frequencyPenalty,
    PresensePenalty: value.PresensePenalty,
    formatingOrder: value.formatingOrder,
    aiModel: value.aiModel,
    subModel: value.subModel,
    currentPluginProvider: value.currentPluginProvider,
    textgenWebUIStreamURL: value.textgenWebUIStreamURL,
    textgenWebUIBlockingURL: value.textgenWebUIBlockingURL,
    forceReplaceUrl: value.forceReplaceUrl,
    promptPreprocess: value.promptPreprocess,
    bias: value.bias,
    proxyRequestModel: value.proxyRequestModel,
    openrouterRequestModel: value.openrouterRequestModel,
    proxyKey: value.proxyKey,
    ooba: value.ooba,
    ainconfig: value.ainconfig,
    koboldURL: value.koboldURL,
    NAISettings: value.NAISettings,
    autoSuggestPrompt: value.autoSuggestPrompt,
    autoSuggestPrefix: value.autoSuggestPrefix,
    autoSuggestClean: value.autoSuggestClean,
    promptTemplate: value.promptTemplate ?? undefined,
    NAIadventure: value.NAIadventure,
    NAIappendName: value.NAIappendName,
    localStopStrings: value.localStopStrings,
    customProxyRequestModel: value.customProxyRequestModel,
    reverseProxyOobaArgs: value.reverseProxyOobaArgs,
    top_p: value.top_p,
    promptSettings: value.promptSettings,
    repetition_penalty: value.repetition_penalty,
    min_p: value.min_p,
    top_a: value.top_a,
    openrouterProvider: value.openrouterProvider,
    useInstructPrompt: value.useInstructPrompt,
    customPromptTemplateToggle: value.customPromptTemplateToggle,
    templateDefaultVariables: value.templateDefaultVariables,
    moduleIntergration: value.moduleIntergration,
    top_k: value.top_k,
    instructChatTemplate: value.instructChatTemplate,
    JinjaTemplate: value.JinjaTemplate,
    jsonSchemaEnabled: value.jsonSchemaEnabled,
    jsonSchema: value.jsonSchema,
    strictJsonSchema: value.strictJsonSchema,
    extractJson: value.extractJson,
    groupTemplate: value.groupTemplate,
    groupOtherBotRole: value.groupOtherBotRole,
    seperateParametersEnabled: value.seperateParametersEnabled,
    seperateParameters: value.seperateParameters,
    customAPIFormat: value.customAPIFormat,
    systemContentReplacement: value.systemContentReplacement,
    systemRoleReplacement: value.systemRoleReplacement,
    enableCustomFlags: value.enableCustomFlags,
    customFlags: value.customFlags,
    image: value.image,
    regex: value.regex,
    reasonEffort: value.reasonEffort,
    thinkingTokens: value.thinkingTokens ?? undefined,
    thinkingType: value.thinkingType,
    deepseekThinkingType: value.deepseekThinkingType,
    adaptiveThinkingEffort: value.adaptiveThinkingEffort,
    deepseekReasoningEffort: value.deepseekReasoningEffort,
    outputImageModal: value.outputImageModal,
    seperateModelsForAxModels: value.seperateModelsForAxModels,
    seperateModels: value.seperateModels,
    modelTools: value.modelTools,
    fallbackModels: value.fallbackModels,
    fallbackWhenBlankResponse: value.fallbackWhenBlankResponse,
    verbosity: value.verbosity,
    dynamicOutput: value.dynamicOutput,
  };
}

function legacyLorebook(value: loreBook): loreBook {
  return {
    key: value.key,
    secondkey: value.secondkey,
    insertorder: value.insertorder,
    comment: value.comment,
    content: value.content,
    mode: value.mode,
    alwaysActive: value.alwaysActive,
    selective: value.selective,
    extentions: value.extentions && {
      risu_case_sensitive: value.extentions.risu_case_sensitive,
    },
    activationPercent: value.activationPercent,
    loreCache: value.loreCache && {
      key: value.loreCache.key,
      data: value.loreCache.data,
    },
    useRegex: value.useRegex,
    bookVersion: value.bookVersion,
    id: value.id,
    folder: value.folder,
  };
}

function legacyPlugin(value: PluginMetadata & { script: string }): RisuPlugin {
  return {
    name: value.name,
    displayName: value.displayName,
    script: value.script,
    arguments: value.arguments,
    realArg: value.realArg,
    version: value.version,
    customLink: (value.customLink ?? []).map((link) => ({
      link: link.link,
      hoverText: link.hoverText,
    })),
    argMeta: value.argMeta,
    versionOfPlugin: value.versionOfPlugin,
    updateURL: value.updateURL,
    enabled: value.enabled,
    allowedIPC: value.allowedIPC,
  };
}

function legacyTrigger(value: triggerscript): LegacyTrigger {
  return {
    comment: value.comment,
    type: value.type,
    conditions: value.conditions,
    effect: value.effect,
    lowLevelAccess: value.lowLevelAccess,
  };
}

export function toLegacyMessage(value: Message): LegacyMessage {
  return structuredClone(legacyMessage(value));
}
export function toLegacyChat(
  value: ChatFields,
  messages: readonly Message[],
): LegacyChat {
  return toLegacyChatSnapshot({ ...value, message: [...messages] });
}
export function toLegacyChatSnapshot(value: ChatState): LegacyChat {
  return structuredClone(legacyChat(value));
}
export function toLegacyCharacter(
  value: CharacterFields,
  chats: readonly LegacyChat[],
  chatFolders: character["chatFolders"],
  chatPage: number,
): character {
  return structuredClone(
    legacyCharacter({ ...value, chats: [...chats], chatFolders, chatPage }),
  );
}
export function toLegacyCharacterSnapshot(
  value: CharacterSnapshot,
): LegacyCharacter {
  return structuredClone(
    value.type === "group" ? legacyGroup(value) : legacyCharacter(value),
  );
}
export function toLegacyModule(value: DomainModule): RisuModule {
  return structuredClone(legacyModule(value));
}
export function toLegacyPersona(value: DomainPersona): RisuPersona {
  return structuredClone(legacyPersona(value));
}
export function toLegacyPreset(value: PresetFields): botPreset {
  return structuredClone(legacyPreset(value));
}
export function toLegacyLorebook(value: loreBook): loreBook {
  return structuredClone(legacyLorebook(value));
}
export function toLegacyPlugin(
  value: PluginMetadata,
  script: string,
): RisuPlugin {
  return structuredClone(legacyPlugin({ ...value, script }));
}

function applyMessage(value: LegacyMessage, current?: Message): Message {
  return { ...current, ...legacyMessage(value) };
}
function applyChat(value: LegacyChat, current?: ChatState): ChatState {
  const messages = new Map(
    current?.message.map((message) => [message.chatId, message]),
  );
  const nextMessages = (value.message ?? []).map((message) =>
    applyMessage(
      message,
      message.chatId ? messages.get(message.chatId) : undefined,
    ),
  );
  return { ...current, ...legacyChat(value, nextMessages) };
}
function applyTriggers(
  values: readonly LegacyTrigger[],
  current: readonly triggerscript[] = [],
): triggerscript[] {
  return (values ?? []).map((value, index) => {
    const matching = current.filter(
      (trigger) =>
        trigger.comment === value.comment && trigger.type === value.type,
    );
    const previous =
      matching.length === 1
        ? matching[0]
        : current[index]?.comment === value.comment &&
            current[index]?.type === value.type
          ? current[index]
          : undefined;
    return { ...previous, ...legacyTrigger(value) };
  });
}
function applyModule(value: RisuModule, current?: DomainModule): DomainModule {
  return {
    ...current,
    ...legacyModule(
      value,
      value.trigger && applyTriggers(value.trigger, current?.trigger),
    ),
  };
}
export function fromLegacyMessage(
  value: LegacyMessage,
  current?: Message,
): Message {
  return structuredClone(applyMessage(value, current));
}
export function fromLegacyChat(
  value: LegacyChat,
  current?: ChatState,
): ChatState {
  return structuredClone(applyChat(value, current));
}
export function fromLegacyCharacter(
  value: LegacyCharacter,
  current?: CharacterSnapshot,
): CharacterSnapshot {
  const chats = new Map<string, ChatState>(
    current?.chats.map((chat) => [chat.id!, chat] as const),
  );
  const nextChats = (value.chats ?? []).map((chat) =>
    applyChat(chat, chat.id ? chats.get(chat.id) : undefined),
  );
  return structuredClone(
    value.type === "group"
      ? {
          ...(current?.type === "group" ? current : undefined),
          ...legacyGroup(value, nextChats),
        }
      : {
          ...(current?.type !== "group" ? current : undefined),
          ...legacyCharacter(
            value,
            nextChats,
            applyTriggers(
              value.triggerscript,
              current?.type !== "group" ? current?.triggerscript : undefined,
            ),
          ),
        },
  );
}
export function fromLegacyModule(
  value: RisuModule,
  current?: DomainModule,
): DomainModule {
  return structuredClone(applyModule(value, current));
}
export function fromLegacyPersona(
  value: RisuPersona,
  current?: DomainPersona,
): DomainPersona {
  return structuredClone({
    ...current,
    ...legacyPersona(
      value,
      value.embeddedModule &&
        applyModule(value.embeddedModule, current?.embeddedModule),
    ),
  });
}
