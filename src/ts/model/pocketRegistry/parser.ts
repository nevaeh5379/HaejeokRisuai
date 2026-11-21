import bundledData from "./bundled.json";
import {
  ClaudeParameters,
  LLMFlags,
  LLMFormat,
  LLMProvider,
  LLMTokenizer,
  OpenAIParameters,
  type LLMModel,
} from "../types";
import type { LLMParameter } from "../../process/request/shared";
import { fetchNative } from "../../globalApi.svelte";

export const DEFAULT_POCKET_REGISTRY_BASE_URL =
  "https://raw.githubusercontent.com/PocketRisu/pocketrisu-model-registry/main";

const CACHE_STORAGE_KEY = "risuai_pocket_registry_cache_v1";
const META_STORAGE_KEY = "risuai_pocket_registry_meta_v1";
const CUSTOM_URL_STORAGE_KEY = "risuai_pocket_registry_url_v1";

export interface CompactSchemaHint {
  k: string;
  p?: string;
  e?: unknown[];
  d?: unknown;
}

export interface CompactRegistryProvider {
  id: string;
  displayName: string;
  adapterKind: string;
  authKinds: string[];
  endpointKinds: string[];
  capabilities?: string[];
  defaultEndpointUrl?: string;
}

export interface CompactRegistryProfile {
  id: string;
  providerBaseId: string;
  displayName: string;
  modelId: string;
  profileStatus?: string;
  sortOrder?: number;
  endpointUrl?: string;
  endpointKind?: string;
  capabilities?: string[];
  tokenizer?: string;
  schema?: CompactSchemaHint[];
  defaults?: Record<string, unknown>;
}

export interface CompactRegistryBundle {
  schemaVersion: number;
  hash: string;
  providers: Record<string, CompactRegistryProvider>;
  profiles: CompactRegistryProfile[];
}

export interface PocketRegistryProviderMeta {
  id: string;
  displayName: string;
  providerGroup: string;
  legacyProvider: LLMProvider;
  format: LLMFormat;
  keyIdentifier?: string;
  usesDedicatedSettingKey: boolean;
  defaultEndpointUrl?: string;
}

export interface PocketRegistrySyncMeta {
  hash: string;
  syncedAt: number | null;
  source: "bundled" | "remote";
  profileCount: number;
}

export interface PocketRegistrySyncResult {
  updated: boolean;
  hash: string;
  profileCount: number;
  addedOrTotal: number;
  message: string;
}

const NATIVE_DEDICATED_KEY_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "vertex-gemini-native",
  "openrouter",
  "nanogpt",
  "ollama-cloud",
  "ollama",
]);

const SKIPPED_TEMPLATE_BASES = new Set([
  "openai-compatible",
  "anthropic-compatible",
  "bedrock",
  "bedrock-anthropic",
  "vertex-openai",
  "ollama",
]);

function resolveTokenizer(raw?: string, modelId?: string): LLMTokenizer {
  switch (raw) {
    case "claude":
      return LLMTokenizer.Claude;
    case "deepseek":
      return modelId?.includes("v4") ? LLMTokenizer.DeepSeekV4 : LLMTokenizer.DeepSeek;
    case "gemma":
      return LLMTokenizer.Gemma;
    case "mistral":
      return LLMTokenizer.Mistral;
    case "llama":
      return LLMTokenizer.Llama;
    case "llama3":
      return LLMTokenizer.Llama3;
    case "cohere":
      return LLMTokenizer.Cohere;
    case "novelai":
      return LLMTokenizer.NovelAI;
    case "novellist":
      return LLMTokenizer.NovelList;
    case "tik":
      return LLMTokenizer.tiktokenO200Base;
    default:
      if (modelId?.includes("glm-5")) return LLMTokenizer.GLM5;
      if (modelId?.includes("glm-4")) return LLMTokenizer.GLM4;
      return LLMTokenizer.Unknown;
  }
}

