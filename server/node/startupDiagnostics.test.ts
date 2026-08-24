import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    StartupTimeoutError,
    describeOracleTarget,
    describePostgresTarget,
    readStorageStartupSettings,
    runStartupStage,
    sanitizeSensitiveText,
    startupErrorHint,
} = require('./startupDiagnostics.cjs') as {
    StartupTimeoutError:new (scope:string, operation:string, timeoutMs:number) => Error
    describeOracleTarget:(tnsAlias:string, walletPath?:string) => string
    describePostgresTarget:(connectionString:string) => string
    readStorageStartupSettings:(env:Record<string, string>) => {
        startupTimeoutMs:number
        connectTimeoutMs:number
        heartbeatMs:number
    }
    runStartupStage:<T>(options:Record<string, unknown>, task:() => Promise<T>) => Promise<T>
    sanitizeSensitiveText:(value:unknown) => string
    startupErrorHint:(error:{ code?:string, message?:string }) => string
}

describe('server startup diagnostics', () => {
    it('describes PostgreSQL targets without credentials or unrelated query parameters', () => {
        const description = describePostgresTarget(
            'postgresql://risuai:super-secret@postgres:5544/risuai?sslmode=require&token=also-secret',
        )

        expect(description).toBe('postgres:5544/risuai (sslmode=require)')
        expect(description).not.toContain('super-secret')
        expect(description).not.toContain('also-secret')
        expect(description).not.toContain('risuai@')
    })

    it('redacts credentials and named secrets from error text', () => {
        const sanitized = sanitizeSensitiveText(
            'connect postgresql://user:password@db:5432/app password=hunter2 token=abc123',
        )

        expect(sanitized).toContain('postgresql://<redacted>@db:5432/app')
        expect(sanitized).toContain('password=<redacted>')
        expect(sanitized).toContain('token=<redacted>')
        expect(sanitized).not.toContain('hunter2')
        expect(sanitized).not.toContain('abc123')
    })

    it('does not print full Oracle descriptors that may contain sensitive fields', () => {
        expect(describeOracleTarget('RISU_PROD', '/wallet')).toBe('RISU_PROD (wallet configured)')
        expect(describeOracleTarget('(DESCRIPTION=(ADDRESS=(HOST=db.internal)))')).toBe('configured TNS descriptor')
    })

    it('uses bounded defaults for invalid startup timing settings', () => {
        expect(readStorageStartupSettings({
            RISU_STORAGE_STARTUP_TIMEOUT_MS: 'not-a-number',
            RISU_STORAGE_CONNECT_TIMEOUT_MS: '0',
            RISU_STORAGE_STARTUP_HEARTBEAT_MS: '999999',
        })).toEqual({
            startupTimeoutMs: 180000,
            connectTimeoutMs: 30000,
            heartbeatMs: 10000,
        })
        expect(readStorageStartupSettings({
            RISU_STORAGE_STARTUP_TIMEOUT_MS: '5000',
            RISU_STORAGE_CONNECT_TIMEOUT_MS: '30000',
        }).connectTimeoutMs).toBe(5000)
    })

    it('reports the active stage while it is slow and then completes', async () => {
        const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
        const result = await runStartupStage({
            scope: 'Test',
            operation: 'Connect database',
            heartbeatMs: 5,
            logger,
        }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 12))
            return 'ready'
        })

        expect(result).toBe('ready')
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is still running'))
        expect(logger.log).toHaveBeenLastCalledWith(expect.stringContaining('completed in'))
    })

    it('fails a stuck stage with a named timeout and actionable hint', async () => {
        const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
        const result = runStartupStage({
            scope: 'Test',
            operation: 'Apply schema',
            timeoutMs: 10,
            heartbeatMs: 5,
            logger,
        }, () => new Promise(() => {}))

        await expect(result).rejects.toBeInstanceOf(StartupTimeoutError)
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Apply schema failed'))
        expect(startupErrorHint({ code: 'RISUAI_STARTUP_TIMEOUT' })).toContain('last progress line')
        expect(startupErrorHint({ message: 'Connection terminated due to connection timeout' })).toContain('firewall')
    })

    it('keeps the innermost startup operation on propagated errors', async () => {
        const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
        const error = new Error('authentication failed') as Error & { startupOperation?:string }

        await expect(runStartupStage({
            scope: 'Outer',
            operation: 'Initialize storage',
            logger,
        }, () => runStartupStage({
            scope: 'PostgreSQL',
            operation: 'Connect and ping',
            logger,
        }, async () => { throw error }))).rejects.toBe(error)

        expect(error.startupOperation).toBe('Connect and ping')
    })
})
