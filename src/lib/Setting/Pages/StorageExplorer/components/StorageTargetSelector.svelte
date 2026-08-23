<script lang="ts">
    import { HardDriveIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { formatBytes } from '../utils'
    import type { NodeS3ServerConfig, NodeStorageSummary, ViewTarget } from '../types'

    interface Props {
        viewTarget: ViewTarget
        storageSummary: NodeStorageSummary | null
        config?: NodeS3ServerConfig | null
        onSwitchTarget: (target: ViewTarget) => void
        disabled?: boolean
    }

    const {
        viewTarget,
        storageSummary,
        config,
        onSwitchTarget,
        disabled = false
    }: Props = $props()
</script>

<div class="flex items-center gap-1.5 shrink-0">
    <label class="text-xs text-textcolor2 hidden sm:inline-flex items-center gap-1" for="storage-target-select">
        <HardDriveIcon class="h-3.5 w-3.5 text-textcolor2" />
        <span>{language.s3StatsStorageType ?? '스토리지'}:</span>
    </label>
    <div class="relative inline-flex items-center">
        <select
            id="storage-target-select"
            value={viewTarget}
            {disabled}
            onchange={(e) => onSwitchTarget((e.target as HTMLSelectElement).value as ViewTarget)}
            class="rounded-lg border border-darkborderc bg-darkbg pl-2.5 pr-7 py-1.5 sm:py-2 text-xs font-medium text-textcolor focus:border-darkborderc/90 focus:outline-hidden cursor-pointer appearance-none transition-colors"
        >
            <option value="s3">
                ☁️ S3 / RustFS {storageSummary?.s3 ? `(${formatBytes(storageSummary.s3.totalSizeBytes)})` : ''} {storageSummary?.activeType === 's3' ? `[${language.storageActive}]` : ''}
            </option>
            <option value="azuresql">
                🗄️ {language.storageAzureSql ?? 'Azure SQL'} {storageSummary?.azuresql ? `(${formatBytes(storageSummary.azuresql.totalSizeBytes)})` : ''} {storageSummary?.activeType === 'azuresql' ? `[${language.storageActive}]` : ''}
            </option>
            <option value="fs">
                📁 {language.storageBackendLocalFs} {storageSummary?.localFs ? `(${formatBytes(storageSummary.localFs.totalSizeBytes)})` : ''} {storageSummary?.activeType === 'fs' ? `[${language.storageActive}]` : ''}
            </option>
        </select>
        <!-- Custom down arrow indicator -->
        <div class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-textcolor2">
            ▼
        </div>
    </div>
</div>
