export type AssetStorageType = 'fs' | 's3' | 'azuresql'

export interface NodeS3ServerConfig {
    enabled: boolean
    storageType: AssetStorageType
    endpoint: string
    bucket: string
    region: string
    forcePathStyle: boolean
    autoCreateBucket: boolean
    accessKeyId: string
    hasSecretAccessKey: boolean
    accessKeyDisplay: string
    managedByEnvironment: boolean
    // Azure SQL asset storage fields (populated regardless of active backend
    // so the UI can display/switch to Azure SQL without a round-trip).
    azureServer: string
    azureDatabase: string
    azureUser: string
    azurePort: number
    hasAzurePassword: boolean
    azureManagedByEnvironment: boolean
    s3ManagedByEnvironment: boolean
}

export interface NodeS3ServerConfigUpdate {
    enabled: boolean
    storageType?: AssetStorageType
    endpoint?: string
    bucket?: string
    accessKeyId?: string
    secretAccessKey?: string
    region?: string
    forcePathStyle?: boolean
    autoCreateBucket?: boolean
    // Azure SQL asset storage fields
    azureServer?: string
    azureDatabase?: string
    azureUser?: string
    azurePassword?: string
    azurePort?: number
}

export interface NodeS3TestResult {
    success: boolean
    bucketExists: boolean
    message: string
}

export interface NodeS3Stats {
    storageType: AssetStorageType
    bucketName?: string
    endpoint?: string
    totalObjects: number
    totalSizeBytes: number
}

export interface NodeS3MigrationResult {
    total: number
    migrated: number
    skipped: number
    errors: string[]
}

export interface NodeS3RollbackResult {
    total: number
    downloaded: number
    errors: string[]
}

export interface NodeS3ThumbnailsResult {
    total: number
    created: number
    skipped: number
    errors: string[]
}

export interface NodeStorageSummary {
    activeType: AssetStorageType
    localFs: NodeS3Stats
    s3: NodeS3Stats | null
    azuresql: NodeS3Stats | null
    config: NodeS3ServerConfig
}

export interface NodeStorageAssetItem {
    key: string
    size: number
    mtime: number
}

export interface NodeStorageAssetDetails {
    storageType: AssetStorageType
    bucketName?: string
    endpoint?: string
    totalObjects: number
    totalSizeBytes: number
    assets: NodeStorageAssetItem[]
}

export interface NodeS3ProgressEvent {
    type: 'progress'
    current: number
    total: number
    migrated?: number
    skipped?: number
    downloaded?: number
    created?: number
    percentage: number
    currentKey?: string
}

export interface NodeDatabaseBinHashes {
    activeType: AssetStorageType
    local: { exists: boolean; hash: string | null; size: number; error?: string } | null
    s3: { exists: boolean; hash: string | null; size: number; error?: string } | null
    azuresql: { exists: boolean; hash: string | null; size: number; error?: string } | null
    same: boolean | null
}

async function responseError(response: Response, fallback: string) {
    const body = await response.json().catch(() => null)
    return new Error(body?.error || `${fallback} (${response.status})`)
}

export class NodeS3Storage {
    constructor(private readonly getAuth: () => Promise<string>) {}

    private async authHeaders() {
        return {
            'risu-auth': await this.getAuth()
        }
    }

