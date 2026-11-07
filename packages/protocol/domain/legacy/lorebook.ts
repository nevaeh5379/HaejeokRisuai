/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface loreBook {
  key: string;
  secondkey: string;
  insertorder: number;
  comment: string;
  content: string;
  mode: "multiple" | "constant" | "normal" | "child" | "folder";
  alwaysActive: boolean;
  selective: boolean;
  extentions?: {
    risu_case_sensitive: boolean;
  };
  activationPercent?: number;
  loreCache?: {
    key: string;
    data: string[];
  };
  useRegex?: boolean;
  bookVersion?: number;
  id?: string;
  folder?: string;
}
