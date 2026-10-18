<script lang="ts">
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";

    interface Props {
        title: string;
        help?: keyof typeof language.help;
        anchorId?: string;
        open?: boolean;
        children?: import("svelte").Snippet;
    }

    let { title, help, anchorId, open = $bindable(false), children }: Props = $props();
</script>

<section
    class="overflow-hidden rounded-2xl border border-textcolor/10 bg-darkbg"
    data-setting-id={anchorId}
>
    <button
        type="button"
        class="flex w-full items-center justify-between gap-2 border-b-textcolor/10 px-4 py-3.5 text-left transition-colors hover:bg-textcolor/5 sm:px-5"
        class:border-b={open}
        onclick={() => (open = !open)}
    >
        <div class="flex min-w-0 items-center gap-2">
            <h3 class="font-bold">{title}</h3>
            {#if help}
                <Help key={help} />
            {/if}
        </div>
        {#if open}
            <ChevronDownIcon size={16} class="shrink-0 text-textcolor2" />
        {:else}
            <ChevronRightIcon size={16} class="shrink-0 text-textcolor2" />
        {/if}
    </button>
    {#if open}
        <div class="flex flex-col gap-3 p-4 sm:p-5">
            {@render children?.()}
        </div>
    {/if}
</section>