function mapProviderInfo(
  baseId: string,
  base: CompactRegistryProvider | undefined,
  defaultEndpointUrl?: string,
): PocketRegistryProviderMeta | null {
  if (SKIPPED_TEMPLATE_BASES.has(baseId)) return null;

  switch (baseId) {
    case "openai":
      return {
        id: baseId,
        displayName: "OpenAI",
        providerGroup: "OpenAI",
        legacyProvider: LLMProvider.OpenAI,
        format: LLMFormat.OpenAICompatible,
        usesDedicatedSettingKey: true,
        defaultEndpointUrl: defaultEndpointUrl || "https://api.openai.com/v1/chat/completions",
      };
    case "anthropic":
      return {
        id: baseId,
        displayName: "Anthropic",
        providerGroup: "Anthropic",
        legacyProvider: LLMProvider.Anthropic,
        format: LLMFormat.Anthropic,
        usesDedicatedSettingKey: true,
        defaultEndpointUrl: defaultEndpointUrl || "https://api.anthropic.com/v1/messages",
      };
    case "google":
      return {
        id: baseId,
        displayName: "Google Cloud",
        providerGroup: "Google Cloud",
        legacyProvider: LLMProvider.GoogleCloud,
        format: LLMFormat.GoogleCloud,
        usesDedicatedSettingKey: true,
        defaultEndpointUrl,
      };
    case "vertex-gemini-native":
      return {
        id: baseId,
        displayName: "Vertex AI",
        providerGroup: "Vertex AI",
        legacyProvider: LLMProvider.VertexAI,
        format: LLMFormat.VertexAIGemini,
        usesDedicatedSettingKey: true,
        defaultEndpointUrl,
      };
    case "deepseek":
      return {
        id: baseId,
        displayName: "DeepSeek",
        providerGroup: "DeepSeek",
        legacyProvider: LLMProvider.DeepSeek,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: "deepseek",
        usesDedicatedSettingKey: false,
        defaultEndpointUrl: defaultEndpointUrl || "https://api.deepseek.com/chat/completions",
      };
    case "deepinfra":
      return {
        id: baseId,
        displayName: "DeepInfra",
        providerGroup: "DeepInfra",
        legacyProvider: LLMProvider.DeepInfra,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: "deepinfra",
        usesDedicatedSettingKey: false,
        defaultEndpointUrl:
          defaultEndpointUrl || "https://api.deepinfra.com/v1/openai/chat/completions",
      };
    case "openrouter":
      return {
        id: baseId,
        displayName: "OpenRouter",
        providerGroup: "OpenRouter",
        legacyProvider: LLMProvider.AsIs,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: "openrouter",
        usesDedicatedSettingKey: true,
        defaultEndpointUrl:
          defaultEndpointUrl || "https://openrouter.ai/api/v1/chat/completions",
      };
    case "nanogpt":
      return {
        id: baseId,
        displayName: "NanoGPT",
        providerGroup: "NanoGPT",
        legacyProvider: LLMProvider.AsIs,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: "nanogpt",
        usesDedicatedSettingKey: true,
        defaultEndpointUrl:
          defaultEndpointUrl || "https://nano-gpt.com/api/v1/chat/completions",
      };
    case "ollama-cloud":
      return {
        id: baseId,
        displayName: "Ollama Cloud",
        providerGroup: "Ollama",
        legacyProvider: LLMProvider.Ollama,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: "ollama-cloud",
        usesDedicatedSettingKey: true,
        defaultEndpointUrl: defaultEndpointUrl || "https://ollama.com/v1/chat/completions",
      };
    default: {
      if (base?.adapterKind && base.adapterKind !== "openai-compatible") {
        return null;
      }
      const label = base?.displayName || baseId;
      return {
        id: baseId,
        displayName: label,
        providerGroup: label,
        legacyProvider: LLMProvider.AsIs,
        format: LLMFormat.OpenAICompatible,
        keyIdentifier: baseId,
        usesDedicatedSettingKey: NATIVE_DEDICATED_KEY_PROVIDERS.has(baseId),
        defaultEndpointUrl,
      };
    }
  }
}

