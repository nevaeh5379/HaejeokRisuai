/** Portable settings and persisted metadata. No credentials or scene snapshots belong here. */
export interface IllustrationSettings {
  enabled: boolean;
  recentMessages: number;
  includeDescription: boolean;
  includePersona: boolean;
  includeLorebook: boolean;
  includeMemory: boolean;
  markerInstructions: string;
  tagInstructions: string;
  basePrompt: string;
  negativePrompt: string;
}

export const DEFAULT_ILLUSTRATION_SETTINGS: Readonly<IllustrationSettings> = {
  enabled: false,
  recentMessages: 6,
  includeDescription: true,
  includePersona: true,
  includeLorebook: false,
  includeMemory: false,
  markerInstructions:
    "Place <Illustration> after an important visual description or scene transition when an illustration would enrich the story. The marker depicts the scene immediately before it. Use the exact marker in narrative text, outside code and reasoning. Do not write image tags yourself.",
  tagInstructions:
    "Describe the scene immediately before the illustration marker using concise English image generation tags. Include the visible characters, appearance, expressions, actions, setting, lighting and composition. Respect the supplied character and persona descriptions. Return only the tags, without commentary or reasoning.",
  basePrompt: "",
  negativePrompt: "",
};

export type IllustrationOverrides = Partial<IllustrationSettings>;
export type IllustrationStatus =
  "queued" | "tagging" | "generating" | "complete" | "failed" | "interrupted";
export type IllustrationAction = "retry" | "regenerate" | "rewrite";

export interface Illustration {
  id: string;
  token: string;
  status: IllustrationStatus;
  version: number;
  sourceHash: string;
  branchId?: string;
  executor: "app" | "server";
  runId: string;
  tags?: string;
  prompt?: string;
  negativePrompt?: string;
  imageId?: string;
  error?: string;
}

export interface IllustrationTarget {
  characterId: string;
  chatId: string;
  messageId: string;
  illustrationId: string;
}

export interface IllustrationMessage {
  role: "user" | "char";
  data: string;
  chatId?: string;
  illustrations?: Illustration[];
}

export interface IllustrationContext {
  description?: string;
  persona?: string;
  lorebook?: string;
  memory?: string;
}

export interface IllustrationPromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A prepared HTTP submodel request, held only for the duration of a server job. */
export interface IllustrationTagRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface IllustrationJobRequest extends IllustrationTarget {
  version: number;
  action?: IllustrationAction;
  tagRequest?: IllustrationTagRequest;
}

export interface IllustrationJobResponse {
  runId: string;
  illustration: Illustration;
}

const append = (a: string, b: string) => [a, b].filter(Boolean).join("\n\n");

export function resolveIllustrationSettings(
  global?: Partial<IllustrationSettings>,
  character?: IllustrationOverrides,
): IllustrationSettings {
  const base = { ...DEFAULT_ILLUSTRATION_SETTINGS, ...global };
  const result = { ...base, ...character };
  for (const key of [
    "markerInstructions",
    "tagInstructions",
    "basePrompt",
    "negativePrompt",
  ] as const) {
    result[key] = append(base[key] ?? "", character?.[key] ?? "");
  }
  result.recentMessages = Number.isFinite(result.recentMessages)
    ? Math.max(0, Math.floor(result.recentMessages))
    : 6;
  return result;
}

export const illustrationToken = (id: string) => `{{illustration::${id}}}`;
export const isIllustrationBusy = (status: IllustrationStatus) =>
  status === "queued" || status === "tagging" || status === "generating";

/** Skip fenced/indented code, matching backtick runs, and nested reasoning regions. */
export function findIllustrationMarkers(text: string): number[] {
  const positions: number[] = [];
  let fence = "";
  let inline = 0;
  const thoughts: string[] = [];
  for (let i = 0; i < text.length;) {
    if (i === 0 || text[i - 1] === "\n") {
      const line = text.slice(
        i,
        text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i),
      );
      const fenced = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (fenced) {
        const run = fenced[2];
        if (!fence) fence = run;
        else if (
          run[0] === fence[0] &&
          run.length >= fence.length &&
          /^\s*$/.test(line.slice(fenced[0].length))
        )
          fence = "";
        i += line.length + (i + line.length < text.length ? 1 : 0);
        continue;
      }
      if (fence || /^( {4}|\t)/.test(line)) {
        i += line.length + (i + line.length < text.length ? 1 : 0);
        continue;
      }
    }
    if (text[i] === "`" && (i === 0 || text[i - 1] !== "\\")) {
      const run = /^`+/.exec(text.slice(i))![0].length;
      if (inline === run) inline = 0;
      else if (!inline) {
        const closing = /`+/g;
        closing.lastIndex = i + run;
        let match: RegExpExecArray | null;
        while ((match = closing.exec(text))) {
          if (match[0].length === run && text[match.index - 1] !== "\\") {
            inline = run;
            break;
          }
        }
      }
      i += run;
      continue;
    }
    if (!inline) {
      const tag =
        /^<(\/)?(thoughts?|think|analysis|reasoning|pre|code)\b[^>]*>/i.exec(
          text.slice(i),
        );
      if (tag) {
        const name = tag[2].toLowerCase();
        if (!tag[1]) thoughts.push(name);
        else if (thoughts.at(-1) === name) thoughts.pop();
        i += tag[0].length;
        continue;
      }
      if (
        !thoughts.length &&
        text.startsWith("<Illustration>", i) &&
        (i === 0 || text[i - 1] !== "\\")
      ) {
        positions.push(i);
        i += "<Illustration>".length;
        continue;
      }
    }
    i++;
  }
  return positions;
}

