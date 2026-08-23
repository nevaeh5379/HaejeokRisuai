import { mount, unmount } from 'svelte'
import type {
    ColorPalette,
    ExportFormat,
    LogExportData,
    LogExporterSettings,
} from './types'
import { generateMarkdownLog, generateTextLog } from './logGenerator'
import { escapeHtml } from './chatData.svelte'
import LogContainer from 'src/lib/LogExporter/LogContainer.svelte'
import type { LogRenderProps } from './types'

/**
 * Themed standalone HTML / markdown / text export generation.
 * The themed HTML path renders LogContainer offscreen (identical visuals to
 * the preview) and serializes the result into a self-contained document.
 */

const DEFAULT_RENDER_TIMEOUT_MS = 30000
const DEFAULT_STANDALONE_BG = '#1a1b26'

export interface StandaloneHtmlOptions {
    title?: string
    language?: string
    customStyles?: string
    backgroundColor?: string
}

export function buildStandaloneHtmlDocument(
    bodyContent: string,
    options: StandaloneHtmlOptions = {},
): string {
    const {
        title = 'Chat Log',
        language = 'ko',
        customStyles = '',
        backgroundColor = DEFAULT_STANDALONE_BG,
    } = options

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
    }
    body {
      padding: 20px 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
      background-color: ${backgroundColor};
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    img, video {
      max-width: 100%;
      height: auto;
    }
    ${customStyles.trim() ? `\n    ${customStyles.trim()}` : ''}
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`
}

/** Renders LogContainer offscreen and returns its serialized HTML. */
export async function renderLogHtml(
    data: LogExportData,
    settings: LogExporterSettings,
    colorPalette: ColorPalette,
): Promise<string> {
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.left = '-10000px'
    container.style.top = '0'
    container.style.zIndex = '-1'
    container.style.width = `${settings.previewWidth || 900}px`
    document.body.appendChild(container)

    const props: LogRenderProps = {
        data,
        settings,
        color: colorPalette,
        isForExport: true,
        containerWidth: settings.previewWidth || 900,
        fontSize: settings.previewFontSize || 16,
        onReady: () => {},
    }

    const app = mount(LogContainer, { target: container, props })

    try {
        // Wait for all message processing (async image embedding) to settle.
        await waitForRenderReady(container)
        return container.innerHTML
    } finally {
        await unmount(app)
        container.remove()
    }
}

function waitForRenderReady(container: HTMLElement): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const check = () => {
            if (Date.now() - started > DEFAULT_RENDER_TIMEOUT_MS) {
                reject(new Error('HTML render timed out'))
                return
            }
            // The renderer marks readiness via data attribute on the root node
            if (container.querySelector('[data-log-render-complete="true"]')) {
                requestAnimationFrame(() => resolve())
                return
            }
            setTimeout(check, 120)
        }
        setTimeout(check, 150)
    })
}

export interface GenerateExportResult {
    format: ExportFormat
    content: string
    extension: string
    mime: string
}

/** Generates export content in the requested format. */
export async function generateExport(
    data: LogExportData,
    settings: LogExporterSettings,
    colorPalette: ColorPalette,
): Promise<GenerateExportResult> {
    switch (settings.format) {
        case 'markdown':
            return {
                format: 'markdown',
                content: generateMarkdownLog(data.messages, settings),
                extension: 'md',
                mime: 'text/markdown;charset=utf-8',
            }
        case 'text':
            return {
                format: 'text',
                content: generateTextLog(data.messages, settings),
                extension: 'txt',
                mime: 'text/plain;charset=utf-8',
            }
        case 'html': {
            const raw = await renderLogHtml(data, settings, colorPalette)
            const doc = buildStandaloneHtmlDocument(raw, {
                title: data.charInfo.name
                    ? `${data.charInfo.name}${data.charInfo.chatName ? ` - ${data.charInfo.chatName}` : ''}`
                    : 'Chat Log',
                customStyles: settings.customCss,
                backgroundColor: colorPalette?.background || DEFAULT_STANDALONE_BG,
            })
            return {
                format: 'html',
                content: doc,
                extension: 'html',
                mime: 'text/html;charset=utf-8',
            }
        }
        case 'basic':
        default:
            throw new Error('Use saveAsImage for the basic (image) format')
    }
}
