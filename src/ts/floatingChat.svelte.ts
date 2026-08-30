/**
 * Floating chat window (PiP-style) state.
 *
 * The floating window pins a single character/chat and floats above the
 * home screen while the user browses other parts of the app. The state is
 * intentionally session-only (never persisted) to keep the save data small
 * and avoid stale geometry on different devices.
 */

const MIN_WIDTH = 320
const MIN_HEIGHT = 240
const MARGIN = 16

export type FloatingChatGeometry = {
    x: number
    y: number
    width: number
    height: number
}

export const floatingChatStore = $state({
    open: false,
    /** chaId of the character pinned into the floating window. */
    characterId: '',
    /** Viewport geometry; width/height <= 0 falls back to defaults. */
    x: 0,
    y: 0,
    width: 0,
    height: 0,
})

function getDefaultGeometry(): FloatingChatGeometry {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.max(MIN_WIDTH, Math.min(420, Math.floor(viewportWidth * 0.3)))
    const height = Math.max(MIN_HEIGHT, Math.min(640, Math.floor(viewportHeight * 0.7)))
    return {
        x: viewportWidth - width - MARGIN,
        y: Math.max(MARGIN, Math.floor(viewportHeight * 0.12)),
        width,
        height,
    }
}

export function openFloatingChat(characterId: string): void {
    floatingChatStore.characterId = characterId
    floatingChatStore.open = true
    const geometry = getDefaultGeometry()
    // Keep the last used position/size when the window was already placed.
    if (floatingChatStore.width <= 0 || floatingChatStore.height <= 0) {
        floatingChatStore.width = geometry.width
        floatingChatStore.height = geometry.height
        floatingChatStore.x = geometry.x
        floatingChatStore.y = geometry.y
    }
    clampFloatingChat()
}

export function closeFloatingChat(keepGeometry = true): void {
    floatingChatStore.open = false
    floatingChatStore.characterId = ''
    if (!keepGeometry) {
        floatingChatStore.x = 0
        floatingChatStore.y = 0
        floatingChatStore.width = 0
        floatingChatStore.height = 0
    }
}

export function clampFloatingChat(): void {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.min(
        Math.max(MIN_WIDTH, floatingChatStore.width),
        Math.max(MIN_WIDTH, viewportWidth - MARGIN * 2),
    )
    const height = Math.min(
        Math.max(MIN_HEIGHT, floatingChatStore.height),
        Math.max(MIN_HEIGHT, viewportHeight - MARGIN * 2),
    )
    floatingChatStore.width = width
    floatingChatStore.height = height
    floatingChatStore.x = Math.min(
        Math.max(MARGIN, floatingChatStore.x),
        Math.max(MIN_WIDTH, viewportWidth - width - MARGIN),
    )
    floatingChatStore.y = Math.min(
        Math.max(0, floatingChatStore.y),
        Math.max(0, viewportHeight - MARGIN * 2),
    )
}