function inferFlagsAndParameters(
  profile: CompactRegistryProfile,
  providerMeta: PocketRegistryProviderMeta,
): { flags: LLMFlags[]; parameters: LLMParameter[] } {
  const caps = new Set(profile.capabilities ?? []);
  const schema = profile.schema ?? [];
  const schemaKeys = new Set(schema.map((s) => s.k));
  const flags = new Set<LLMFlags>();
  const params = new Set<LLMParameter>();

  if (caps.has("streaming")) flags.add(LLMFlags.hasStreaming);
  if (caps.has("vision")) flags.add(LLMFlags.hasImageInput);
  if (caps.has("cache")) flags.add(LLMFlags.hasCache);

  const findHint = (key: string) => schema.find((s) => s.k === key);

  if (providerMeta.format === LLMFormat.Anthropic) {
    flags.add(LLMFlags.hasFirstSystemPrompt);
    if (schemaKeys.has("temperature") || schema.length === 0) {
      for (const p of ClaudeParameters) params.add(p);
    }
    const thinkingTypeHint = findHint("thinking_type") ?? findHint("extended_thinking");
    const effortHint = findHint("effort");
    if (thinkingTypeHint) {
      const enums = (thinkingTypeHint.e ?? []).map(String);
      if (enums.includes("adaptive")) {
        flags.add(LLMFlags.claudeAdaptiveThinking);
      }
      if (enums.includes("enabled") || schemaKeys.has("thinking_budget_tokens")) {
        flags.add(LLMFlags.claudeThinking);
        params.add("thinking_tokens");
      }
      if (thinkingTypeHint.d === "adaptive" && enums.length === 1) {
        flags.add(LLMFlags.claudeThinkingOnByDefault);
      }
    } else if (caps.has("reasoning")) {
      flags.add(LLMFlags.claudeThinking);
      flags.add(LLMFlags.claudeAdaptiveThinking);
      params.add("thinking_tokens");
    }
    if (effortHint) {
      const enums = (effortHint.e ?? []).map(String);
      if (enums.includes("xhigh")) {
        flags.add(LLMFlags.claudeXHighEffort);
      }
    }
    return { flags: [...flags], parameters: [...params] };
  }

  if (
    providerMeta.format === LLMFormat.GoogleCloud ||
    providerMeta.format === LLMFormat.VertexAIGemini
  ) {
    flags.add(LLMFlags.hasFirstSystemPrompt);
    flags.add(LLMFlags.requiresAlternateRole);
    flags.add(LLMFlags.poolSupported);
    if (caps.has("vision")) {
      flags.add(LLMFlags.hasAudioInput);
      flags.add(LLMFlags.hasVideoInput);
    }
    if (caps.has("reasoning") || schemaKeys.has("thinkingLevel") || schemaKeys.has("thinkingBudget")) {
      flags.add(LLMFlags.geminiThinking);
      const levelHint = findHint("thinkingLevel");
      if (levelHint?.e && !levelHint.e.map(String).includes("minimal")) {
        flags.add(LLMFlags.geminiThinkingNoMinimal);
      }
      if (schemaKeys.has("thinkingLevel")) {
        params.add("reasoning_effort");
      } else {
        params.add("thinking_tokens");
      }
    }
    if (schemaKeys.has("temperature")) params.add("temperature");
    if (schemaKeys.has("topK")) params.add("top_k");
    if (schemaKeys.has("topP")) params.add("top_p");
    if (schemaKeys.has("presencePenalty")) params.add("presence_penalty");
    if (schemaKeys.has("frequencyPenalty")) params.add("frequency_penalty");
    if (params.size === 0) {
      params.add("temperature");
      params.add("top_p");
      params.add("top_k");
    }
    return { flags: [...flags], parameters: [...params] };
  }

  // OpenAI & OpenAI-compatible gateways / DeepSeek
  if (providerMeta.id === "deepseek") {
    flags.add(LLMFlags.hasFirstSystemPrompt);
    flags.add(LLMFlags.requiresAlternateRole);
    flags.add(LLMFlags.mustStartWithUserInput);
    flags.add(LLMFlags.hasPrefill);
    flags.add(LLMFlags.deepSeekPrefix);
    if (caps.has("reasoning")) {
      flags.add(LLMFlags.deepSeekThinkingInput);
      flags.add(LLMFlags.deepSeekThinkingOutput);
      flags.add(LLMFlags.deepSeekThinkingToggle);
    }
    for (const p of OpenAIParameters) params.add(p);
    return { flags: [...flags], parameters: [...params] };
  }

  flags.add(LLMFlags.hasFullSystemPrompt);
  if (
    schemaKeys.has("max_completion_tokens") ||
    (providerMeta.id === "openai" &&
      (profile.modelId.startsWith("gpt-5") ||
        profile.modelId.startsWith("gpt-6") ||
        profile.modelId.startsWith("o")))
  ) {
    flags.add(LLMFlags.OAICompletionTokens);
    if (providerMeta.id === "openai") {
      flags.add(LLMFlags.DeveloperRole);
    }
  }

  for (const p of OpenAIParameters) params.add(p);

  const reasoningHint = findHint("reasoning_effort");
  if (reasoningHint) {
    params.add("reasoning_effort");
    const enums = (reasoningHint.e ?? []).map(String);
    if (enums.includes("none")) params.add("reasoning_effort_none");
    if (enums.includes("xhigh")) params.add("reasoning_effort_xhigh");
  } else if (caps.has("reasoning") && providerMeta.id === "openai") {
    params.add("reasoning_effort");
  }

  if (schemaKeys.has("verbosity")) {
    params.add("verbosity");
  }

  return { flags: [...flags], parameters: [...params] };
}

