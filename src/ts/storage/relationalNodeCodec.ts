export const RELATIONAL_SCHEMA_LAYOUT = 'relational-schema-v2'
export const SQLITE_SCHEMA_VERSION = 2
export const MAX_RELATIONAL_NODE_DEPTH = 128
export const MAX_RELATIONAL_NODE_ROWS = 250_000

export class SqlSchemaResetRequiredError extends Error {
    constructor(foundVersion: unknown, foundLayout: unknown) {
        super(`Local database reset required: found ${String(foundVersion)}/${String(foundLayout)}, expected ${SQLITE_SCHEMA_VERSION}/${RELATIONAL_SCHEMA_LAYOUT}`)
        this.name = 'SqlSchemaResetRequiredError'
    }
}

export type RelationalNodeType =
    | 'null' | 'undefined' | 'boolean' | 'number' | 'string'
    | 'array' | 'object'

export interface RelationalNodeRow {
    [key: string]: unknown
    node_id: number
    parent_node_id: number | null
    node_order: number
    object_key: string | null
    object_key_encoded: string | null
    value_type: RelationalNodeType
    text_value: string | null
    encoded_text_value: string | null
    number_value: number | null
    boolean_value: number | null
}

export interface RelationalNodeCodecOptions {
    maxDepth?: number
    maxRows?: number
}

function bytesToBase64(bytes: Uint8Array): string {
    if (typeof btoa === 'function') {
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary)
    }
    return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(value: string): Uint8Array {
    if (typeof atob === 'function') {
        const binary = atob(value)
        return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    }
    return Uint8Array.from(Buffer.from(value, 'base64'))
}

function encodeUtf16(value: string): string {
    const bytes = new Uint8Array(value.length * 2)
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        bytes[index * 2] = code & 0xff
        bytes[index * 2 + 1] = code >>> 8
    }
    return bytesToBase64(bytes)
}

function decodeUtf16(value: string): string {
    const bytes = base64ToBytes(value)
    if (bytes.length % 2 !== 0) throw new Error('Invalid UTF-16 relational node value')
    let result = ''
    // Avoid apply/spread argument limits for large prompts.
    for (let index = 0; index < bytes.length; index += 2) {
        result += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8))
    }
    return result
}

function isSqlTextSafe(value: string): boolean {
    if (value.includes('\0')) return false
    // TextEncoder replaces unpaired surrogates. A round trip therefore also
    // acts as the portability check shared by SQLite, PostgreSQL, and Oracle.
    return new TextDecoder().decode(new TextEncoder().encode(value)) === value
}

function encodedText(value: string): { text: string | null; encoded: string | null } {
    return isSqlTextSafe(value)
        ? { text: value, encoded: null }
        : { text: null, encoded: encodeUtf16(value) }
}

function decodedText(text: unknown, encoded: unknown): string {
    if (encoded !== null && encoded !== undefined) return decodeUtf16(String(encoded))
    return String(text ?? '')
}

function defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    })
}

/**
 * Flattens a JavaScript value into typed adjacency-list rows. No JSON text is
 * involved, and empty containers, null, object insertion order, NUL, and
 * unpaired UTF-16 surrogates survive a round trip.
 */
