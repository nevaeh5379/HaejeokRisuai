import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"
import { NodePostgresStorage } from "./nodePostgresStorage"
import { NodeS3Storage } from "./nodeS3Storage"

export {
    NodePostgresPayloadTooLargeError,
    NodePostgresRevisionConflictError,
} from "./nodePostgresStorage"
export {
    type NodeS3ServerConfig,
    type NodeS3ServerConfigUpdate,
    type NodeS3Stats,
    type NodeS3TestResult,
    type NodeS3MigrationResult,
    type NodeS3RollbackResult,
    type NodeS3ThumbnailsResult,
    type NodeS3ProgressEvent,
    type NodeStorageAssetItem,
    type NodeStorageAssetDetails,
    type NodeStorageSummary,
} from "./nodeS3Storage"

export type NodeStorageBulkReadProgress = {
    completedFiles: number
    totalFiles: number
    currentFile: string | null
    receivedBytes: number
    totalBytes: bigint
}

export type NodeStorageBulkReadHandlers = {
    onFileStart: (name: string, size: bigint) => Promise<void> | void
    onFileChunk: (name: string, chunk: Uint8Array) => Promise<void> | void
    onFileEnd?: (name: string) => Promise<void> | void
}

export type NodeStorageBulkWriteProgress = {
    uploadedBytes: number
    totalBytes: number
    percent: number
}

export class NodeStorage{

    authChecked = false
    readonly postgres = new NodePostgresStorage(async () => {
        await this.checkAuth()
        return await this.createAuth()
    })
    readonly s3 = new NodeS3Storage(async () => {
        await this.checkAuth()
        return await this.createAuth()
    })
    JSONStringlifyAndbase64Url(obj:any){
        return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'))
    }

