import { writable } from 'svelte/store'

export const ConnectionOpenStore = writable(false)
export const ConnectionIsHost = writable(false)
export const RoomIdStore = writable('')
