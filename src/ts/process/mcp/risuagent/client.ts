import { MCPClientLike } from "../internalmcp";
import type { MCPTool, RPCToolCallContent } from "../mcplib";
import type { character, loreBook } from "../../../storage/database/schema";
import {
  defaultRisuAgentAccessDependencies,
  type RisuAgentAccessDependencies,
} from "./deps";
import type { RisuAgentContextScope } from "./scope";

/** Reserved MCP URL used to route agent tool calls to the scoped client. */
export const RISU_AGENT_MCP_URL = "internal:risu-agent-access";

export const RISU_AGENT_READ_TOOL_NAMES = [
  "risu-agent-get-character-info",
  "risu-agent-list-lorebooks",
  "risu-agent-get-lorebooks",
  "risu-agent-list-chats",
  "risu-agent-get-chat-history",
] as const;

export type RisuAgentReadToolName = (typeof RISU_AGENT_READ_TOOL_NAMES)[number];

const RISU_AGENT_READ_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  RISU_AGENT_READ_TOOL_NAMES,
);

const MAX_FIELD_CHARS = 12_000;
const MAX_LOREBOOK_LIST = 100;
const MAX_LOREBOOK_PREVIEW_CHARS = 240;
const MAX_LOREBOOK_CONTENT_CHARS = 8_000;
const MAX_LOREBOOK_GET_ENTRIES = 10;
const MAX_CHAT_LIST = 50;
const MAX_HISTORY_COUNT = 40;
const DEFAULT_HISTORY_COUNT = 20;
const MAX_MESSAGE_CHARS = 4_000;

const CHARACTER_FIELD_MAP = {
  name: "name",
  description: "desc",
  personality: "personality",
  scenario: "scenario",
  firstMessage: "firstMessage",
  exampleMessage: "exampleMessage",
  creatorNotes: "creatorNotes",
  systemPrompt: "systemPrompt",
  postHistoryInstructions: "postHistoryInstructions",
  replaceGlobalNote: "replaceGlobalNote",
  tags: "tags",
  creator: "creator",
  characterVersion: "characterVersion",
  alternateGreetings: "alternateGreetings",
} as const;

type CharacterInfoField = keyof typeof CHARACTER_FIELD_MAP;

const DEFAULT_CHARACTER_FIELDS: CharacterInfoField[] = [
  "name",
  "description",
  "personality",
  "scenario",
  "firstMessage",
  "exampleMessage",
  "creatorNotes",
  "systemPrompt",
  "postHistoryInstructions",
];

const TOOL_DEFINITIONS: MCPTool[] = [
  {
    name: "risu-agent-get-character-info",
    description:
      "Read metadata for the Risu character currently attached to Risu Agent. Useful for character creation and worldbuilding. Read-only; other characters are not reachable.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          description: "Specific fields to include. Defaults to a useful subset.",
          items: {
            type: "string",
            enum: Object.keys(CHARACTER_FIELD_MAP),
          },
        },
        id: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached character. Any other id is rejected.",
        },
      },
    },
  },
  {
    name: "risu-agent-list-lorebooks",
    description:
      "List lorebook entries of the attached Risu character with short previews. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached character. Any other id is rejected.",
        },
        count: {
          type: "integer",
          description: `Maximum entries to return (1-${MAX_LOREBOOK_LIST}, default 50).`,
        },
        offset: {
          type: "integer",
          description: "Number of entries to skip for pagination.",
        },
      },
    },
  },
  {
    name: "risu-agent-get-lorebooks",
    description:
      "Read the full content of named lorebook entries from the attached Risu character. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached character. Any other id is rejected.",
        },
        names: {
          type: "array",
          description: `Lorebook names to read (1-${MAX_LOREBOOK_GET_ENTRIES}).`,
          items: { type: "string" },
        },
      },
      required: ["names"],
    },
  },
  {
    name: "risu-agent-list-chats",
    description:
      "List chat sessions of the attached Risu character as lightweight summaries. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached character. Any other id is rejected.",
        },
        count: {
          type: "integer",
          description: `Maximum sessions to return (1-${MAX_CHAT_LIST}, default 20).`,
        },
        offset: {
          type: "integer",
          description: "Number of sessions to skip for pagination.",
        },
      },
    },
  },
  {
    name: "risu-agent-get-chat-history",
    description:
      "Read a bounded page of the explicitly attached chat, newest first. Use nextBefore from the response to page to older messages. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached character. Any other id is rejected.",
        },
        chatId: {
          type: "string",
          description:
            "Optional. Leave blank to target the attached chat. Any other chat is rejected.",
        },
        count: {
          type: "integer",
          description: `Number of messages to return (1-${MAX_HISTORY_COUNT}, default ${DEFAULT_HISTORY_COUNT}).`,
        },
        before: {
          type: "integer",
          description:
            "Exclusive message index to page older messages. Pass nextBefore from a previous response.",
        },
      },
    },
  },
];

