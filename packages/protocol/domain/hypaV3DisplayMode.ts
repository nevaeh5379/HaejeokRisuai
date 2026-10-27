export const DISPLAY_MODE = {
  All: "All",
  Range: "Range",
  Recent: "Recent",
} as const;

export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];
