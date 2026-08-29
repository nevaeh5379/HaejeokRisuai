import { mount, unmount } from "svelte";
import type {
  ColorPalette,
  ExportFormat,
  LogExportData,
  LogExporterSettings,
  ReplacementRule,
} from "./types";
import { generateMarkdownLog, generateTextLog } from "./logGenerator";
import { escapeHtml, htmlToText } from "./chatData.svelte";
import { applyRulesToString, imageUrlToDataUrl } from "./messageRenderer";
import Chats from "src/lib/ChatScreens/Chats.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { createSimpleCharacter, selectedCharID } from "src/ts/stores.svelte";
import { get } from "svelte/store";
import { getUserIcon, getUserName, findCharacterbyId } from "src/ts/util";
import type { character, groupChat, Message } from "../storage/database/schema";

/**
 * Standalone HTML / Markdown / Text export generation.
 * HTML export renders Chats.svelte offscreen (with hideButtons: true) so it
 * produces an identical visual representation to DefaultChatScreen.svelte.
 */

const DEFAULT_RENDER_TIMEOUT_MS = 15000;
const DEFAULT_STANDALONE_BG = "#282a36";

export interface StandaloneHtmlOptions {
  title?: string;
  language?: string;
  customStyles?: string;
  backgroundColor?: string;
  previewWidth?: number;
}

/** Extracts all available CSS rules from active document stylesheets. */
export function extractAppStyles(): string {
  const rules: string[] = [];
  try {
    if (typeof document !== "undefined") {
      for (let i = 0; i < document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        try {
          const sheetRules = sheet.cssRules || sheet.rules;
          if (sheetRules) {
            for (let j = 0; j < sheetRules.length; j++) {
              rules.push(sheetRules[j].cssText);
            }
          }
        } catch {
          // Cross-origin stylesheet security restriction (ignore)
        }
      }
    }
  } catch (e) {
    console.warn("[logexporter] Failed to read stylesheets:", e);
  }
  return rules.join("\n");
}

/** Serializes current CSS custom properties from :root. */
export function getRootCssVariables(colorPalette?: ColorPalette): string {
  const vars: string[] = [];
  if (typeof document !== "undefined") {
    const root = document.documentElement || document.body;
    const computed = window.getComputedStyle(root);
    const varNames = [
      "--risu-theme-bgcolor",
      "--risu-theme-darkbg",
      "--risu-theme-borderc",
      "--risu-theme-selected",
      "--risu-theme-draculared",
      "--risu-theme-textcolor",
      "--risu-theme-textcolor2",
      "--risu-theme-darkborderc",
      "--risu-theme-darkbutton",
      "--risu-font-family",
      "--FontColorStandard",
      "--FontColorBold",
      "--FontColorItalic",
      "--FontColorItalicBold",
      "--FontColorQuote1",
      "--FontColorQuote2",
    ];
    for (const name of varNames) {
      const val =
        computed.getPropertyValue(name) || root.style.getPropertyValue(name);
      if (val) {
        vars.push(`  ${name}: ${val.trim()};`);
      }
    }
  }

  // Fallbacks if not present
  if (
    colorPalette?.background &&
    !vars.some((v) => v.includes("--risu-theme-bgcolor"))
  ) {
    vars.push(`  --risu-theme-bgcolor: ${colorPalette.background};`);
  }
  if (
    colorPalette?.text &&
    !vars.some((v) => v.includes("--risu-theme-textcolor"))
  ) {
    vars.push(`  --risu-theme-textcolor: ${colorPalette.text};`);
  }

  return `:root {\n${vars.join("\n")}\n}`;
}

