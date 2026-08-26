import { LLMFormat } from "../../model/modellist";
import { getDatabase } from "../../storage/database.svelte";
import { sleep } from "../../util";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProvider } from "./nodeProviderExecutor";

export async function requestEcho(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = getDatabase();
  const delay = db.echoDelay ?? 0;
  const message = db.echoMessage ?? "Echo Message";
  const remote = await tryExecuteNodeProvider(arg.modelInfo?.format ?? LLMFormat.Echo, {
    message,
    delayMs: Math.max(0, Math.round(delay * 1000)),
  });
  if (remote) return remote;

  if (delay > 0) {
    await sleep(delay * 1000);
  }

  return {
    type: "success",
    result: message,
  };
}

