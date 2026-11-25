import { writable } from "svelte/store";
import type { ModelModeExtended } from "./shared";

interface Notice {
  id: number;
  mode: ModelModeExtended;
  model: string;
  expires: number;
}

let nextId = 0;
let notices: Notice[] = [];
let timer: ReturnType<typeof setTimeout>;
export const modelRequestNotices = writable<readonly Notice[]>([]);

function publish() {
  clearTimeout(timer);
  const now = Date.now();
  notices = notices.filter((n) => n.expires > now);
  modelRequestNotices.set(notices);
  if (notices.length) timer = setTimeout(publish, notices[0].expires - now);
}

export function notifyModelRequest(model: string, mode: ModelModeExtended) {
  notices = [
    ...notices.slice(-3),
    { id: ++nextId, mode, model, expires: Date.now() + 3500 },
  ];
  publish();
}
