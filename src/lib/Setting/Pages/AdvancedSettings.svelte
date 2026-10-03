<script lang="ts">
    import GlobalAuthorNoteSettings from "./GlobalAuthorNoteSettings.svelte";
    import { advancedSettingsItems } from "src/ts/setting/advancedSettingsData";
    import { usesAndroidNativeIntegration } from "src/ts/android/androidNativeIntegration";
    import SettingRenderer from "../SettingRenderer.svelte";
    import AndroidIntegrationSettings from "./AndroidIntegrationSettings.svelte";
</script>

<GlobalAuthorNoteSettings />
<SettingRenderer items={advancedSettingsItems} />
{#if usesAndroidNativeIntegration()}
    <AndroidIntegrationSettings />
{/if}
