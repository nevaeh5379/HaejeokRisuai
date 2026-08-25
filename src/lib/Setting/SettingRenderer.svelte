<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import type { LLMModel } from 'src/ts/model/types';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { getModelInfo } from 'src/ts/model/modellist';
    import { settingRegistry } from 'src/ts/setting/settingRegistry';
    import { checkCondition } from 'src/ts/setting/utils';

    interface Props {
        items: SettingItem[];
        /** Optional modelInfo, derived automatically if not provided */
        modelInfo?: LLMModel;
        /** Optional subModelInfo, derived automatically if not provided */
        subModelInfo?: LLMModel;
    }

    let { items, modelInfo, subModelInfo }: Props = $props();

    // Derive modelInfo if not provided
    let effectiveModelInfo = $derived(modelInfo ?? getModelInfo(settingsStore.state.aiModel));
    let effectiveSubModelInfo = $derived(subModelInfo ?? getModelInfo(settingsStore.state.subModel));

    // Build context for condition checks
    let ctx: SettingContext = $derived({
        db: settingsStore.state as any,
        modelInfo: effectiveModelInfo,
        subModelInfo: effectiveSubModelInfo,
    });
</script>

{#each items as item (item.id)}
    {#if checkCondition(item, ctx)}
        {@const Component = settingRegistry[item.type]}
        {#if Component}
            <div class="contents" data-setting-id={item.id}>
                <Component {item} {ctx} />
            </div>
        {:else}
            <div class="text-draculared text-xs mt-2">Unknown setting type: {item.type}</div>
        {/if}
    {/if}
{/each}
