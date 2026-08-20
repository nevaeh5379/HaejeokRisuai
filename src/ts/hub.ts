import { isNodeServer } from './platform'

const EXTERNAL_HUB_URL = 'https://sv.risuai.xyz'
const NIGHTLY_HUB_URL = 'https://nightly.sv.risuai.xyz'

export const hubURL = isNodeServer
    ? '/hub-proxy'
    : ((typeof window !== 'undefined' && window.location?.hostname === 'nightly.risuai.xyz')
        || (typeof localStorage !== 'undefined' && localStorage?.getItem('hub') === 'nightly'))
        ? NIGHTLY_HUB_URL
        : EXTERNAL_HUB_URL
