import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { Chat, Message } from "src/ts/storage/database/schema";
import type { SqlChatBranchGraphData } from "src/ts/storage/sql/ISqlStorage";
import BranchGraphModalHarness from "./fixtures/BranchGraphModalHarness.svelte";

let mounted:
  | {
      app: { setBranchGraph(graph: SqlChatBranchGraphData | null): void };
      target: HTMLElement;
    }
  | undefined;

function message(chatId: string, role: "user" | "char", data: string): Message {
  return { chatId, role, data } as Message;
}

function linearChat(): Chat {
  return {
    id: "chat-1",
    message: [message("m1", "user", "hello"), message("m3", "char", "reroll")],
  } as Chat;
}

function persistentGraph(): SqlChatBranchGraphData {
  return {
    branches: [
      {
        id: "root",
        chatId: "chat-1",
        headMessageId: "m2",
        reason: "root",
        createdAt: 0,
      },
      {
        id: "reroll",
        chatId: "chat-1",
        parentBranchId: "root",
        forkMessageId: "m1",
        headMessageId: "m3",
        reason: "reroll",
        createdAt: 1,
      },
    ],
    activeBranchId: "reroll",
    messages: [
      message("m1", "user", "hello"),
      message("m2", "char", "original"),
      message("m3", "char", "reroll"),
    ],
    links: [
      { messageId: "m1", originBranchId: "root" },
      { messageId: "m2", parentMessageId: "m1", originBranchId: "root" },
      { messageId: "m3", parentMessageId: "m1", originBranchId: "reroll" },
    ],
  };
}

describe("BranchGraphModal persistent branch hydration", () => {
  afterEach(async () => {
    if (!mounted) return;
    await unmount(mounted.app as never);
    mounted.target.remove();
    mounted = undefined;
  });

  it("rebuilds the graph when the persistent SQL graph arrives asynchronously", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const app = mount(BranchGraphModalHarness, {
      target,
      props: { initialChat: linearChat() },
    }) as unknown as {
      setBranchGraph(graph: SqlChatBranchGraphData | null): void;
    };
    mounted = { app, target };

    expect(target.querySelectorAll(".branch-node")).toHaveLength(2);
    expect(target.querySelectorAll(".branch-node--fork")).toHaveLength(0);

    app.setBranchGraph(persistentGraph());
    flushSync();

    expect(target.querySelectorAll(".branch-node")).toHaveLength(3);
    expect(target.querySelectorAll(".branch-node--fork")).toHaveLength(1);
    expect(target.querySelectorAll(".branch-junction").length).toBeGreaterThan(
      0,
    );
  });
});
