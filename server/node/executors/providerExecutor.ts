"use strict";

import {
  canExecuteProviderRoute,
  executeProviderRoute,
} from "../../../packages/chat-core/providerExecutor.ts";
import { resolveProviderRoute } from "../../../packages/chat-core/providerRouting.ts";
import {
  DEFAULT_MISTRAL_API_URL,
  decodeMistralResponse,
} from "../../../packages/chat-core/mistralProvider.ts";
import {
  DEFAULT_OPENAI_CHAT_COMPLETIONS_URL,
  DEFAULT_OPENAI_RESPONSES_URL,
  DEFAULT_OPENAI_COMPLETIONS_URL,
} from "../../../packages/chat-core/openAIProvider.ts";
import { DEFAULT_ANTHROPIC_MESSAGES_URL } from "../../../packages/chat-core/anthropicProvider.ts";
import { buildGoogleGenerateContentUrl } from "../../../packages/chat-core/googleProvider.ts";
import { DEFAULT_COHERE_CHAT_URL } from "../../../packages/chat-core/cohereProvider.ts";
import { resolveNovelAIGenerateUrl } from "../../../packages/chat-core/novelAIProvider.ts";
import { DEFAULT_NOVELLIST_API_URL } from "../../../packages/chat-core/novelListProvider.ts";
import { resolveNanoGPTTransportUrl } from "../../../packages/chat-core/nanoGPTProvider.ts";
import { resolveOllamaCloudTransportUrl } from "../../../packages/chat-core/ollamaProvider.ts";
import {
  STABLE_HORDE_TEXT_ASYNC_URL,
  buildStableHordeStatusUrl,
} from "../../../packages/chat-core/hordeProvider.ts";
import { LLM_FORMATS } from "../../../packages/protocol/modelFormat.ts";
import {
  normalizeNodeProviderExecutionRequest,
  normalizeNodeProviderTransportRequest,
} from "../../../packages/protocol/providerExecution.ts";

function normalizeEchoPayload(payload?: any): any {
  if (typeof payload.message !== "string") {
    throw new TypeError("echo message must be a string");
  }
  const delayMs: any = payload.delayMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 3_600_000) {
    throw new RangeError("echo delayMs must be an integer from 0 to 3600000");
  }
  return { message: payload.message, delayMs };
}

function normalizeMistralPayload(payload?: any): any {
  if (
    !payload.body ||
    typeof payload.body !== "object" ||
    Array.isArray(payload.body)
  ) {
    throw new TypeError("mistral body must be an object");
  }
  if (typeof payload.apiKey !== "string" || payload.apiKey.length > 16_384) {
    throw new TypeError(
      "mistral apiKey must be a string up to 16384 characters",
    );
  }
  const httpErrorPrefix: any = payload.httpErrorPrefix ?? "";
  if (typeof httpErrorPrefix !== "string" || httpErrorPrefix.length > 4096) {
    throw new TypeError(
      "mistral httpErrorPrefix must be a string up to 4096 characters",
    );
  }
  const body: any = JSON.stringify(payload.body);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new RangeError("mistral body exceeds 16 MiB");
  }
  return { body, apiKey: payload.apiKey, httpErrorPrefix };
}

