import { describe, expect, it } from "vitest";

import {
  buildChatGraphGitRows,
  buildChatGraphPackedLanes,
  buildChatMessageGraph,
  getChatBranches,
  getChatBranchesFromPersistentGraph,
  type ChatGraphTimeline,
} from "./branches";
import type { Chat, Message } from "../storage/database/schema";

function message(chatId: string, role: Message["role"], data: string): Message {
  return { chatId, role, data };
}

function timeline(
  branchId: string,
  messages: Message[],
  active = false,
): ChatGraphTimeline {
  return {
    branchId,
    messages,
    active,
    reason: branchId === "root" ? "root" : "reroll",
  };
}

describe("buildChatMessageGraph", () => {
  it("shows every shared and alternative message exactly once", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "first answer");
    const u2 = message("u2", "user", "continue");
    const original = message("a2", "char", "original answer");
    const reroll = message("a2-alt", "char", "alternative answer");

    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2, original]),
      timeline("reroll", [u1, a1, u2, reroll], true),
    ]);

    expect(graph.nodes).toHaveLength(5);
    expect(graph.timelineCount).toBe(2);
    expect(graph.nodes.map((node) => node.preview)).toEqual([
      "hello",
      "first answer",
      "continue",
      "original answer",
      "alternative answer",
    ]);
  });

  it("places alternative responses horizontally at their actual fork message", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "first answer");
    const u2 = message("u2", "user", "continue");
    const original = message("a2", "char", "original answer");
    const reroll = message("a2-alt", "char", "alternative answer");
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2, original]),
      timeline("reroll", [u1, a1, u2, reroll], true),
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:u2")!;
    const originalNode = graph.nodes.find((node) => node.id === "message:a2")!;
    const rerollNode = graph.nodes.find(
      (node) => node.id === "message:a2-alt",
    )!;
    expect(fork.branchPoint).toBe(true);
    expect(fork.continuationCount).toBe(2);
    expect(originalNode.y).toBe(rerollNode.y);
    expect(originalNode.x).not.toBe(rerollNode.x);
  });

  it("marks the complete active message path and its terminal", () => {
    const shared = message("u1", "user", "hello");
    const original = message("a1", "char", "original");
    const alternative = message("a1-alt", "char", "alternative");
    const graph = buildChatMessageGraph([
      timeline("root", [shared, original]),
      timeline("reroll", [shared, alternative], true),
    ]);

    expect(
      graph.nodes.find((node) => node.id === "message:u1")?.activePath,
    ).toBe(true);
    expect(
      graph.nodes.find((node) => node.id === "message:a1")?.activePath,
    ).toBe(false);
    expect(
      graph.nodes.find((node) => node.id === "message:a1-alt")?.activeTerminal,
    ).toBe(true);
    expect(
      graph.edges.find((edge) => edge.to === "message:a1-alt")?.active,
    ).toBe(true);
  });

  it("exposes an empty branch as a terminal on the message where it split", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "answer");
    const u2 = message("u2", "user", "continue");
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2]),
      { ...timeline("manual", [u1, a1], true), reason: "manual" },
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:a1")!;
    expect(fork.branchPoint).toBe(true);
    expect(fork.terminals).toEqual([
      { branchId: "manual", reason: "manual", active: true },
    ]);
    expect(fork.activeTerminal).toBe(true);
  });

  it("merges copied legacy messages without chat IDs beneath the same parent", () => {
    const sharedUser: Message = { role: "user", data: "hello" };
    const sharedAnswer: Message = { role: "char", data: "same answer" };
    const graph = buildChatMessageGraph([
      timeline("root", [
        sharedUser,
        sharedAnswer,
        { role: "user", data: "left" },
      ]),
      timeline(
        "reroll",
        [
          { ...sharedUser },
          { ...sharedAnswer },
          { role: "user", data: "right" },
        ],
        true,
      ),
    ]);

    expect(graph.nodes).toHaveLength(4);
    expect(
      graph.nodes.filter((node) => node.preview === "same answer"),
    ).toHaveLength(1);
    expect(
      graph.nodes.find((node) => node.preview === "same answer")?.branchPoint,
    ).toBe(true);
  });

  it("collapses a long linear stretch while preserving its endpoints and active path", () => {
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(
        `m${index}`,
        index % 2 === 0 ? "user" : "char",
        `message ${index + 1}`,
      ),
    );
    const graph = buildChatMessageGraph([timeline("root", messages, true)]);

    const summary = graph.nodes.find((node) => node.kind === "summary")!;
    expect(graph.messageCount).toBe(120);
    expect(graph.collapsedMessageCount).toBe(114);
    expect(graph.nodes).toHaveLength(7);
    expect(summary.collapsedCount).toBe(114);
    expect(summary.messageIndex).toBe(3);
    expect(summary.endMessageIndex).toBe(116);
    expect(summary.activePath).toBe(true);
    expect(
      graph.edges.filter(
        (edge) => edge.from === summary.id || edge.to === summary.id,
      ),
    ).toHaveLength(2);
    expect(
      graph.edges
        .filter((edge) => edge.from === summary.id || edge.to === summary.id)
        .every((edge) => edge.active),
    ).toBe(true);
  });

  it("keeps every message when density is all", () => {
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(
        `full-${index}`,
        index % 2 === 0 ? "user" : "char",
        `full message ${index + 1}`,
      ),
    );

    const graph = buildChatMessageGraph([timeline("root", messages, true)], {
      density: "all",
    });

    expect(graph.nodes).toHaveLength(120);
    expect(graph.collapsedMessageCount).toBe(0);
    expect(graph.nodes.every((node) => node.kind === "message")).toBe(true);
  });

  it("compresses linear runs to branch landmarks when density is branches", () => {
    const shared = Array.from({ length: 12 }, (_, index) =>
      message(
        `landmark-${index}`,
        index % 2 === 0 ? "user" : "char",
        `landmark ${index + 1}`,
      ),
    );
    const original = message("landmark-original", "char", "original ending");
    const alternative = message("landmark-alt", "char", "alternative ending");

    const graph = buildChatMessageGraph(
      [
        timeline("root", [...shared, original]),
        timeline("reroll", [...shared, alternative], true),
      ],
      { density: "branches" },
    );

    const fork = graph.nodes.find((node) => node.id === "message:landmark-11")!;
    expect(graph.nodes).toHaveLength(5);
    expect(graph.collapsedMessageCount).toBe(10);
    expect(graph.nodes.filter((node) => node.kind === "summary")).toHaveLength(
      1,
    );
    expect(fork.branchPoint).toBe(true);
    expect(
      graph.nodes.some((node) => node.id === "message:landmark-original"),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.id === "message:landmark-alt")).toBe(
      true,
    );
  });

  it("never collapses the exact fork point in a long chat", () => {
    const shared = Array.from({ length: 100 }, (_, index) =>
      message(
        `shared-${index}`,
        index % 2 === 0 ? "user" : "char",
        `shared ${index + 1}`,
      ),
    );
    const original = message("original", "char", "original ending");
    const alternative = message("alternative", "char", "alternative ending");
    const graph = buildChatMessageGraph([
      timeline("root", [...shared, original]),
      timeline("reroll", [...shared, alternative], true),
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:shared-99")!;
    const originalNode = graph.nodes.find(
      (node) => node.id === "message:original",
    )!;
    const alternativeNode = graph.nodes.find(
      (node) => node.id === "message:alternative",
    )!;
    expect(graph.collapsedMessageCount).toBeGreaterThan(0);
    expect(fork.kind).toBe("message");
    expect(fork.branchPoint).toBe(true);
    expect(originalNode.y).toBe(alternativeNode.y);
    expect(originalNode.x).not.toBe(alternativeNode.x);
  });

  it("compacts trees with repeated rerolls across turns without column explosion or diagonal drift", () => {
    // 30 turns = 60 messages in main timeline
    const mainMessages: Message[] = [];
    const timelines: ChatGraphTimeline[] = [];

    for (let turn = 0; turn < 30; turn++) {
      const userMsg = message(`u-${turn}`, "user", `user ${turn}`);
      const charMsg = message(`c-${turn}`, "char", `char ${turn}`);
      mainMessages.push(userMsg, charMsg);

      // Add rerolls at various turns
      if (turn % 3 === 1) {
        const rerollMsg = message(`c-${turn}-reroll`, "char", `char ${turn} reroll`);
        timelines.push(
          timeline(`reroll-${turn}`, [...mainMessages.slice(0, -1), rerollMsg], false)
        );
      }
    }
    timelines.unshift(timeline("root", mainMessages, true));

    const graph = buildChatMessageGraph(timelines, { density: "all" });

    // With contour packing, columns are kept compact (7 columns vs naive 11)
    expect(graph.columns).toBeLessThanOrEqual(8);

    // Verify tree fork centering: for each branch point, parent is centered between its children
    const parentNodes = graph.nodes.filter((n) => n.branchPoint);
    for (const parent of parentNodes) {
      const childEdges = graph.edges.filter((e) => e.from === parent.id);
      const childNodes = childEdges.map((e) => graph.nodes.find((n) => n.id === e.to)!);
      if (childNodes.length >= 2) {
        const minChildX = Math.min(...childNodes.map((c) => c.x));
        const maxChildX = Math.max(...childNodes.map((c) => c.x));
        expect(parent.x).toBeCloseTo((minChildX + maxChildX) / 2);
      }
    }

    // Nodes at the same depth must never share the same x
    const depthMap = new Map<number, number[]>();
    for (const node of graph.nodes) {
      const xs = depthMap.get(node.y) ?? [];
      expect(xs).not.toContain(node.x);
      xs.push(node.x);
      depthMap.set(node.y, xs);
    }
  });
});

