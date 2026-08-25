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
