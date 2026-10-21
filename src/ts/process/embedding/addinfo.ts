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
    const userName = getUserName(chatTarget);
    const charName = char.name;
    const limit = Math.min(chats.message.length, 4);
    let filteredChat = "";
    for (let i = 0; i < limit; i++) {
      const chat = chats.message[i];
      let name = chat.saying;
      if (!name) {
        name = chat.role === "user" ? userName : charName;
      }
      if (filteredChat) filteredChat += "\n\n";
      filteredChat += `${name}: ${chat.data}`;
    }
    const searched = await processer.similaritySearch(filteredChat);
    const result = searched.slice(0, 3).join("\n\n");
    return result;
  }

  return "";
}
