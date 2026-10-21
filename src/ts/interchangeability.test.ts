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
import type { character, RisuPersona } from "./storage/database/schema";

describe("interchangeability conversion optimizations", () => {
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
