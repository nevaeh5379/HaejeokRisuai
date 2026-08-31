self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

const downloadStreams = new Map()
// The page fires the /sw/download request right after posting the
// REGISTER_STREAM_DOWNLOAD message. The two cross the same IPC boundary in
// either order, so a fetch that arrives before its registration must wait
// briefly — otherwise the browser downloads an empty/404 body and the user
// sees a silent empty backup file. Unknown/expired ids simply pay a short
// delay before the 404 (an acceptable cost for a rare path).
const PENDING_REGISTER_GRACE_MS = 1500

function waitForStreamRegistration(id) {
    return new Promise((resolve) => {
        const startedAt = Date.now()
        const poll = () => {
            if (downloadStreams.has(id)) return resolve(true)
            if (Date.now() - startedAt >= PENDING_REGISTER_GRACE_MS) return resolve(false)
            setTimeout(poll, 25)
        }
        poll()
    })
}

self.addEventListener('message', (event) => {
    if (event.data?.type === 'REGISTER_STREAM_DOWNLOAD') {
        const { id, filename } = event.data
        const streamPort = event.ports?.[0]
        if (streamPort && id) {
            const readable = new ReadableStream({
                start(controller) {
                    streamPort.onmessage = (e) => {
                        if (e.data?.done) {
                            // The producer finished writing. Closing the
                            // stream flushes the buffered chunks; the entry
                            // must STAY in downloadStreams until the download
                            // request actually consumes it (the /sw/download
                            // handler deletes it). Deleting here raced the
                            // browser's download request and produced silent
                            // empty backup files.
                            try { controller.close() } catch {}
                        } else if (e.data?.error) {
                            try { controller.error(new Error(e.data.error)) } catch {}
                            try { streamPort.close() } catch {}
                            downloadStreams.delete(id)
                        } else if (e.data instanceof Uint8Array || e.data instanceof ArrayBuffer) {
                            const chunk = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data
                            controller.enqueue(chunk)
                        }
                    }
                },
                cancel() {
                    try { streamPort.postMessage({ cancel: true }) } catch {}
                    try { streamPort.close() } catch {}
                    downloadStreams.delete(id)
                }
            })
            downloadStreams.set(id, { readable, filename })
        }
    }
})

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url)
    const path = url.pathname.split('/')
    if(path[1] === 'sw'){
        try {
            switch (path[2]){
                case "download": {
                    const id = url.searchParams.get('id')
                    event.respondWith((async () => {
                        // Wait out the register/fetch race described above.
                        if (!(await waitForStreamRegistration(id))) {
                            return new Response("Download stream not found or expired", { status: 404 })
                        }
                        const item = downloadStreams.get(id)
                        if (!item) {
                            return new Response("Download stream not found or expired", { status: 404 })
                        }
                        downloadStreams.delete(id)
                        const rawFilename = item.filename || 'backup.bin'
                        const encodedFilename = encodeURIComponent(rawFilename)
                        return new Response(item.readable, {
                            headers: {
                                'Content-Type': 'application/octet-stream',
                                'Content-Disposition': `attachment; filename="${rawFilename.replace(/"/g, '')}"; filename*=UTF-8''${encodedFilename}`,
                                'Cache-Control': 'no-store'
                            }
                        })
                    })())
                    break
                }
                case "check":{
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    event.respondWith(checkCache(targetUrl))
                    break
                }
                case "img": {
                    event.respondWith(getSource(url, event.request))
                    break
                }
                case "register": {
                    let targetUrl = url
                    const headers = event.request.headers
                    const headerUrl = headers.get('x-register-url')
                    if(headerUrl){
                        targetUrl.pathname = decodeURIComponent(headerUrl)
                    }
                    const noContentType = headers.get('x-no-content-type') === 'true'
                    const customContentType = headers.get('content-type') || headers.get('x-content-type')
                    event.respondWith(
                        registerCache(targetUrl, event.request.arrayBuffer(), noContentType, customContentType)
                    )
                    break
                }
                case "init":{
                    event.respondWith(new Response("v2"))
                    break
                }
                case 'share':{
                    event.respondWith((async () => {
                        const formData = await event.request.formData();
                        /**
                         * @type {File}
                        */
                        const character = formData.get('character')
                        const preset = formData.get('preset')
                        const module = formData.get('module')
                        if(character){
                            const buf = await character.arrayBuffer()
                            await registerCache(`/sw/share/character`, buf, true)
                            return Response.redirect("/#share_character", 303)
                        }
                        if(preset){
                            const buf = await preset.arrayBuffer()
                            await registerCache(`/sw/share/preset`, buf, true)
                            return Response.redirect("/#share_preset", 303)
                        }
                        if(module){
                            const buf = await module.arrayBuffer()
                            await registerCache(`/sw/share/module`, buf, true)
                            return Response.redirect("/#share_module", 303)
                        }
                        return Response.redirect("/", 303)

                    })())
                    break
                }
                default: {
                    event.respondWith(new Response(
                        path[2]
                    ))
                }
            }
        } catch (error) {
            event.respondWith(new Response(`${error}`))
        }
    }
    if(path[1] === 'tf'){{
        event.respondWith(new Response("Cannot find resource from cache", {
            status: 404
        }))
    }}
})


