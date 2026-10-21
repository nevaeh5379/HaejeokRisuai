import { risuChatParser } from "./parser.svelte";

const STARTER = "<|im_start|>";
const ENDER = "<|im_end|>";
const USER_SEP = "user<|im_sep|>";
const SYSTEM_SEP = "system<|im_sep|>";
const ASSISTANT_SEP = "assistant<|im_sep|>";

export function parseChatML(
  data: string,
): (OpenAIChat & { thoughts?: string[] })[] | null {
  const trimedData = data.trim();
  if (!trimedData.startsWith(STARTER)) {
    return null;
  }

  const parts = trimedData.split(STARTER);
  const result: (OpenAIChat & { thoughts?: string[] })[] = [];

  for (let i = 0; i < parts.length; i++) {
    let v = parts[i];
    if (v === "") continue;

    let role: "system" | "user" | "assistant" = "user";
    //default separators
    if (v.startsWith(USER_SEP)) {
      role = "user";
      v = v.substring(USER_SEP.length);
    } else if (v.startsWith(SYSTEM_SEP)) {
      role = "system";
      v = v.substring(SYSTEM_SEP.length);
    } else if (v.startsWith(ASSISTANT_SEP)) {
      role = "assistant";
      v = v.substring(ASSISTANT_SEP.length);
    }
    //space/newline separators
    else if (v.startsWith("user ") || v.startsWith("user\n")) {
      role = "user";
      v = v.substring(5);
    } else if (v.startsWith("system ") || v.startsWith("system\n")) {
      role = "system";
      v = v.substring(7);
    } else if (v.startsWith("assistant ") || v.startsWith("assistant\n")) {
      role = "assistant";
      v = v.substring(10);
    }

    v = v.trim();

    if (v.endsWith(ENDER)) {
      v = v.substring(0, v.length - ENDER.length);
    }

    const thoughts: string[] = [];
    v = v.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, p1) => {
      thoughts.push(p1);
      return "";
    });

    result.push({
      role: role,
      content: risuChatParser(v),
      thoughts: thoughts,
    });
  }

  return result;
}
