import { language } from "src/lang";
import { languageEnglish } from "src/lang/en";
import { get } from "svelte/store";
import { getModelInfo } from "../model/modellist";
import { isLite } from "../lite";
import { isTauri } from "../platform";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { checkCondition, getLabel } from "./utils";
import type { SettingItem, SettingContext } from "./types";
import { accessibilitySettingsItems } from "./accessibilitySettingsData";
import { advancedSettingsItems } from "./advancedSettingsData";
import { allBasicParameterItems } from "./botSettingsParamsData";
import {
  displayOtherSettingsItems,
  displaySizeSettingsItems,
  displayThemeSettingsItems,
} from "./displaySettingsData.svelte";
import { languageSettingsItems } from "./languageSettingsData.svelte";

export type SettingsSearchTarget =
  | { kind: "menu"; menuIndex: number; subTab?: number; itemId?: string }
  | { kind: "dbExplorer" }
  | { kind: "storageExplorer" };

export interface SettingSearchResult {
  key: string;
  label: string;
  location: string;
  help?: string;
  target: SettingsSearchTarget;
  rank: number;
}
interface SearchSource {
  items: SettingItem[];
  menuIndex: number;
  subTab?: number;
  pageLabel: () => string;
  tabLabel?: () => string;
}

const sources: SearchSource[] = [
  { items: displayThemeSettingsItems, menuIndex: 3, subTab: 0, pageLabel: () => language.display, tabLabel: () => language.theme },
  { items: displaySizeSettingsItems, menuIndex: 3, subTab: 1, pageLabel: () => language.display, tabLabel: () => language.sizeAndSpeed },
  { items: displayOtherSettingsItems, menuIndex: 3, subTab: 2, pageLabel: () => language.display, tabLabel: () => language.others },
  { items: accessibilitySettingsItems, menuIndex: 11, pageLabel: () => language.accessibility },
  { items: advancedSettingsItems, menuIndex: 6, pageLabel: () => language.advancedSettings },
  { items: languageSettingsItems, menuIndex: 10, pageLabel: () => language.language },
  { items: allBasicParameterItems, menuIndex: 1, subTab: 1, pageLabel: () => language.chatBot, tabLabel: () => language.parameters },
];

