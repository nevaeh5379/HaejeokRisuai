<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { alertConfirm, alertError, alertNormal } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { getDatabase } from 'src/ts/storage/database.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import type { NodePostgresRevision, NodePostgresServerConfig, NodePostgresTokenUsage } from 'src/ts/storage/nodePostgresStorage'
    import { encodeRisuSaveLegacy } from 'src/ts/storage/risuSave'

    let config = $state<NodePostgresServerConfig|null>(null)
    let enabled = $state(false)
    let connectionString = $state('')
    let poolMax = $state(10)
    let busy = $state(false)
    let loadError = $state('')
    let revisions = $state<NodePostgresRevision[]>([])
    let tokenUsage = $state<NodePostgresTokenUsage[]>([])

    function getNodeStorage() {
        if(!(forageStorage.realStorage instanceof NodeStorage)){
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function refresh() {
        busy = true
        loadError = ''
        try {
            config = await getNodeStorage().postgres.getServerConfig()
            enabled = config.enabled
            poolMax = config.poolMax
            revisions = config.enabled ? await getNodeStorage().postgres.listRevisions(20) : []
            tokenUsage = config.enabled ? await getNodeStorage().postgres.getTokenUsage() : []
        } catch (error) {
            loadError = `${error}`
        } finally {
            busy = false
        }
    }

    async function restoreRevision(revision:NodePostgresRevision) {
        if(busy || !await alertConfirm(language.postgresRestoreConfirm(revision.id))){
            return
        }
        busy = true
        try {
            await getNodeStorage().postgres.restoreRevision(revision.id)
            alertNormal(language.postgresRestoreSuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    async function applyConfiguration() {
        if(!config || config.managedByEnvironment || busy){
            return
        }
        if(!await alertConfirm(language.postgresApplyConfirm)){
            return
        }

        busy = true
        try {
            const storage = getNodeStorage()
            let legacySnapshotReady = false
            if(config.enabled){
                const snapshot = encodeRisuSaveLegacy(
                    getDatabase({ snapshot: true }),
                    'compression'
                )
                await storage.setItem('database/database.bin', snapshot)
                legacySnapshotReady = true
            }
            await storage.postgres.configureServer({
                enabled,
                connectionString: connectionString.trim() || undefined,
                poolMax,
                legacySnapshotReady,
            })
            alertNormal(language.postgresApplySuccess)
            setTimeout(() => location.reload(), 300)
        } catch (error) {
            alertError(error)
            busy = false
        }
    }

    onMount(refresh)
</script>

<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/40 p-4 text-textcolor">
    <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
            <h3 class="text-base font-semibold">{language.postgresStorage}</h3>
            <p class="mt-1 text-sm text-textcolor2">{language.postgresStorageDescription}</p>
        </div>
        {#if config}
            <span class="rounded-full px-2 py-1 text-xs {config.enabled ? 'bg-selected text-textcolor' : 'bg-darkbutton text-textcolor2'}">
                {config.enabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
            </span>
        {/if}
    </div>

    {#if loadError}
        <p class="mt-3 rounded-md border border-draculared/50 bg-draculared/10 p-2 text-sm text-draculared">{loadError}</p>
    {:else if !config}
        <p class="mt-3 text-sm text-textcolor2">{language.postgresStatusLoading}</p>
    {:else}
        {#if config.managedByEnvironment}
            <p class="mt-3 rounded-md border border-borderc bg-bgcolor/40 p-2 text-sm text-textcolor2">
                {language.postgresEnvironmentManaged}
            </p>
        {/if}

        <div class="mt-4 {config.managedByEnvironment ? 'pointer-events-none opacity-60' : ''}">
            <CheckInput bind:check={enabled} name={language.usePostgresStorage} />
        </div>

        <label class="mt-4 block text-sm text-textcolor2" for="postgres-connection-string">
            {language.postgresConnectionString}
        </label>
        <TextInput
            id="postgres-connection-string"
            bind:value={connectionString}
            hideText={true}
            fullwidth={true}
            disabled={config.managedByEnvironment}
            placeholder={config.connectionDisplay || 'postgresql://user:password@host:5432/database'}
            className="mt-1"
        />
        <p class="mt-1 text-xs text-textcolor2">{language.postgresConnectionSecurity}</p>

        <label class="mt-4 block text-sm text-textcolor2" for="postgres-pool-size">
            {language.postgresPoolSize}
        </label>
        <NumberInput
            id="postgres-pool-size"
            bind:value={poolMax}
            min={1}
            max={100}
            fullwidth={true}
            disabled={config.managedByEnvironment}
            className="mt-1"
        />

        {#if config.enabled}
            <p class="mt-3 text-xs text-textcolor2">
                {language.postgresRevision}: {config.revision ?? 0} · {config.initialized ? language.postgresInitialized : language.postgresWaitingMigration}
            </p>
        {/if}

        {#if !config.managedByEnvironment}
            <Button className="mt-4" disabled={busy} onclick={applyConfiguration}>
                {busy ? language.postgresApplying : language.postgresApply}
            </Button>
        {/if}

        {#if config.enabled}
            <div class="mt-5 border-t border-darkborderc pt-4">
                <h4 class="text-sm font-semibold">{language.postgresTokenUsage}</h4>
                <p class="mt-1 text-xs text-textcolor2">{language.postgresTokenUsageDescription}</p>
                {#if tokenUsage.length === 0}
                    <p class="mt-3 text-sm text-textcolor2">{language.postgresTokenUsageEmpty}</p>
                {:else}
                    <div class="mt-3 max-h-72 space-y-2 overflow-y-auto">
                        {#each tokenUsage as usage}
                            <div class="flex items-center justify-between gap-3 rounded-md border border-darkborderc bg-bgcolor/30 p-2">
                                <div class="min-w-0 text-xs">
                                    <div class="font-medium text-textcolor">{usage.model}</div>
                                    <div class="mt-0.5 text-textcolor2">
                                        {usage.messageCount} {language.postgresTokenUsageMessages}
                                    </div>
                                </div>
                                <div class="text-right text-xs text-textcolor2">
                                    <div>{language.postgresTokenUsageInput}: {usage.totalInputTokens.toLocaleString()}</div>
                                    <div>{language.postgresTokenUsageOutput}: {usage.totalOutputTokens.toLocaleString()}</div>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            <div class="mt-5 border-t border-darkborderc pt-4">
                <h4 class="text-sm font-semibold">{language.postgresHistory}</h4>
                <p class="mt-1 text-xs text-textcolor2">{language.postgresHistoryDescription}</p>
                {#if revisions.length === 0}
                    <p class="mt-3 text-sm text-textcolor2">{language.postgresHistoryEmpty}</p>
                {:else}
                    <div class="mt-3 max-h-72 space-y-2 overflow-y-auto">
                        {#each revisions as revision}
                            <div class="flex items-center justify-between gap-3 rounded-md border border-darkborderc bg-bgcolor/30 p-2">
                                <div class="min-w-0 text-xs">
                                    <div class="font-medium text-textcolor">
                                        #{revision.id} · {revision.scope} / {revision.action}
                                    </div>
                                    <div class="mt-0.5 text-textcolor2">
                                        {new Date(revision.created_at).toLocaleString()} · {revision.change_count} {language.postgresHistoryChanges}
                                    </div>
                                </div>
                                <Button disabled={busy || revision.id === revisions[0]?.id} onclick={() => restoreRevision(revision)}>
                                    {language.postgresRestore}
                                </Button>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}
    {/if}
</section>
