<script lang="ts">
  import { startWindowResize, type ResizeDirection } from 'src/ts/nativeWindowChrome';

  const begin = (direction: ResizeDirection) => (event: PointerEvent) => {
    startWindowResize(direction, event);
  };
</script>

<div role="presentation" aria-hidden="true" class="fixed inset-x-3 top-0 h-1.5 z-[2147483000] cursor-n-resize" onpointerdown={begin('North')}></div>
<div role="presentation" aria-hidden="true" class="fixed inset-x-3 bottom-0 h-1.5 z-[2147483000] cursor-s-resize" onpointerdown={begin('South')}></div>
<div role="presentation" aria-hidden="true" class="fixed inset-y-3 left-0 w-1.5 z-[2147483000] cursor-w-resize" onpointerdown={begin('West')}></div>
<div role="presentation" aria-hidden="true" class="fixed inset-y-3 right-0 w-1.5 z-[2147483000] cursor-e-resize" onpointerdown={begin('East')}></div>

<div role="presentation" aria-hidden="true" class="fixed left-0 top-0 w-3 h-3 z-[2147483001] cursor-nw-resize" onpointerdown={begin('NorthWest')}></div>
<div role="presentation" aria-hidden="true" class="fixed right-0 top-0 w-3 h-3 z-[2147483001] cursor-ne-resize" onpointerdown={begin('NorthEast')}></div>
<div role="presentation" aria-hidden="true" class="fixed left-0 bottom-0 w-3 h-3 z-[2147483001] cursor-sw-resize" onpointerdown={begin('SouthWest')}></div>
<div role="presentation" aria-hidden="true" class="fixed right-0 bottom-0 w-3 h-3 z-[2147483001] cursor-se-resize" onpointerdown={begin('SouthEast')}></div>
