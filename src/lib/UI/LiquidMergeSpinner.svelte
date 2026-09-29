<script lang="ts">
  // Unique per-instance filter id: SVG filter ids are document-global,
  // so multiple instances must not share one id.
  import { v4 as uuidv4 } from "uuid";

  interface Props {
    /** Rendered size in px (width & height). Default 24. */
    size?: number;
    /**
     * Chat process stage (0-4). Controls the liquid color, mirroring
     * the legacy .loadmove chat-process-stage-{1..4} colors in
     * DefaultChatScreen.svelte. 0 = theme default.
     */
    stage?: number;
    /** autoMode — mirrors .loadmove's .autoload (green #10b981). */
    autoMode?: boolean;
  }

  let { size = 24, stage = 0, autoMode = false }: Props = $props();
  let filterId = `liquid-goo-${uuidv4().slice(0, 8)}`;

  // The original animation geometry is a fixed 140px box; scaling that box
  // down to the requested size requires a unitless scale factor. A unitless
  // number is computed in JS because CSS scale() rejects the px value that
  // calc(var(--liquid-spinner-size) / 140) would produce.
  let scaleStyle = $derived(`transform: scale(${(size / 140).toFixed(4)})`);

  // Same colors as DefaultChatScreen.svelte's .chat-process-stage-{1..4} / .autoload.
  const STAGE_COLORS: Record<number, string> = {
    1: "#60a5fa", // blue
    2: "#db2777", // pink
    3: "#34d399", // green
    4: "#8b5cf6", // purple
  };

  let color = $derived(
    autoMode ? "#10b981" : (STAGE_COLORS[stage] ?? "var(--risu-theme-borderc)"),
  );
</script>

<div
  class="liquid-spinner"
  style="--liquid-spinner-size: {size}px; --liquid-color: {color};"
  aria-hidden="true"
>
  <svg class="liquid-svg" width="0" height="0" aria-hidden="true">
    <defs>
      <filter
        id={filterId}
        x="-50%"
        y="-50%"
        width="200%"
        height="200%"
        color-interpolation-filters="sRGB"
      >
        <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
        <feColorMatrix
          in="blur"
          mode="matrix"
          values="1 0 0 0 0
                  0 1 0 0 0
                  0 0 1 0 0
                  0 0 0 50 -20"
        />
      </filter>
    </defs>
  </svg>

  <!-- 140px fixed inner box (matches the original HTML's geometry), scaled
       down to the requested size. Keeps the original keyframes math intact. -->
  <div class="liquid-scale" style={scaleStyle}>
    <div class="liquid-rotor" style="filter: url(#{filterId})">
      <div class="liquid-drop liquid-neck"></div>
      <div class="liquid-drop liquid-a"></div>
      <div class="liquid-drop liquid-b"></div>
    </div>
  </div>
</div>

<style>
  .liquid-spinner {
    display: flex;
    justify-content: center;
    align-items: center;
    width: var(--liquid-spinner-size);
    height: var(--liquid-spinner-size);
    overflow: clip;
  }

  .liquid-scale {
    width: 140px;
    height: 140px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .liquid-rotor {
    position: relative;
    width: 100px;
    height: 100px;
    animation: liquid-spin 3.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  }

  .liquid-drop {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 32px;
    height: 32px;
    margin: -16px 0 0 -16px;
    background: var(--liquid-color);
    border-radius: 50%;
  }

  .liquid-a {
    animation: liquid-drop-a 2.5s infinite;
  }

  .liquid-b {
    animation: liquid-drop-b 2.5s infinite;
  }

  .liquid-neck {
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
    transform: scale(0);
    animation: liquid-neck 2.5s infinite;
  }

  /* ===== Keyframes: copied verbatim from the original Liquid Merge spinner
     HTML (lines 89-183), renamed with the liquid- prefix. DO NOT tweak. ===== */
  @keyframes liquid-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes liquid-drop-a {
    0% {
      transform: translateY(-36px) scale(0.95, 0.95);
      animation-timing-function: ease-in;
    }
    28% {
      transform: translateY(-14px) scale(0.82, 1.25);
      animation-timing-function: ease-out;
    }
    40% {
      transform: translateY(0) scale(1.65, 1.25);
    }
    48% {
      transform: translateY(0) scale(1.35, 1.65);
    }
    58% {
      transform: translateY(0) scale(1.58, 1.58);
    }
    66% {
      transform: translateY(0) scale(1.52, 1.52);
      animation-timing-function: ease-in;
    }
    76% {
      transform: translateY(-12px) scale(0.88, 1.45);
      animation-timing-function: ease-out;
    }
    88% {
      transform: translateY(-40px) scale(1.15, 0.85);
    }
    94% {
      transform: translateY(-35px) scale(0.95, 1.05);
    }
    100% {
      transform: translateY(-36px) scale(0.95, 0.95);
    }
  }

  @keyframes liquid-drop-b {
    0% {
      transform: translateY(36px) scale(0.95, 0.95);
      animation-timing-function: ease-in;
    }
    28% {
      transform: translateY(14px) scale(0.82, 1.25);
      animation-timing-function: ease-out;
    }
    40% {
      transform: translateY(0) scale(1.65, 1.25);
    }
    48% {
      transform: translateY(0) scale(1.35, 1.65);
    }
    58% {
      transform: translateY(0) scale(1.58, 1.58);
    }
    66% {
      transform: translateY(0) scale(1.52, 1.52);
      animation-timing-function: ease-in;
    }
    76% {
      transform: translateY(12px) scale(0.88, 1.45);
      animation-timing-function: ease-out;
    }
    88% {
      transform: translateY(40px) scale(1.15, 0.85);
    }
    94% {
      transform: translateY(35px) scale(0.95, 1.05);
    }
    100% {
      transform: translateY(36px) scale(0.95, 0.95);
    }
  }

  @keyframes liquid-neck {
    0%,
    66% {
      transform: scale(0);
    }
    76% {
      transform: scale(1.1, 1.7);
    }
    86% {
      transform: scale(0.7);
    }
    94%,
    100% {
      transform: scale(0);
    }
  }
</style>