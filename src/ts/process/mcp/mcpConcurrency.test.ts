import { afterEach, beforeEach, expect, test, vi } from "vitest";

const getModuleMcps = vi.hoisted(() =>
  vi.fn((character?: { name?: string }) =>
    character?.name === "Alpha" ? ["mcp:a"] : ["mcp:b"],
  ),
);

vi.mock("../modules", () => ({ getModuleMcps }));
vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { authRefreshes: [] } },
}));
vi.mock("src/ts/stores/domain/moduleStore.svelte", () => ({
  moduleStore: { installModule: vi.fn() },
}));
vi.mock("src/ts/alert", () => ({
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
}));
vi.mock("src/ts/platform", () => ({ isTauri: false }));
vi.mock("src/ts/globalApi.svelte", () => ({
  fetchNative: vi.fn(),
  openURL: vi.fn(),
}));
vi.mock("src/ts/util", () => ({ sleep: vi.fn() }));
vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({ setItem: vi.fn(), getItem: vi.fn() }),
  },
}));
vi.mock("./pluginmcp", () => ({ registeredCustomPluginMCPs: new Map() }));

import { MCPs, callMCPTool, getMCPTools } from "./mcp";

function fakeClient(label: string) {
  return {
    serverInfo: { capabilities: { tools: {} }, serverInfo: { name: label } },
    checkHandshake: vi.fn(),
    getToolList: vi.fn(async () => [
      { name: "shared_tool", description: label, inputSchema: {} },
    ]),
    callTool: vi.fn(async () => [{ type: "text", text: label }]),
    destroy: vi.fn(),
  } as any;
}

const clientA = fakeClient("A");
const clientB = fakeClient("B");
const callOnly = fakeClient("call-only");

beforeEach(() => {
  MCPs["mcp:a"] = clientA;
  MCPs["mcp:b"] = clientB;
  MCPs["internal:risuai"] = callOnly;
  vi.clearAllMocks();
});

afterEach(() => {
  delete MCPs["mcp:a"];
  delete MCPs["mcp:b"];
  delete MCPs["internal:risuai"];
});

test("exposes only the MCP tools selected for each character", async () => {
  const alpha = await getMCPTools(undefined, { name: "Alpha" } as never);
  const beta = await getMCPTools(undefined, { name: "Beta" } as never);

  expect(alpha.map((tool) => [tool.mcpURL, tool.description])).toEqual([
    ["mcp:a", "A"],
  ]);
  expect(beta.map((tool) => [tool.mcpURL, tool.description])).toEqual([
    ["mcp:b", "B"],
  ]);
  expect(clientA.destroy).not.toHaveBeenCalled();
  expect(clientB.destroy).not.toHaveBeenCalled();
});

test("routes duplicate tool names to the MCP selected by the request", async () => {
  await expect(callMCPTool("shared_tool", {}, "mcp:a")).resolves.toEqual([
    { type: "text", text: "A" },
  ]);
  await expect(callMCPTool("shared_tool", {}, "mcp:b")).resolves.toEqual([
    { type: "text", text: "B" },
  ]);

  expect(clientA.callTool).toHaveBeenCalledWith("shared_tool", {}, undefined);
  expect(clientB.callTool).toHaveBeenCalledWith("shared_tool", {}, undefined);
});