    async getServerConfig(): Promise<NodeS3ServerConfig> {
        const response = await fetch('/api/s3-config', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'S3 storage configuration load failed')
        }
        return await response.json()
    }

    async configureServer(update: NodeS3ServerConfigUpdate): Promise<NodeS3ServerConfig> {
        const response = await fetch('/api/s3-config', {
            method: 'POST',
            body: JSON.stringify(update),
            headers: {
                'content-type': 'application/json',
                ...await this.authHeaders()
            }
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'S3 storage configuration update failed')
        }
        const data = await response.json()
        return data.config
    }

    async testConnection(config: NodeS3ServerConfigUpdate): Promise<NodeS3TestResult> {
        const response = await fetch('/api/s3-test', {
            method: 'POST',
            body: JSON.stringify(config),
            headers: {
                'content-type': 'application/json',
                ...await this.authHeaders()
            }
        })
        if (response.status < 200 || response.status >= 300) {
            const body = await response.json().catch(() => null)
            return {
                success: false,
                bucketExists: false,
                message: body?.message || body?.error || `Connection test failed (${response.status})`
            }
        }
        return await response.json()
    }

    async getStats(): Promise<NodeS3Stats> {
        const response = await fetch('/api/s3-stats', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to fetch storage stats')
        }
        return await response.json()
    }

    async getDatabaseBinHashes(): Promise<NodeDatabaseBinHashes> {
        const response = await fetch('/api/db-hash', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to fetch database.bin hashes')
        }
        return await response.json()
    }

    async resolveDatabaseBinConflict(keep: 'local' | 's3' | 'azuresql'): Promise<{ ok: boolean; size: number; error?: string }> {
        const response = await fetch(`/api/db-resolve?keep=${keep}`, {
            method: 'POST',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to resolve database.bin conflict')
        }
        return await response.json()
    }

    async migrateLocalToS3(onProgress?: (event: NodeS3ProgressEvent) => void): Promise<NodeS3MigrationResult> {
        const response = await fetch('/api/s3-migrate', {
            method: 'POST',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Local to S3 migration failed')
        }

        const reader = response.body?.getReader()
        if (!reader) {
            return await response.json()
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let finalResult: NodeS3MigrationResult = { total: 0, migrated: 0, skipped: 0, errors: [] }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line)
                    if (parsed.type === 'progress') {
                        onProgress?.(parsed)
                    } else if (parsed.type === 'done') {
                        finalResult = {
                            total: parsed.total,
                            migrated: parsed.migrated,
                            skipped: parsed.skipped,
                            errors: parsed.errors || []
                        }
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error)
                    }
                } catch (err: any) {
                    if (err?.message && !err.message.includes('JSON')) {
                        throw err
                    }
                }
            }
        }

        return finalResult
    }

    async rollbackS3ToLocal(onProgress?: (event: NodeS3ProgressEvent) => void): Promise<NodeS3RollbackResult> {
        const response = await fetch('/api/s3-rollback', {
            method: 'POST',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'S3 to local rollback failed')
        }

        const reader = response.body?.getReader()
        if (!reader) {
            return await response.json()
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let finalResult: NodeS3RollbackResult = { total: 0, downloaded: 0, errors: [] }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line)
                    if (parsed.type === 'progress') {
                        onProgress?.(parsed)
                    } else if (parsed.type === 'done') {
                        finalResult = {
                            total: parsed.total,
                            downloaded: parsed.downloaded,
                            errors: parsed.errors || []
                        }
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error)
                    }
                } catch (err: any) {
                    if (err?.message && !err.message.includes('JSON')) {
                        throw err
                    }
                }
            }
        }

        return finalResult
    }

    async generateMissingThumbnails(onProgress?: (event: NodeS3ProgressEvent) => void): Promise<NodeS3ThumbnailsResult> {
        const response = await fetch('/api/s3-generate-thumbnails', {
            method: 'POST',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'S3 thumbnail generation failed')
        }

        const reader = response.body?.getReader()
        if (!reader) {
            return await response.json()
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let finalResult: NodeS3ThumbnailsResult = { total: 0, created: 0, skipped: 0, errors: [] }

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const parsed = JSON.parse(line)
                    if (parsed.type === 'progress') {
                        onProgress?.(parsed)
                    } else if (parsed.type === 'done') {
                        finalResult = {
                            total: parsed.total,
                            created: parsed.created,
                            skipped: parsed.skipped,
                            errors: parsed.errors || []
                        }
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error)
                    }
                } catch (err: any) {
                    if (err?.message && !err.message.includes('JSON')) {
                        throw err
                    }
                }
            }
        }

        return finalResult
    }

    async getStorageSummary(): Promise<NodeStorageSummary> {
        const response = await fetch('/api/storage-summary', {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to fetch storage summary')
        }
        return await response.json()
    }

    async getAssetDetails(target: 'active' | 'fs' | 's3' | 'azuresql' = 'active'): Promise<NodeStorageAssetDetails> {
        const url = target === 'active' ? '/api/s3-asset-details' : `/api/s3-asset-details?target=${target}`
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-cache',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to fetch asset details')
        }
        return await response.json()
    }

    async deleteAssetKeys(keys: string[], target: 'active' | 'fs' | 's3' | 'azuresql' = 'active'): Promise<{ deleted: number }> {
        const response = await fetch('/api/storage-assets-delete', {
            method: 'POST',
            body: JSON.stringify({ keys, target }),
            headers: {
                'content-type': 'application/json',
                ...await this.authHeaders()
            }
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to delete assets')
        }
        return await response.json()
    }

    async cleanLocalFs(): Promise<{ deleted: number; freedBytes: number }> {
        const response = await fetch('/api/storage-local-clean', {
            method: 'POST',
            headers: await this.authHeaders()
        })
        if (response.status < 200 || response.status >= 300) {
            throw await responseError(response, 'Failed to clean local storage')
        }
        return await response.json()
    }
}
