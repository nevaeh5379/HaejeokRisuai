<script lang="ts">
    import { advancedSettingsItems } from "src/ts/setting/advancedSettingsData";
    import { usesAndroidNativeIntegration } from "src/ts/androidNativeIntegration";
    import SettingRenderer from "../SettingRenderer.svelte";
    import AndroidIntegrationSettings from "./AndroidIntegrationSettings.svelte";
</script>

<SettingRenderer items={advancedSettingsItems} />
{#if usesAndroidNativeIntegration()}
    <AndroidIntegrationSettings />
{/if}