interface ManualEntry {
  id: string;
  label: () => string;
  keywords: string[];
  target: SettingsSearchTarget;
  location?: () => string;
}
const manualEntries: ManualEntry[] = [
  { id: "page.account", label: () => `${language.account} & ${language.files}`, keywords: ["account", "files", "storage", "계정", "파일"], target: { kind: "menu", menuIndex: 0 } },
  { id: "page.chatbot", label: () => language.chatBot, keywords: ["chatbot", "model", "ai", "챗봇", "모델"], target: { kind: "menu", menuIndex: 1 } },
  { id: "chatbot.model", label: () => language.model, keywords: ["model", "provider", "api key", "openai", "claude", "gemini", "openrouter", "ollama", "nanogpt", "mistral", "novelai", "reverse proxy", "모델", "api 키"], target: { kind: "menu", menuIndex: 1, subTab: 0 }, location: () => language.chatBot },
  { id: "chatbot.parameters", label: () => language.parameters, keywords: ["parameters", "sampling", "temperature", "token", "파라미터", "샘플링"], target: { kind: "menu", menuIndex: 1, subTab: 1 }, location: () => language.chatBot },
  { id: "chatbot.prompt", label: () => language.prompt, keywords: ["prompt", "main prompt", "jailbreak", "global note", "프롬프트"], target: { kind: "menu", menuIndex: 1, subTab: 2 }, location: () => language.chatBot },
  { id: "chatbot.others", label: () => language.others, keywords: ["bias", "additional params", "custom flags", "tools", "기타"], target: { kind: "menu", menuIndex: 1, subTab: 3 }, location: () => language.chatBot },
  { id: "page.otherBots", label: () => language.otherBots, keywords: ["other bots", "auxiliary", "memory", "tts", "image", "기타 봇", "보조"], target: { kind: "menu", menuIndex: 2 } },
  { id: "other.memory", label: () => language.longTermMemory, keywords: ["memory", "hypa", "supa", "embedding", "메모리", "장기기억"], target: { kind: "menu", menuIndex: 2, subTab: 0 }, location: () => language.otherBots },
  { id: "other.tts", label: () => "TTS", keywords: ["tts", "voice", "speech", "elevenlabs", "음성", "보이스"], target: { kind: "menu", menuIndex: 2, subTab: 1 }, location: () => language.otherBots },
  { id: "other.emotion", label: () => language.emotionImage, keywords: ["emotion", "image", "감정", "표정"], target: { kind: "menu", menuIndex: 2, subTab: 2 }, location: () => language.otherBots },
  { id: "other.image", label: () => language.imageGeneration, keywords: ["image generation", "stable diffusion", "novelai", "dall-e", "comfyui", "wavespeed", "이미지 생성", "그림"], target: { kind: "menu", menuIndex: 2, subTab: 3 }, location: () => language.otherBots },
  { id: "page.display", label: () => language.display, keywords: ["display", "theme", "appearance", "화면", "테마"], target: { kind: "menu", menuIndex: 3 } },
  { id: "page.plugin", label: () => language.plugin, keywords: ["plugin", "플러그인"], target: { kind: "menu", menuIndex: 4 } },
  { id: "page.advanced", label: () => language.advancedSettings, keywords: ["advanced", "developer", "고급", "개발자"], target: { kind: "menu", menuIndex: 6 } },
];
manualEntries.push(
  { id: "page.lorebook", label: () => language.loreBook, keywords: ["lorebook", "world info", "로어북", "월드인포"], target: { kind: "menu", menuIndex: 8 } },
  { id: "page.regex", label: () => language.regexScript, keywords: ["regex", "regexp", "정규식", "정규표현식"], target: { kind: "menu", menuIndex: 9 } },
  { id: "page.language", label: () => language.language, keywords: ["language", "translator", "translation", "언어", "번역"], target: { kind: "menu", menuIndex: 10 } },
  { id: "page.accessibility", label: () => language.accessibility, keywords: ["accessibility", "convenience", "접근성", "편의"], target: { kind: "menu", menuIndex: 11 } },
  { id: "page.persona", label: () => language.persona, keywords: ["persona", "user", "profile", "페르소나", "사용자"], target: { kind: "menu", menuIndex: 12 } },
  { id: "page.promptTemplate", label: () => language.promptTemplate, keywords: ["prompt template", "프롬프트 템플릿"], target: { kind: "menu", menuIndex: 13 } },
  { id: "page.module", label: () => language.modules, keywords: ["module", "lua", "script", "모듈", "스크립트"], target: { kind: "menu", menuIndex: 14 } },
  { id: "page.hotkey", label: () => language.hotkey, keywords: ["hotkey", "shortcut", "keyboard", "핫키", "단축키"], target: { kind: "menu", menuIndex: 15 } },
  { id: "page.dbExplorer", label: () => language.postgresDbExplorer, keywords: ["postgres", "database", "db explorer", "sql", "데이터베이스"], target: { kind: "dbExplorer" } },
  { id: "page.storageExplorer", label: () => language.storageExplorer, keywords: ["storage", "assets", "orphan", "missing", "저장소", "에셋"], target: { kind: "storageExplorer" } },
);

function currentContext(): SettingContext {
  return {
    db: settingsStore.state as any,
    modelInfo: getModelInfo(settingsStore.state.aiModel),
    subModelInfo: getModelInfo(settingsStore.state.subModel),
  };
}

