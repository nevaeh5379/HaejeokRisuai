import { get } from 'svelte/store'
import { selectedCharID } from '../stores.svelte'
import { parseKeyValue } from '../util'
import { characterStore } from '../stores/domain/characterStore.svelte'
import { settingsStore } from '../stores/domain/settingsStore.svelte'

export function getChatVar(key:string): string {
    const selectedChar = get(selectedCharID)
    const char = characterStore.characters[selectedChar]
    if(!char){
        return 'null'
    }
    const chat = char.chats[char.chatPage]
    if (!chat) {
        return 'null'
    }
    chat.scriptstate ??= {}
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(settingsStore.state.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string): boolean {
    const selectedChar = get(selectedCharID)
    const char = characterStore.characters[selectedChar]
    if (!char || !char.chats) {
        return false
    }
    const chat = char.chats[char.chatPage]
    if (!chat) {
        return false
    }
    chat.scriptstate ??= {}

    const stateKey = '$' + key
    if(chat.scriptstate[stateKey] === value){
        return false
    }

    chat.scriptstate[stateKey] = value
    return true
}

export function getGlobalChatVar(key:string): string {
    return settingsStore.state.globalChatVariables?.[key] ?? 'null'
}
