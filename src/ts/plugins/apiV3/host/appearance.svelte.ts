import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import {
  changeColorScheme,
  updateColorScheme,
  updateTextThemeAndCSS,
  type ColorScheme,
} from "src/ts/gui/colorscheme";

export const appearanceApi = {
  changeColorScheme: (name: string) => {
    changeColorScheme(name);
  },
  setColorScheme: (scheme: ColorScheme) => {
    const requiredKeys = [
      "bgcolor",
      "darkbg",
      "borderc",
      "selected",
      "draculared",
      "textcolor",
      "textcolor2",
      "darkBorderc",
      "darkbutton",
      "type",
    ] as const;
    for (const key of requiredKeys) {
      if (typeof scheme[key] !== "string") {
        throw new Error(`Invalid color scheme: missing or invalid '${key}'`);
      }
    }

    if (scheme.type !== "light" && scheme.type !== "dark") {
      throw new Error('Invalid color scheme type: must be "light" or "dark"');
    }

    settingsStore.state.colorSchemeName = "custom";
    settingsStore.state.customColorScheme = scheme;
    settingsStore.state.colorScheme = scheme;
    updateColorScheme();
  },
  getColorScheme: () => {
    return {
      name: settingsStore.state.colorSchemeName,
      scheme: $state.snapshot(settingsStore.state.colorScheme),
    };
  },
  changeTextTheme: (name: string) => {
    if (!["standard", "highcontrast"].includes(name)) {
      throw new Error(`Invalid text theme: ${name}`);
    }

    settingsStore.state.textTheme = name;
    updateTextThemeAndCSS();
  },
  setCustomTextTheme: (theme: {
    FontColorStandard: string;
    FontColorBold: string;
    FontColorItalic: string;
    FontColorItalicBold: string;
    FontColorQuote1: string;
    FontColorQuote2: string;
  }) => {
    const requiredKeys = [
      "FontColorStandard",
      "FontColorBold",
      "FontColorItalic",
      "FontColorItalicBold",
      "FontColorQuote1",
      "FontColorQuote2",
    ] as const;
    for (const key of requiredKeys) {
      if (typeof theme[key] !== "string") {
        throw new Error(`Invalid text theme: missing or invalid '${key}'`);
      }
    }

    settingsStore.state.textTheme = "custom";
    settingsStore.state.customTextTheme = theme;
    updateTextThemeAndCSS();
  },
  getTextTheme: () => {
    return {
      name: settingsStore.state.textTheme,
      customTheme: $state.snapshot(settingsStore.state.customTextTheme),
    };
  },
};
