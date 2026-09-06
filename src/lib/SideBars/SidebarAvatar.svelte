<script lang="ts">
  import { onMount } from "svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";

  type LazySource = string | Promise<string> | (() => string | Promise<string>);

  // One shared observer for every avatar in the app (hundreds of them across
  // the sidebar and session lists) instead of one IntersectionObserver per
  // avatar, which multiplies layout-observer work on low-end phones.
  type ObservedAvatar = {
    element: HTMLSpanElement;
    reveal: (visible: boolean) => void;
  };
  let sharedObserver: IntersectionObserver | null = null;
  let observed = new Set<ObservedAvatar>();

  function getSharedObserver(): IntersectionObserver {
    if (sharedObserver) return sharedObserver;
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = observedAvatars.get(entry.target as HTMLSpanElement);
          if (target) {
            // Lazy-load only once. Hiding the sidebar must not tear down
            // already decoded avatars and force recreation on the next open.
            target.reveal(true);
            sharedObserver!.unobserve(entry.target as HTMLSpanElement);
            observedAvatars.delete(entry.target as HTMLSpanElement);
          }
        }
      },
      { rootMargin: '320px' },
    );
    return sharedObserver;
  }

  const observedAvatars = new Map<Element, ObservedAvatar>();

  interface Props {
    rounded: boolean;
    src: LazySource;
    name: string;
    size?: string;
    onClick?: any;
    bordered?: boolean;
    color?: string;
    backgroundimg?: LazySource;
    children?: import('svelte').Snippet;
    oncontextmenu?: (event: MouseEvent & {
        currentTarget: EventTarget & HTMLDivElement;
    }) => any
    chaId?: string;
    eager?: boolean;
  }

  let {
    rounded,
    src,
    name,
    size = "22",
    onClick = () => {},
    bordered = false,
    color = '',
    backgroundimg = '',
    children,
    oncontextmenu,
    chaId,
    eager = false
  }: Props = $props();

  let avatarElement: HTMLSpanElement;
  // Eager mode (short lists like recent sessions whose thumbnails are
  // batch-preloaded) skips the intersection dance entirely: rows are fully
  // rendered up front so scrolling is pure compositing.
  let sourceVisible = $state(false);
  let resolvedSrc = $derived(typeof src === 'function' ? (sourceVisible ? src() : '') : src);
  let resolvedBackground = $derived(typeof backgroundimg === 'function' ? (sourceVisible ? backgroundimg() : '') : backgroundimg);

  onMount(() => {
    if (eager || typeof IntersectionObserver === 'undefined') {
      sourceVisible = true;
      return;
    }
    const entry: ObservedAvatar = {
      element: avatarElement,
      reveal: (visible) => {
        if (visible) sourceVisible = true;
      },
    };
    observedAvatars.set(avatarElement, entry);
    observed.add(entry);
    getSharedObserver().observe(avatarElement);
    return () => {
      observedAvatars.delete(avatarElement);
      getSharedObserver().unobserve(avatarElement);
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<span class="flex shrink-0 items-center justify-center avatar"
      bind:this={avatarElement}
      class:border = {bordered}
      class:border-selected={bordered}
      class:rounded-md={bordered}
      oncontextmenu={oncontextmenu}
      onclick={onClick} use:tooltipRight={name}
      role="button"
      tabindex="0"
      data-char-id={chaId}
>
  {#if src}
    {#if src === "slot"}
      {#await resolvedBackground}
      <div
        class="bg-skin-border sidebar-avatar rounded-md bg-top flex items-center justify-center {
          color === 'red' ? 'bg-red-700/50' :
          color === 'yellow' ? 'bg-yellow-700/50' :
          color === 'green' ? 'bg-green-700/50' :
          color === 'blue' ? 'bg-blue-700/50' :
          color === 'indigo' ? 'bg-indigo-700/50' :
          color === 'purple' ? 'bg-purple-700/50' :
          color === 'pink' ? 'bg-pink-700/50' :
          'bg-darkbg/50'
        }"
        style:width={size + "px"}
        style:height={size + "px"}
        style:minWidth={size + "px"}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      ></div>
      {:then resolvedBgImg}
      <div
        class="bg-skin-border sidebar-avatar rounded-md bg-top flex items-center justify-center {
          color === 'red' ? 'bg-red-700/50' :
          color === 'yellow' ? 'bg-yellow-700/50' :
          color === 'green' ? 'bg-green-700/50' :
          color === 'blue' ? 'bg-blue-700/50' :
          color === 'indigo' ? 'bg-indigo-700/50' :
          color === 'purple' ? 'bg-purple-700/50' :
          color === 'pink' ? 'bg-pink-700/50' :
          'bg-darkbg/50'
        }"
        style:width={size + "px"}
        style:height={size + "px"}
        style:minWidth={size + "px"}
        style:background-image={resolvedBgImg ? `url('${resolvedBgImg}')` : undefined}
        style:background-size={resolvedBgImg ? "cover" : undefined}
        style:background-position={resolvedBgImg ? "center" : undefined}
        class:rounded-md={!rounded} class:rounded-full={rounded}
      >
      {#if !resolvedBgImg}
        {@render children?.()}
      {/if}
        </div>
    {/await}
    {:else}
      {#if resolvedSrc}
        {#await resolvedSrc}
          <div
            class="bg-skin-border sidebar-avatar rounded-md bg-top"
            style:width={size + "px"}
            style:height={size + "px"}
            style:minWidth={size + "px"}
            class:rounded-md={!rounded} class:rounded-full={rounded}
          ></div>
        {:then img}
          <img
            src={img}
            loading="eager"
            decoding="async"
            fetchpriority="auto"
            class="bg-skin-border sidebar-avatar rounded-md object-cover object-top"
            style:width={size + "px"}
            style:height={size + "px"}
            style:minWidth={size + "px"}
            class:rounded-md={!rounded} class:rounded-full={rounded}
            alt="avatar"
          />
        {/await}
      {:else}
        <div
          class="bg-skin-border sidebar-avatar rounded-md bg-top"
          style:width={size + "px"}
          style:height={size + "px"}
          style:minWidth={size + "px"}
          class:rounded-md={!rounded} class:rounded-full={rounded}
        ></div>
      {/if}
    {/if}
  {:else}
    <div
      class="bg-skin-border sidebar-avatar rounded-md bg-top"
      style:width={size + "px"}
      style:height={size + "px"}
      style:minWidth={size + "px"}
      class:rounded-md={!rounded} class:rounded-full={rounded} 
></div>
  {/if}
</span>