function isMenuAvailable(menuIndex: number): boolean {
  if (get(isLite) && ![0, 10, 15].includes(menuIndex)) return false;
  if (menuIndex === 15 && typeof window !== "undefined" && window.innerWidth < 768) return false;
  return true;
}
function flattenVisible(items: SettingItem[], ctx: SettingContext): SettingItem[] {
  const result: SettingItem[] = [];
  for (const item of items) {
    if (!checkCondition(item, ctx)) continue;
    if (item.type === "accordion") {
      result.push(...flattenVisible(item.options?.children ?? [], ctx));
    } else if (item.type !== "header") {
      result.push(item);
    }
  }
  return result;
}

function englishLabel(item: SettingItem): string {
  if (!item.labelKey) return item.fallbackLabel ?? "";
  return (languageEnglish as any)[item.labelKey] ?? item.fallbackLabel ?? "";
}

function itemHelp(item: SettingItem): string {
  if (!item.helpKey) return "";
  return (language.help as any)?.[item.helpKey] ?? "";
}

function englishHelp(item: SettingItem): string {
  if (!item.helpKey) return "";
  return (languageEnglish.help as any)?.[item.helpKey] ?? "";
}
function rankMatch(query: string, labels: string[], keywords: string[], helps: string[]): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const labelText = labels.join(" ").toLowerCase();
  const keywordText = keywords.join(" ").toLowerCase();
  const helpText = helps.join(" ").toLowerCase();
  const allText = `${labelText} ${keywordText} ${helpText}`;
  if (!terms.every((term) => allText.includes(term))) return -1;
  if (labels.some((label) => label.toLowerCase() === query)) return 0;
  if (labels.some((label) => label.toLowerCase().startsWith(query))) return 1;
  if (terms.every((term) => labelText.includes(term))) return 2;
  if (terms.every((term) => keywordText.includes(term))) return 3;
  return 4;
}

export function searchSettings(rawQuery: string): SettingSearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const ctx = currentContext();
  const results: SettingSearchResult[] = [];

  for (const source of sources) {
    if (!isMenuAvailable(source.menuIndex)) continue;
    for (const item of flattenVisible(source.items, ctx)) {
      const label = getLabel(item);
      if (!label) continue;
      const help = itemHelp(item);
      const rank = rankMatch(query, [label, englishLabel(item)], item.keywords ?? [], [help, englishHelp(item)]);
      if (rank < 0) continue;
      results.push({
        key: `${source.menuIndex}:${source.subTab ?? ""}:${item.id}`,
        label,
        location: [source.pageLabel(), source.tabLabel?.()].filter(Boolean).join(" · "),
        help: help || undefined,
        target: { kind: "menu", menuIndex: source.menuIndex, subTab: source.subTab, itemId: item.id },
        rank,
      });
    }
  }

  for (const entry of manualEntries) {
    if (isTauri && (entry.target.kind === "dbExplorer" || entry.target.kind === "storageExplorer")) continue;
    if (entry.target.kind === "menu" && !isMenuAvailable(entry.target.menuIndex)) continue;
    const label = entry.label();
    const rank = rankMatch(query, [label], entry.keywords, []);
    if (rank < 0) continue;
    results.push({
      key: entry.id,
      label,
      location: entry.location?.() ?? "",
      target: entry.target,
      rank,
    });
  }

  results.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return results.slice(0, 30);
}

export function scrollToSettingAnchor(itemId: string, attempt = 0): void {
  if (typeof document === "undefined") return;
  const wrapper = document.querySelector<HTMLElement>(
    `[data-setting-id="${CSS.escape(itemId)}"]`,
  );
  const target = (wrapper?.firstElementChild as HTMLElement | null) ?? wrapper;
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.animate(
      [
        { outline: "3px solid var(--risu-theme-primary, #fbbf24)" },
        { outline: "3px solid transparent" },
      ],
      { duration: 1600, easing: "ease-out" },
    );
    return;
  }
  if (attempt < 45) requestAnimationFrame(() => scrollToSettingAnchor(itemId, attempt + 1));
}