async function checkCache(url){
    const cache = await caches.open('risuCache')

    if(url.pathname.startsWith("/sw/check")) {
        url.pathname = "/sw/img" + url.pathname.slice(9);
        return new Response(JSON.stringify({
            "able": !!(await cache.match(url))
        }))
    }

    return new Response(JSON.stringify({
        "able": !!(await cache.match(url))
    }))
}

function hexToKey(hex) {
    try {
        let str = '';
        for (let i = 0; i < hex.length; i += 2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return str;
    } catch (e) {
        return '';
    }
}

function getMimeFromPath(path) {
    const ext = path.split('?')[0].split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'svg': return 'image/svg+xml';
        case 'avif': return 'image/avif';
        case 'webm': return 'video/webm';
        case 'mp4': return 'video/mp4';
        case 'mkv': return 'video/x-matroska';
        case 'mov': return 'video/quicktime';
        case 'mp3': return 'audio/mpeg';
        case 'wav': return 'audio/wav';
        case 'ogg': return 'audio/ogg';
        case 'flac': return 'audio/flac';
        case 'aac': return 'audio/aac';
        default: return 'application/octet-stream';
    }
}

async function getSource(url, request){
    const cache = await caches.open('risuCache')
    const cached = await cache.match(url)
    if (!cached) {
        return new Response("Not found", { status: 404 })
    }

    const rangeHeader = request?.headers?.get('range')
    if (rangeHeader) {
        const buffer = await cached.arrayBuffer()
        const total = buffer.byteLength
        const parts = rangeHeader.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1

        if (!isNaN(start) && start < total) {
            const chunkEnd = Math.min(end, total - 1)
            const slice = buffer.slice(start, chunkEnd + 1)
            const headers = new Headers(cached.headers)
            headers.set('Content-Range', `bytes ${start}-${chunkEnd}/${total}`)
            headers.set('Content-Length', slice.byteLength.toString())
            headers.set('Accept-Ranges', 'bytes')
            return new Response(slice, {
                status: 206,
                statusText: 'Partial Content',
                headers
            })
        }
    }

    const headers = new Headers(cached.headers)
    headers.set('Accept-Ranges', 'bytes')
    return new Response(cached.body, {
        status: 200,
        headers
    })
}

async function check(){

}

async function registerCache(urlr, buffer, noContentType = false, customContentType = null){
    const cache = await caches.open('risuCache')
    const url = new URL(urlr)
    if(!noContentType){
        let path = url.pathname.split('/')
        path[2] = 'img'
        url.pathname = path.join('/')
    }
    const buf = new Uint8Array(await buffer)
    let contentType = customContentType
    if (!contentType && !noContentType) {
        const rawHex = url.pathname.split('/').pop() || ''
        const decodedKey = hexToKey(rawHex)
        contentType = getMimeFromPath(decodedKey || url.pathname)
    }
    let headers = {
        "cache-control": "max-age=604800",
        "accept-ranges": "bytes",
        "content-type": contentType || "application/octet-stream"
    }
    if(noContentType){
        delete headers["content-type"]
    }
    await cache.put(url, new Response(buf, {
        headers
    }))
    return new Response(JSON.stringify({
        "done": true
    }))
}