describe("buildChatGraphPackedLanes", () => {
  it("keeps the active continuation in its current lane and packs alternatives", () => {
    const shared = message("lane-shared", "user", "shared");
    const original = message("lane-original", "char", "original");
    const activeAlternative = message(
      "lane-active",
      "char",
      "active alternative",
    );
    const graph = buildChatMessageGraph([
      timeline("root", [shared, original]),
      timeline("reroll", [shared, activeAlternative], true),
    ]);

    const lanes = buildChatGraphPackedLanes(graph, (node) => node.y);

    expect(lanes.laneByNodeId.get("message:lane-shared")).toBe(0);
    expect(lanes.laneByNodeId.get("message:lane-active")).toBe(0);
    expect(lanes.laneByNodeId.get("message:lane-original")).not.toBe(0);
    expect(lanes.columns).toBe(2);
  });

  it("reuses lanes for branches that never overlap in flow order", () => {
    const withTime = (id: string, role: Message["role"], data: string, time: number) => ({
      ...message(id, role, data),
      time,
    });
    const u1 = withTime("ru1", "user", "hello", 1);
    const a1 = withTime("ra1", "char", "first answer", 2);
    const u2 = withTime("ru2", "user", "continue", 3);
    const earlyReroll = withTime("alt-early", "char", "early reroll", 4);
    const lateReroll = withTime("alt-late", "char", "late reroll", 5);
    const original = withTime("orig", "char", "original answer", 6);
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2, original], true),
      timeline("early", [u1, a1, u2, earlyReroll]),
      timeline("late", [u1, a1, u2, lateReroll]),
    ]);

    const rows = buildChatGraphGitRows(graph);
    const lanes = buildChatGraphPackedLanes(
      graph,
      (node) => rows.rowByNodeId.get(node.id) ?? 0,
    );

    expect(lanes.columns).toBe(2);
    expect(lanes.laneByNodeId.get("message:orig")).toBe(0);
    expect(lanes.laneByNodeId.get("message:alt-early")).toBe(1);
    expect(lanes.laneByNodeId.get("message:alt-late")).toBe(1);
  });
});

