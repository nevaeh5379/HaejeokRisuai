import { v4 } from "uuid";
import type { RisuModule } from "./process/modules.ts";
import type { character, RisuPersona } from "./storage/database/schema.js";
import { createBlankChar } from "src/ts/characters";

export function convertModuleToCharacter(m: RisuModule): character {
  const char = createBlankChar();

  if (m.mcp) {
    throw new Error("MCP modules are not supported for character conversion.");
  }

  char.name = m.name;
  char.creatorNotes = m.description;
  char.customscript = m.regex || [];
  char.triggerscript = m.trigger || [];
  char.lowLevelAccess = m.lowLevelAccess || false;
  char.hideChatIcon = m.hideIcon || false;
  char.backgroundHTML = m.backgroundEmbedding || "";
  char.additionalAssets = m.assets || [];
  char.moduleNamespace = m.namespace;
  char.customModuleToggle = m.customModuleToggle || "";
  char.image = m.icon || "";
  if (m.subModel) {
    char.extentions ??= {};
    char.extentions["moduleSubModel"] = m.subModel;
  }
  if (m.subModelRequestRules?.length) {
    char.extentions ??= {};
    char.extentions["moduleSubModelRequestRules"] = m.subModelRequestRules;
  }

  const rawLores = m.lorebook || [];
  const retainedLore: typeof char.globalLore = [];
  const altFmRegex = /<FM_alt>([\s\S]*?)<\/FM_alt>/g;

  for (let i = 0; i < rawLores.length; i++) {
    const lore = rawLores[i];
    const content = lore.content || "";
    if (
      content.startsWith("@@indicator replace_global_note") ||
      content.startsWith("@@indicator phi")
    ) {
      // Backward compat: pre-rename modules stored global notes under the '@@indicator phi' marker
      char.replaceGlobalNote = content
        .replace(/^@@indicator\s+(?:replace_global_note|phi)/, "")
        .trim();
      continue;
    }
    if (content.startsWith("@@indicator character_desc")) {
      char.desc = content.replace("@@indicator character_desc", "").trim();
      continue;
    }
    if (content.startsWith("@@indicator character_first_message")) {
      const firstMsgContent = content
        .replace("@@indicator character_first_message", "")
        .trim();
      const fmMatch = firstMsgContent.match(/<FM>([\s\S]*?)<\/FM>/);
      if (fmMatch) {
        char.firstMessage = fmMatch[1].trim();
      }
      altFmRegex.lastIndex = 0;
      let altMatch: RegExpExecArray | null;
      const alternateGreetings: string[] = [];
      while ((altMatch = altFmRegex.exec(firstMsgContent)) !== null) {
        alternateGreetings.push(altMatch[1].trim());
      }
      char.alternateGreetings = alternateGreetings;
      continue;
    }
    retainedLore.push(lore);
  }
  char.globalLore = retainedLore;

  return safeStructuredClone(char);
}

export function convertCharacterToModule(c: character): RisuModule {
  const mod: RisuModule = {
    name: c.name,
    description: c.creatorNotes,
    lorebook: c.globalLore ? [...c.globalLore] : [],
    regex: c.customscript || [],
    trigger: c.triggerscript || [],
    lowLevelAccess: c.lowLevelAccess,
    hideIcon: c.hideChatIcon,
    backgroundEmbedding: c.backgroundHTML,
    assets: c.additionalAssets || [],
    namespace: c.moduleNamespace,
    customModuleToggle: c.customModuleToggle,
    id: v4(),
    icon: c.image,
    subModel: (c.extentions?.["moduleSubModel"] as string) || undefined,
    subModelRequestRules: Array.isArray(
      c.extentions?.["moduleSubModelRequestRules"],
    )
      ? (c.extentions[
          "moduleSubModelRequestRules"
        ] as RisuModule["subModelRequestRules"])
      : undefined,
  };

  if (c.desc) {
    mod.lorebook.push({
      key: "",
      secondkey: "",
      insertorder: 0,
      comment: "From Character Description",
      content: `@@indicator character_desc\n\n${c.desc}`,
      mode: "constant",
      alwaysActive: true,
      selective: false,
    });
  }

  if (
    c.firstMessage ||
    (c.alternateGreetings && c.alternateGreetings.length > 0)
  ) {
    let firstMessages = `<FM>\n${c.firstMessage}\n</FM>`;
    c.alternateGreetings ??= [];
    for (let i = 0; i < c.alternateGreetings.length; i++) {
      firstMessages += `\n<FM_alt>\n${c.alternateGreetings[i]}\n</FM_alt>`;
    }

    mod.lorebook.push({
      key: "",
      secondkey: "",
      insertorder: 0,
      comment: "From First Messages",
      content: `@@indicator character_first_message\n\n${firstMessages}`,
      mode: "constant",
      alwaysActive: false,
      selective: false,
    });
  }

  if (c.replaceGlobalNote) {
    mod.lorebook.push({
      key: "",
      secondkey: "",
      insertorder: 0,
      comment: "From Global Note Replacement",
      content: `@@indicator replace_global_note\n\n${c.replaceGlobalNote}`,
      mode: "constant",
      alwaysActive: true,
      selective: false,
    });
  }

  return safeStructuredClone(mod);
}

export function convertPersonaToCharacter(p: RisuPersona): character {
  let char = createBlankChar();

  if (p.embeddedModule) {
    char = convertModuleToCharacter(p.embeddedModule);
  }
  char.name = p.name;
  char.image = p.icon;
  char.largePortrait = p.largePortrait || false;
  char.creatorNotes = p.note || "";
  char.desc = p.personaPrompt;
  return char;
}

export function convertCharacterToPersona(c: character): RisuPersona {
  const p: RisuPersona = {
    name: c.name,
    icon: c.image,
    personaPrompt: c.desc,
    note: c.creatorNotes,
    embeddedModule: convertCharacterToModule(c),
  };
  return p;
}

export function convertPersonaToModule(p: RisuPersona): RisuModule {
  const baseModule: RisuModule = p.embeddedModule
    ? { ...p.embeddedModule, id: v4() }
    : {
        name: "",
        description: "",
        id: v4(),
      };

  baseModule.name = p.name;
  baseModule.description = p.note || "";
  baseModule.lorebook = [
    {
      key: "",
      secondkey: "",
      insertorder: 0,
      comment: "From Persona Prompt",
      content: `@@indicator persona\n\n${p.personaPrompt}`,
      mode: "constant",
      alwaysActive: true,
      selective: false,
    },
  ];

  return safeStructuredClone(baseModule);
}

export function convertModuleToPersona(m: RisuModule): RisuPersona {
  let personaPrompt = "";
  const remainingLores = [];
  for (const lore of m.lorebook || []) {
    if (lore.content?.startsWith("@@indicator persona")) {
      personaPrompt = lore.content.replace("@@indicator persona", "").trim();
    } else {
      remainingLores.push(lore);
    }
  }

  const basePersona: RisuPersona = {
    name: m.name,
    icon: "",
    personaPrompt,
    embeddedModule: {
      ...m,
      lorebook: remainingLores,
      id: "$embedded",
    },
  };

  return safeStructuredClone(basePersona);
}
