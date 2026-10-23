<script lang="ts">
    import { createDatabaseSnapshot } from "src/ts/storage/database/databaseSnapshot";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { alertError, alertMd, alertNormal } from "src/ts/alert";
    import { downloadFile, getRequestLog } from "src/ts/globalApi.svelte";
    
    import { isCapacitorAndroid, isNodeServer, isTauri } from "src/ts/platform";
    import { shareAndroidDiagnostics } from "src/ts/android/androidCrashDiagnostics";

    const SHARED_TEXT_ENCODER = new TextEncoder();
    const KEYS_TO_REMOVE = new Set([
        'characters', 'loreBook', 'plugins', 'account', 'personas', 'username', 'userIcon', 'userNote',
        'modules', 'enabledModules', 'botPresets', 'characterOrder', 'webUiUrl',
        'hordeConfig', 'novelai', 'koboldURL', 'ooba', 'ainconfig', 'personaPrompt', 'promptTemplate',
        'deeplOptions', 'google', 'customPromptTemplateToggle', 'globalChatVariables', 'comfyConfig',
        'comfyUiUrl', 'translatorPrompt', 'translatorPresets', 'translatorPresetId', 'customModels', 'mcpURLs', 'authRefreshes'
    ]);
</script>

{#if isCapacitorAndroid}
    <Button
        className="mt-4"
        onclick={async () => {
            try {
                await shareAndroidDiagnostics();
            } catch {
                alertError(language.androidDiagnosticsShareFailed);
            }
        }}
    >
        {language.androidDiagnosticsShare}
    </Button>
{/if}

<Button
    className="mt-4"
    onclick={async () => {
        alertMd(getRequestLog())
    }}
>
    {language.ShowLog}
</Button>

<Button
    className="mt-4"
    onclick={async () => {
        let mdTable = "| Type | Value |\n| --- | --- |\n"
        const s = settingsStore.state.statics
        for (const key in s) {
            mdTable += `| ${key} | ${s[key]} |\n`
        }
        mdTable += `\n\n<small>${language.staticsDisclaimer}</small>`
        alertMd(mdTable)
    }}
>
Show Statistics
</Button>

<Button
    className="mt-4"
    onclick={async () => {
        const db = createDatabaseSnapshot() as unknown as Record<string, unknown>

        for (const key in db) {
            const lower = key.toLowerCase()
            if (
                KEYS_TO_REMOVE.has(key) ||
                lower.includes('key') || lower.includes('proxy') ||
                lower.includes('hypa')
            ) {
                delete db[key]
            }
        }

        db.meta = {
            isTauri: isTauri,
            isNodeServer: isNodeServer,
            protocol: location.protocol
        }

        const json = JSON.stringify(db, null, 2)
        await downloadFile('risuai-settings-report.json', SHARED_TEXT_ENCODER.encode(json))
        await navigator.clipboard.writeText(json)
        alertNormal(language.settingsExported)
    }}
>
Export Settings for Bug Report
</Button>
