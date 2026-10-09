import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import {
  STABLE_HORDE_TEXT_ASYNC_URL,
  buildStableHordeStatusUrl,
} from "@risuai/chat-core/hordeProvider.ts";
import { LLMFormat } from "../../model/modellist";

import { sleep } from "../../util";
import { unstringlizeChat } from "../stringlize";
import { applyChatTemplate } from "../templates/chatTemplate";
import { resolveRequestCharacter } from "./requestContext";
import type {
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";
import { tryExecuteNodeProvider } from "./nodeProviderExecutor";
import { applyAdditionalParameters, getAdditionalParameters } from "./shared";

/**
 * Builds a Horde text request and either previews it or executes/polls the generation task.
 *
 * 한국어: Horde 텍스트 요청을 구성하고 요청 미리보기 또는 생성 작업 실행·결과 조회를 처리하는 함수.
 *
 * @param arg - Provider arguments including chat template and preview selection. / 채팅 템플릿·미리보기 선택을 포함한 제공자 인자.
 * @remarks
 * Preview returns the final asynchronous endpoint, body and headers without submitting a task,
 * allowing the Node illustration executor to own submission and polling after client exit.
 * 한국어: 미리보기는 작업을 접수하지 않고 최종 비동기 요청 주소·본문·헤더를 반환.
 * Node 삽화 실행기가 클라이언트 종료 후에도 접수·결과 조회를 소유하도록 연결.
 */
export async function requestHorde(
  arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
  const formated = arg.formated;
  const db = settingsStore.state;
  const aiModel = arg.aiModel;
  const currentChar = resolveRequestCharacter(arg);
  const abortSignal = arg.abortSignal;

  const prompt = applyChatTemplate(formated, {
    currentChar,
    chatTarget: arg.triggerTarget,
  });

  const realModel = aiModel.split(":::")[1];

  const argument = {
    prompt: prompt,
    params: {
      n: 1,
      max_context_length: presetStore.state.maxContext + 100,
      max_length: presetStore.state.maxResponse,
      singleline: false,
      temperature: presetStore.state.temperature / 100,
      top_k: presetStore.state.top_k,
      top_p: presetStore.state.top_p,
    },
    trusted_workers: false,
    workerslow_workers: true,
    _blacklist: false,
    dry_run: false,
    models: [realModel, realModel.trim(), " " + realModel, realModel + " "],
  };

  if (realModel === "auto") {
    delete argument.models;
  }

  let apiKey = "0000000000";
  if (db.hordeConfig.apiKey.length > 2) {
    apiKey = db.hordeConfig.apiKey;
  }

  let headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: apiKey,
  };

  let finalBody = applyAdditionalParameters(
    argument,
    headers,
    getAdditionalParameters(arg.aiModel),
  );

  if (arg.previewBody)
    return {
      type: "success",
      result: JSON.stringify({
        url: STABLE_HORDE_TEXT_ASYNC_URL,
        body: finalBody,
        headers,
      }),
    };

  const remote = await tryExecuteNodeProvider(
    LLMFormat.Horde,
    {
      body: finalBody,
      headers,
    },
    abortSignal,
  );
  if (remote) {
    if (remote.type !== "success") return remote;
    return {
      ...remote,
      result: unstringlizeChat(
        remote.result,
        formated,
        currentChar?.name ?? "",
        arg.triggerTarget,
      ),
    };
  }

  const da = await fetch(STABLE_HORDE_TEXT_ASYNC_URL, {
    body: JSON.stringify(finalBody),
    method: "POST",
    headers: headers,
    signal: abortSignal,
  });

  if (da.status !== 202) {
    return {
      type: "fail",
      result: await da.text(),
    };
  }

  const json: {
    id: string;
    kudos: number;
    message: string;
  } = await da.json();

  let warnMessage = "";
  if (json.message) {
    warnMessage = "with " + json.message;
  }
  const statusUrl = buildStableHordeStatusUrl(json.id);
  if (!statusUrl) {
    return {
      type: "fail",
      result: "Invalid Horde generation id",
      noRetry: true,
    };
  }

  try {
    while (true) {
      await sleep(2000);
      abortSignal?.throwIfAborted?.();
      const data = await (
        await fetch(statusUrl, { signal: abortSignal })
      ).json();
      if (!data.is_possible) {
        fetch(statusUrl, {
          method: "DELETE",
        });
        return {
          type: "fail",
          result: "Response not possible" + warnMessage,
          noRetry: true,
        };
      }
      if (
        data.done &&
        Array.isArray(data.generations) &&
        data.generations.length > 0
      ) {
        const generations: { text: string }[] = data.generations;
        if (generations && generations.length > 0) {
          return {
            type: "success",
            result: unstringlizeChat(
              generations[0].text ?? "",
              formated,
              currentChar?.name ?? "",
              arg.triggerTarget,
            ),
          };
        }
        return {
          type: "fail",
          result: "No Generations when done",
          noRetry: true,
        };
      }
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      try {
        await fetch(statusUrl, { method: "DELETE" });
      } catch {}
    }
    throw error;
  }
}
