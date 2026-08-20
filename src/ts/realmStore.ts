import { writable } from 'svelte/store'
import type { hubType } from './characterCards'

export const showRealmInfoStore = writable<null | hubType>(null)
