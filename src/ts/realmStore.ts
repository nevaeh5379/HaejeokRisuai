import { writable } from 'svelte/store'
import type { hubType } from './hubCatalog'

export const showRealmInfoStore = writable<null | hubType>(null)
