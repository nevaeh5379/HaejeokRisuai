import type {
  Illustration,
  IllustrationErrorDetails,
} from "@risuai/protocol/dist/illustration.mjs";

export const item = $state({
  id: "slot",
  status: "failed",
  error: "fallback",
  tags: undefined as string | undefined,
  errorDetails: undefined as IllustrationErrorDetails | undefined,
  imageId: undefined as string | undefined,
  imageIds: undefined as string[] | undefined,
  batch: undefined as Illustration["batch"],
});

export const characterStore = $state({
  characters: [
    {
      chaId: "character",
      chats: [
        { id: "chat", message: [{ chatId: "message", illustrations: [item] }] },
      ],
    },
  ],
});
