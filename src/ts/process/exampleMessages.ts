import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import type { character } from "../storage/database/schema";
import { risuChatParser } from "./scripts";

export function exampleMessage(
  char: character,
  userName: string,
  chatTarget?: ChatExecutionTarget,
): OpenAIChat[] {
  if (char.exampleMessage === "") {
    return [];
  }

  const messages = char.exampleMessage.split("\n");
  let result: OpenAIChat[] = [];
  let currentMessage: OpenAIChat;

  function add() {
    if (currentMessage) {
      result.push(currentMessage);
    }
  }

  for (const mes of messages) {
    const trimed = mes.trim();
    const lowered = trimed.toLocaleLowerCase();

    if (lowered === "<start>") {
      add();
      result.push({
        role: "system",
        content: "[Start a new chat]",
        memo: "NewChatExample",
      });
      currentMessage = null;
    } else if (
      lowered.startsWith("{{char}}:") ||
      lowered.startsWith("<bot>:") ||
      lowered.startsWith(`${char.name}:`)
    ) {
      add();
      const colonIndex = trimed.indexOf(":");
      currentMessage = {
        role: "assistant",
        content:
          colonIndex !== -1 ? trimed.slice(colonIndex + 1).trimStart() : "",
        name: "example_assistant",
      };
    } else if (
      lowered.startsWith("{{user}}:") ||
      lowered.startsWith("<user>:")
    ) {
      add();
      const colonIndex = trimed.indexOf(":");
      currentMessage = {
        role: "user",
        content:
          colonIndex !== -1 ? trimed.slice(colonIndex + 1).trimStart() : "",
        name: "example_user",
      };
    } else {
      if (currentMessage) {
        currentMessage.content += "\n" + trimed;
      }
    }
  }
  add();

  for (let i = 0; i < result.length; i++) {
    result[i].content = risuChatParser(result[i].content, {
      chara: char,
      chatTarget,
    });
  }

  return result;
}
