import type { Database, Message } from "../../database/schema";

/**
 * Shared fixture database used by the SQLite storage test suites.
 * Built through the production replaceDatabase() path in tests so the
 * commit encoder and the loaders validate each other.
 */
export function buildFullDatabase(): Database {
  return {
    username: "tester",
    language: "en",
    theme: "dark",
    personas: [
      { name: "Persona", icon: "", personaPrompt: "", note: "", largePortrait: false },
    ],
    loreBook: [
      {
        name: "World",
        data: [
          { key: "fact", content: "value", insertion_order: 1, enabled: true },
        ],
      },
    ],
    modules: [{ id: "module-1", name: "Module", lorebook: [] }],
    globalscript: [],
    pluginCustomStorage: { plugin: { nested: [1, null, "three"] } },
    characters: [
      {
        chaId: "char-1",
        type: "character",
        name: "Alpha",
        image: "img://alpha.png",
        firstMessage: "hi",
        emotionImages: [["joy", "img://joy.png"]],
        chats: [
          {
            id: "chat-1",
            name: "Main",
            note: "notes",
            localLore: [],
            message: [
              makeMessage("m1", "user", "one", {
                time: 1000,
                name: "user",
                generationInfo: { model: "test-model", inputTokens: 10 },
                promptInfo: {
                  promptName: "preset",
                  promptToggles: [],
                  promptText: [
                    { role: "system", content: "you are a helpful assistant" },
                    { role: "user", content: "hello" },
                  ],
                },
              }),
              makeMessage("m2", "char", "two", { time: 2000 }),
            ],
          },
          {
            id: "chat-2",
            name: "Second",
            note: "",
            localLore: [],
            message: [makeMessage("m3", "user", "three")],
          },
        ],
      },
      {
        chaId: "char-2",
        type: "character",
        name: "Beta",
        image: "",
        firstMessage: "",
        chats: [],
      },
    ],
  } as any;
}

export function makeMessage(
  chatId: string,
  role: "user" | "char",
  data: string,
  extra: Partial<Message> = {},
): Message {
  return { chatId, role, data, ...extra } as Message;
}