function resolveLegacyModelId(
  profile: CompactRegistryProfile,
  providerMeta: PocketRegistryProviderMeta,
): string {
  // Keep clean native IDs for 1st-party providers so existing presets match naturally
  if (
    providerMeta.id === "openai" ||
    providerMeta.id === "anthropic" ||
    providerMeta.id === "google"
  ) {
    return profile.modelId;
  }
  if (providerMeta.id === "vertex-gemini-native") {
    if (profile.id.endsWith(":flash") || profile.id.endsWith(":pro")) {
      return `pocket_${profile.id}`;
    }
    return `${profile.modelId}-vertex`;
  }
  if (providerMeta.id === "deepseek") {
    const thinkingDefault = (profile.defaults?.thinking as any)?.type;
    if (thinkingDefault === "disabled") {
      return `${profile.modelId}-chat`;
    }
    return profile.modelId;
  }
  return `pocket_${profile.id}`;
}

export function convertCatalogToCompactBundle(rawCatalog: any): CompactRegistryBundle {
  const providers: Record<string, CompactRegistryProvider> = {};
  for (const [id, bp] of Object.entries<any>(rawCatalog?.baseProviders ?? {})) {
    if (!bp?.id) continue;
    providers[id] = {
      id: bp.id,
      displayName: bp.displayName || bp.id,
      adapterKind: bp.adapterKind || "openai-compatible",
      authKinds: Array.isArray(bp.authKinds) ? bp.authKinds : [],
      endpointKinds: Array.isArray(bp.endpointKinds) ? bp.endpointKinds : [],
      capabilities: Array.isArray(bp.capabilities) ? bp.capabilities : [],
    };
  }

  const profiles: CompactRegistryProfile[] = [];
  for (const p of Object.values<any>(rawCatalog?.profiles ?? {})) {
    if (!p?.id || !p?.providerBaseId) continue;
    if (!p.modelId) {
      if (p.endpoint?.url && providers[p.providerBaseId] && !providers[p.providerBaseId].defaultEndpointUrl) {
        providers[p.providerBaseId].defaultEndpointUrl = p.endpoint.url;
      }
      continue;
    }

    if (p.endpoint?.url && providers[p.providerBaseId] && !providers[p.providerBaseId].defaultEndpointUrl) {
      providers[p.providerBaseId].defaultEndpointUrl = p.endpoint.url;
    }

    const schemaHints: CompactSchemaHint[] = [];
    if (Array.isArray(p.schema)) {
      for (const f of p.schema) {
        if (!f?.key || f.key === "modelId") continue;
        const enumVals = Array.isArray(f.enum) ? f.enum.map((e: any) => e.value) : [];
        const hint: CompactSchemaHint = { k: f.key };
        if (f.mapsTo?.path && f.mapsTo.path !== f.key) hint.p = f.mapsTo.path;
        if (enumVals.length > 0) hint.e = enumVals;
        if (f.default !== undefined && f.default !== null) hint.d = f.default;
        schemaHints.push(hint);
      }
    }

    const item: CompactRegistryProfile = {
      id: p.id,
      providerBaseId: p.providerBaseId,
      displayName: p.displayName || p.modelId,
      modelId: p.modelId,
      profileStatus: p.profileStatus || "current",
    };
    if (typeof p.sortOrder === "number") item.sortOrder = p.sortOrder;
    if (p.endpoint?.url) item.endpointUrl = p.endpoint.url;
    if (p.endpoint?.kind && p.endpoint.kind !== "static") item.endpointKind = p.endpoint.kind;
    if (Array.isArray(p.capabilities) && p.capabilities.length > 0) item.capabilities = p.capabilities;
    if (p.recommendedTokenizer) item.tokenizer = p.recommendedTokenizer;
    if (schemaHints.length > 0) item.schema = schemaHints;
    if (p.defaults && typeof p.defaults === "object" && Object.keys(p.defaults).length > 0) {
      item.defaults = p.defaults;
    }
    profiles.push(item);
  }

  return {
    schemaVersion: rawCatalog?.schemaVersion ?? 4,
    hash: rawCatalog?.hash ?? "",
    providers,
    profiles,
  };
}

