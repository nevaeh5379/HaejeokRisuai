import { getCurrentCharacter } from "../../storage/database.svelte";
import type { RequestDataArgumentExtended } from "./requestContracts";

export function resolveRequestCharacter(arg: RequestDataArgumentExtended) {
  return arg.currentChar ?? getCurrentCharacter();
}
