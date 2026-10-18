import { object, picklist, string, type InferOutput } from "valibot";

export const colorSchemeSchema = object({
  bgcolor: string(),
  darkbg: string(),
  borderc: string(),
  selected: string(),
  draculared: string(),
  textcolor: string(),
  textcolor2: string(),
  darkBorderc: string(),
  darkbutton: string(),
  type: picklist(["light", "dark"]),
});

export type ColorScheme = InferOutput<typeof colorSchemeSchema>;

export const defaultColorScheme: ColorScheme = {
  bgcolor: "#282a36",
  darkbg: "#21222c",
  borderc: "#6272a4",
  selected: "#44475a",
  draculared: "#ff5555",
  textcolor: "#f8f8f2",
  textcolor2: "#64748b",
  darkBorderc: "#4b5563",
  darkbutton: "#374151",
  type: "dark",
};
