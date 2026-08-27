import type { character, Chat, groupChat } from "../storage/schema";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../polyfill";
import {
  getAuthorNoteDefaultText,
  getPersonaPrompt,
} from "../util";
import { risuChatParser } from "./scripts";
import { additionalInformations } from "./embedding/addinfo";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import type { PromptItem, PromptRole } from "./prompt";
import { generationOverride, type ChatGenerationOverrides } from "./chatGenerationContext";
import type { OpenAIChat, PromptSections } from "@risuai/chat-core/types.cjs";
export type { PromptSections } from "@risuai/chat-core/types.cjs";


export const PROMPT_ROLE_TO_OPENAI = {
  system: "system",
  user: "user",
  bot: "assistant",
} as const;

export function applyPromptBlockRole(chats: OpenAIChat[], role?: PromptRole) {
  if (!role) return;
  for (const chat of chats) {
    chat.role = PROMPT_ROLE_TO_OPENAI[role];
  }
}

function createPromptSections(): PromptSections {
  return {
    main: [],
    jailbreak: [],
    chats: [],
    lorebook: [],
    globalNote: [],
    authorNote: [],
    lastChat: [],
    description: [],
    postEverything: [],
    personaPrompt: [],
  };
}

function ensurePostEverythingCard(template: PromptItem[]) {
  if (!template.some((card) => card.type === "postEverything")) {
    template.push({ type: "postEverything" });
  }
}

function getUtilityBotTemplate(): PromptItem[] {
  return [
    { type: "plain", text: "", role: "system", type2: "main" },
    { type: "description" },
    { type: "lorebook" },
    { type: "chat", rangeStart: 0, rangeEnd: "end" },
    { type: "plain", text: "", role: "system", type2: "globalNote" },
    { type: "postEverything" },
  ];
}

function resolvePromptTemplate(currentChar: character, generation?: ChatGenerationOverrides) {
  let promptTemplate = safeStructuredClone(
    generationOverride(generation, "promptTemplate", settingsStore.state.promptTemplate),
  );
  const usingPromptTemplate = !!promptTemplate;
  if (promptTemplate) ensurePostEverythingCard(promptTemplate);

  if (
    currentChar.utilityBot &&
    !(
      usingPromptTemplate &&
      generationOverride(generation, "promptSettings", settingsStore.state.promptSettings).utilOverride
    )
  ) {
    promptTemplate = getUtilityBotTemplate();
  }
  return { promptTemplate, usingPromptTemplate };
}

function parseLegacyPrompt(data: string): OpenAIChat[] {
  const normalized = data.startsWith("@@") ? data : `@@system\n${data}`;
  const parts = normalized.split(/@@@?(user|assistant|system)\n/);
  const chats: OpenAIChat[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    chats.push({
      role: parts[i] as "user" | "assistant" | "system",
      content: parts[i + 1]?.trim() || "",
    });
  }
  return chats;
}


function buildLegacyMainPrompts(
  sections: PromptSections,
  currentChar: character,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const baseMainPrompt = generationOverride(
    generation,
    "mainPrompt",
    settingsStore.state.mainPrompt,
  );
  const mainPrompt =
    currentChar.systemPrompt?.replaceAll("{{original}}", baseMainPrompt) ||
    baseMainPrompt;
  const promptPreprocess = generationOverride(
    generation,
    "promptPreprocess",
    settingsStore.state.promptPreprocess,
  );
  const additionalPrompt =
    settingsStore.state.additionalPrompt && promptPreprocess
      ? `\n${settingsStore.state.additionalPrompt}`
      : "";
  sections.main.push(
    ...parseLegacyPrompt(
      risuChatParser(mainPrompt + additionalPrompt, {
        chara: currentChar,
        chatTarget: target,
      }),
    ),
  );
  if (generationOverride(
    generation,
    "jailbreakToggle",
    settingsStore.state.jailbreakToggle,
  )) {
    sections.jailbreak.push(
      ...parseLegacyPrompt(
        risuChatParser(
          generationOverride(generation, "jailbreak", settingsStore.state.jailbreak),
          {
            chara: currentChar,
            chatTarget: target,
          },
        ),
      ),
    );
  }
}

function buildLegacyGlobalNote(
  sections: PromptSections,
  currentChar: character,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const baseGlobalNote = generationOverride(
    generation,
    "globalNote",
    settingsStore.state.globalNote,
  );
  const globalNote =
    currentChar.replaceGlobalNote?.replaceAll(
      "{{original}}",
      baseGlobalNote,
    ) || baseGlobalNote;
  sections.globalNote.push(
    ...parseLegacyPrompt(
      risuChatParser(globalNote, { chara: currentChar, chatTarget: target }),
    ),
  );
}