describe("buildChatGraphGitRows", () => {
  it("assigns every node its own row ordered by message time", () => {
    const withTime = (id: string, role: Message["role"], data: string, time: number) => ({
      ...message(id, role, data),
      time,
    });
    const u1 = withTime("row-u1", "user", "hello", 1);
    const a1 = withTime("row-a1", "char", "first answer", 2);
    const original = withTime("row-a2", "char", "original answer", 4);
    const reroll = withTime("row-a2-alt", "char", "alternative answer", 3);
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, original]),
      timeline("reroll", [u1, a1, reroll], true),
    ]);

    const rows = buildChatGraphGitRows(graph);

    expect(rows.rowByNodeId.get("message:row-u1")).toBe(0);
    expect(rows.rowByNodeId.get("message:row-a1")).toBe(1);
    expect(rows.rowByNodeId.get("message:row-a2-alt")).toBe(2);
    expect(rows.rowByNodeId.get("message:row-a2")).toBe(3);
    expect(rows.rows).toBe(4);
  });

  it("falls back to topological order when messages have no timestamps", () => {
    const u1 = message("fb-u1", "user", "hello");
    const a1 = message("fb-a1", "char", "first answer");
    const original = message("fb-a2", "char", "original answer");
    const reroll = message("fb-a2-alt", "char", "alternative answer");
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, original]),
      timeline("reroll", [u1, a1, reroll], true),
    ]);

    const rows = buildChatGraphGitRows(graph);

    expect(rows.rowByNodeId.get("message:fb-u1")).toBe(0);
    expect(rows.rowByNodeId.get("message:fb-a1")).toBe(1);
    expect(rows.rowByNodeId.get("message:fb-a1")!).toBeLessThan(
      rows.rowByNodeId.get("message:fb-a2")!,
    );
    expect(rows.rowByNodeId.get("message:fb-a1")!).toBeLessThan(
      rows.rowByNodeId.get("message:fb-a2-alt")!,
    );
    expect(rows.rows).toBe(4);
  });

  it("keeps parents above children even with out-of-order timestamps", () => {
    const withTime = (id: string, role: Message["role"], data: string, time: number) => ({
      ...message(id, role, data),
      time,
    });
    const u1 = withTime("oo-u1", "user", "hello", 5);
    const a1 = withTime("oo-a1", "char", "first answer", 2);
    const graph = buildChatMessageGraph([timeline("root", [u1, a1], true)]);

    const rows = buildChatGraphGitRows(graph);

    expect(rows.rowByNodeId.get("message:oo-u1")!).toBeLessThan(
      rows.rowByNodeId.get("message:oo-a1")!,
    );
  });
});

