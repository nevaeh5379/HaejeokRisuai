/**
 * Intelligent Color Adaptation Engine
 *
 * Automatically transforms dark-mode hardcoded bot inline styles
 * into light-theme optimized styles (and vice versa) using 4 distinct algorithms.
 */

export type ColorAdaptEngine = "oklch" | "colord" | "leonardo" | "darkreader";

export interface RGBA {
  r: number; // 0 - 255
  g: number; // 0 - 255
  b: number; // 0 - 255
  a: number; // 0 - 1
}

export interface HSL {
  h: number; // 0 - 360
  s: number; // 0 - 1
  l: number; // 0 - 1
  a: number; // 0 - 1
}

export interface OKLCH {
  l: number; // 0 - 1
  c: number; // 0 - 0.4
  h: number; // 0 - 360
  a: number; // 0 - 1
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Color Parsing & Conversion Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function parseColor(colorStr: string): RGBA | null {
  if (!colorStr) return null;
  const str = colorStr.trim().toLowerCase();

  // Named colors
  const namedColors: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    gray: "#808080",
    grey: "#808080",
    darkgray: "#a9a9a9",
    darkgrey: "#a9a9a9",
    lightgray: "#d3d3d3",
    lightgrey: "#d3d3d3",
    dimgray: "#696969",
    dimgrey: "#696969",
    transparent: "rgba(0,0,0,0)",
  };
  if (namedColors[str]) {
    return parseColor(namedColors[str]);
  }

  // Hex (#rgb, #rgba, #rrggbb, #rrggbbaa)
  if (str.startsWith("#")) {
    const hex = str.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: parseInt(hex[3] + hex[3], 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
  }

  // rgb/rgba
  const rgbMatch = str.match(
    /rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/,
  );
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, parseFloat(rgbMatch[1])));
    const g = Math.min(255, Math.max(0, parseFloat(rgbMatch[2])));
    const b = Math.min(255, Math.max(0, parseFloat(rgbMatch[3])));
    let a = 1;
    if (rgbMatch[4]) {
      if (rgbMatch[4].endsWith("%")) {
        a = parseFloat(rgbMatch[4]) / 100;
      } else {
        a = parseFloat(rgbMatch[4]);
      }
    }
    return { r, g, b, a: Math.min(1, Math.max(0, a)) };
  }

  // hsl/hsla
  const hslMatch = str.match(
    /hsla?\s*\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:[,\s/]+([\d.]+%?))?\s*\)/,
  );
  if (hslMatch) {
    const h = parseFloat(hslMatch[1]) % 360;
    const s = Math.min(100, Math.max(0, parseFloat(hslMatch[2]))) / 100;
    const l = Math.min(100, Math.max(0, parseFloat(hslMatch[3]))) / 100;
    let a = 1;
    if (hslMatch[4]) {
      a = hslMatch[4].endsWith("%")
        ? parseFloat(hslMatch[4]) / 100
        : parseFloat(hslMatch[4]);
    }
    const rgb = hslToRgb({ h, s, l, a });
    return rgb;
  }

  return null;
}

export function rgbaToString(rgba: RGBA): string {
  const r = Math.round(rgba.r);
  const g = Math.round(rgba.g);
  const b = Math.round(rgba.b);
  if (rgba.a < 0.999) {
    return `rgba(${r}, ${g}, ${b}, ${parseFloat(rgba.a.toFixed(3))})`;
  }
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function rgbToHsl(rgba: RGBA): HSL {
  const r = rgba.r / 255;
  const g = rgba.g / 255;
  const b = rgba.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }

  return { h, s, l, a: rgba.a };
}

export function hslToRgb(hsl: HSL): RGBA {
  const { h, s, l, a } = hsl;
  if (s === 0) {
    const val = Math.round(l * 255);
    return { r: val, g: val, b: val, a };
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    let normalized = t;
    if (normalized < 0) normalized += 1;
    if (normalized > 1) normalized -= 1;
    if (normalized < 1 / 6) return p + (q - p) * 6 * normalized;
    if (normalized < 1 / 2) return q;
    if (normalized < 2 / 3) return p + (q - p) * (2 / 3 - normalized) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hNorm = h / 360;

  return {
    r: Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hNorm) * 255),
    b: Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255),
    a,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Perceptual Color Spaces (OKLab & OKLCH)
// ─────────────────────────────────────────────────────────────────────────────

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

