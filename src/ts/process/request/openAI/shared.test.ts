// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { getLocalNetworkRequestOptions } from "./shared";

describe("local network request ownership", () => {
  beforeEach(() => {
    settingsStore.init({}, null);
    settingsStore.releasePresetOwnedState();
    presetStore.resetForTesting();
    presetStore.state.localNetworkMode = true;
    presetStore.state.localNetworkTimeoutSec = 12;
  });
  afterEach(() => {
    settingsStore.dispose();
    presetStore.resetForTesting();
  });

  it("reads the active preset using the real guarded stores", () => {
    expect(
      getLocalNetworkRequestOptions(
        "http://192.168.1.2:8080/v1",
        undefined,
        true,
      ),
    ).toEqual({ networkRoute: "local_network", requestTimeoutMs: 12000 });
    presetStore.state.localNetworkTimeoutSec = 30;
    expect(
      getLocalNetworkRequestOptions(
        "http://localhost:8080/v1",
        undefined,
        true,
      ),
    ).toEqual({ networkRoute: "local_network", requestTimeoutMs: 30000 });
  });

  it("keeps external and disabled requests on the normal route", () => {
    expect(getLocalNetworkRequestOptions("https://api.openai.com/v1")).toEqual(
      {},
    );
    presetStore.state.localNetworkMode = false;
    expect(getLocalNetworkRequestOptions("http://localhost:8080/v1")).toEqual(
      {},
    );
  });

  it("uses the timeout fallback only for streaming local requests", () => {
    presetStore.state.localNetworkTimeoutSec = NaN;
    expect(
      getLocalNetworkRequestOptions("http://localhost", undefined, true),
    ).toEqual({ networkRoute: "local_network", requestTimeoutMs: 600000 });
    expect(getLocalNetworkRequestOptions("http://localhost")).toEqual({
      networkRoute: "local_network",
      requestTimeoutMs: undefined,
    });
  });
});
