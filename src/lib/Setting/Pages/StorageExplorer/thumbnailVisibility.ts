import type { Action } from "svelte/action";
import type { ViewTarget } from "./types";

interface ThumbnailTarget {
  key?: string;
  target: ViewTarget;
}

/** Share one observer across the list and start image I/O only near the viewport. */
export function createLazyThumbnailAction(
  load: (key: string) => void,
): Action<HTMLElement, ThumbnailTarget> {
  let observer: IntersectionObserver | null = null;
  const pending = new Map<Element, string>();

  function stop(node: Element) {
    observer?.unobserve(node);
    pending.delete(node);
    if (pending.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  }

  function observe(node: HTMLElement, key?: string) {
    if (!key) return;
    if (typeof IntersectionObserver === "undefined") {
      load(key);
      return;
    }
    pending.set(node, key);
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = pending.get(entry.target);
          if (!key) continue;
          stop(entry.target);
          load(key);
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
  }

  return (node, initial) => {
    let current = initial;
    observe(node, current.key);
    return {
      update(next) {
        if (next.key === current.key && next.target === current.target) return;
        stop(node);
        current = next;
        observe(node, current.key);
      },
      destroy() {
        stop(node);
      },
    };
  };
}