export function flattenRelationalValue(
    value: unknown,
    options: RelationalNodeCodecOptions = {},
): RelationalNodeRow[] {
    const maxDepth = options.maxDepth ?? MAX_RELATIONAL_NODE_DEPTH
    const maxRows = options.maxRows ?? MAX_RELATIONAL_NODE_ROWS
    const rows: RelationalNodeRow[] = []
    const ancestors = new Set<object>()

    const append = (
        current: unknown,
        parentNodeId: number | null,
        nodeOrder: number,
        key: string | null,
        depth: number,
    ): void => {
        if (depth > maxDepth) throw new Error(`Relational value exceeds maximum depth ${maxDepth}`)
        if (rows.length >= maxRows) throw new Error(`Relational value exceeds maximum row count ${maxRows}`)

        const nodeId = rows.length
        const encodedKey = key === null ? { text: null, encoded: null } : encodedText(key)
        const row: RelationalNodeRow = {
            node_id: nodeId,
            parent_node_id: parentNodeId,
            node_order: nodeOrder,
            object_key: encodedKey.text,
            object_key_encoded: encodedKey.encoded,
            value_type: 'null',
            text_value: null,
            encoded_text_value: null,
            number_value: null,
            boolean_value: null,
        }
        rows.push(row)

        if (current === null) return
        if (current === undefined) { row.value_type = 'undefined'; return }
        if (typeof current === 'boolean') { row.value_type = 'boolean'; row.boolean_value = current ? 1 : 0; return }
        if (typeof current === 'number') {
            row.value_type = 'number'
            if (Number.isFinite(current)) row.number_value = current
            else row.text_value = Number.isNaN(current) ? 'NaN' : current > 0 ? 'Infinity' : '-Infinity'
            return
        }
        if (typeof current === 'string') {
            row.value_type = 'string'
            const encoded = encodedText(current)
            row.text_value = encoded.text
            row.encoded_text_value = encoded.encoded
            return
        }
        if (typeof current !== 'object') {
            throw new TypeError(`Unsupported relational value type: ${typeof current}`)
        }
        if (ancestors.has(current)) throw new TypeError('Relational values cannot contain cycles')
        ancestors.add(current)
        row.value_type = Array.isArray(current) ? 'array' : 'object'
        if (Array.isArray(current)) {
            current.forEach((item, index) => append(item, nodeId, index, null, depth + 1))
        } else {
            Object.entries(current).forEach(([childKey, item], index) => append(item, nodeId, index, childKey, depth + 1))
        }
        ancestors.delete(current)
    }

    append(value, null, 0, null, 0)
    return rows
}

export function rebuildRelationalValue(input: readonly Record<string, unknown>[]): unknown {
    if (input.length === 0) throw new Error('Relational value has no root node')
    const rows = [...input].sort((left, right) => Number(left.node_id) - Number(right.node_id))
    if (Number(rows[0].node_id) !== 0 || rows[0].parent_node_id !== null) {
        throw new Error('Relational value has an invalid root node')
    }
    const children = new Map<number, Record<string, unknown>[]>()
    for (const row of rows.slice(1)) {
        const parent = Number(row.parent_node_id)
        if (!Number.isSafeInteger(parent)) throw new Error('Relational node has no parent')
        const list = children.get(parent) ?? []
        list.push(row)
        children.set(parent, list)
    }
    for (const list of children.values()) {
        list.sort((left, right) => Number(left.node_order) - Number(right.node_order))
    }

    const build = (row: Record<string, unknown>, depth: number): unknown => {
        if (depth > MAX_RELATIONAL_NODE_DEPTH) throw new Error('Relational value exceeds maximum depth')
        switch (row.value_type) {
            case 'null': return null
            case 'undefined': return undefined
            case 'boolean': return Boolean(row.boolean_value)
            case 'number': {
                if (row.text_value === 'NaN') return Number.NaN
                if (row.text_value === 'Infinity') return Number.POSITIVE_INFINITY
                if (row.text_value === '-Infinity') return Number.NEGATIVE_INFINITY
                return Number(row.number_value)
            }
            case 'string': return decodedText(row.text_value, row.encoded_text_value)
            case 'array': return (children.get(Number(row.node_id)) ?? []).map((child) => build(child, depth + 1))
            case 'object': {
                const result: Record<string, unknown> = {}
                for (const child of children.get(Number(row.node_id)) ?? []) {
                    const key = decodedText(child.object_key, child.object_key_encoded)
                    defineEntry(result, key, build(child, depth + 1))
                }
                return result
            }
            default: throw new Error(`Unknown relational node type: ${String(row.value_type)}`)
        }
    }
    return build(rows[0], 0)
}

export const RELATIONAL_NODE_COLUMNS = [
    'node_id', 'parent_node_id', 'node_order', 'object_key', 'object_key_encoded',
    'value_type', 'text_value', 'encoded_text_value', 'number_value', 'boolean_value',
] as const
