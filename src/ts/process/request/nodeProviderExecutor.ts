import type {
  ChatFailureResponse,
  ChatSuccessResponse,
} from "@risuai/chat-core/types.cjs";
import { resolveProviderRoute } from "@risuai/chat-core/providerRouting.cjs";
import type { NodeProviderTransportResult } from "../../../../packages/protocol/providerExecution.cjs";
import { forageStorage } from "../../globalApi.svelte";
import { isNodeServer } from "../../platform";
import { NodeStorage } from "../../storage/files/nodeStorage";

export async function tryExecuteNodeProvider(
  format: number,
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal | null,
): Promise<ChatSuccessResponse | ChatFailureResponse | null> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return null;
  }

  const route = resolveProviderRoute(format);
  if (!route) return null;
  const storage = forageStorage.realStorage;

  try {
    const capabilities = await storage.getNodeProviderCapabilities(abortSignal);
    if (
      !capabilities.formats.includes(format) ||
      !capabilities.routes.includes(route)
    ) {
      return null;
    }
    const result = await storage.executeChatProvider(
      { format, payload },
      abortSignal,
    );
    return result.handled ? result.response : null;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn(
      "Server provider execution failed; falling back to browser provider",
      error,
    );
    return null;
  }
}

export type NodeProviderTransportResponse = Extract<
  NodeProviderTransportResult,
  { handled: true }
>["response"];

export async function tryExecuteNodeProviderTransport(
  format: number,
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal | null,
): Promise<NodeProviderTransportResponse | null> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return null;
  }
  const storage = forageStorage.realStorage;
  try {
    const capabilities = await storage.getNodeProviderCapabilities(abortSignal);
    if (!capabilities.transportFormats?.includes(format)) return null;
    const result = await storage.executeChatProviderTransport(
      { format, payload },
      abortSignal,
    );
    return result.handled ? result.response : null;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn(
      "Server provider transport failed; falling back to browser transport",
      error,
    );
    return null;
  }
}
