export interface TiltOptions {
  /**
   * Maximum tilt angle in degrees. Defaults to 8.5.
   */
  max?: number;
}

/**
 * Svelte action providing smooth 3D parallax tilt
 * responsive to mouse pointer coordinates.
 * Touch interactions are ignored to keep zero overhead on mobile devices.
 */
export function tilt(node: HTMLElement, options?: TiltOptions) {
  const maxTilt = options?.max ?? 8.5;
  let rafId: number | null = null;
  let targetRx = 0;
  let targetRy = 0;

  function update() {
    node.style.setProperty('--rx', `${targetRx.toFixed(2)}deg`);
    node.style.setProperty('--ry', `${targetRy.toFixed(2)}deg`);
    rafId = null;
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // Normalized coordinates from -0.5 to 0.5 (relative to center)
    const normX = (e.clientX - rect.left) / rect.width - 0.5;
    const normY = (e.clientY - rect.top) / rect.height - 0.5;

    // 3D rotation: tilt towards mouse pointer with zero normalization
    targetRx = Math.abs(normY) < 0.001 ? 0 : -normY * maxTilt * 2;
    targetRy = Math.abs(normX) < 0.001 ? 0 : normX * maxTilt * 2;

    if (!rafId) {
      rafId = requestAnimationFrame(update);
    }
  }

  function onPointerLeave() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    node.style.removeProperty('--rx');
    node.style.removeProperty('--ry');
  }

  node.addEventListener('pointermove', onPointerMove, { passive: true });
  node.addEventListener('pointerleave', onPointerLeave, { passive: true });

  return {
    destroy() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerleave', onPointerLeave);
      node.style.removeProperty('--rx');
      node.style.removeProperty('--ry');
    },
  };
}