export function canonicalIllustrationText(
  message: IllustrationMessage,
): string {
  let text = message.data;
  for (const item of message.illustrations ?? []) {
    text = text.replace(item.token, "<Illustration>");
  }
  return text;
}

/** Compact deterministic edit guard; never retains a copy of the conversation. */
export function illustrationSourceHash(message: IllustrationMessage): string {
  const text = canonicalIllustrationText(message);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

export function prepareIllustrations(
  message: IllustrationMessage,
  createId: () => string,
  branchId: string | undefined,
  executor: Illustration["executor"],
  runId: string,
): Illustration[] {
  const positions = findIllustrationMarkers(message.data);
  if (!positions.length) return [];
  const items = positions.map((): Illustration => {
    const id = createId();
    return {
      id,
      token: illustrationToken(id),
      status: "queued",
      version: 1,
      sourceHash: "",
      branchId,
      executor,
      runId,
    };
  });
  for (let i = positions.length - 1; i >= 0; i--) {
    message.data =
      message.data.slice(0, positions[i]) +
      items[i].token +
      message.data.slice(positions[i] + 14);
  }
  message.illustrations = [...(message.illustrations ?? []), ...items];
  const hash = illustrationSourceHash(message);
  for (const item of items) item.sourceHash = hash;
  return items;
}

export function validIllustration(
  message: IllustrationMessage,
  item: Illustration,
  branchId: string | undefined,
  version: number,
): boolean {
  return (
    item.version === version &&
    item.branchId === branchId &&
    message.data.split(item.token).length === 2 &&
    illustrationSourceHash(message) === item.sourceHash
  );
}

export function stripIllustrationMedia(text: string): string {
  return text
    .replace(
      /<(thoughts?|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    )
    .replace(
      /{{(?:inlay|inlayed|inlayeddata|illustration)::[^}]+}}|<Illustration>/g,
      "",
    )
    .trim();
}

/** Only previous messages and the target answer up to this slot are supplied. */
export function buildIllustrationPrompt(
  settings: IllustrationSettings,
  history: IllustrationMessage[],
  message: IllustrationMessage,
  item: Illustration,
  context: IllustrationContext,
): {
  required: IllustrationPromptMessage[];
  history: IllustrationPromptMessage[];
} {
  const sections: string[] = [];
  for (const [flag, key, title] of [
    ["includeDescription", "description", "Character"],
    ["includePersona", "persona", "Persona"],
    ["includeLorebook", "lorebook", "Active lorebook"],
    ["includeMemory", "memory", "Used memory"],
  ] as const) {
    if (settings[flag] && context[key])
      sections.push(`${title}:\n${context[key]}`);
  }
  const position = message.data.indexOf(item.token);
  if (position < 0) throw new Error("Illustration position was removed");
  return {
    required: [
      {
        role: "system",
        content: append(settings.tagInstructions, sections.join("\n\n")),
      },
      {
        role: "user",
        content: `Current scene (illustrate its final moment):\n${stripIllustrationMedia(message.data.slice(0, position))}`,
      },
    ],
    history: (settings.recentMessages
      ? history.slice(-settings.recentMessages)
      : []
    ).map((m) => ({
      role: m.role === "char" ? "assistant" : "user",
      content: stripIllustrationMedia(m.data),
    })),
  };
}

export async function fitIllustrationPrompt(
  prompt: ReturnType<typeof buildIllustrationPrompt>,
  count: (messages: IllustrationPromptMessage[]) => Promise<number>,
  maxContext: number,
  outputTokens = 300,
): Promise<IllustrationPromptMessage[]> {
  const history = [...prompt.history];
  while (true) {
    const messages = [prompt.required[0], ...history, prompt.required[1]];
    if ((await count(messages)) + outputTokens <= maxContext) return messages;
    if (!history.length)
      throw new Error(
        "Illustration instructions and current scene exceed the submodel context limit",
      );
    history.shift();
  }
}

export function cleanIllustrationTags(text: string): string {
  const tags = stripIllustrationMedia(text)
    .replace(/^```(?:\w+)?\s*|\s*```$/g, "")
    .trim();
  if (!tags) throw new Error("The submodel returned no image tags");
  return tags;
}

/** A failed task cannot poison later tasks. Duplicate clicks share the same promise. */
export class IllustrationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<void>>();
  has(key: string): boolean {
    return this.pending.has(key);
  }
  hasPrefix(prefix: string): boolean {
    for (const key of this.pending.keys())
      if (key.startsWith(prefix)) return true;
    return false;
  }
  enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.tail
      .catch(() => {})
      .then(work)
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    this.tail = task.catch(() => {});
    return task;
  }
}
