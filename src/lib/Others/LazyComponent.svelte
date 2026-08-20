<script lang="ts">
    import type { Component } from 'svelte'

    interface Props {
        loader: () => Promise<{ default: Component<any> }>
        props?: Record<string, unknown>
    }

    let { loader, props = {} }: Props = $props()
    let Loaded = $state<Component<any> | null>(null)

    $effect(() => {
        let active = true
        loader().then((module) => {
            if (active) Loaded = module.default
        }).catch((error) => {
            console.error('Failed to load component', error)
        })
        return () => { active = false }
    })
</script>

{#if Loaded}
    <Loaded {...props} />
{/if}
