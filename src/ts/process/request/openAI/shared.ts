import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import type { PresetState } from "src/ts/stores/domain/stateOwnership";

import { isLocalNetworkUrl } from "src/ts/network/localNetwork";

export interface LocalNetworkRequestOptions {
  networkRoute?: "auto" | "local_network";
  requestTimeoutMs?: number;
}

export function getLocalNetworkRequestOptions(
  url: string,
  db: Pick<PresetState, "localNetworkMode" | "localNetworkTimeoutSec"> = presetStore.state,
  useStreaming = false,
): LocalNetworkRequestOptions {
  if (!db.localNetworkMode || !isLocalNetworkUrl(url)) {
    return {};
  }

  const timeoutSec =
    Number.isFinite(db.localNetworkTimeoutSec) && db.localNetworkTimeoutSec > 0
      ? db.localNetworkTimeoutSec
      : 600;

  return {
    networkRoute: "local_network",
    requestTimeoutMs: useStreaming
      ? Math.max(1, Math.floor(timeoutSec * 1000))
      : undefined,
  };
}
