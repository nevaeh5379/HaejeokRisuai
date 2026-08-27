import { getCurrentCharacter } from "../../storage/database.svelte";
import type { RequestDataArgumentExtended } from "./requestContracts";

export function resolveRequestCharacter(arg: RequestDataArgumentExtended) {
  return arg.currentChar ?? getCurrentCharacter();
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