function buildLegacyPromptSections(
  sections: PromptSections,
  currentChar: character,
  promptTemplate: PromptItem[] | null | undefined,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  if (currentChar.utilityBot || promptTemplate) return;
  buildLegacyMainPrompts(sections, currentChar, target, generation);
  buildLegacyGlobalNote(sections, currentChar, target, generation);
}

function buildAuthorAndControlPrompts(
  sections: PromptSections,
  currentChar: character,
  currentChat: Chat,
  usingPromptTemplate: boolean,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const authorNote = currentChat.note || getAuthorNoteDefaultText();
  if (authorNote) {
    sections.authorNote.push({
      role: "system",
      content: risuChatParser(authorNote, {
        chara: currentChar,
        chatTarget: target,
      }),
    });
  }

  const promptSettings = generationOverride(
    generation,
    "promptSettings",
    settingsStore.state.promptSettings,
  );
  if (
    settingsStore.state.chainOfThought &&
    !(usingPromptTemplate && promptSettings.customChainOfThought)
  ) {
    sections.postEverything.push({
      role: "system",
      content:
        "<instruction> - before respond everything, Think step by step as a ai assistant how would you respond inside <Thoughts> xml tag. this must be less than 5 paragraphs.</instruction>",
    });
  }
}

async function buildDescriptionText(
  currentChar: character,
  currentChat: Chat,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const promptPreprocess = generationOverride(
    generation,
    "promptPreprocess",
    settingsStore.state.promptPreprocess,
  );
  let description = risuChatParser(
    (promptPreprocess ? settingsStore.state.descriptionPrefix : "") + currentChar.desc,
    { chara: currentChar, chatTarget: target },
  );
  const additionalInfo = await additionalInformations(
    currentChar,
    currentChat,
    target,
  );
  if (additionalInfo) {
    description += `\n\n${risuChatParser(additionalInfo, {
      chara: currentChar,
      chatTarget: target,
    })}`;
  }
  if (currentChar.personality) {
    description += risuChatParser(
      `\n\nDescription of {{char}}: ${currentChar.personality}`,
      { chara: currentChar, chatTarget: target },
    );
  }
  if (currentChar.scenario) {
    description += risuChatParser(
      `\n\nCircumstances and context of the dialogue: ${currentChar.scenario}`,
      { chara: currentChar, chatTarget: target },
    );
  }
  return description;
}

function appendGroupSpeakerInstruction(
  sections: PromptSections,
  currentChar: character,
  nowChatroom: character | groupChat,
) {
  if (nowChatroom.type !== "group") return;
  sections.postEverything.push({
    role: "system",
    content: `[Write the next reply only as ${currentChar.name}]`,
  });
}

async function buildDescriptionPrompt(
  sections: PromptSections,
  currentChar: character,
  currentChat: Chat,
  nowChatroom: character | groupChat,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const prompt: OpenAIChat = {
    role: "system",
    content: await buildDescriptionText(currentChar, currentChat, target, generation),
  };
  sections.description.push(prompt);
  appendGroupSpeakerInstruction(sections, currentChar, nowChatroom);
  return prompt;
}

type LorePrompt = Awaited<ReturnType<typeof loadLoreBookV3Prompt>>;

function createPositionResolver(lorePrompt: LorePrompt) {
  const positionRegex = /{{position::(.+?)}}/g;
  return (text: string, maxDepth = 5) => {
    let result = text;
    for (let depth = 0; depth < maxDepth; depth++) {
      let replaced = false;
      result = result.replace(positionRegex, (_match, position) => {
        replaced = true;
        return lorePrompt.actives
          .filter((active) => active.pos === `pt_${position}`)
          .map((active) => active.prompt)
          .join("\n");
      });
      if (!replaced) break;
    }
    return result.replace(positionRegex, "");
  };
}

function buildLorebookSections(
  sections: PromptSections,
  currentChar: character,
  lorePrompt: LorePrompt,
  resolvePosition: (text: string, maxDepth?: number) => string,
  target?: ChatExecutionTarget,
) {
  const toChat = (lorebook: LorePrompt["actives"][number]): OpenAIChat => ({
    role: lorebook.role,
    content: risuChatParser(resolvePosition(lorebook.prompt), {
      chara: currentChar,
      chatTarget: target,
    }),
  });

  for (const lorebook of lorePrompt.actives) {
    if (lorebook.pos === "" && lorebook.inject === null) {
      sections.lorebook.push(toChat(lorebook));
      continue;
    }
    if (
      lorebook.pos === "after_desc" ||
      lorebook.pos === "personality" ||
      lorebook.pos === "scenario"
    ) {
      sections.description.push(toChat(lorebook));
      continue;
    }
    if (lorebook.pos === "before_desc") {
      sections.description.unshift(toChat(lorebook));
      continue;
    }
  }
}

