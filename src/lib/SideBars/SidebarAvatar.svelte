<script lang="ts">
  import { onMount } from "svelte";
  import { tooltipRight } from "src/ts/gui/tooltip";

  type LazySource = string | Promise<string> | (() => string | Promise<string>);

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
    chaId
  }: Props = $props();

  let avatarElement: HTMLSpanElement;
  let sourceVisible = $state(false);
  let resolvedSrc = $derived(typeof src === 'function' ? (sourceVisible ? src() : '') : src);
  let resolvedBackground = $derived(typeof backgroundimg === 'function' ? (sourceVisible ? backgroundimg() : '') : backgroundimg);

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') {
      sourceVisible = true;
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        // Lazy-load only once. Hiding the sidebar must not tear down already
        // decoded avatars and force every icon to be recreated on the next open.
        sourceVisible = true;
        observer.disconnect();
      }
    }, { rootMargin: '320px' });
    observer.observe(avatarElement);
    return () => observer.disconnect();
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
