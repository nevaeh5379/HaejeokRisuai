import { Buffer } from 'buffer'

/**
 * Generates a downscaled thumbnail (default max 128px) in WebP format on the client side.
 * Uses createImageBitmap when available for hardware-accelerated decode & resize off the main thread.
 * 
 * @param imageData - Raw binary data of the original image
 * @param maxSize - Maximum width/height for the thumbnail (default: 128)
 * @returns Downscaled image buffer as Uint8Array
 */
export async function generateClientThumbnail(imageData: Uint8Array, maxSize: number = 128): Promise<Uint8Array> {
    if (typeof window === 'undefined') {
        return imageData
    }
    try {
        const blob = new Blob([imageData as any])

        if ('createImageBitmap' in window) {
            const bitmap = await createImageBitmap(blob, {
                resizeWidth: maxSize,
                resizeHeight: maxSize,
                resizeQuality: 'medium'
            })

            let canvas: HTMLCanvasElement | OffscreenCanvas
            if (typeof OffscreenCanvas !== 'undefined') {
                canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            } else {
                canvas = document.createElement('canvas')
                canvas.width = bitmap.width
                canvas.height = bitmap.height
            }

            const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
            if (!ctx) {
                bitmap.close()
                return imageData
            }
            ctx.drawImage(bitmap, 0, 0)
            bitmap.close()

            if ('convertToBlob' in canvas) {
                const outBlob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality: 0.8 })
                return new Uint8Array(await outBlob.arrayBuffer())
            } else {
                const dataUrl = (canvas as HTMLCanvasElement).toDataURL('image/webp', 0.8)
                const b64 = dataUrl.split(',')[1]
                return Buffer.from(b64, 'base64')
            }
        } else {
            return new Promise((resolve) => {
                const url = URL.createObjectURL(blob)
                const img = new Image()
                img.onload = () => {
                    URL.revokeObjectURL(url)
                    const canvas = document.createElement('canvas')
                    let { width, height } = img
                    if (width > height) {
                        height = Math.round((height * maxSize) / width)
                        width = maxSize
                    } else {
                        width = Math.round((width * maxSize) / height)
                        height = maxSize
                    }
                    canvas.width = Math.max(1, width)
                    canvas.height = Math.max(1, height)
                    const ctx = canvas.getContext('2d')
                    if (ctx) {
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
                        const dataUrl = canvas.toDataURL('image/webp', 0.8)
                        const b64 = dataUrl.split(',')[1]
                        resolve(Buffer.from(b64, 'base64'))
                    } else {
                        resolve(imageData)
                    }
                }
                img.onerror = () => {
                    URL.revokeObjectURL(url)
                    resolve(imageData)
                }
                img.src = url
            })
        }
    } catch (e) {
        console.warn('[Thumbnail] Client thumbnail generation fallback to original:', e)
        return imageData
    }
}