describe("getChatBranches", () => {
  it("builds from the explicitly pinned chat instead of global selection", () => {
    const chat = {
      message: [
        message("u1", "user", "focused tab message"),
        message("a1", "char", "focused tab response"),
      ],
    } as Chat;

    const graph = getChatBranches(chat);

    expect(graph.messageCount).toBe(2);
    expect(graph.timelineCount).toBe(1);
    expect(graph.nodes.map((node) => node.preview)).toEqual([
      "focused tab message",
      "focused tab response",
    ]);
  });

  it("renders edited user input from the persistent SQL graph as a separate branch node", () => {
    const graph = getChatBranchesFromPersistentGraph({
      branches: [
        {
          id: "root",
          chatId: "chat-1",
          headMessageId: "a2",
          reason: "root",
          createdAt: 1,
        },
        {
          id: "edit",
          chatId: "chat-1",
          parentBranchId: "root",
          forkMessageId: "a1",
          headMessageId: "u2-edit",
          reason: "manual",
          createdAt: 10,
        },
      ],
      activeBranchId: "edit",
      messages: [
        message("u1", "user", "first prompt"),
        message("a1", "char", "first answer"),
        message("u2", "user", "original input"),
        message("a2", "char", "original response"),
        message("u2-edit", "user", "edited input"),
      ],
      links: [
        { messageId: "u1", originBranchId: "root" },
        { messageId: "a1", parentMessageId: "u1", originBranchId: "root" },
        { messageId: "u2", parentMessageId: "a1", originBranchId: "root" },
        { messageId: "a2", parentMessageId: "u2", originBranchId: "root" },
        {
          messageId: "u2-edit",
          parentMessageId: "a1",
          originBranchId: "edit",
        },
      ],
    });
    const originalInput = graph.nodes.find(
      (node) => node.preview === "original input",
    )!;
    const editedInput = graph.nodes.find(
      (node) => node.preview === "edited input",
    )!;
    const fork = graph.nodes.find((node) => node.preview === "first answer")!;

    expect(graph.timelineCount).toBe(2);
    expect(originalInput.id).not.toBe(editedInput.id);
    expect(originalInput.y).toBe(editedInput.y);
    expect(fork.branchPoint).toBe(true);
    expect(editedInput.activeTerminal).toBe(true);
  });
});