export function rgbToOklch(rgba: RGBA): OKLCH {
  const lr = srgbToLinear(rgba.r);
  const lg = srgbToLinear(rgba.g);
  const lb = srgbToLinear(rgba.b);

  const l_ = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m_ = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s_ = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;

  return { l: L, c: C, h: H, a: rgba.a };
}

export function oklchToRgb(oklch: OKLCH): RGBA {
  const { l, c, h, a } = oklch;
  const hRad = (h * Math.PI) / 180;
  const a_ = c * Math.cos(hRad);
  const b_ = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a_ + 0.2158037573 * b_;
  const m_ = l - 0.1055613458 * a_ - 0.0638541728 * b_;
  const s_ = l - 0.0894841775 * a_ - 1.291485548 * b_;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const lr = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return {
    r: linearToSrgb(lr),
    g: linearToSrgb(lg),
    b: linearToSrgb(lb),
    a,
  };
}

export function getRelativeLuminance(rgba: RGBA): number {
  const r = srgbToLinear(rgba.r);
  const g = srgbToLinear(rgba.g);
  const b = srgbToLinear(rgba.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastRatio(fg: RGBA, bg: RGBA): number {
  const l1 = getRelativeLuminance(fg);
  const l2 = getRelativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The 4 Transformation Engines
// ─────────────────────────────────────────────────────────────────────────────

export type ColorRole = "bg" | "fg" | "border";

export function adaptColorOklch(
  rgba: RGBA,
  role: ColorRole,
  toLight: boolean,
): RGBA {
  const oklch = rgbToOklch(rgba);

  if (toLight) {
    if (role === "bg") {
      if (oklch.l < 0.6) {
        oklch.l = 0.94 - oklch.l * 0.15;
        oklch.c = Math.min(oklch.c * 0.5, 0.04);
      }
    } else if (role === "border") {
      if (oklch.l < 0.4) {
        oklch.l = 0.82 + oklch.l * 0.1;
        oklch.c = Math.min(oklch.c * 0.4, 0.03);
      }
    } else {
      // Intelligent text adaptation:
      // Distinguish between colored accent text (cyan, mint, purple, orange) and neutral text (white, gray)
      const isColoredAccent = oklch.c > 0.035;
      if (isColoredAccent) {
        // Bright neon/accent in dark theme -> Deep, vivid jewel tone in light theme
        if (oklch.l > 0.38) {
          oklch.l = 0.4; // Optimal 5.5:1 ~ 7:1 contrast ratio against white/light backgrounds
          oklch.c = Math.min(oklch.c * 1.1, 0.19); // Retain rich, eye-pleasing hue
        }
      } else {
        // Neutral text (white, light gray) -> Deep ink text
        if (oklch.l > 0.4) {
          oklch.l = 0.16;
        }
      }
    }
  } else {
    if (role === "bg") {
      if (oklch.l > 0.5) {
        oklch.l = 0.12 + (1 - oklch.l) * 0.15;
        oklch.c = Math.min(oklch.c * 0.6, 0.05);
      }
    } else if (role === "border") {
      if (oklch.l > 0.6) {
        oklch.l = 0.28 - (1 - oklch.l) * 0.1;
        oklch.c = Math.min(oklch.c * 0.4, 0.03);
      }
    } else {
      if (oklch.l < 0.5) {
        oklch.l = 0.88 - oklch.l * 0.2;
      }
    }
  }

  return oklchToRgb(oklch);
}

export function adaptColorColord(
  rgba: RGBA,
  role: ColorRole,
  toLight: boolean,
): RGBA {
  const hsl = rgbToHsl(rgba);

  if (toLight) {
    if (role === "bg") {
      if (hsl.l < 0.6) {
        hsl.l = 0.92 + (1 - hsl.l / 0.6) * 0.05;
        hsl.s = Math.min(hsl.s * 0.35, 0.25);
      }
    } else if (role === "border") {
      if (hsl.l < 0.4) {
        hsl.l = 0.82;
        hsl.s = Math.min(hsl.s * 0.3, 0.2);
      }
    } else {
      const isColored = hsl.s > 0.15;
      if (isColored) {
        if (hsl.l > 0.35) {
          hsl.l = 0.36;
          hsl.s = Math.min(hsl.s, 0.8);
        }
      } else {
        if (hsl.l > 0.35) {
          hsl.l = 0.15;
        }
      }
    }
  } else {
    if (role === "bg") {
      if (hsl.l > 0.5) {
        hsl.l = 0.14 * (1 - hsl.l);
        hsl.s = Math.min(hsl.s * 0.4, 0.3);
      }
    } else if (role === "border") {
      if (hsl.l > 0.6) {
        hsl.l = 0.28;
      }
    } else {
      if (hsl.l < 0.5) {
        hsl.l = 0.85 + (1 - hsl.l) * 0.1;
      }
    }
  }

  return hslToRgb(hsl);
}

export function adaptColorLeonardo(
  rgba: RGBA,
  role: ColorRole,
  toLight: boolean,
): RGBA {
  const oklch = rgbToOklch(rgba);

  if (toLight) {
    if (role === "bg") {
      if (oklch.l < 0.6) {
        oklch.l = 0.93;
        oklch.c = Math.min(oklch.c * 0.4, 0.03);
      }
    } else if (role === "border") {
      if (oklch.l < 0.4) {
        oklch.l = 0.84;
        oklch.c = Math.min(oklch.c * 0.3, 0.02);
      }
    } else {
      const isColored = oklch.c > 0.035;
      if (isColored) {
        if (oklch.l > 0.38) {
          oklch.l = 0.38;
          oklch.c = Math.min(oklch.c * 1.1, 0.18);
        }
      } else {
        if (oklch.l > 0.4) {
          oklch.l = 0.16;
        }
      }
    }
  } else {
    if (role === "bg") {
      if (oklch.l > 0.5) {
        oklch.l = 0.16;
        oklch.c = Math.min(oklch.c * 0.4, 0.03);
      }
    } else if (role === "border") {
      if (oklch.l > 0.6) {
        oklch.l = 0.28;
      }
    } else {
      if (oklch.l < 0.5) {
        oklch.l = 0.92;
      }
    }
  }

  return oklchToRgb(oklch);
}

export function adaptColorDarkReader(
  rgba: RGBA,
  role: ColorRole,
  toLight: boolean,
): RGBA {
  const hsl = rgbToHsl(rgba);

  if (toLight) {
    if (role === "bg") {
      if (hsl.l < 0.55) {
        hsl.l = 1 - hsl.l * 0.85;
        hsl.s = hsl.s * 0.6;
      }
    } else if (role === "border") {
      if (hsl.l < 0.4) {
        hsl.l = 1 - hsl.l * 0.5;
      }
    } else {
      const isColored = hsl.s > 0.15;
      if (isColored) {
        if (hsl.l > 0.35) {
          hsl.l = 0.35;
        }
      } else {
        if (hsl.l > 0.35) {
          hsl.l = 0.15;
        }
      }
    }
  } else {
    if (role === "bg") {
      if (hsl.l > 0.5) {
        hsl.l = (1 - hsl.l) * 0.85;
        hsl.s = hsl.s * 0.6;
      }
    } else if (role === "border") {
      if (hsl.l > 0.6) {
        hsl.l = (1 - hsl.l) * 0.6;
      }
    } else {
      if (hsl.l < 0.5) {
        hsl.l = 1 - hsl.l * 0.75;
      }
    }
  }

  return hslToRgb(hsl);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Style String Transformer
// ─────────────────────────────────────────────────────────────────────────────

export function adaptSingleColor(
  colorStr: string,
  roleOrIsBg: ColorRole | boolean,
  toLight: boolean,
  engine: ColorAdaptEngine = "oklch",
): string {
  const parsed = parseColor(colorStr);
  if (!parsed) return colorStr;

  const role: ColorRole =
    typeof roleOrIsBg === "boolean" ? (roleOrIsBg ? "bg" : "fg") : roleOrIsBg;

  let adapted: RGBA;
  switch (engine) {
    case "colord":
      adapted = adaptColorColord(parsed, role, toLight);
      break;
    case "leonardo":
      adapted = adaptColorLeonardo(parsed, role, toLight);
      break;
    case "darkreader":
      adapted = adaptColorDarkReader(parsed, role, toLight);
      break;
    case "oklch":
    default:
      adapted = adaptColorOklch(parsed, role, toLight);
      break;
  }

  return rgbaToString(adapted);
}

/**
 * Adapts all colors within an arbitrary CSS property value (including linear-gradient,
 * radial-gradient, box-shadow, shorthand border, multiple color stops, and !important).
 */
export function adaptCssValue(
  val: string,
  role: ColorRole,
  toLight: boolean,
  engine: ColorAdaptEngine = "oklch",
): string {
  if (!val || typeof val !== "string") return val;

  const hasImportant = /!\s*important/i.test(val);
  let cleanVal = val.replace(/!\s*important/gi, "").trim();

  // If it's a url(...) image without gradient, don't modify the URL part
  if (cleanVal.includes("url(") && !cleanVal.includes("gradient")) {
    return val;
  }

  // 1. rgba? / hsla?
  cleanVal = cleanVal.replace(/rgba?\s*\([^)]+\)/gi, (match) => {
    return adaptSingleColor(match, role, toLight, engine);
  });
  cleanVal = cleanVal.replace(/hsla?\s*\([^)]+\)/gi, (match) => {
    return adaptSingleColor(match, role, toLight, engine);
  });

  // 2. Hex colors (#rgb, #rgba, #rrggbb, #rrggbbaa)
  cleanVal = cleanVal.replace(/#[0-9a-fA-F]{3,8}\b/g, (match) => {
    return adaptSingleColor(match, role, toLight, engine);
  });

  // 3. Known named colors (whole word boundary)
  const named = [
    "white",
    "black",
    "gray",
    "grey",
    "darkgray",
    "darkgrey",
    "lightgray",
    "lightgrey",
    "dimgray",
    "dimgrey",
  ];
  const namedRegex = new RegExp(`\\b(${named.join("|")})\\b`, "gi");
  cleanVal = cleanVal.replace(namedRegex, (match) => {
    return adaptSingleColor(match, role, toLight, engine);
  });

  return cleanVal + (hasImportant ? " !important" : "");
}

/**
 * Adapts an inline CSS style string so that dark hardcoded colors
 * adapt beautifully to light theme (and vice-versa).
 */
export function adaptInlineStyle(
  styleStr: string,
  toLight: boolean,
  engine: ColorAdaptEngine = "oklch",
): string {
  if (!styleStr || typeof styleStr !== "string") return styleStr;

  const declarations = styleStr.split(";");
  const result: string[] = [];

  for (const decl of declarations) {
    const trimmed = decl.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      result.push(trimmed);
      continue;
    }

    const prop = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (
      prop === "background" ||
      prop === "background-color" ||
      prop === "background-image"
    ) {
      result.push(`${prop}: ${adaptCssValue(val, "bg", toLight, engine)}`);
      continue;
    }

    if (prop === "color") {
      result.push(`${prop}: ${adaptCssValue(val, "fg", toLight, engine)}`);
      continue;
    }

    if (
      prop === "border" ||
      prop === "border-color" ||
      prop === "border-top" ||
      prop === "border-bottom" ||
      prop === "border-left" ||
      prop === "border-right" ||
      prop === "outline" ||
      prop === "outline-color"
    ) {
      result.push(`${prop}: ${adaptCssValue(val, "border", toLight, engine)}`);
      continue;
    }

    if (prop === "box-shadow" || prop === "text-shadow") {
      result.push(`${prop}: ${adaptCssValue(val, "border", toLight, engine)}`);
      continue;
    }

    result.push(trimmed);
  }

  return result.join("; ") + (result.length > 0 ? ";" : "");
}

/**
 * Adapts an entire CSS stylesheet string (e.g. from <style> blocks).
 */
export function adaptFullCssText(
  cssText: string,
  toLight: boolean,
  engine: ColorAdaptEngine = "oklch",
): string {
  if (!cssText || typeof cssText !== "string") return cssText;

  return cssText.replace(
    /([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g,
    (fullMatch, prop, val) => {
      const p = prop.trim().toLowerCase();
      if (
        p === "background" ||
        p === "background-color" ||
        p === "background-image"
      ) {
        return `${prop}: ${adaptCssValue(val, "bg", toLight, engine)}`;
      }
      if (p === "color") {
        return `${prop}: ${adaptCssValue(val, "fg", toLight, engine)}`;
      }
      if (p.includes("border") || p.includes("outline")) {
        return `${prop}: ${adaptCssValue(val, "border", toLight, engine)}`;
      }
      if (p === "box-shadow" || p === "text-shadow") {
        return `${prop}: ${adaptCssValue(val, "border", toLight, engine)}`;
      }
      return fullMatch;
    },
  );
}
