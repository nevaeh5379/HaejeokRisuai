import { characterStore } from "src/ts/stores/domain/characterStore.svelte";

import type { RequestDataArgumentExtended } from "./requestContracts";

export function resolveRequestCharacter(arg: RequestDataArgumentExtended) {
  return arg.currentChar ?? characterStore.currentCharacter;
}

export function resolveRequestParserContext(arg: RequestDataArgumentExtended) {
  return {
    chara: resolveRequestCharacter(arg),
    chatTarget: arg.triggerTarget,
  };
}

export function resolveRequestToolContext(arg: RequestDataArgumentExtended) {
  return {
    currentChar: arg.currentChar,
    chatTarget: arg.triggerTarget,
  };
}
