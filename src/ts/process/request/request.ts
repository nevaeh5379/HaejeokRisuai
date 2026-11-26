import { formatProviderMessages } from "@risuai/chat-core/providerPrompt.ts";
import { executeBrowserProvider } from "./browserProviderRegistry";
import { prepareBrowserProviderContext } from "./providerContextAdapter";
import { notifyModelRequest, trackModelResponse } from "./modelRequestNotices";
import { getRequestModelLabel } from "../models/modelString";
import type { ModelModeExtended } from "./shared";

export type {
  ToolCall,
  requestDataArgument,
  RequestDataArgumentExtended,
  requestDataResponse,
  StreamResponseChunk,
} from "./requestContracts";
import type {
  requestDataArgument,
  RequestDataArgumentExtended,
  requestDataResponse,
} from "./requestContracts";

export async function requestChatDataMain(
  arg: requestDataArgument,
  model: ModelModeExtended,
  abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
  const { prepared, messageFormatting } = prepareBrowserProviderContext(
    arg,
    model,
  );
  const targ: RequestDataArgumentExtended = arg;

  if (prepared.pluginBlocked) {
    return {
      type: "fail",
      result: "Plugin calls are blocked by the caller.",
    };
  }

  Object.assign(targ, prepared);
  targ.formated = safeStructuredClone(arg.formated);
  targ.bias = arg.bias;
  targ.currentChar = arg.currentChar;
  targ.abortSignal = abortSignal;
  targ.mode = model;

  const format = targ.modelInfo.format;

  targ.formated = formatProviderMessages(
    targ.formated,
    targ.modelInfo.flags,
    messageFormatting,
  );

  if (targ.previewBody) return executeBrowserProvider(format, targ);
  const label =
    targ.aiModel === "reverse_proxy" && targ.modelInfo.internalID
      ? targ.modelInfo.internalID
      : getRequestModelLabel(targ.aiModel, targ.modelInfo.name);
  const finish = notifyModelRequest(label, model);
  return trackModelResponse(executeBrowserProvider(format, targ), finish);
}
