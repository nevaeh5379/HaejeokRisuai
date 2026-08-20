import { v4 as uuidv4 } from 'uuid'
import { defaultSdDataFunc, type character } from './storage/database.svelte'

export function createBlankChar(): character {
    return {
        name: '', firstMessage: '', desc: '', notes: '',
        chats: [{ message: [], note: '', name: 'Chat 1', localLore: [] }],
        chatFolders: [], chatPage: 0, emotionImages: [], bias: [], viewScreen: 'none',
        globalLore: [], chaId: uuidv4(), type: 'character', sdData: defaultSdDataFunc(),
        utilityBot: false, customscript: [], exampleMessage: '', creatorNotes: '',
        systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: [],
        creator: '', characterVersion: '', personality: '', scenario: '', firstMsgIndex: -1,
        replaceGlobalNote: '',
        triggerscript: [
            { comment: '', type: 'manual', conditions: [], effect: [{ type: 'v2Header', code: '', indent: 0 }] },
            { comment: 'New Event', type: 'manual', conditions: [], effect: [] },
        ],
        additionalText: '',
    }
}