function normalizeJsonTransportPayload(payload?: any, providerName?: any): any {
  if (
    !payload.body ||
    typeof payload.body !== "object" ||
    Array.isArray(payload.body)
  ) {
    throw new TypeError(`${providerName} body must be an object`);
  }
  if (
    !payload.headers ||
    typeof payload.headers !== "object" ||
    Array.isArray(payload.headers)
  ) {
    throw new TypeError(`${providerName} headers must be an object`);
  }
  const headers: any = {};
  const forbiddenHeaders: any = new Set([
    "host",
    "connection",
    "content-length",
    "risu-auth",
    "anthropic-dangerous-direct-browser-access",
  ]);
  for (const [key, value] of Object.entries(payload.headers)) {
    if (typeof value !== "string") {
      throw new TypeError(`${providerName} headers must contain string values`);
    }
    if (forbiddenHeaders.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const body: any = JSON.stringify(payload.body);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
    throw new RangeError(`${providerName} body exceeds 16 MiB`);
  }
  return { body, headers };
}

function normalizeGoogleTransportPayload(payload?: any): any {
  const normalized: any = normalizeJsonTransportPayload(payload, "google");
  if (
    typeof payload.modelId !== "string" ||
    payload.modelId.length === 0 ||
    payload.modelId.length > 256 ||
    !/^[A-Za-z0-9._-]+$/.test(payload.modelId)
  ) {
    throw new TypeError(
      "google modelId must be a safe model identifier up to 256 characters",
    );
  }
  if (typeof payload.apiKey !== "string" || payload.apiKey.length > 16_384) {
    throw new TypeError(
      "google apiKey must be a string up to 16384 characters",
    );
  }
  return { ...normalized, modelId: payload.modelId, apiKey: payload.apiKey };
}

function normalizeNovelAITransportPayload(payload?: any): any {
  const normalized: any = normalizeJsonTransportPayload(payload, "novelai");
  if (payload.variant !== "kayra" && payload.variant !== "clio") {
    throw new TypeError("novelai variant must be kayra or clio");
  }
  return { ...normalized, variant: payload.variant };
}

function normalizeNanoGPTTransportPayload(payload?: any): any {
  const normalized: any = normalizeJsonTransportPayload(payload, "nanogpt");
  if (payload.api !== "chat" && payload.api !== "responses") {
    throw new TypeError("nanogpt api must be chat or responses");
  }
  if (typeof payload.subscription !== "boolean") {
    throw new TypeError("nanogpt subscription must be a boolean");
  }
  return {
    ...normalized,
    api: payload.api,
    subscription: payload.subscription,
  };
}

function normalizeOllamaTransportPayload(payload?: any): any {
  const normalized: any = normalizeJsonTransportPayload(
    payload,
    "ollama cloud",
  );
  if (
    !["native", "openai-chat", "responses", "anthropic"].includes(payload.api)
  ) {
    throw new TypeError(
      "ollama cloud api must be native, openai-chat, responses, or anthropic",
    );
  }
  return { ...normalized, api: payload.api };
}

function getTransportTarget(format?: any): any {
  if (format === LLM_FORMATS.OpenAICompatible) {
    return { name: "openai", url: DEFAULT_OPENAI_CHAT_COMPLETIONS_URL };
  }
  if (format === LLM_FORMATS.OpenAIResponseAPI) {
    return { name: "openai responses", url: DEFAULT_OPENAI_RESPONSES_URL };
  }
  if (format === LLM_FORMATS.OpenAILegacyInstruct) {
    return { name: "openai completions", url: DEFAULT_OPENAI_COMPLETIONS_URL };
  }
  if (format === LLM_FORMATS.Anthropic) {
    return { name: "anthropic", url: DEFAULT_ANTHROPIC_MESSAGES_URL };
  }
  if (format === LLM_FORMATS.Cohere) {
    return { name: "cohere", url: DEFAULT_COHERE_CHAT_URL };
  }
  if (format === LLM_FORMATS.NovelList) {
    return { name: "novellist", url: DEFAULT_NOVELLIST_API_URL };
  }
  return null;
}

function createNodeProviderExecutor({
  sleep = (delayMs?: any) =>
    new Promise((resolve?: any) => setTimeout(resolve, delayMs)),
  fetchImpl = globalThis.fetch,
  extraHandlers = {},
  extraFormats = [],
}: any = {}): any {
  const handlers: any = {
    echo: async (payload?: any) => {
      const input: any = normalizeEchoPayload(payload);
      if (input.delayMs > 0) await sleep(input.delayMs);
      return { type: "success", result: input.message };
    },
    openai: async (payload?: any, context?: any) => {
      const input: any = normalizeMistralPayload(payload);
      const response: any = await fetchImpl(DEFAULT_MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        body: input.body,
        signal: context?.signal,
        redirect: "error",
      });
      const data: any = await response.json();
      return decodeMistralResponse(response.ok, data, input.httpErrorPrefix);
    },
    horde: async (payload?: any, context?: any) => {
      const input: any = normalizeJsonTransportPayload(payload, "stable horde");
      const submission: any = await fetchImpl(STABLE_HORDE_TEXT_ASYNC_URL, {
        method: "POST",
        headers: input.headers,
        body: input.body,
        signal: context?.signal,
        redirect: "error",
      });
      const submissionText: any = await submission.text();
      if (submission.status !== 202) {
        return { type: "fail", result: submissionText };
      }
      let job: any;
      try {
        job = JSON.parse(submissionText);
      } catch {
        return {
          type: "fail",
          result: submissionText || "Invalid Horde response",
        };
      }
      const statusUrl: any = buildStableHordeStatusUrl(job?.id);
      if (!statusUrl) {
        return {
          type: "fail",
          result: "Invalid Horde generation id",
          noRetry: true,
        };
      }
      const warning: any = job?.message ? `with ${job.message}` : "";
      const cancel: any = async () => {
        try {
          await fetchImpl(statusUrl, { method: "DELETE", redirect: "error" });
        } catch {}
      };
      try {
        while (true) {
          context?.signal?.throwIfAborted?.();
          await sleep(2000);
          context?.signal?.throwIfAborted?.();
          const statusResponse: any = await fetchImpl(statusUrl, {
            signal: context?.signal,
            redirect: "error",
          });
          const statusText: any = await statusResponse.text();
          let data: any;
          try {
            data = JSON.parse(statusText);
          } catch {
            return {
              type: "fail",
              result: statusText || "Invalid Horde status response",
            };
          }
          if (!statusResponse.ok) {
            return { type: "fail", result: statusText };
          }
          if (!data.is_possible) {
            await cancel();
            return {
              type: "fail",
              result: `Response not possible${warning}`,
              noRetry: true,
            };
          }
          if (data.done && Array.isArray(data.generations)) {
            if (data.generations.length === 0) {
              return {
                type: "fail",
                result: "No Generations when done",
                noRetry: true,
              };
            }
            return { type: "success", result: data.generations[0]?.text ?? "" };
          }
        }
      } catch (error: any) {
        if (context?.signal?.aborted) await cancel();
        throw error;
      }
    },
    ...extraHandlers,
  };
  const formats: any = Object.freeze([
    LLM_FORMATS.Echo,
    LLM_FORMATS.Mistral,
    LLM_FORMATS.Horde,
    ...extraFormats,
  ]);
  const supportedFormats: any = new Set(formats);
  const routes: any = Object.freeze([
    ...new Set(formats.map(resolveProviderRoute).filter(Boolean)),
  ]);
  const transportFormats: any = Object.freeze([
    LLM_FORMATS.OpenAICompatible,
    LLM_FORMATS.OpenAIResponseAPI,
    LLM_FORMATS.OpenAILegacyInstruct,
    LLM_FORMATS.Anthropic,
    LLM_FORMATS.GoogleCloud,
    LLM_FORMATS.Cohere,
    LLM_FORMATS.NovelAI,
    LLM_FORMATS.NovelList,
    LLM_FORMATS.NanoGPT,
    LLM_FORMATS.Ollama,
  ]);
  const supportedTransportFormats: any = new Set(transportFormats);

  function supports(format?: any): any {
    return (
      supportedFormats.has(format) && canExecuteProviderRoute(format, handlers)
    );
  }

  function supportsTransport(format?: any): any {
    return supportedTransportFormats.has(format);
  }

  async function execute(rawInput?: any, context: any = {}): Promise<any> {
    const normalized: any = normalizeNodeProviderExecutionRequest(rawInput);
    if (normalized.error) {
      const error: any = new TypeError(normalized.error);
      error.code = "invalid_provider_execution";
      throw error;
    }
    const input: any = normalized.value;
    if (!supports(input.format)) return { handled: false };
    return {
      handled: true,
      response: await executeProviderRoute(
        input.format,
        input.payload,
        handlers,
        { context },
      ),
    };
  }

  async function executeTransport(
    rawInput?: any,
    context: any = {},
  ): Promise<any> {
    const normalized: any = normalizeNodeProviderTransportRequest(rawInput);
    if (normalized.error) {
      const error: any = new TypeError(normalized.error);
      error.code = "invalid_provider_transport";
      throw error;
    }
    const input: any = normalized.value;
    if (!supportsTransport(input.format)) return { handled: false };
    let target: any;
    let payload: any;
    if (input.format === LLM_FORMATS.GoogleCloud) {
      payload = normalizeGoogleTransportPayload(input.payload);
      target = {
        name: "google",
        url: buildGoogleGenerateContentUrl(payload.modelId, payload.apiKey),
      };
    } else if (input.format === LLM_FORMATS.NovelAI) {
      payload = normalizeNovelAITransportPayload(input.payload);
      target = {
        name: "novelai",
        url: resolveNovelAIGenerateUrl(payload.variant),
      };
    } else if (input.format === LLM_FORMATS.NanoGPT) {
      payload = normalizeNanoGPTTransportPayload(input.payload);
      target = {
        name: "nanogpt",
        url: resolveNanoGPTTransportUrl(payload.api, payload.subscription),
      };
    } else if (input.format === LLM_FORMATS.Ollama) {
      payload = normalizeOllamaTransportPayload(input.payload);
      target = {
        name: "ollama cloud",
        url: resolveOllamaCloudTransportUrl(payload.api),
      };
    } else {
      target = getTransportTarget(input.format);
      if (!target) return { handled: false };
      payload = normalizeJsonTransportPayload(input.payload, target.name);
    }
    if (!target?.url) return { handled: false };
    const response: any = await fetchImpl(target.url, {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
      signal: context?.signal,
      redirect: "error",
    });
    const text: any = await response.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      handled: true,
      response: { ok: response.ok, status: response.status, data },
    };
  }

  function registerRoutes(app?: any, { auth, limiter }: any = {}): any {
    const guards: any = limiter ? [limiter] : [];
    app.get(
      "/api/chat-executor/providers",
      ...guards,
      async (req?: any, res?: any) => {
        if (auth && !(await auth(req, res))) return;
        res.send({ formats, routes, transportFormats });
      },
    );

    app.post(
      "/api/chat-executor/provider",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        const controller: any = new AbortController();
        const abort: any = () => controller.abort();
        const abortOnClose: any = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.once("aborted", abort);
        res.once("close", abortOnClose);
        try {
          res.send(await execute(req.body, { signal: controller.signal }));
        } catch (error: any) {
          if (
            error?.code === "invalid_provider_execution" ||
            error instanceof TypeError ||
            error instanceof RangeError
          ) {
            res.status(400).send({ error: error.message });
            return;
          }
          if (error?.name === "AbortError" && controller.signal.aborted) return;
          next(error);
        } finally {
          req.off("aborted", abort);
          res.off("close", abortOnClose);
        }
      },
    );

    app.post(
      "/api/chat-executor/transport",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        const controller: any = new AbortController();
        const abort: any = () => controller.abort();
        const abortOnClose: any = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.once("aborted", abort);
        res.once("close", abortOnClose);
        try {
          res.send(
            await executeTransport(req.body, { signal: controller.signal }),
          );
        } catch (error: any) {
          if (
            error?.code === "invalid_provider_transport" ||
            error instanceof TypeError ||
            error instanceof RangeError
          ) {
            res.status(400).send({ error: error.message });
            return;
          }
          if (error?.name === "AbortError" && controller.signal.aborted) return;
          next(error);
        } finally {
          req.off("aborted", abort);
          res.off("close", abortOnClose);
        }
      },
    );
  }

  return {
    formats,
    routes,
    transportFormats,
    supports,
    supportsTransport,
    execute,
    executeTransport,
    registerRoutes,
    resolveRoute: resolveProviderRoute,
  };
}

export { createNodeProviderExecutor };