export function parseCompactBundleToModels(bundle: CompactRegistryBundle): {
  models: LLMModel[];
  providers: PocketRegistryProviderMeta[];
} {
  const providerEndpointMap = new Map<string, string>();
  for (const p of bundle.profiles) {
    if (p.endpointUrl && !providerEndpointMap.has(p.providerBaseId)) {
      providerEndpointMap.set(p.providerBaseId, p.endpointUrl);
    }
  }

  const providerMetaMap = new Map<string, PocketRegistryProviderMeta>();
  for (const [id, bp] of Object.entries(bundle.providers ?? {})) {
    const endpointUrl = bp.defaultEndpointUrl || providerEndpointMap.get(id);
    const meta = mapProviderInfo(id, bp, endpointUrl);
    if (meta) {
      providerMetaMap.set(id, meta);
    }
  }

  const sortedProfiles = [...(bundle.profiles ?? [])].sort(
    (a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999),
  );

  const models: LLMModel[] = [];
  for (const profile of sortedProfiles) {
    const providerMeta = providerMetaMap.get(profile.providerBaseId);
    if (!providerMeta) continue;

    const id = resolveLegacyModelId(profile, providerMeta);
    const { flags, parameters } = inferFlagsAndParameters(profile, providerMeta);
    const endpointUrl = profile.endpointUrl || providerMeta.defaultEndpointUrl;

    const cleanName = profile.displayName.startsWith(`${providerMeta.displayName} `)
      ? profile.displayName.slice(providerMeta.displayName.length + 1)
      : profile.displayName;

    const model: LLMModel = {
      id,
      name: cleanName || profile.displayName,
      shortName: cleanName || profile.displayName,
      fullName: `${providerMeta.providerGroup} ${cleanName || profile.displayName}`.trim(),
      internalID: profile.modelId,
      provider: providerMeta.legacyProvider,
      providerGroup: providerMeta.providerGroup,
      format: providerMeta.format,
      flags,
      parameters,
      tokenizer: resolveTokenizer(profile.tokenizer, profile.modelId),
      recommended: (profile.profileStatus ?? "current") === "current",
      keyIdentifier: providerMeta.keyIdentifier,
      endpoint:
        providerMeta.format === LLMFormat.OpenAICompatible ? endpointUrl : undefined,
      fromPocketRegistry: true,
    };

    models.push(model);
  }

  return {
    models,
    providers: [...providerMetaMap.values()],
  };
}

function safeGetStorage(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota / SSR errors
  }
}

function safeRemoveStorage(key: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}

export function getPocketRegistryBaseUrl(): string {
  const custom = safeGetStorage(CUSTOM_URL_STORAGE_KEY)?.trim();
  return (custom || DEFAULT_POCKET_REGISTRY_BASE_URL).replace(/\/+$/, "");
}

