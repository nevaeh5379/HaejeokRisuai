import { describe, expect, it } from "vitest";
import {
  convertCharacterToModule,
  convertCharacterToPersona,
  convertModuleToCharacter,
  convertModuleToPersona,
  convertPersonaToCharacter,
  convertPersonaToModule,
} from "./interchangeability";
import { createBlankChar } from "./characterDefaults";
import type { RisuModule } from "./process/modules";
import type { RisuPersona } from "./storage/database/schema";

function editableModule(): RisuModule {
  return {
    id: "original-module",
    name: "Original",
    description: "",
    lorebook: [
      {
        key: "key",
        secondkey: "",
        content: "original",
        comment: "",
        insertorder: 0,
        mode: "constant",
        alwaysActive: true,
        selective: false,
      },
    ],
    regex: [
      {
        comment: "",
        in: "original",
        out: "replacement",
        type: "editdisplay",
        ableFlag: false,
      },
    ],
    trigger: [
      {
        comment: "original",
        type: "manual",
        conditions: [],
        effect: [{ type: "v2Header", code: "original", indent: 0 }],
      },
    ],
    assets: [["asset", "original.png", "png"]],
    subModelRequestRules: [{ enabled: true, phrases: ["original"] }],
  };
}

function editModule(module: RisuModule) {
  module.lorebook[0].content = "edited";
  module.regex[0].in = "edited";
  module.trigger[0].effect[0] = { type: "v2Header", code: "edited", indent: 0 };
  module.assets[0][1] = "edited.png";
  module.subModelRequestRules[0].phrases.push("edited");
}

