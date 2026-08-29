<!--
    Reproduction fixture for the `props_invalid_value` crash reported on Risu b6595
    (https://svelte.dev/e/props_invalid_value).

    This carries the exact `value` prop signature that `src/lib/UI/ModelGrid.svelte`
    had when the crash was reported: a two-way-bindable prop WITH a fallback value.
    Svelte 5 throws `props_invalid_value` when `undefined` arrives through a `bind:`
    into such a prop (see svelte@5.57.0, internal/client/reactivity/props.js).
-->
<script lang="ts">
    let { value = $bindable('') }: { value?: string } = $props()
</script>

<p>{value || '–'}</p>