export function buildStandaloneHtmlDocument(
  bodyContent: string,
  options: StandaloneHtmlOptions = {},
): string {
  const {
    title = "Chat Log",
    language = "ko",
    customStyles = "",
    backgroundColor = DEFAULT_STANDALONE_BG,
    previewWidth = 800,
  } = options;

  const rootCss = getRootCssVariables();
  const appStyles = extractAppStyles();

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
    }
    ${rootCss}
    ${appStyles}
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background-color: var(--risu-theme-bgcolor, ${backgroundColor});
      color: var(--risu-theme-textcolor, #f5f5f5);
      font-family: var(--risu-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    }
    body {
      padding: 20px 10px;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow-y: auto;
    }
    .risu-html-export-container {
      width: 100%;
      max-width: ${previewWidth}px;
    }
    img, video {
      max-width: 100%;
      height: auto;
    }
    ${customStyles.trim() ? `\n    ${customStyles.trim()}` : ""}
  </style>
</head>
<body>
  <div class="risu-html-export-container">
    ${bodyContent}
  </div>
</body>
</html>`;
}

/** Converts LogExportData messages into Message[] array for Chats.svelte. */
export function convertLogDataToMessages(
  data: LogExportData,
  rules?: ReplacementRule[],
): Message[] {
  return data.messages.map((m, idx) => {
    let msgData =
      m.rawMessage?.data ?? m.text ?? (m.html ? htmlToText(m.html) : "");
    if (rules && rules.length > 0) {
      msgData = applyRulesToString(msgData, rules);
    }
    return {
      role: m.role ?? (m.isUser ? "user" : "char"),
      data: msgData,
      name: m.name,
      time: m.time,
      chatId: m.rawMessage?.chatId ?? `log-msg-${idx}`,
      saying: m.rawMessage?.saying,
      disabled: m.rawMessage?.disabled,
      isComment: m.rawMessage?.isComment,
      generationInfo: m.rawMessage?.generationInfo,
    };
  });
}

/** Embeds all images in the container into Base64 Data URLs. */
async function embedContainerImages(container: HTMLElement): Promise<void> {
  // 1. <img> tags
  const imgs = container.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:")) {
      try {
        const dataUrl = await imageUrlToDataUrl(src);
        if (dataUrl && dataUrl.startsWith("data:")) {
          img.setAttribute("src", dataUrl);
        }
      } catch (e) {
        console.warn("[logexporter] Failed to embed img src:", src, e);
      }
    }
  }

  // 2. Elements with inline style background-image
  const bgElements = container.querySelectorAll<HTMLElement>(
    '[style*="background-image"], [style*="background"]',
  );
  for (const el of bgElements) {
    const style = el.getAttribute("style") || "";
    const urlMatch = style.match(/url\(['"]?(.*?)['"]?\)/);
    if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith("data:")) {
      try {
        const originalUrl = urlMatch[1];
        const dataUrl = await imageUrlToDataUrl(originalUrl);
        if (dataUrl && dataUrl.startsWith("data:")) {
          el.style.backgroundImage = `url("${dataUrl}")`;
        }
      } catch (e) {
        console.warn("[logexporter] Failed to embed bg image:", urlMatch[1], e);
      }
    }
  }
}

/** Waits for offscreen Chats component to complete parsing and rendering. */
function waitForChatsRenderReady(
  container: HTMLElement,
  expectedCount: number,
): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = async () => {
      if (Date.now() - started > DEFAULT_RENDER_TIMEOUT_MS) {
        // If timeout reached, proceed anyway with whatever rendered
        resolve();
        return;
      }

      const mountedContainers = container.querySelectorAll(
        ".chat-message-container",
      );
      if (mountedContainers.length >= expectedCount) {
        const chatTexts = container.querySelectorAll(".chattext");
        const allTextsRendered =
          expectedCount === 0 ||
          (chatTexts.length > 0 &&
            Array.from(chatTexts).every(
              (el) => (el.textContent || "").trim().length > 0,
            ));

        if (allTextsRendered || Date.now() - started > 2000) {
          // Wait for document fonts if available
          if (typeof document !== "undefined" && document.fonts?.ready) {
            try {
              await document.fonts.ready;
            } catch {}
          }
          // Short RAF tick to allow DOM layout to settle
          setTimeout(() => resolve(), 50);
          return;
        }
      }
      setTimeout(check, 30);
    };
    setTimeout(check, 30);
  });
}

/** Renders Chats.svelte offscreen (with hideButtons: true) and returns its serialized HTML. */
export async function renderLogHtml(
  data: LogExportData,
  settings: LogExporterSettings,
  colorPalette?: ColorPalette,
): Promise<string> {
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.zIndex = "-1000";
  container.style.width = `${settings.previewWidth || 800}px`;
  document.body.appendChild(container);

  const selId = get(selectedCharID);
  const currentChar: character | groupChat =
    data.character ||
    (data.characterId ? findCharacterbyId(data.characterId) : null) ||
    (selId >= 0 ? characterStore.characters[selId] : null) ||
    ({
      name: data.charInfo.name || "AI",
      image: data.charInfo.avatarUrl || "",
      chats: [{ message: [] }],
      chatPage: 0,
      type: "character",
      firstMessage: "",
      alternateGreetings: [],
      largePortrait: false,
    } as unknown as character);

  const chatMessages = convertLogDataToMessages(
    data,
    settings.replacementRules,
  );
  const userIcon = getUserIcon();
  const currentUsername = getUserName();
  const largePortrait = (currentChar as character).largePortrait ?? false;

  const app = mount(Chats, {
    target: container,
    props: {
      messages: chatMessages,
      currentCharacter: currentChar,
      currentUsername: currentUsername,
      userIcon: userIcon,
      loadPages: chatMessages.length,
      userIconPortrait: largePortrait,
      hideButtons: true,
    },
  });

  try {
    await waitForChatsRenderReady(container, chatMessages.length);
    if (settings.embedImages !== false) {
      await embedContainerImages(container);
    }
    return container.innerHTML;
  } finally {
    try {
      await unmount(app);
    } catch {}
    container.remove();
  }
}

export interface GenerateExportResult {
  format: ExportFormat;
  content: string;
  extension: string;
  mime: string;
}

/** Generates export content in the requested format. */
export async function generateExport(
  data: LogExportData,
  settings: LogExporterSettings,
  colorPalette: ColorPalette,
): Promise<GenerateExportResult> {
  switch (settings.format) {
    case "markdown":
      return {
        format: "markdown",
        content: generateMarkdownLog(data.messages, settings),
        extension: "md",
        mime: "text/markdown;charset=utf-8",
      };
    case "text":
      return {
        format: "text",
        content: generateTextLog(data.messages, settings),
        extension: "txt",
        mime: "text/plain;charset=utf-8",
      };
    case "html": {
      const raw = await renderLogHtml(data, settings, colorPalette);
      const doc = buildStandaloneHtmlDocument(raw, {
        title: data.charInfo.name
          ? `${data.charInfo.name}${data.charInfo.chatName ? ` - ${data.charInfo.chatName}` : ""}`
          : "Chat Log",
        customStyles: settings.customCss,
        backgroundColor: colorPalette?.background || DEFAULT_STANDALONE_BG,
        previewWidth: settings.previewWidth || 800,
      });
      return {
        format: "html",
        content: doc,
        extension: "html",
        mime: "text/html;charset=utf-8",
      };
    }
    case "basic":
    default:
      throw new Error("Use saveAsImage for the basic (image) format");
  }
}
