import type {
  Chat,
  ChatAuxModelTask,
  ChatModelBinding,
} from "../../storage/database/schema";
import type { ModelModeExtended } from "./shared";

export const CHAT_AUX_MODEL_TASKS: readonly ChatAuxModelTask[] = [
  "memory",
  "translate",
  "emotion",
  "otherAx",
];

export function emptyChatModelBinding(separateAux = false): ChatModelBinding {
  return {
    main: "",
    sub: "",
    separateAux,
    aux: { memory: "", translate: "", emotion: "", otherAx: "" },
  };
}

/**
 * Model this chat binds for the given request mode, or undefined when the
 * slot is empty and the active preset's model should be used.
 */
export function resolveChatBoundModel(
  chat: Pick<Chat, "modelBinding"> | undefined | null,
  mode: ModelModeExtended,
): string | undefined {
  const binding = chat?.modelBinding;
  if (!binding) return undefined;
  if (mode === "model") return binding.main || undefined;
  if (mode !== "submodel" && binding.separateAux) {
    const model = binding.aux?.[mode];
    if (model) return model;
  }
  return binding.sub || undefined;
}
