import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { LLMFormat } from "../../model/modellist";

import { sleep } from "../../util";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProvider } from "./nodeProviderExecutor";

/**
 * Returns the configured Echo message after its delay, or previews a server-executable Echo request.
 *
 * 한국어: 설정된 지연 후 Echo 메시지를 반환하거나 서버에서 실행할 Echo 요청을 미리 구성하는 함수.
 *
 * @param arg - Provider arguments; previewBody selects preparation without execution. / 제공자 인자, previewBody이면 실행 없이 요청 준비.
 * @returns Chat response or serialized URL/headers/body for the Node illustration worker. / 채팅 응답 또는 Node 삽화 작업용 URL·헤더·본문의 직렬화 결과.
 */
export async function requestEcho(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const db = settingsStore.state;
  const delay = db.echoDelay ?? 0;
  const message = db.echoMessage ?? "Echo Message";
  if (arg.previewBody)
    return {
      type: "success",
      result: JSON.stringify({
        url: "risu:echo",
        headers: {},
        body: { message, delayMs: Math.max(0, Math.round(delay * 1000)) },
      }),
    };
  const remote = await tryExecuteNodeProvider(
    arg.modelInfo?.format ?? LLMFormat.Echo,
    {
      message,
      delayMs: Math.max(0, Math.round(delay * 1000)),
    },
  );
  if (remote) return remote;

  if (delay > 0) {
    await sleep(delay * 1000);
  }

  return {
    type: "success",
    result: message,
  };
}
