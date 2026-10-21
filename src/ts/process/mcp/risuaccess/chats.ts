import {
  type MCPTool,
  MCPToolHandler,
  type RPCToolCallContent,
} from "../mcplib";
import { getCharacter } from "./utils";
import type { MCPToolCallContext } from "../mcp";
import type { character, groupChat } from "../../../storage/database/schema";
import { resolveChatTarget } from "../../../chatTarget";

export class ChatHandler extends MCPToolHandler {
  getTools(): MCPTool[] {
    return [
      {
        name: "risu-get-chat-history",
        description:
          "Get the chat history with user and a Risuai character. ordered by time, newest first.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "The ID or name of the Risuai character. This can be a character name or ID. if its blank string, it will use the current character.",
            },
            count: {
              type: "integer",
              description:
                "The number of chat history entries to retrieve. maximum and default is 20.",
              default: 20,
            },
            offset: {
              type: "integer",
              description:
                "The offset to start retrieving chat history entries from. This is useful for pagination.",
            },
          },
          required: ["id"],
        },
      },
    ];
  }

  async handle(
    toolName: string,
    args: any,
    context?: MCPToolCallContext,
  ): Promise<RPCToolCallContent[] | null> {
    if (toolName === "risu-get-chat-history") {
      return await this.getChatHistory(
        args.id,
        args.count,
        args.offset,
        context,
      );
    }
    return null;
  }

  async getChatHistory(
    id: string,
    count: number = 20,
    offset: number = 0,
    context?: MCPToolCallContext,
  ): Promise<RPCToolCallContent[]> {
    const char: character | groupChat = getCharacter(id);
    if (!char) {
      return [
        {
          type: "text",
          text: `Error: Character with ID ${id} not found.`,
        },
      ];
    }
    if (char.type === "group") {
      return [
        {
          type: "text",
          text: `Error: The id pointed to a group chat, not a character.`,
        },
      ];
    }

    if (count > 100) count = 100;
    if (count < 1) count = 1;
    if (offset < 0) offset = 0;

    const contextTarget =
      context?.currentChar?.chaId === char.chaId && context.chatTarget
        ? resolveChatTarget(context.chatTarget)
        : null;
    const chatIndex =
      contextTarget?.character.chaId === char.chaId
        ? contextTarget.chatIndex
        : char.chatPage;
    const targetChat =
      contextTarget?.character.chaId === char.chaId
        ? contextTarget.chat
        : char.chats[chatIndex];
    if (!targetChat) {
      return [
        {
          type: "text",
          text: `Error: Chat ${chatIndex} not found for character ${char.name}.`,
        },
      ];
    }

    // Slice only the requested newest-first window directly from the tail,
    // avoiding cloning and reversing the entire chat history.
    const len = targetChat.message.length;
    const start = Math.max(0, len - offset - count);
    const end = Math.max(0, len - offset);
    const history = targetChat.message.slice(start, end).reverse();

    const ordered = history.map((entry) => ({
      type: "text",
      text: `${entry.role === "char" ? char.name : "User"}: ${entry.data}`,
    }));

    return [
      {
        type: "text",
        text: JSON.stringify(ordered),
      },
    ];
  }
}