function appendDepthZeroLorebookPrompts(
  sections: PromptSections,
  currentChar: character,
  lorePrompt: LorePrompt,
  resolvePosition: (text: string, maxDepth?: number) => string,
  target?: ChatExecutionTarget,
) {
  const append = (assistant: boolean) => {
    for (const lorebook of lorePrompt.actives) {
      if (
        lorebook.pos === "depth" &&
        lorebook.depth === 0 &&
        (lorebook.role === "assistant") === assistant
      ) {
        sections.postEverything.push({
          role: lorebook.role,
          content: risuChatParser(resolvePosition(lorebook.prompt), {
            chara: currentChar,
            chatTarget: target,
          }),
        });
      }
    }
  };

  append(false);
  // Assistant depth-0 lorebooks must remain after user/system lorebooks.
  append(true);
}

function addPersonaAndInlayPrompts(
  sections: PromptSections,
  currentChar: character,
  target?: ChatExecutionTarget,
) {
  if (settingsStore.state.personaPrompt) {
    sections.personaPrompt.push({
      role: "system",
      content: risuChatParser(getPersonaPrompt(target), {
        chara: currentChar,
        chatTarget: target,
      }),
    });
  }

  if (!currentChar.inlayViewScreen) return;
  if (currentChar.viewScreen === "emotion") {
    sections.postEverything.push({
      role: "system",
      content: currentChar.newGenData.emotionInstructions.replaceAll(
        "{{slot}}",
        currentChar.emotionImages.map((asset) => asset[0]).join(", "),
      ),
    });
  } else if (currentChar.viewScreen === "imggen") {
    sections.postEverything.push({
      role: "system",
      content: currentChar.newGenData.instructions,
    });
  }
}

function createPositionParser(
  lorePrompt: LorePrompt,
  resolvePosition: (text: string, maxDepth?: number) => string,
) {
  const injections = lorePrompt.actives.filter((active) => active.inject && !active.inject.lore);
  const byLocation = new Map<string, typeof injections>();
  for (const injection of injections) {
    const location = injection.inject.location;
    const entries = byLocation.get(location) ?? [];
    entries.push(injection);
    byLocation.set(location, entries);
  }

  return (text: string, location: string) => {
    for (const lore of byLocation.get(location) ?? []) {
      switch (lore.inject.operation) {
        case "append":
          text += ` ${lore.prompt}`;
          break;
        case "prepend":
          text = `${lore.prompt} ${text}`;
          break;
        case "replace":
          text = text.replace(lore.inject.param, lore.prompt);
          break;
      }
    }
    return resolvePosition(text);
  };
}

function createDescriptionPromptGetter(
  sections: PromptSections,
  lorePrompt: LorePrompt,
) {
  const beforeDescriptionCount = lorePrompt.actives.filter(
    (active) => active.pos === "before_desc",
  ).length;
  return (role?: PromptRole) => {
    const prompts = safeStructuredClone(sections.description);
    applyPromptBlockRole([prompts[beforeDescriptionCount]], role);
    return prompts;
  };
}

export async function preparePromptSections(
  currentChar: character,
  currentChat: Chat,
  nowChatroom: character | groupChat,
  target?: ChatExecutionTarget,
  generation?: ChatGenerationOverrides,
) {
  const sections = createPromptSections();
  const scopedTarget: ChatExecutionTarget | undefined = target
    ? { ...target, globalVariables: generation?.chatVariables }
    : target;
  const { promptTemplate, usingPromptTemplate } = resolvePromptTemplate(
    currentChar,
    generation,
  );
  buildLegacyPromptSections(
    sections,
    currentChar,
    promptTemplate,
    scopedTarget,
    generation,
  );
  buildAuthorAndControlPrompts(
    sections,
    currentChar,
    currentChat,
    usingPromptTemplate,
    scopedTarget,
    generation,
  );

  await buildDescriptionPrompt(
    sections,
    currentChar,
    currentChat,
    nowChatroom,
    scopedTarget,
    generation,
  );
  const lorePrompt = await loadLoreBookV3Prompt(scopedTarget, {
    chat: currentChat,
    moduleIds: generation?.moduleIds,
    chatVariables: generation?.chatVariables,
  });
  const resolvePosition = createPositionResolver(lorePrompt);
  buildLorebookSections(sections, currentChar, lorePrompt, resolvePosition, scopedTarget);
  addPersonaAndInlayPrompts(sections, currentChar, scopedTarget);
  appendDepthZeroLorebookPrompts(
    sections,
    currentChar,
    lorePrompt,
    resolvePosition,
    scopedTarget,
  );

  return {
    unformated: sections,
    promptTemplate,
    usingPromptTemplate,
    lorepmt: lorePrompt,
    resolvePosition,
    positionParser: createPositionParser(lorePrompt, resolvePosition),
    getDescriptionPrompts: createDescriptionPromptGetter(sections, lorePrompt),
  };
}
