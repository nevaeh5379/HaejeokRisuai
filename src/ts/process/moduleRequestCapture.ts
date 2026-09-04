import { writable } from "svelte/store";
import type { ModuleRuleDecision, RuleMessage } from "./moduleRequestRules";

export interface CapturedModuleRequest {
  id: number;
  sourceModuleId?: string;
  activeModuleIds: string[];
  messages: RuleMessage[];
  truncated: boolean;
  decision: ModuleRuleDecision;
  selectedModel?: string;
}

const MAX_REQUESTS = 5;
const MAX_CHARACTERS = 24000;
const MAX_MESSAGES = 100;
let enabled = false;
let capturesRemaining = 0;
let nextId = 0;
export const moduleRequestCaptureEnabled = writable(false);
export const capturedModuleRequests = writable<CapturedModuleRequest[]>([]);
export const recentModuleRuleDecisions = writable<
  Pick<CapturedModuleRequest, "sourceModuleId" | "decision" | "selectedModel">[]
>([]);

export function setModuleRequestCapture(value: boolean) {
  enabled = value;
  capturesRemaining = value ? MAX_REQUESTS : 0;
  moduleRequestCaptureEnabled.set(value);
}

export function clearModuleRequestCapture() {
  capturedModuleRequests.set([]);
  recentModuleRuleDecisions.set([]);
}

export function captureModuleRequest(
  request: Omit<CapturedModuleRequest, "id" | "truncated">,
) {
  const decision = {
    ...request.decision,
    modules: request.decision.modules.map((m) => ({ ...m })),
  };
  recentModuleRuleDecisions.update((entries) =>
    [
      {
        sourceModuleId: request.sourceModuleId,
        decision,
        selectedModel: request.selectedModel,
      },
      ...entries,
    ].slice(0, MAX_REQUESTS),
  );
  if (!enabled) return;
  let remaining = MAX_CHARACTERS;
  let truncated = request.messages.length > MAX_MESSAGES;
  const messages: RuleMessage[] = [];
  // Keep the tail, which usually contains output instructions, without retaining
  // multimodal payloads or references to live requests.
  for (
    let i = request.messages.length - 1;
    i >= 0 && messages.length < MAX_MESSAGES;
    i--
  ) {
    const message = request.messages[i];
    const content = typeof message.content === "string" ? message.content : "";
    if (content.length > remaining) truncated = true;
    messages.unshift({
      role: message.role,
      content: content.slice(Math.max(0, content.length - remaining)),
    });
    remaining -= Math.min(content.length, remaining);
    if (remaining === 0) {
      truncated ||= i > 0;
      break;
    }
  }
  capturedModuleRequests.update((entries) =>
    [
      {
        ...request,
        id: ++nextId,
        messages,
        activeModuleIds: [...request.activeModuleIds],
        decision,
        truncated,
      },
      ...entries,
    ].slice(0, MAX_REQUESTS),
  );
  if (--capturesRemaining === 0) setModuleRequestCapture(false);
}
