import type { ChatFailureResponse, ChatSuccessResponse } from "@risuai/chat-core/types.cjs";
import { resolveProviderRoute } from "@risuai/chat-core/providerRouting.cjs";
import { forageStorage } from "../../globalApi.svelte";
import { isNodeServer } from "../../platform";
import { NodeStorage } from "../../storage/nodeStorage";

export async function tryExecuteNodeProvider(
  format: number,
  payload: Record<string, unknown>,
): Promise<ChatSuccessResponse | ChatFailureResponse | null> {
  if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
    return null;
  }

  const route = resolveProviderRoute(format);
  if (!route) return null;
  const storage = forageStorage.realStorage;

  try {
    const capabilities = await storage.getNodeProviderCapabilities();
    if (!capabilities.routes.includes(route)) return null;
    const result = await storage.executeChatProvider({ format, payload });
    return result.handled ? result.response : null;
  } catch (error) {
    console.warn(
      "Server provider execution failed; falling back to browser provider",
      error,
    );
    return null;
  }
}
