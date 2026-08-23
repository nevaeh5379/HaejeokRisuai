import type { FFmpeg } from '@ffmpeg/ffmpeg'
import type { ImageFormat } from './types'

/**
 * ffmpeg.wasm media service.
 *
 * Replaces the plugin's hand-written binary codecs (png.ts / jpeg.ts /
 * webp.ts / webmConverter.ts): vertical image stitching, format conversion
 * and WebM → animated WebP conversion are delegated to a real ffmpeg build,
 * loaded on demand from CDN so it never touches the initial bundle.
 */

const CORE_VERSION = '0.12.10'
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`

export const DEFAULT_WEBM_FPS = 10
export const DEFAULT_WEBM_MAX_WIDTH = 500
export const DEFAULT_WEBM_QUALITY = 80

let ffmpegInstance: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null

export interface MediaProgress {
    progress: number
    time: number
}

/** Lazily loads (and caches) the ffmpeg.wasm core. */
export async function getFFmpeg(onLog?: (message: string) => void): Promise<FFmpeg> {
    if (ffmpegInstance) return ffmpegInstance
    if (!loadPromise) {
        loadPromise = (async () => {
            // Dynamic imports keep @ffmpeg/ffmpeg out of the initial bundle
            const { FFmpeg: FFmpegClass } = await import('@ffmpeg/ffmpeg')
            const { toBlobURL } = await import('@ffmpeg/util')
            const ffmpeg = new FFmpegClass()
            if (onLog) {
                ffmpeg.on('log', ({ message }) => onLog(message))
            }
            await ffmpeg.load({
                coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
            })
            ffmpegInstance = ffmpeg
            return ffmpeg
        })().catch((e) => {
            loadPromise = null
            throw e
        })
    }
    return loadPromise
}

export function isFFmpegLoaded(): boolean {
    return ffmpegInstance !== null
}

/** Converts a Blob into the data format ffmpeg.writeFile expects. */
async function toFFmpegData(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer())
}

// ─── Vertical image stitching ────────────────────────────────────────────────

function extFor(format: ImageFormat): string {
    switch (format) {
        case 'png': return 'png'
        case 'jpeg': return 'jpg'
        case 'webp': return 'webp'
    }
}

function mimeFor(format: ImageFormat): string {
    switch (format) {
        case 'png': return 'image/png'
        case 'jpeg': return 'image/jpeg'
        case 'webp': return 'image/webp'
    }
}

/**
 * Stitches image blobs vertically into one file using ffmpeg's vstack filter.
 *
 * Inputs of differing widths are scaled to the narrowest width first so the
 * filter never fails. Replaces the plugin's binary PNG/JPEG/WebP mergers and,
 * unlike canvas merging, is not limited by browser texture size limits.
 */
export async function mergeImagesVertically(
    blobs: Blob[],
    format: ImageFormat = 'png',
    onProgressUpdate?: (update: { message?: string }) => void,
): Promise<Blob> {
    if (blobs.length === 0) throw new Error('No images to merge')
    if (blobs.length === 1) return blobs[0]

    onProgressUpdate?.({ message: 'ffmpeg 로드 중...' })
    const ffmpeg = await getFFmpeg()

    const ext = extFor(format)
    const inputNames: string[] = []

    // Probe natural widths via ImageBitmap to normalize scale
    let targetWidth = Infinity
    const bitmaps: ImageBitmap[] = []
    try {
        for (const blob of blobs) {
            const bmp = await createImageBitmap(blob)
            bitmaps.push(bmp)
            targetWidth = Math.min(targetWidth, bmp.width)
        }
    } catch {
        targetWidth = Infinity
    } finally {
        for (const bmp of bitmaps) bmp.close?.()
    }

    for (let i = 0; i < blobs.length; i++) {
        const name = `in${i}.${ext}`
        await ffmpeg.writeFile(name, await toFFmpegData(blobs[i]))
        inputNames.push(name)
    }

    try {
        // Build filter_complex: scale all inputs to a common width, then vstack
        const scaleAll = targetWidth !== Infinity
        const parts: string[] = []
        if (scaleAll) {
            inputNames.forEach((_, i) => parts.push(`[${i}:v]scale=${targetWidth}:-1:flags=lanczos[p${i}]`))
        }
        const stackInputs = inputNames.map((_, i) => `[${scaleAll ? 'p' + i : i + ':v'}]`).join('')
        parts.push(`${stackInputs}vstack=inputs=${inputNames.length}[out]`)
        const filterComplex = parts.join(';')

        onProgressUpdate?.({ message: `${blobs.length}개 이미지 병합 중...` })
        await ffmpeg.exec([
            ...inputNames.flatMap((name) => ['-i', name]),
            '-filter_complex', filterComplex,
            '-frames:v', '1',
            ...(format === 'jpeg' ? ['-q:v', '2'] : []),
            ...(format === 'webp' ? ['-lossless', '0', '-q:v', '95'] : []),
            '-c:v', format === 'webp' ? 'libwebp' : format === 'jpeg' ? 'mjpeg' : 'png',
            `out.${ext}`,
        ])

        const data = await ffmpeg.readFile(`out.${ext}`)
        return new Blob([data as unknown as BlobPart], { type: mimeFor(format) })
    } finally {
        for (const name of inputNames) {
            try { await ffmpeg.deleteFile(name) } catch { /* ignore */ }
        }
        try { await ffmpeg.deleteFile(`out.${ext}`) } catch { /* ignore */ }
    }
}

// ─── WebM → Animated WebP ────────────────────────────────────────────────────

/**
 * Converts a WebM video into a spec-compliant animated WebP image using
 * ffmpeg (`libwebp` encoder). Replaces the manual frame-extraction +
 * RIFF chunk assembly in the plugin's webmConverter.ts.
 */
export async function convertWebMToAnimatedWebp(
    videoBlob: Blob,
    options: {
        fps?: number | null
        maxWidth?: number | null
        quality?: number
    } = {},
): Promise<Blob> {
    const fps = options.fps ?? DEFAULT_WEBM_FPS
    const maxWidth = options.maxWidth ?? DEFAULT_WEBM_MAX_WIDTH
    const quality = Math.min(100, Math.max(1, options.quality ?? DEFAULT_WEBM_QUALITY))

    const ffmpeg = await getFFmpeg()
    await ffmpeg.writeFile('input.webm', await toFFmpegData(videoBlob))
    try {
        const vfParts = [`fps=${fps}`]
        if (maxWidth && maxWidth > 0) {
            vfParts.push(`scale='min(${maxWidth},iw)':-2:flags=lanczos`)
        }
        await ffmpeg.exec([
            '-i', 'input.webm',
            '-vf', vfParts.join(','),
            '-c:v', 'libwebp',
            '-lossless', '0',
            '-q:v', String(quality),
            '-loop', '0',
            '-an',
            '-vsync', '0',
            'output.webp',
        ])
        const data = await ffmpeg.readFile('output.webp')
        return new Blob([data as unknown as BlobPart], { type: 'image/webp' })
    } finally {
        try { await ffmpeg.deleteFile('input.webm') } catch { /* ignore */ }
        try { await ffmpeg.deleteFile('output.webp') } catch { /* ignore */ }
    }
}