    async createAuth(){
        const keyPair = await this.getKeyPair()
        const date = Math.floor(Date.now() / 1000)

        const header = {
            alg: "ES256",
            typ: "JWT",
        }
        const payload = {
            iat: date,
            exp: date + 5 * 60, //5 minutes expiration
            pub: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        }
        const sig = await crypto.subtle.sign(
            {
                name: "ECDSA",
                hash: "SHA-256"
            },
            keyPair.privateKey,
            Buffer.from(
                this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload)
            )
        )
        const sigString = base64url(new Uint8Array(sig))
        return this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload) + "." + sigString
    }

    private cachedAuthToken: string = ''
    private cachedAuthTokenExpiresAt: number = 0

    async getCachedAuth(): Promise<string> {
        const now = Math.floor(Date.now() / 1000)
        if (!this.cachedAuthToken || this.cachedAuthTokenExpiresAt - now < 60) {
            await this.checkAuth()
            this.cachedAuthToken = await this.createAuth()
            this.cachedAuthTokenExpiresAt = now + 4 * 60
        }
        return this.cachedAuthToken
    }

    async getDirectUrl(key: string, options?: { thumbnail?: boolean }): Promise<string> {
        const auth = await this.getCachedAuth()
        const hex = Buffer.from(key, 'utf-8').toString('hex')
        const thumbParam = options?.thumbnail ? '&thumb=1' : ''
        return `/api/read?path=${hex}${thumbParam}&auth=${encodeURIComponent(auth)}`
    }

    async getProxyAuth() {
        await this.checkAuth()
        const auth = await this.createAuth()
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('risuauth', auth)
        }
        return auth
    }

    async getKeyPair():Promise<CryptoKeyPair>{
        
        const storedKey = await getKeypairStore('node')

        if(storedKey){
            return storedKey
        }

        const keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            false,
            ["sign", "verify"],
        );

        await saveKeypairStore('node', keyPair)

        return keyPair

    }

    async setItem(key:string, value:Uint8Array) {
        await this.checkAuth()
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    async setItems(
        items: ReadonlyMap<string, Uint8Array>,
        onProgress?: (progress: NodeStorageBulkWriteProgress) => void
    ):Promise<void> {
        await this.checkAuth()

        const parts: BlobPart[] = []
        const chunkSize = 256 * 1024
        let fileId = 0

        for(const [name, data] of items){
            const nameBuffer = Buffer.from(name, 'utf8')
            const header = Buffer.alloc(1 + 4 + 4 + nameBuffer.length + 8)
            let offset = 0

            header.writeUInt8(0x01, offset)
            offset += 1
            header.writeUInt32BE(fileId, offset)
            offset += 4
            header.writeUInt32BE(nameBuffer.length, offset)
            offset += 4
            nameBuffer.copy(header, offset)
            offset += nameBuffer.length
            header.writeBigUInt64BE(BigInt(data.byteLength), offset)
            parts.push(header as unknown as BlobPart)

            for(let dataOffset=0;dataOffset<data.byteLength;dataOffset+=chunkSize){
                const chunk = data.subarray(
                    dataOffset,
                    Math.min(dataOffset + chunkSize, data.byteLength)
                )
                const chunkHeader = Buffer.alloc(1 + 4 + 4)
                chunkHeader.writeUInt8(0x02, 0)
                chunkHeader.writeUInt32BE(fileId, 1)
                chunkHeader.writeUInt32BE(chunk.byteLength, 5)
                parts.push(chunkHeader as unknown as BlobPart)
                parts.push(chunk as unknown as BlobPart)
            }

            const end = Buffer.alloc(1 + 4)
            end.writeUInt8(0x03, 0)
            end.writeUInt32BE(fileId, 1)
            parts.push(end as unknown as BlobPart)
            fileId += 1
        }

        const body = new Blob(parts, { type: 'application/x-risu-bulk' })
        const auth = await this.createAuth()

        await new Promise<void>((resolve, reject) => {
            const request = new XMLHttpRequest()
            request.open('POST', '/api/write-bulk')
            request.responseType = 'json'
            request.setRequestHeader('content-type', body.type)
            request.setRequestHeader('risu-auth', auth)

            request.upload.onprogress = (event) => {
                const totalBytes = event.lengthComputable ? event.total : body.size
                const percent = totalBytes === 0
                    ? 100
                    : Math.min(100, event.loaded / totalBytes * 100)
                onProgress?.({
                    uploadedBytes: event.loaded,
                    totalBytes,
                    percent
                })
            }
            request.onerror = () => reject(new Error('setItems network error'))
            request.onabort = () => reject(new Error('setItems request aborted'))
            request.onload = () => {
                if(request.status < 200 || request.status >= 300){
                    const message = request.response?.error
                        ?? `setItems Error: ${request.status}`
                    reject(new Error(message))
                    return
                }
                onProgress?.({
                    uploadedBytes: body.size,
                    totalBytes: body.size,
                    percent: 100
                })
                resolve()
            }

            request.send(body)
        })
    }

    async getItem(key:string, options?: { thumbnail?: boolean }):Promise<Buffer> {
        await this.checkAuth()
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex'),
            'risu-auth': await this.createAuth()
        }
        if (options?.thumbnail) {
            headers['x-thumbnail'] = 'true'
        }
        const da = await fetch('/api/read' + (options?.thumbnail ? '?thumb=1' : ''), {
            method: "GET",
            cache: 'no-cache',
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }

    async getItemFromBrowserCache(key:string, options?: { thumbnail?: boolean }):Promise<Buffer|null> {
        await this.checkAuth()
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex'),
            'risu-auth': await this.createAuth()
        }
        if (options?.thumbnail) {
            headers['x-thumbnail'] = 'true'
        }
        let da: Response
        try {
            da = await fetch('/api/read' + (options?.thumbnail ? '?thumb=1' : ''), {
                method: "GET",
                cache: 'force-cache',
                headers
            })
        } catch {
            return null
        }
        if(da.status < 200 || da.status >= 300){
            return null
        }
        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }

    async getItems(
      keys: string[],
      onProgress?: (progress: NodeStorageBulkReadProgress) => void,
      options?: { thumbnail?: boolean }
    ): Promise<Map<string, Buffer>> {
      const results = new Map<string, Buffer>()
      const receivingChunks = new Map<string, Buffer[]>()

      await this.streamItems(keys, {
          onFileStart: (name) => {
              receivingChunks.set(name, [])
          },
          onFileChunk: (name, chunk) => {
              const chunks = receivingChunks.get(name)
              if (!chunks) {
                  throw new Error(`Received chunk before file start: ${name}`)
              }
              chunks.push(Buffer.from(chunk))
          },
          onFileEnd: (name) => {
              const chunks = receivingChunks.get(name)
              if (!chunks) {
                  throw new Error(`Received file end before file start: ${name}`)
              }
              results.set(name, Buffer.concat(chunks))
              receivingChunks.delete(name)
          }
      }, onProgress, options)

      return results
    }

    async streamItems(
      keys: string[],
      handlers: NodeStorageBulkReadHandlers,
      onProgress?: (progress: NodeStorageBulkReadProgress) => void,
      options?: { thumbnail?: boolean }
    ): Promise<void> {
      await this.checkAuth()

      const filePaths = keys.map((key) =>
          Buffer.from(key, "utf8").toString("hex")
      )

      const isThumb = options?.thumbnail ?? false
      const url = isThumb ? "/api/read-bulk?thumb=1" : "/api/read-bulk"

      const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ filePaths, thumb: isThumb }),
          cache: 'no-cache',
          headers: {
              "content-type": "application/json",
              "risu-auth": await this.createAuth()
          }
      })

      if (!response.ok) {
          throw new Error(`getItems Error: ${response.status}`)
      }

      if (!response.body) {
          throw new Error("getItems Error: response body is missing")
      }

      type ReceivingFile = {
          name: string
          expectedSize: bigint
          receivedSize: number
      }

      const reader = response.body.getReader()
      const receivingFiles = new Map<number, ReceivingFile>()
      let completedFiles = 0

      let pending = Buffer.alloc(0)

      onProgress?.({
          completedFiles,
          totalFiles: keys.length,
          currentFile: null,
          receivedBytes: 0,
          totalBytes: 0n
      })

      while (true) {
          const { value, done } = await reader.read()

          if (value) {
              pending = Buffer.concat([pending, Buffer.from(value)])
          }

          let offset = 0

          while (offset < pending.length) {
              const available = pending.length - offset

              if (available < 1) break

              const type = pending.readUInt8(offset)

              if (type === 0x01) {
                  // Type(1) + File ID(4) + NameLength(4)
                  if (available < 9) break

                  const fileId = pending.readUInt32BE(offset + 1)
                  const nameLength = pending.readUInt32BE(offset + 5)
                  const packetLength = 1 + 4 + 4 + nameLength + 8

                  if (available < packetLength) break

                  const nameStart = offset + 9
                  const nameEnd = nameStart + nameLength

                  const name = pending
                      .subarray(nameStart, nameEnd)
                      .toString("utf8")

                  const expectedSize = pending.readBigUInt64BE(nameEnd)

                  receivingFiles.set(fileId, {
                      name,
                      expectedSize,
                      receivedSize: 0
                  })

                  await handlers.onFileStart(name, expectedSize)

                  onProgress?.({
                      completedFiles,
                      totalFiles: keys.length,
                      currentFile: name,
                      receivedBytes: 0,
                      totalBytes: expectedSize
                  })

                  offset += packetLength
                  continue
              }

              if (type === 0x02) {
                  // Type(1) + File ID(4) + ChunkSize(4)
                  if (available < 9) break

                  const fileId = pending.readUInt32BE(offset + 1)
                  const chunkSize = pending.readUInt32BE(offset + 5)
                  const packetLength = 1 + 4 + 4 + chunkSize

                  if (available < packetLength) break

                  const file = receivingFiles.get(fileId)

                  if (!file) {
                      throw new Error(
                          `Received chunk for unknown file ID: ${fileId}`
                      )
                  }

                  const chunkStart = offset + 9
                  const chunkEnd = chunkStart + chunkSize
                  const chunk = pending.subarray(chunkStart, chunkEnd)

                  file.receivedSize += chunk.length

                  if (BigInt(file.receivedSize) > file.expectedSize) {
                      throw new Error(
                          `Received too much data for file: ${file.name}`
                      )
                  }

                  await handlers.onFileChunk(file.name, chunk)

                  onProgress?.({
                      completedFiles,
                      totalFiles: keys.length,
                      currentFile: file.name,
                      receivedBytes: file.receivedSize,
                      totalBytes: file.expectedSize
                  })

                  offset += packetLength
                  continue
              }

              if (type === 0x03) {
                  // Type(1) + File ID(4)
                  if (available < 5) break

                  const fileId = pending.readUInt32BE(offset + 1)
                  const file = receivingFiles.get(fileId)

                  if (!file) {
                      throw new Error(
                          `Received end packet for unknown file ID: ${fileId}`
                      )
                  }

                  if (BigInt(file.receivedSize) !== file.expectedSize) {
                      throw new Error(
                          `File size mismatch for ${file.name}: ` +
                          `expected ${file.expectedSize}, received ${file.receivedSize}`
                      )
                  }

                  await handlers.onFileEnd?.(file.name)

                  receivingFiles.delete(fileId)
                  completedFiles += 1
                  onProgress?.({
                      completedFiles,
                      totalFiles: keys.length,
                      currentFile: null,
                      receivedBytes: 0,
                      totalBytes: 0n
                  })
                  offset += 5
                  continue
              }

              throw new Error(`Unknown bulk packet type: ${type}`)
          }

          pending = pending.subarray(offset)

          if (done) break
      }

      if (pending.length !== 0) {
          throw new Error("Bulk response ended with an incomplete packet")
      }

      if (receivingFiles.size !== 0) {
          throw new Error("Bulk response ended before all files were completed")
      }

      if (completedFiles !== keys.length) {
          throw new Error(
              `Bulk response completed ${completedFiles} of ${keys.length} files`
          )
      }
  }

    async keys():Promise<string[]>{
        await this.checkAuth()
        const da = await fetch('/api/list', {
            method: "GET",
            headers:{
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string|string[]){
        await this.checkAuth()
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(Array.isArray(key) ? key.join('$$') : key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async authorizeKey(password:string) {
        const keypair = await this.getKeyPair()
        const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey)
        const response = await fetch('/api/login',{
            method: "POST",
            body: JSON.stringify({
                password,
                publicKey,
            }),
            headers: {
                'content-type': 'application/json'
            }
        })
        if(response.status < 200 || response.status >= 300){
            let message = `Login failed (${response.status})`
            try {
                const body = await response.json()
                if(body?.error){
                    message = body.error
                }
            } catch {}
            alertError(message)
            await waitAlert()
            throw message
        }
        this.authChecked = true
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': await this.createAuth()
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                if(response.status < 200 || response.status >= 300){
                    throw new Error(`Setting the Node server password failed (${response.status})`)
                }
                await this.authorizeKey(input)
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.authorizeKey(input)
            }
            else{
                this.authChecked = true
            }
        }
    }

    listItem = this.keys
}

const sharedNodeStorage = new NodeStorage()

export async function getNodeServerProxyAuth() {
    return await sharedNodeStorage.getProxyAuth()
}

async function digestPassword(message:string) {
    const response = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })

    if(response.status < 200 || response.status >= 300){
        let message = `Password crypto failed (${response.status})`
        try {
            const body = await response.json()
            if(body?.error){
                message = body.error
            }
        } catch {}
        throw message
    }
    const crypt = await response.text()
    
    return crypt;
}
