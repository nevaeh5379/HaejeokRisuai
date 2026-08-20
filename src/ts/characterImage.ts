import { DBState } from './stores.svelte'
import { getFileSrc } from './globalApi.svelte'

export async function getCharImage(
    loc: string,
    type: 'plain' | 'css' | 'contain' | 'lgcss',
    options?: { thumbnail?: boolean },
) {
    if (DBState.db.hideAllImages) return type === 'plain' ? '/none.webp' : ''
    if (!loc) return type === 'css' ? '' : null

    const fileSource = await getFileSrc(loc, options)
    if (type === 'plain') return fileSource
    if (type === 'css') return `background: url("${fileSource}");background-size: cover;`
    if (type === 'lgcss') return `background: url("${fileSource}");background-size: cover;height: 10.66rem;`
    return `background: url("${fileSource}");background-size: contain;background-repeat: no-repeat;background-position: center;`
}
