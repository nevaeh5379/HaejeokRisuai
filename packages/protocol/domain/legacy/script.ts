import type { triggerscript as triggerscriptMain } from "./triggers.ts";
/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface customscript {
  comment: string;
  in: string;
  out: string;
  type: string;
  flag?: string;
  ableFlag?: boolean;
}

export type triggerscript = triggerscriptMain;