export class RisuAgentAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RisuAgentAccessError";
  }
}

function textResult(text: string): RPCToolCallContent[] {
  return [{ type: "text", text }];
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncate(
  value: string | undefined,
  maxChars: number,
): { value: string; truncated: boolean } {
  const text = value ?? "";
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}

function lorebookDisplayName(entry: loreBook, index: number): string {
  const comment = entry.comment?.trim();
  return comment && comment.length > 0 ? comment : `Untitled lorebook ${index}`;
}

export class RisuAgentAccessClient extends MCPClientLike {
  private readonly scope: RisuAgentContextScope;
  private readonly deps: RisuAgentAccessDependencies;

  constructor(
    scope: RisuAgentContextScope,
    deps: RisuAgentAccessDependencies = defaultRisuAgentAccessDependencies,
  ) {
    super(RISU_AGENT_MCP_URL);
    this.scope = { characterId: scope.characterId, chatId: scope.chatId };
    this.deps = deps;
    this.serverInfo.serverInfo.name = "Risu Agent Access (read-only)";
    this.serverInfo.serverInfo.version = "1.0.0";
    this.serverInfo.instructions =
      "Read-only access to the single Risu character (and optional chat) explicitly attached to Risu Agent. Mutation tools are never exposed. Other characters are not reachable.";
  }

  async getToolList(): Promise<MCPTool[]> {
    return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
  }

  async callTool(
    toolName: string,
    args: unknown,
    _context?: unknown,
  ): Promise<RPCToolCallContent[]> {
    // Allowlist first: anything not in the read-only set is rejected before any
    // dependency is touched, including write/delete tools from the general
    // Risu Access MCP.
    if (!RISU_AGENT_READ_TOOL_NAME_SET.has(toolName)) {
      return textResult(
        `Error: Tool "${toolName}" is not available to Risu Agent. Risu Agent only exposes read-only Risu context tools; mutation tools are rejected. Available tools: ${RISU_AGENT_READ_TOOL_NAMES.join(", ")}.`,
      );
    }

    const safeArgs = normalizeArgs(args);
    try {
      switch (toolName) {
        case "risu-agent-get-character-info":
          return await this.getCharacterInfo(safeArgs);
        case "risu-agent-list-lorebooks":
          return await this.listLorebooks(safeArgs);
        case "risu-agent-get-lorebooks":
          return await this.getLorebooks(safeArgs);
        case "risu-agent-list-chats":
          return await this.listChats(safeArgs);
        case "risu-agent-get-chat-history":
          return await this.getChatHistory(safeArgs);
        default:
          return textResult(`Error: Tool "${toolName}" is not implemented.`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      return textResult(`Error: ${message}`);
    }
  }

  private async requireScopeCharacter(): Promise<character> {
    const char = await this.deps.resolveCharacter(this.scope.characterId);
    if (!char) {
      throw new RisuAgentAccessError(
        "The attached character is no longer available. Detach and attach a character again.",
      );
    }
    return char;
  }

  private assertRequestedCharacterInScope(
    char: character,
    requestedId: unknown,
  ): void {
    const requested = normalizeOptionalString(requestedId);
    if (!requested || requested === "current") return;
    if (requested === char.chaId || requested === char.name) return;
    throw new RisuAgentAccessError(
      `Access denied: Risu Agent is scoped to the attached character "${char.name}". Reading a different character by id or name is not allowed.`,
    );
  }

  private resolveScopeChatId(char: character, requestedChatId: unknown): string {
    const requested = normalizeOptionalString(requestedChatId);
    const chats = char.chats ?? [];
    const attachedChatId = this.scope.chatId;
    if (attachedChatId) {
      const attachedChat = chats.find((chat) => chat.id === attachedChatId);
      if (!attachedChat) {
        throw new RisuAgentAccessError(
          "The attached chat is no longer available. Attach a chat again.",
        );
      }
      if (requested && requested !== attachedChatId) {
        throw new RisuAgentAccessError(
          "Access denied: only the explicitly attached chat can be read. Attach that chat first.",
        );
      }
      return attachedChatId;
    }

    const activeChat = chats[char.chatPage ?? 0];
    if (!activeChat?.id) {
      throw new RisuAgentAccessError(
        "No chat is attached and the character has no active chat to read.",
      );
    }
    if (requested && requested !== activeChat.id) {
      throw new RisuAgentAccessError(
        "Access denied: no chat is attached. Attach a chat before reading its history.",
      );
    }
    return activeChat.id;
  }

  private async getCharacterInfo(
    args: Record<string, unknown>,
  ): Promise<RPCToolCallContent[]> {
    const char = await this.requireScopeCharacter();
    this.assertRequestedCharacterInScope(char, args.id);

    const requestedFields = Array.isArray(args.fields)
      ? args.fields.filter(
          (field): field is CharacterInfoField =>
            typeof field === "string" &&
            Object.prototype.hasOwnProperty.call(CHARACTER_FIELD_MAP, field),
        )
      : [];
    const unknownFields = Array.isArray(args.fields)
      ? args.fields.filter(
          (field) =>
            typeof field !== "string" ||
            !Object.prototype.hasOwnProperty.call(CHARACTER_FIELD_MAP, field),
        )
      : [];
    if (unknownFields.length > 0) {
      return textResult(
        `Error: Unknown or disallowed fields: ${unknownFields.join(", ")}. Allowed fields: ${Object.keys(CHARACTER_FIELD_MAP).join(", ")}.`,
      );
    }
    const fields =
      requestedFields.length > 0 ? requestedFields : DEFAULT_CHARACTER_FIELDS;

    const payload: Record<string, unknown> = {};
    let truncated = false;
    for (const field of fields) {
      const value = char[CHARACTER_FIELD_MAP[field] as keyof character];
      if (typeof value === "string") {
        const bounded = truncate(value, MAX_FIELD_CHARS);
        payload[field] = bounded.value;
        truncated ||= bounded.truncated;
      } else {
        payload[field] = value ?? null;
      }
    }

    return textResult(
      JSON.stringify({
        characterId: char.chaId,
        name: char.name,
        fields: payload,
        truncated,
      }),
    );
  }

  private async listLorebooks(
    args: Record<string, unknown>,
  ): Promise<RPCToolCallContent[]> {
    const char = await this.requireScopeCharacter();
    this.assertRequestedCharacterInScope(char, args.id);

    const lorebooks = char.globalLore ?? [];
    const offset = clampInteger(args.offset, 0, 0, lorebooks.length);
    const count = clampInteger(args.count, 50, 1, MAX_LOREBOOK_LIST);
    const page = lorebooks.slice(offset, offset + count);
    const entries = page.map((entry, index) => {
      const absoluteIndex = offset + index;
      const preview = truncate(entry.content, MAX_LOREBOOK_PREVIEW_CHARS);
      return {
        name: lorebookDisplayName(entry, absoluteIndex),
        keys: entry.key ?? "",
        secondKeys: entry.secondkey ?? "",
        alwaysActive: Boolean(entry.alwaysActive),
        contentLength: (entry.content ?? "").length,
        contentPreview: preview.value,
        previewTruncated: preview.truncated,
      };
    });

    return textResult(
      JSON.stringify({
        characterId: char.chaId,
        total: lorebooks.length,
        offset,
        hasMore: offset + page.length < lorebooks.length,
        entries,
      }),
    );
  }

  private async getLorebooks(
    args: Record<string, unknown>,
  ): Promise<RPCToolCallContent[]> {
    const char = await this.requireScopeCharacter();
    this.assertRequestedCharacterInScope(char, args.id);

    const requestedNames = Array.isArray(args.names)
      ? args.names
          .map((name) => normalizeOptionalString(name))
          .filter((name) => name.length > 0)
      : [];
    if (requestedNames.length === 0) {
      return textResult("Error: Provide at least one lorebook name.");
    }
    if (requestedNames.length > MAX_LOREBOOK_GET_ENTRIES) {
      return textResult(
        `Error: At most ${MAX_LOREBOOK_GET_ENTRIES} lorebook entries can be read at once.`,
      );
    }

    const lorebooks = char.globalLore ?? [];
    const results: Array<Record<string, unknown>> = [];
    const missing: string[] = [];
    for (const name of requestedNames) {
      const index = lorebooks.findIndex(
        (entry, entryIndex) => lorebookDisplayName(entry, entryIndex) === name,
      );
      if (index < 0) {
        missing.push(name);
        continue;
      }
      const entry = lorebooks[index];
      const content = truncate(entry.content, MAX_LOREBOOK_CONTENT_CHARS);
      results.push({
        name,
        keys: entry.key ?? "",
        secondKeys: entry.secondkey ?? "",
        alwaysActive: Boolean(entry.alwaysActive),
        content: content.value,
        contentTruncated: content.truncated,
      });
    }

    return textResult(
      JSON.stringify({
        characterId: char.chaId,
        entries: results,
        missing,
      }),
    );
  }

  private async listChats(
    args: Record<string, unknown>,
  ): Promise<RPCToolCallContent[]> {
    const char = await this.requireScopeCharacter();
    this.assertRequestedCharacterInScope(char, args.id);

    const chats = char.chats ?? [];
    const offset = clampInteger(args.offset, 0, 0, chats.length);
    const count = clampInteger(args.count, 20, 1, MAX_CHAT_LIST);
    const page = chats.slice(offset, offset + count);
    const entries = page.map((chat, index) => {
      const absoluteIndex = offset + index;
      return {
        chatId: chat.id ?? null,
        name: chat.name || `Chat ${absoluteIndex + 1}`,
        lastDate: typeof chat.lastDate === "number" ? chat.lastDate : null,
        messageTotal:
          typeof chat.messageTotal === "number" ? chat.messageTotal : null,
        isActive: absoluteIndex === (char.chatPage ?? 0),
        isAttached: chat.id === this.scope.chatId,
      };
    });

    return textResult(
      JSON.stringify({
        characterId: char.chaId,
        total: chats.length,
        offset,
        hasMore: offset + page.length < chats.length,
        attachedChatId: this.scope.chatId ?? null,
        entries,
      }),
    );
  }

  private async getChatHistory(
    args: Record<string, unknown>,
  ): Promise<RPCToolCallContent[]> {
    const char = await this.requireScopeCharacter();
    this.assertRequestedCharacterInScope(char, args.id);
    const chatId = this.resolveScopeChatId(char, args.chatId);

    const count = clampInteger(
      args.count,
      DEFAULT_HISTORY_COUNT,
      1,
      MAX_HISTORY_COUNT,
    );
    const before =
      typeof args.before === "number" &&
      Number.isFinite(args.before) &&
      args.before >= 0
        ? Math.floor(args.before)
        : undefined;

    const page = await this.deps.loadChatMessagePage(chatId, before, count);
    const indexed = page.messages.map((message, index) => ({
      index: page.offset + index,
      role: message.role,
      speaker: message.role === "char" ? char.name : "User",
      time: typeof message.time === "number" ? message.time : null,
      data: message.data ?? "",
    }));
    // Present newest first while keeping the absolute index stable.
    indexed.reverse();
    const messages = indexed.map((message) => {
      const bounded = truncate(message.data, MAX_MESSAGE_CHARS);
      return {
        index: message.index,
        role: message.role,
        speaker: message.speaker,
        time: message.time,
        text: bounded.value,
        truncated: bounded.truncated,
      };
    });

    return textResult(
      JSON.stringify({
        characterId: char.chaId,
        chatId,
        total: page.total,
        offset: page.offset,
        hasMore: page.hasMore,
        nextBefore: page.hasMore ? page.offset : null,
        messages,
      }),
    );
  }
}
