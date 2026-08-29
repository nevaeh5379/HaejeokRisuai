import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import type { Chat, character } from "../../storage/database/schema";

import { HypaProcesser } from "../memory/hypamemory";
import { getUserName } from "src/ts/util";

export async function additionalInformations(
  char: character,
  chats: Chat,
  chatTarget?: ChatExecutionTarget,
) {
  const processer = new HypaProcesser();
  const db = settingsStore.state;

  const info = char.additionalText;
  if (info) {
    const infos = info.split("\n\n");

    await processer.addText(infos);
    const filteredChat = chats.message
      .slice(0, 4)
      .map((chat) => {
        let name = chat.saying ?? "";

        if (!name) {
          if (chat.role === "user") {
            name = getUserName(chatTarget);
          } else {
            name = char.name;
          }
        }

        return `${name}: ${chat.data}`;
      })
      .join("\n\n");
    const searched = await processer.similaritySearch(filteredChat);
    const result = searched.slice(0, 3).join("\n\n");
    return result;
  }

  return "";
}
