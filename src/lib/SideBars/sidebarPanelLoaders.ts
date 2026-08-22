import type { Component } from 'svelte'

type ComponentModule = { default: Component<any> }

export function createCachedLoader<T>(loader: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined

    return () => {
        if (!pending) {
            pending = loader().catch((error) => {
                pending = undefined
                throw error
            })
        }
        return pending
    }
}

export const loadCharConfig = createCachedLoader<ComponentModule>(
    () => import('./CharConfig.svelte'),
)

export const loadSideChatList = createCachedLoader<ComponentModule>(
    () => import('./SideChatListForCurrent.svelte'),
)

export async function preloadSidebarPanels(): Promise<void> {
    await Promise.allSettled([loadCharConfig(), loadSideChatList()])
}
