import { findCharacterbyId } from "../util";
import { alertConfirm, alertError, alertSelectChar } from "../alert";
import { language } from "src/lang";
import { get } from "svelte/store";

import { selectedCharID } from "../stores.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { orderGroupSpeakers } from "@risuai/chat-core/group.cjs";

export async function addGroupChar() {
  let selectedId = get(selectedCharID);
  let group = characterStore.characters[selectedId];
  if (group && group.type === "group") {
    const res = await alertSelectChar();
    if (res) {
      if (group.characters.includes(res)) {
        alertError(language.errors.alreadyCharInGroup);
      } else {
        if (await alertConfirm(language.askLoadFirstMsg)) {
          group.chats[group.chatPage].message.push({
            role: "char",
            data: findCharacterbyId(res).firstMessage,
            saying: res,
          });
        }

        group.characters.push(res);
        group.characterTalks.push((1 / 6) * 4);
        group.characterActive.push(true);
      }
    }
  }
}

export function rmCharFromGroup(index: number) {
  let selectedId = get(selectedCharID);
  let group = characterStore.characters[selectedId];
  if (group && group.type === "group") {
    group.characters.splice(index, 1);
    group.characterTalks.splice(index, 1);
    group.characterActive.splice(index, 1);
  }
}

export type GroupOrder = {
  id: string;
  talkness: number;
  index: number;
};

export function groupOrder(chars: GroupOrder[], input: string): GroupOrder[] {
  return orderGroupSpeakers(
    chars.map((char) => ({
      ...char,
      name: findCharacterbyId(char.id).name,
    })),
    input,
  ).map(({ name: _name, ...char }) => char);
}
