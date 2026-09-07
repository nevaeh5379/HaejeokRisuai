<button
    type="button"
    title={(name ? name + ' ' : '') + language.showHelp}
    class="relative help inline-flex items-center cursor-pointer hover:text-green-500"
    style="vertical-align: -2px;"
    onclick={(e) => {
        e.stopPropagation();
        const content = text ?? (key ? language.help[key] : '');
        if (content) {
            alertMd(content, 'help');
        }
    }}
>
    
    {#if key === "experimental"}
        <div class="text-red-500 hover:text-green-500">
            <FlaskConicalIcon size={16} />
        </div>
    {:else if unrecommended}
        <div class="text-red-500 hover:text-green-500">
            <TriangleAlert size={14} />
        </div>
    {:else}
        <CircleQuestionMarkIcon size={14} />
    {/if}    
</button>
<script lang="ts">
    import { TriangleAlert, FlaskConicalIcon, CircleQuestionMarkIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertMd } from "src/ts/alert";

    interface Props {
        unrecommended?: boolean;
        key?: (keyof (typeof language.help));
        name?: string;
        text?: string;
    }

    let { unrecommended = false, key, name = '', text }: Props = $props();
</script>
