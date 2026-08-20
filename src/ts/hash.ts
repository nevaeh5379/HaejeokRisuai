export async function hasher(data: Uint8Array) {
    return Buffer.from(await crypto.subtle.digest('SHA-256', data as BufferSource)).toString('hex')
}