describe("interchangeability conversion optimizations", () => {
  it("isolates converted characters from their source module", () => {
    const source = editableModule();
    const before = structuredClone(source);
    const char = convertModuleToCharacter(source);
    char.globalLore[0].content = "edited";
    char.customscript[0].in = "edited";
    char.triggerscript[0].effect[0] = {
      type: "v2Header",
      code: "edited",
      indent: 0,
    };
    char.additionalAssets[0][1] = "edited.png";
    (
      char.extentions
        .moduleSubModelRequestRules as RisuModule["subModelRequestRules"]
    )[0].phrases.push("edited");
    expect(source).toEqual(before);
  });

  it.each(["module", "persona"] as const)(
    "isolates a converted %s from its source character",
    (target) => {
      const source = convertModuleToCharacter(editableModule());
      const before = structuredClone(source);
      const result =
        target === "module"
          ? convertCharacterToModule(source)
          : convertCharacterToPersona(source).embeddedModule;
      editModule(result);
      expect(source).toEqual(before);
    },
  );

  it.each(["module", "character"] as const)(
    "isolates a converted %s from its source persona",
    (target) => {
      const source: RisuPersona = {
        name: "Persona",
        icon: "",
        personaPrompt: "Prompt",
        embeddedModule: editableModule(),
      };
      const before = structuredClone(source);
      if (target === "module") {
        editModule(convertPersonaToModule(source));
      } else {
        const result = convertPersonaToCharacter(source);
        result.globalLore[0].content = "edited";
        result.triggerscript[0].effect.length = 0;
      }
      expect(source).toEqual(before);
    },
  );

  it("isolates an embedded persona module from the original module", () => {
    const source = editableModule();
    const before = structuredClone(source);
    editModule(convertModuleToPersona(source).embeddedModule);
    expect(source).toEqual(before);
  });

  it("converts module with indicators into character correctly", () => {
    const mod: RisuModule = {
      id: "mod-1",
      name: "Test Module",
      description: "Test Description",
      namespace: "test-ns",
      subModel: "sub-1",
      subModelRequestRules: [
        {
          enabled: true,
          phrases: ["test phrase"],
        },
      ],
      lorebook: [
        {
          key: "",
          secondkey: "",
          insertorder: 0,
          comment: "",
          content:
            "@@indicator character_desc\nThis is a character description.",
          mode: "constant",
          alwaysActive: true,
          selective: false,
        },
        {
          key: "",
          secondkey: "",
          insertorder: 0,
          comment: "",
          content:
            "@@indicator character_first_message\n<FM>\nHello there!\n</FM>\n<FM_alt>\nAlternative 1\n</FM_alt>\n<FM_alt>\nAlternative 2\n</FM_alt>",
          mode: "constant",
          alwaysActive: false,
          selective: false,
        },
        {
          key: "",
          secondkey: "",
          insertorder: 0,
          comment: "",
          content: "@@indicator replace_global_note\nGlobal note replacement.",
          mode: "constant",
          alwaysActive: true,
          selective: false,
        },
        {
          key: "regular",
          secondkey: "",
          insertorder: 0,
          comment: "regular entry",
          content: "Standard lore content",
          mode: "constant",
          alwaysActive: true,
          selective: false,
        },
      ],
    };

    const char = convertModuleToCharacter(mod);
    expect(char.name).toBe("Test Module");
    expect(char.creatorNotes).toBe("Test Description");
    expect(char.desc).toBe("This is a character description.");
    expect(char.firstMessage).toBe("Hello there!");
    expect(char.alternateGreetings).toEqual(["Alternative 1", "Alternative 2"]);
    expect(char.replaceGlobalNote).toBe("Global note replacement.");
    expect(char.globalLore).toHaveLength(1);
    expect(char.globalLore[0].key).toBe("regular");
    expect(char.extentions?.["moduleSubModel"]).toBe("sub-1");
    expect(char.extentions?.["moduleSubModelRequestRules"]).toEqual([
      { enabled: true, phrases: ["test phrase"] },
    ]);
  });

  it("converts character to module and round-trips indicators", () => {
    const char = createBlankChar();
    char.name = "Hero";
    char.desc = "A brave knight";
    char.firstMessage = "Greetings traveler.";
    char.alternateGreetings = ["Welcome!", "Greetings!"];
    char.replaceGlobalNote = "Knight lore";
    char.creatorNotes = "Creator note";

    const mod = convertCharacterToModule(char);
    expect(mod.name).toBe("Hero");
    expect(mod.description).toBe("Creator note");
    expect(mod.lorebook).toHaveLength(3);

    const rechar = convertModuleToCharacter(mod);
    expect(rechar.name).toBe("Hero");
    expect(rechar.desc).toBe("A brave knight");
    expect(rechar.firstMessage).toBe("Greetings traveler.");
    expect(rechar.alternateGreetings).toEqual(["Welcome!", "Greetings!"]);
    expect(rechar.replaceGlobalNote).toBe("Knight lore");
  });

  it("converts between persona and module", () => {
    const persona: RisuPersona = {
      name: "Traveler",
      icon: "icon.png",
      personaPrompt: "I am a wanderer.",
      note: "Adventurer",
    };

    const mod = convertPersonaToModule(persona);
    expect(mod.name).toBe("Traveler");
    expect(mod.description).toBe("Adventurer");
    expect(mod.lorebook?.[0].content).toContain(
      "@@indicator persona\n\nI am a wanderer.",
    );

    const convertedPersona = convertModuleToPersona(mod);
    expect(convertedPersona.name).toBe("Traveler");
    expect(convertedPersona.personaPrompt).toBe("I am a wanderer.");
    expect(convertedPersona.embeddedModule.id).toBe("$embedded");
    expect(convertedPersona.embeddedModule.lorebook).toHaveLength(0);
  });

  it("converts persona to character and character to persona", () => {
    const char = createBlankChar();
    char.name = "Sage";
    char.desc = "Wise mentor";
    char.creatorNotes = "Sage notes";

    const persona = convertCharacterToPersona(char);
    expect(persona.name).toBe("Sage");
    expect(persona.personaPrompt).toBe("Wise mentor");
    expect(persona.note).toBe("Sage notes");
    expect(persona.embeddedModule).toBeDefined();

    const charFromPersona = convertPersonaToCharacter(persona);
    expect(charFromPersona.name).toBe("Sage");
    expect(charFromPersona.desc).toBe("Wise mentor");
    expect(charFromPersona.creatorNotes).toBe("Sage notes");
  });
});
