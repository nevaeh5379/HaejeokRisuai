import {
  resolveOllamaCloudTransportUrl,
  type OllamaCloudTransportApi,
} from "@risuai/chat-core/ollamaProvider.cjs";
import { LLMFormat } from "../../model/modellist";

export function shouldUseNodeOllamaCloudTransport(options: {
  isCloud: boolean;
  requestFormat: LLMFormat;
  useStreaming?: boolean;
}): boolean {
  return (
    options.isCloud &&
    options.requestFormat === LLMFormat.Ollama &&
    !options.useStreaming
  );
}

export function matchesNodeOllamaCloudEndpoint(options: {
  requestURL: string;
  format: LLMFormat;
  api: Exclude<OllamaCloudTransportApi, "native">;
}): boolean {
  return (
    options.format === LLMFormat.Ollama &&
    options.requestURL === resolveOllamaCloudTransportUrl(options.api)
  );
}
