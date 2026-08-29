/**
 * `$state`-backed stand-in for `settingsStore.state.providerModelOverrides[role]`.
 *
 * BotSettings binds directly into the store object (`bind:value={currentOverride.*}`)
 * and Svelte relies on the source being a reactive state proxy to propagate changes
 * back into the component ("the state proxy (if it exists) should take care of the
 * notification" — svelte@5.57.0, internal/client/reactivity/props.js). A plain
 * object stub would make the test blind to re-renders, so tests use the same
 * runtime shape as the real store.
 *
 * Field types intentionally mirror `ProviderModelOverride` in
 * src/ts/storage/database/schema.ts: strings stay `undefined` while unset.
 */
export class ProviderModelOverrideState {
  ollamaCloudModel: string | undefined = $state(undefined);
  ollamaCloudModelName: string | undefined = $state(undefined);
}