export function setPocketRegistryBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === DEFAULT_POCKET_REGISTRY_BASE_URL) {
    safeRemoveStorage(CUSTOM_URL_STORAGE_KEY);
  } else {
    safeSetStorage(CUSTOM_URL_STORAGE_KEY, trimmed);
  }
}

export function loadActiveCompactBundle(): {
  bundle: CompactRegistryBundle;
  meta: PocketRegistrySyncMeta;
} {
  const fallback = bundledData as unknown as CompactRegistryBundle;
  const cachedRaw = safeGetStorage(CACHE_STORAGE_KEY);
  const metaRaw = safeGetStorage(META_STORAGE_KEY);

  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw) as CompactRegistryBundle;
      if (parsed && Array.isArray(parsed.profiles) && parsed.providers) {
        let syncedAt: number | null = null;
        if (metaRaw) {
          try {
            syncedAt = JSON.parse(metaRaw)?.syncedAt ?? null;
          } catch {
            syncedAt = null;
          }
        }
        return {
          bundle: parsed,
          meta: {
            hash: parsed.hash || "",
            syncedAt,
            source: "remote",
            profileCount: parsed.profiles.length,
          },
        };
      }
    } catch {
      // Fallback to bundled
    }
  }

  return {
    bundle: fallback,
    meta: {
      hash: fallback.hash || "",
      syncedAt: null,
      source: "bundled",
      profileCount: fallback.profiles?.length ?? 0,
    },
  };
}

export async function syncPocketRegistryFromRemote(options?: {
  force?: boolean;
  baseUrl?: string;
}): Promise<{ bundle: CompactRegistryBundle; result: PocketRegistrySyncResult }> {
  const baseUrl = (options?.baseUrl?.trim() || getPocketRegistryBaseUrl()).replace(/\/+$/, "");
  const current = loadActiveCompactBundle();

  if (!options?.force && current.meta.hash) {
    const indexRes = await fetchNative(`${baseUrl}/index.json`, { method: "GET" });
    if (!indexRes.ok) {
      throw new Error(`Failed to fetch index.json (HTTP ${indexRes.status})`);
    }
    const indexJson = JSON.parse(new TextDecoder().decode(await indexRes.arrayBuffer()));
    if (indexJson?.hash && indexJson.hash === current.meta.hash) {
      const now = Date.now();
      safeSetStorage(META_STORAGE_KEY, JSON.stringify({ syncedAt: now, hash: current.meta.hash }));
      return {
        bundle: current.bundle,
        result: {
          updated: false,
          hash: current.meta.hash,
          profileCount: current.meta.profileCount,
          addedOrTotal: 0,
          message: `이미 최신 레지스트리입니다 (${current.meta.profileCount}개 모델 프로필, hash ${current.meta.hash.slice(0, 8)}).`,
        },
      };
    }
  }

  const catalogRes = await fetchNative(`${baseUrl}/catalog.json`, { method: "GET" });
  if (!catalogRes.ok) {
    throw new Error(`Failed to fetch catalog.json (HTTP ${catalogRes.status})`);
  }
  const rawCatalog = JSON.parse(new TextDecoder().decode(await catalogRes.arrayBuffer()));
  const compact = convertCatalogToCompactBundle(rawCatalog);
  const now = Date.now();

  safeSetStorage(CACHE_STORAGE_KEY, JSON.stringify(compact));
  safeSetStorage(META_STORAGE_KEY, JSON.stringify({ syncedAt: now, hash: compact.hash }));

  const diffCount = Math.max(0, compact.profiles.length - current.meta.profileCount);
  return {
    bundle: compact,
    result: {
      updated: true,
      hash: compact.hash,
      profileCount: compact.profiles.length,
      addedOrTotal: diffCount,
      message: `레지스트리 업데이트 완료: 총 ${compact.profiles.length}개 모델 프로필 적용 (hash ${compact.hash.slice(0, 8)}).`,
    },
  };
}

export function resetPocketRegistryToBundled(): CompactRegistryBundle {
  safeRemoveStorage(CACHE_STORAGE_KEY);
  safeRemoveStorage(META_STORAGE_KEY);
  return bundledData as unknown as CompactRegistryBundle;
}
