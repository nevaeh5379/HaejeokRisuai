import type Viewer from "viewerjs";

/** Loads a single-image viewer on demand and releases it with its image button. */
export function illustrationViewer(button: HTMLButtonElement) {
  let viewer: Viewer | undefined;
  let loading = false;
  let disposed = false;

  function close() {
    const current = viewer;
    viewer = undefined;
    current?.destroy();
  }

  async function open(event: MouseEvent) {
    event.stopPropagation();
    if (disposed || loading || viewer) return;
    const image = button.querySelector("img");
    if (!image) return;
    loading = true;
    try {
      const [{ default: Viewer }] = await Promise.all([
        import("viewerjs"),
        import("viewerjs/dist/viewer.css"),
      ]);
      if (disposed) return;
      viewer = new Viewer(image, {
        navbar: false,
        title: false,
        transition: false,
        toolbar: {
          zoomIn: true,
          zoomOut: true,
          oneToOne: true,
          reset: true,
        },
        hidden() {
          close();
          if (!disposed) button.focus({ preventScroll: true });
        },
      });
      viewer.show();
    } catch (error) {
      close();
      console.error("Failed to open illustration viewer", error);
    } finally {
      loading = false;
    }
  }

  function stopPointer(event: PointerEvent) {
    event.stopPropagation();
  }

  button.addEventListener("click", open);
  button.addEventListener("pointerdown", stopPointer);
  return {
    destroy() {
      disposed = true;
      button.removeEventListener("click", open);
      button.removeEventListener("pointerdown", stopPointer);
      close();
    },
  };
}
