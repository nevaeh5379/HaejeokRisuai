import type {
    AssetStorageType,
    NodeS3ProgressEvent,
    NodeS3ServerConfig,
    NodeStorageAssetDetails,
    NodeStorageAssetItem,
    NodeStorageSummary
} from 'src/ts/storage/nodeS3Storage'

export type TabType = 'bots' | 'modules' | 'backend' | 'files'
export type ViewTarget = AssetStorageType

export type BotAssetType =
    | 'avatar'
    | 'emotion'
    | 'additional'
    | 'ccAsset'
    | 'background'
    | 'audio'
    | 'moduleIcon'
    | 'moduleAsset'
    | 'other'

export interface BotAssetItem {
    key: string
    type: BotAssetType
    label: string
    size: number
}

export interface BotStorageInfo {
    id: string
    name: string
    avatarKey?: string
    totalAssets: number
    totalSizeBytes: number
    assets: BotAssetItem[]
    emotionsCount: number
    additionalAssetsCount: number
    ccAssetsCount: number
    audioCount: number
}

export interface ModuleStorageInfo {
    id: string
    name: string
    iconKey?: string
    totalAssets: number
    totalSizeBytes: number
    assets: BotAssetItem[]
}

export type FileFilterType = 'all' | 'image' | 'audio' | 'orphan'
export type FileSortType = 'size_desc' | 'size_asc' | 'name_asc' | 'name_desc'
export type BotSortType = 'size_desc' | 'size_asc' | 'count_desc' | 'name_asc'
export type ModuleSortType = 'size_desc' | 'size_asc' | 'count_desc' | 'name_asc'

export type {
    AssetStorageType,
    NodeS3ProgressEvent,
    NodeS3ServerConfig,
    NodeStorageAssetDetails,
    NodeStorageAssetItem,
    NodeStorageSummary
}
