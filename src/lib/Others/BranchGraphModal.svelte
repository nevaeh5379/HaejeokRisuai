<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { Ellipsis, GitBranch, Maximize, ZoomIn, ZoomOut, XIcon } from '@lucide/svelte'

    import { language } from 'src/lang'
    import { buildChatGraphGitRows, buildChatGraphPackedLanes, getChatBranches, getChatBranchesFromPersistentGraph, type ChatGraphDensity } from 'src/ts/gui/branches'
    import type { Chat } from '../../ts/storage/database/schema'
    import type { SqlChatBranchGraphData } from '../../ts/storage/sql/ISqlStorage'

    interface Props {
        chat?: Chat | null
        branchGraph?: SqlChatBranchGraphData | null
        loading?: boolean
        onselect: (branchId: string) => void | Promise<void>
        onclose: () => void
    }

    let { chat, branchGraph = null, loading = false, onselect, onclose }: Props = $props()

    type GraphLayout = 'tree' | 'timeline' | 'git' | 'radial'

    const padding = 64
    // Safety guard only — no practical zoom limit; keeps scale positive and finite.
    const minScale = 0.05
    const maxScale = 8
    let layout = $state<GraphLayout>('tree')
    let density = $state<ChatGraphDensity>('smart')
    let focusCurrentPath = $state(false)

    const cardWidth = $derived(layout === 'git' ? 260 : layout === 'radial' ? 264 : 292)
    const cardHeight = $derived(layout === 'git' ? 104 : layout === 'radial' ? 108 : 116)
    const gapX = $derived(layout === 'git' ? 18 : layout === 'timeline' ? 36 : 28)
    const gapY = $derived(layout === 'git' ? 18 : layout === 'timeline' ? 22 : 32)
    const graph = $derived(branchGraph
        ? getChatBranchesFromPersistentGraph(branchGraph, { density })
        : getChatBranches(chat, { density }))
    const nodesById = $derived(new Map(graph.nodes.map((node) => [node.id, node])))
    const gitRows = $derived(buildChatGraphGitRows(graph))
    // Lanes are packed against the layout's flow axis so branches that do not
    // overlap reuse the same lane instead of stretching the canvas.
    const packedLanes = $derived(buildChatGraphPackedLanes(graph, (node) => layout === 'timeline' ? node.y : (gitRows.rowByNodeId.get(node.id) ?? 0)))
    const radialRadius = $derived(Math.max(0, graph.rows - 1) * 190)
    const standardColumns = $derived(layout === 'timeline' ? graph.rows : layout === 'git' ? packedLanes.columns : graph.columns)
    const standardRows = $derived(layout === 'timeline' ? packedLanes.columns : layout === 'git' ? gitRows.rows : graph.rows)
    const graphWidth = $derived(layout === 'radial'
        ? padding * 2 + radialRadius * 2 + cardWidth
        : padding * 2 + standardColumns * cardWidth + Math.max(0, standardColumns - 1) * gapX)
    const graphHeight = $derived(layout === 'radial'
        ? padding * 2 + radialRadius * 2 + cardHeight
        : padding * 2 + standardRows * cardHeight + Math.max(0, standardRows - 1) * gapY)
    const activeNode = $derived(graph.nodes.find((node) => node.activeTerminal)
        ?? [...graph.nodes].reverse().find((node) => node.activePath))
    let viewport: HTMLDivElement | undefined = $state()
    let panX = $state(0)
    let panY = $state(0)
    let scale = $state(1)
    let isPanning = $state(false)
    let panPointerId: number | null = null
    let panStart = { x: 0, y: 0, panX: 0, panY: 0 }
    const touchPointers = new Map<number, { x: number, y: number }>()
    let lastPinchCenter: { x: number, y: number } | null = null
    let lastPinchDistance: number | null = null
    let cachedViewportBounds: DOMRect | null = null
    let hasInteracted = false
    let canvasAnimating = $state(false)
    let canvasAnimatingTimer: ReturnType<typeof setTimeout> | undefined
    // At small scales the whole (huge) canvas is visible at once; heavy paints
    // like node shadows are dropped there since they are invisible anyway.
    const zoomedOut = $derived(scale < 0.45)
    // Below this scale node text is unreadable; render placeholder blocks
    // instead of full cards to keep the DOM/paint cost tiny.
    const lodThreshold = $derived(scale < 0.3)

    function nodePosition(node: typeof graph.nodes[number]) {
        if(layout === 'timeline') {
            const lane = packedLanes.laneByNodeId.get(node.id) ?? 0
            return {
                left: padding + node.y * (cardWidth + gapX),
                top: padding + lane * (cardHeight + gapY),
            }
        }
        if(layout === 'git') {
            const lane = packedLanes.laneByNodeId.get(node.id) ?? 0
            const row = gitRows.rowByNodeId.get(node.id) ?? 0
            return {
                left: padding + lane * (cardWidth + gapX),
                top: padding + row * (cardHeight + gapY),
            }
        }
        if(layout === 'radial') {
            const centerX = graphWidth / 2
            const centerY = graphHeight / 2
            if(node.y === 0) {
                return { left: centerX - cardWidth / 2, top: centerY - cardHeight / 2 }
            }
            const angle = -Math.PI / 2 + (node.x / Math.max(1, graph.columns - 1)) * Math.PI * 2
            const radius = node.y * 190
            return {
                left: centerX + Math.cos(angle) * radius - cardWidth / 2,
                top: centerY + Math.sin(angle) * radius - cardHeight / 2,
            }
        }
        return {
            left: padding + node.x * (cardWidth + gapX),
            top: padding + node.y * (cardHeight + gapY),
        }
    }

    function edgeGeometry(from: typeof graph.nodes[number], to: typeof graph.nodes[number]) {
        const fromPos = nodePosition(from)
        const toPos = nodePosition(to)
        if(layout === 'git') {
            const x1 = fromPos.left + cardWidth / 2
            const y1 = fromPos.top + cardHeight
            const x2 = toPos.left + cardWidth / 2
            const y2 = toPos.top
            if(Math.abs(x2 - x1) < 0.5) {
                return { path: `M ${x1} ${y1} L ${x1} ${y2}`, x2, y2 }
            }
            const yTurn = y2 - gapY / 2
            const radius = Math.max(2, Math.min(12, Math.abs(x2 - x1) / 2, (yTurn - y1) / 2, (y2 - yTurn) / 2))
            const sweep = x2 > x1 ? 1 : 0
            const turnX1 = x1 + (x2 > x1 ? radius : -radius)
            const turnX2 = x2 + (x2 > x1 ? -radius : radius)
            return {
                path: `M ${x1} ${y1} L ${x1} ${yTurn - radius} A ${radius} ${radius} 0 0 ${sweep} ${turnX1} ${yTurn} L ${turnX2} ${yTurn} A ${radius} ${radius} 0 0 ${sweep} ${x2} ${yTurn + radius} L ${x2} ${y2}`,
                x2, y2
            }
        }
        if(layout === 'timeline') {
            const x1 = fromPos.left + cardWidth
            const y1 = fromPos.top + cardHeight / 2
            const x2 = toPos.left
            const y2 = toPos.top + cardHeight / 2
            const midX = (x1 + x2) / 2
            return { path: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`, x2, y2 }
        }
        if(layout === 'radial') {
            const x1 = fromPos.left + cardWidth / 2
            const y1 = fromPos.top + cardHeight / 2
            const x2 = toPos.left + cardWidth / 2
            const y2 = toPos.top + cardHeight / 2
            return { path: `M ${x1} ${y1} L ${x2} ${y2}`, x2, y2 }
        }
        const x1 = fromPos.left + cardWidth / 2
        const y1 = fromPos.top + cardHeight
        const x2 = toPos.left + cardWidth / 2
        const y2 = toPos.top
        const midY = (y1 + y2) / 2
        return { path: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`, x2, y2 }
    }

    const clampScale = (value: number) => Math.min(maxScale, Math.max(minScale, value))

    function triggerCanvasAnimation(duration = 200) {
        if(canvasAnimatingTimer) clearTimeout(canvasAnimatingTimer)
        canvasAnimating = true
        canvasAnimatingTimer = setTimeout(() => {
            canvasAnimating = false
        }, duration)
    }

    function reasonLabel(reason: 'root' | 'manual' | 'reroll'): string {
        if(reason === 'root') return language.branchGraphOriginal
        if(reason === 'reroll') return language.branchGraphReroll
        return language.branch
    }

    function fitGraph(animate = true) {
        if(!viewport) return
        const inset = viewport.clientWidth < 640 ? 28 : 72
        const nextScale = clampScale(Math.min(
            1,
            (viewport.clientWidth - inset * 2) / graphWidth,
            (viewport.clientHeight - inset * 2) / graphHeight,
        ))
        scale = nextScale
        panX = (viewport.clientWidth - graphWidth * nextScale) / 2
        panY = (viewport.clientHeight - graphHeight * nextScale) / 2
        if(animate) triggerCanvasAnimation(200)
    }

    function focusActive() {
        if(!viewport || !activeNode) return
        const nextScale = clampScale(Math.max(scale, 0.9))
        const position = nodePosition(activeNode)
        const centerX = position.left + cardWidth / 2
        const centerY = position.top + cardHeight / 2
        scale = nextScale
        panX = viewport.clientWidth / 2 - centerX * nextScale
        panY = viewport.clientHeight / 2 - centerY * nextScale
        hasInteracted = true
        triggerCanvasAnimation(200)
    }

    function refitAfterDisplayChange() {
        hasInteracted = false
        void tick().then(() => fitGraph(false))
    }

    function setLayout(nextLayout: GraphLayout) {
        if(layout === nextLayout) return
        layout = nextLayout
        refitAfterDisplayChange()
    }

    function setDensity(nextDensity: ChatGraphDensity) {
        if(density === nextDensity) return
        density = nextDensity
        refitAfterDisplayChange()
    }

    let isDraggingNode = false
    let dragThresholdPassed = false

    function selectMessageNode(node: typeof graph.nodes[number]) {
        if(loading || isDraggingNode || dragThresholdPassed) return
        const terminal = node.terminals.find((item) => item.active) ?? node.terminals.at(-1)
        if(terminal) void onselect(terminal.branchId)
    }

    function zoomAt(clientX: number, clientY: number, nextScale: number) {
        if(!viewport) return
        const bounds = viewport.getBoundingClientRect()
        const cursorX = clientX - bounds.left
        const cursorY = clientY - bounds.top
        const graphX = (cursorX - panX) / scale
        const graphY = (cursorY - panY) / scale
        const clamped = clampScale(nextScale)
        panX = cursorX - graphX * clamped
        panY = cursorY - graphY * clamped
        scale = clamped
        hasInteracted = true
    }

    function zoomFromCenter(factor: number) {
        if(!viewport) return
        const bounds = viewport.getBoundingClientRect()
        let nextScale = scale * factor
        if(factor > 1 && scale < 0.25) {
            nextScale = Math.max(scale * 1.35, scale + 0.04)
        } else if(factor < 1 && scale < 0.25) {
            nextScale = Math.min(scale * 0.75, scale - 0.03)
        }
        triggerCanvasAnimation(200)
        zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, nextScale)
    }

    function handleDblClick(event: MouseEvent) {
        if(!viewport) return
        triggerCanvasAnimation(200)
        if(scale < 0.6) {
            zoomAt(event.clientX, event.clientY, 1)
        } else {
            fitGraph(true)
        }
    }

    let pendingWheel: WheelEvent | null = null
    let wheelRafId: number | null = null

    function handleWheel(event: WheelEvent) {
        event.preventDefault()
        // Trackpads fire many wheel events per frame; coalesce into one zoom
        // update per animation frame.
        pendingWheel = event
        if(wheelRafId !== null) return
        wheelRafId = requestAnimationFrame(() => {
            wheelRafId = null
            const wheel = pendingWheel
            pendingWheel = null
            if(!wheel) return
            zoomAt(wheel.clientX, wheel.clientY, scale * Math.exp(-wheel.deltaY * 0.0015))
        })
    }

    function startPinch() {
        if(!viewport || touchPointers.size < 2) return
        const [first, second] = [...touchPointers.values()]
        const distance = Math.hypot(second.x - first.x, second.y - first.y)
        if(distance === 0) return
        lastPinchDistance = distance
        lastPinchCenter = {
            x: (first.x + second.x) / 2,
            y: (first.y + second.y) / 2,
        }
        cachedViewportBounds = viewport.getBoundingClientRect()
        panPointerId = null
        isPanning = true
        isDraggingNode = true
        dragThresholdPassed = true
        hasInteracted = true
        for(const pointerId of touchPointers.keys()) safeSetPointerCapture(pointerId)
    }

    function safeSetPointerCapture(pointerId: number) {
        if(!viewport) return
        try {
            viewport.setPointerCapture(pointerId)
        } catch {
            // Pointer may already be inactive or captured elsewhere.
        }
    }

    function safeReleasePointerCapture(pointerId: number) {
        if(!viewport) return
        try {
            if(viewport.hasPointerCapture(pointerId)) {
                viewport.releasePointerCapture(pointerId)
            }
        } catch {
            // Pointer capture may have already been implicitly released by the browser on pointerup/cancel,
            // or the pointer may already be inactive (common on mobile touch devices).
        }
    }

    function startPan(event: PointerEvent) {
        if(event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return
        const target = event.target as HTMLElement | null
        if(target?.closest('.graph-tool')) return

        if(event.pointerType === 'touch') {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            if(touchPointers.size >= 2) {
                event.preventDefault()
                startPinch()
                return
            }
        }

        const selectableNode = target?.closest('.branch-node--selectable')
        panPointerId = event.pointerId
        panStart = { x: event.clientX, y: event.clientY, panX, panY }

        if(selectableNode && event.button !== 1) {
            dragThresholdPassed = false
            isDraggingNode = false
        } else {
            event.preventDefault()
            dragThresholdPassed = true
            isDraggingNode = false
            hasInteracted = true
            isPanning = true
            safeSetPointerCapture(event.pointerId)
        }
    }

    function movePan(event: PointerEvent) {
        if(event.pointerType === 'touch' && touchPointers.has(event.pointerId)) {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            if(touchPointers.size >= 2) {
                event.preventDefault()
                if(!lastPinchCenter || !lastPinchDistance) {
                    startPinch()
                }
                if(!viewport || !lastPinchCenter || !lastPinchDistance) return
                const [first, second] = [...touchPointers.values()]
                const distance = Math.hypot(second.x - first.x, second.y - first.y)
                const currentCenter = {
                    x: (first.x + second.x) / 2,
                    y: (first.y + second.y) / 2,
                }

                // 1. Pan delta (movement of midpoint between fingers)
                const dx = currentCenter.x - lastPinchCenter.x
                const dy = currentCenter.y - lastPinchCenter.y
                panX += dx
                panY += dy

                // 2. Zoom delta around currentCenter
                if(distance > 5 && lastPinchDistance > 5) {
                    const ratio = distance / lastPinchDistance
                    if(Math.abs(ratio - 1) > 0.001) {
                        if(!cachedViewportBounds) cachedViewportBounds = viewport.getBoundingClientRect()
                        const bounds = cachedViewportBounds
                        const relX = currentCenter.x - bounds.left
                        const relY = currentCenter.y - bounds.top
                        const graphX = (relX - panX) / scale
                        const graphY = (relY - panY) / scale
                        const nextScale = clampScale(scale * ratio)
                        panX = relX - graphX * nextScale
                        panY = relY - graphY * nextScale
                        scale = nextScale
                    }
                }

                lastPinchCenter = currentCenter
                lastPinchDistance = distance
                isDraggingNode = true
                hasInteracted = true
                return
            }
        }

        if(panPointerId !== event.pointerId) return
        const dx = event.clientX - panStart.x
        const dy = event.clientY - panStart.y
        if(!dragThresholdPassed) {
            if(Math.hypot(dx, dy) > 8) {
                dragThresholdPassed = true
                isDraggingNode = true
                hasInteracted = true
                isPanning = true
                safeSetPointerCapture(event.pointerId)
                panStart.x = event.clientX
                panStart.y = event.clientY
                panStart.panX = panX
                panStart.panY = panY
            }
        }
        if(dragThresholdPassed) {
            panX = panStart.panX + (event.clientX - panStart.x)
            panY = panStart.panY + (event.clientY - panStart.y)
        }
    }

    function finishPan(event: PointerEvent) {
        if(event.pointerType === 'touch' && touchPointers.delete(event.pointerId)) {
            safeReleasePointerCapture(event.pointerId)
            const wasPinching = lastPinchCenter !== null || lastPinchDistance !== null
            if(touchPointers.size >= 2) {
                startPinch()
                return
            }
            lastPinchCenter = null
            lastPinchDistance = null
            cachedViewportBounds = null

            if(touchPointers.size === 1) {
                const remaining = touchPointers.entries().next().value
                if(remaining) {
                    const [pointerId, pointer] = remaining
                    panPointerId = pointerId
                    panStart = { x: pointer.x, y: pointer.y, panX, panY }
                    dragThresholdPassed = wasPinching
                    isPanning = wasPinching
                    isDraggingNode = wasPinching
                    safeSetPointerCapture(pointerId)
                }
                return
            }

            panPointerId = null
            isPanning = false
            if(isDraggingNode) {
                setTimeout(() => {
                    isDraggingNode = false
                    dragThresholdPassed = false
                }, 120)
            } else {
                dragThresholdPassed = false
            }
            return
        }

        if(panPointerId !== event.pointerId) return
        safeReleasePointerCapture(event.pointerId)
        panPointerId = null
        isPanning = false
        if(isDraggingNode) {
            setTimeout(() => {
                isDraggingNode = false
                dragThresholdPassed = false
            }, 120)
        } else {
            dragThresholdPassed = false
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if(event.key === 'Escape') onclose()
        if((event.key === '+' || event.key === '=') && !event.metaKey && !event.ctrlKey) zoomFromCenter(1.16)
        if(event.key === '-' && !event.metaKey && !event.ctrlKey) zoomFromCenter(1 / 1.16)
        if(event.key === '0' && !event.metaKey && !event.ctrlKey) fitGraph()
    }

    $effect(() => {
        graph
        if(!viewport || hasInteracted) return
        void tick().then(() => {
            if(viewport && !hasInteracted) fitGraph(false)
        })
    })

    onMount(() => {
        let observer: ResizeObserver | undefined
        void tick().then(() => {
            fitGraph(false)
            if(!viewport) return
            observer = new ResizeObserver(() => {
                if(!hasInteracted) fitGraph(false)
            })
            observer.observe(viewport)
        })
        return () => {
            observer?.disconnect()
            if(wheelRafId !== null) cancelAnimationFrame(wheelRafId)
            if(canvasAnimatingTimer) clearTimeout(canvasAnimatingTimer)
        }
    })
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black/85">
    <header class="relative z-30 flex shrink-0 items-center gap-3 border-b border-darkborderc/70 bg-darkbg/95 px-3.5 py-2.5 pt-[max(env(safe-area-inset-top),0.625rem)] shadow-xl sm:px-5 sm:py-4">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-xl border border-selected/60 bg-selected/20 text-textcolor shadow-inner sm:size-10">
            <GitBranch size={18} class="sm:hidden" />
            <GitBranch size={20} class="hidden sm:block" />
        </div>
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
                <h2 class="m-0 truncate text-base font-bold text-textcolor sm:text-lg">{language.branchGraphTitle}</h2>
                <span class="flex items-center gap-1 rounded-full border border-darkborderc/60 bg-bgcolor/60 px-2 py-0.5 text-[10px] text-textcolor2 sm:hidden">
                    <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgb(34_197_94/0.7)]"></span>
                    {language.branchGraphTimelineCount.replace('{}', graph.timelineCount.toString())}
                </span>
            </div>
            <div class="mt-0.5 hidden truncate text-xs text-textcolor2 sm:block">{language.branchGraphDescription}</div>
        </div>
        <div class="hidden items-center gap-1.5 rounded-full border border-darkborderc/70 bg-bgcolor/70 px-3 py-1.5 text-xs text-textcolor2 sm:flex">
            <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgb(34_197_94/0.75)]"></span>
            {language.branchGraphMessageCount.replace('{}', graph.messageCount.toString())}
            {#if graph.collapsedMessageCount > 0}
                <span class="text-textcolor2/40">·</span>
                {language.branchGraphCollapsedMessages.replace('{}', graph.collapsedMessageCount.toString())}
            {/if}
            <span class="text-textcolor2/40">·</span>
            {language.branchGraphTimelineCount.replace('{}', graph.timelineCount.toString())}
        </div>
        <button class="shrink-0 rounded-xl border border-darkborderc bg-bgcolor p-2 text-textcolor2 transition-colors hover:border-selected hover:text-textcolor" onclick={onclose} title={language.branchGraphClose} aria-label={language.branchGraphClose}>
            <XIcon size={20} />
        </button>
    </header>

    <div class="graph-display-bar relative z-20 flex shrink-0 items-center gap-2 overflow-x-auto border-b border-darkborderc/60 bg-darkbg/90 px-3 py-1.5 text-xs text-textcolor2 sm:px-5 sm:py-2">
        <span class="shrink-0 text-[11px] font-semibold text-textcolor sm:text-xs">{language.branchGraphLayout}</span>
        <div class="flex shrink-0 items-center rounded-xl border border-darkborderc/70 bg-bgcolor/70 p-0.5 sm:p-1">
            <button class="graph-mode" class:graph-mode--active={layout === 'tree'} aria-pressed={layout === 'tree'} onclick={() => setLayout('tree')}>{language.branchGraphLayoutTree}</button>
            <button class="graph-mode" class:graph-mode--active={layout === 'timeline'} aria-pressed={layout === 'timeline'} onclick={() => setLayout('timeline')}>{language.branchGraphLayoutTimeline}</button>
            <button class="graph-mode" class:graph-mode--active={layout === 'git'} aria-pressed={layout === 'git'} onclick={() => setLayout('git')}>{language.branchGraphLayoutGit}</button>
            <button class="graph-mode" class:graph-mode--active={layout === 'radial'} aria-pressed={layout === 'radial'} onclick={() => setLayout('radial')}>{language.branchGraphLayoutRadial}</button>
        </div>
        <span class="ml-1 shrink-0 text-[11px] font-semibold text-textcolor sm:text-xs">{language.branchGraphDensity}</span>
        <div class="flex shrink-0 items-center rounded-xl border border-darkborderc/70 bg-bgcolor/70 p-0.5 sm:p-1">
            <button class="graph-mode" class:graph-mode--active={density === 'smart'} aria-pressed={density === 'smart'} onclick={() => setDensity('smart')}>{language.branchGraphDensitySmart}</button>
            <button class="graph-mode" class:graph-mode--active={density === 'all'} aria-pressed={density === 'all'} onclick={() => setDensity('all')}>{language.branchGraphDensityAll}</button>
            <button class="graph-mode" class:graph-mode--active={density === 'branches'} aria-pressed={density === 'branches'} onclick={() => setDensity('branches')}>{language.branchGraphDensityBranches}</button>
        </div>
        <button
            class="graph-mode ml-1 shrink-0 border border-darkborderc/70 bg-bgcolor/70"
            class:graph-mode--active={focusCurrentPath}
            aria-pressed={focusCurrentPath}
            onclick={() => focusCurrentPath = !focusCurrentPath}
        >
            {language.branchGraphFocusPath}
        </button>
    </div>

    <div
        bind:this={viewport}
        class="graph-viewport relative flex-1 overflow-hidden touch-none select-none"
        class:is-panning={isPanning}
        onwheel={handleWheel}
        onpointerdown={startPan}
        onpointermove={movePan}
        onpointerup={finishPan}
        onpointercancel={finishPan}
        ondblclick={handleDblClick}
        role="application"
        aria-label={language.branchGraphTitle}
    >
        <div
            class="graph-canvas absolute left-0 top-0 touch-none select-none"
            class:graph-canvas--zoomed-out={zoomedOut}
            class:graph-canvas--animated={canvasAnimating}
            style={`width:${graphWidth}px;height:${graphHeight}px;transform:translate3d(${panX}px,${panY}px,0) scale(${scale});`}
        >
            <svg class="pointer-events-none absolute inset-0 overflow-visible" width={graphWidth} height={graphHeight} aria-hidden="true">
                {#each graph.edges as edge}
                    {@const from = nodesById.get(edge.from)}
                    {@const to = nodesById.get(edge.to)}
                    {#if from && to}
                        {@const geometry = edgeGeometry(from, to)}
                        <path
                            class:active-edge={edge.active}
                            class:branch-edge--muted={focusCurrentPath && !edge.active}
                            class="branch-edge"
                            d={geometry.path}
                            fill="none"
                            stroke-width={edge.active ? 3 : 2}
                            stroke-dasharray={edge.active || layout === 'git' ? undefined : '5 7'}
                        />
                        {#if !zoomedOut}
                            <circle
                                class:active-junction={edge.active}
                                class:branch-junction--muted={focusCurrentPath && !edge.active}
                                class="branch-junction"
                                cx={geometry.x2}
                                cy={geometry.y2}
                                r={edge.active ? 5 : 4}
                            />
                        {/if}
                    {/if}
                {/each}
            </svg>

            {#each graph.nodes as node}
                {@const position = nodePosition(node)}
                {#if lodThreshold}
                    <!-- LOD: below the readable threshold full cards cost more to
                         paint than the viewport can show; plain blocks keep zoom
                         smooth and still communicate structure/color. -->
                    <div
                        class="branch-node branch-node--lod absolute z-10 touch-none select-none"
                        class:branch-node--active={node.activeTerminal}
                        class:branch-node--path={!node.activeTerminal && node.activePath}
                        class:branch-node--summary={node.kind === 'summary'}
                        class:branch-node--muted={focusCurrentPath && !node.activePath && !node.activeTerminal}
                        style={`left:${position.left}px;top:${position.top}px;width:${cardWidth}px;height:${cardHeight}px;`}
                    ></div>
                {:else}
                <button
                    class="branch-node absolute z-10 flex flex-col overflow-hidden rounded-2xl border px-4 py-3 text-left touch-none select-none"
                    class:branch-node--active={node.activeTerminal}
                    class:branch-node--path={!node.activeTerminal && node.activePath}
                    class:branch-node--selectable={!loading && node.terminals.length > 0}
                    class:branch-node--summary={node.kind === 'summary'}
                    class:branch-node--fork={node.branchPoint}
                    class:branch-node--git={layout === 'git'}
                    class:branch-node--radial={layout === 'radial'}
                    class:branch-node--muted={focusCurrentPath && !node.activePath && !node.activeTerminal}
                    style={`left:${position.left}px;top:${position.top}px;width:${cardWidth}px;height:${cardHeight}px;`}
                    aria-current={node.activeTerminal ? 'true' : undefined}
                    aria-disabled={loading || node.terminals.length === 0 ? 'true' : undefined}
                    tabindex={!loading && node.terminals.length > 0 ? 0 : -1}
                    onclick={() => selectMessageNode(node)}
                >
                    {#if node.activeTerminal && !zoomedOut}<span class="branch-node-glow pointer-events-none absolute -right-8 -top-12 size-28 rounded-full opacity-0 blur-2xl"></span>{/if}
                    {#if node.kind === 'summary'}
                        <div class="relative flex w-full items-center gap-2">
                            <span class="flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-textcolor2/40 bg-textcolor/5 text-textcolor2">
                                <Ellipsis size={17} />
                            </span>
                            <span class="text-xs font-bold text-textcolor">
                                {language.branchGraphCollapsedMessages.replace('{}', node.collapsedCount.toString())}
                            </span>
                            <span class="ml-auto text-[10px] tabular-nums text-textcolor2">
                                {language.branchGraphCollapsedRange
                                    .replace('{}', (node.messageIndex + 1).toString())
                                    .replace('{}', (node.endMessageIndex + 1).toString())}
                            </span>
                        </div>
                        <div class="relative mt-2 flex min-h-0 flex-1 flex-col justify-center gap-1 text-[10px] leading-4 text-textcolor2">
                            <div class="truncate" title={node.preview}>{node.preview || language.branchGraphNoMessages}</div>
                            <div class="flex items-center gap-2 text-textcolor2/45"><span class="h-px flex-1 bg-textcolor2/20"></span>···<span class="h-px flex-1 bg-textcolor2/20"></span></div>
                            <div class="truncate" title={node.endPreview}>{node.endPreview || language.branchGraphNoMessages}</div>
                        </div>
                    {:else}
                        <div class="relative flex w-full min-w-0 items-center gap-2">
                            <span class="message-role flex shrink-0 items-center gap-1 rounded-full border border-selected/70 bg-selected/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-textcolor2">
                                <span class="size-1.5 rounded-full" class:bg-green-500={node.role === 'char'} class:bg-textcolor2={node.role === 'user'}></span>
                                {node.isComment ? language.branchGraphComment : node.role === 'user' ? language.branchGraphUser : language.branchGraphAssistant}
                            </span>
                            <span class="text-[10px] tabular-nums text-textcolor2">#{node.messageIndex + 1}</span>
                            {#if node.branchPoint}
                                <span class="flex items-center gap-1 rounded-full border border-selected bg-selected/30 px-2 py-0.5 text-[10px] font-bold text-textcolor">
                                    <GitBranch size={11} />
                                    {language.branchGraphForkCount.replace('{}', node.continuationCount.toString())}
                                </span>
                            {/if}
                            {#if node.activeTerminal}
                                <span class="ml-auto flex items-center gap-1 text-[10px] font-bold uppercase text-green-500">
                                    <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_7px_rgb(34_197_94/0.8)]"></span>
                                    {language.branchGraphActive}
                                </span>
                            {/if}
                        </div>
                        <div class="relative mt-2 line-clamp-2 w-full text-xs leading-4 text-textcolor" title={node.preview}>
                            {node.preview || language.branchGraphNoMessages}
                        </div>
                        <div class="relative mt-auto flex min-h-4 w-full items-end gap-2 text-[10px] text-textcolor2">
                            {#if node.model}<span class="truncate" title={node.model}>{node.model}</span>{/if}
                            {#if node.terminals.length > 0}
                                <span class="ml-auto shrink-0 font-semibold" class:text-green-500={node.activeTerminal}>
                                    {reasonLabel((node.terminals.find((item) => item.active) ?? node.terminals.at(-1))!.reason)}
                                </span>
                            {/if}
                        </div>
                    {/if}
                </button>
                {/if}
            {/each}
        </div>

        <div class="pointer-events-none absolute bottom-[max(env(safe-area-inset-bottom),1.25rem)] left-1/2 z-30 -translate-x-1/2 sm:bottom-6">
            <div class="pointer-events-auto flex items-center gap-1 rounded-2xl border border-darkborderc/80 bg-darkbg/90 p-1.5 text-textcolor2 shadow-2xl backdrop-blur-sm">
                <button class="graph-tool" onclick={() => zoomFromCenter(1 / 1.16)} title={language.branchGraphZoomOut} aria-label={language.branchGraphZoomOut}>
                    <ZoomOut size={17} />
                </button>
                <span class="min-w-12 px-1 text-center text-[11px] font-bold tabular-nums text-textcolor">{Math.round(scale * 100)}%</span>
                <button class="graph-tool" onclick={() => zoomFromCenter(1.16)} title={language.branchGraphZoomIn} aria-label={language.branchGraphZoomIn}>
                    <ZoomIn size={17} />
                </button>
                <span class="mx-1 h-5 w-px bg-darkborderc/70"></span>
                <button class="graph-tool" onclick={() => fitGraph()} title={language.branchGraphFit} aria-label={language.branchGraphFit}>
                    <Maximize size={17} />
                </button>
                {#if activeNode}
                    <button class="graph-tool" onclick={focusActive} title={language.branchGraphFocusActive} aria-label={language.branchGraphFocusActive}>
                        <GitBranch size={17} />
                    </button>
                {/if}
            </div>
        </div>

        <div class="pointer-events-none absolute bottom-[max(env(safe-area-inset-bottom),1.25rem)] right-5 hidden rounded-full border border-darkborderc/60 bg-darkbg/70 px-3 py-1.5 text-[11px] text-textcolor2 sm:block">
            {language.branchGraphHint}
        </div>
    </div>
</div>

<style>
    .graph-display-bar {
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }

    .graph-display-bar::-webkit-scrollbar {
        display: none;
    }

    .graph-mode {
        white-space: nowrap;
        border-radius: 0.6rem;
        padding: 0.35rem 0.65rem;
        color: var(--risu-theme-textcolor2);
        transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease;
    }

    @media (max-width: 640px) {
        .graph-mode {
            padding: 0.28rem 0.55rem;
            font-size: 0.72rem;
        }
    }

    .graph-mode:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 42%, transparent);
    }

    .graph-mode--active {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 72%, transparent);
        border-color: color-mix(in srgb, var(--risu-theme-selected) 72%, var(--risu-theme-darkborderc));
    }

    .graph-viewport {
        cursor: grab;
        background-color: var(--risu-theme-bgcolor);
        background-image:
            radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--risu-theme-selected) 25%, transparent) 0, transparent 42%),
            radial-gradient(color-mix(in srgb, var(--risu-theme-textcolor2) 18%, transparent) 1px, transparent 1px);
        background-size: auto, 22px 22px;
    }

    .graph-viewport.is-panning {
        cursor: grabbing;
    }

    .graph-canvas {
        transform-origin: 0 0;
        will-change: transform;
    }

    .graph-canvas--animated {
        transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
    }

    /* Zoomed out the whole canvas is visible at once: drop expensive paint
       effects that are invisible at small scales but cost the rasterizer
       large blur buffers per node. */
    .graph-canvas--zoomed-out .branch-node,
    .graph-canvas--zoomed-out .branch-node--git,
    .graph-canvas--zoomed-out .branch-node--radial,
    .graph-canvas--zoomed-out .branch-node--summary {
        box-shadow: none;
        text-shadow: none;
    }

    .branch-edge {
        stroke: color-mix(in srgb, var(--risu-theme-textcolor2) 48%, transparent);
    }

    .branch-edge.active-edge {
        stroke: #22c55e;
        filter: drop-shadow(0 0 2.5px rgb(34 197 94 / 0.55));
    }

    .branch-junction {
        fill: var(--risu-theme-bgcolor);
        stroke: color-mix(in srgb, var(--risu-theme-textcolor2) 65%, transparent);
        stroke-width: 2px;
    }

    .branch-junction.active-junction {
        fill: #22c55e;
        stroke: color-mix(in srgb, #22c55e 35%, var(--risu-theme-bgcolor));
    }

    .branch-edge--muted,
    .branch-junction--muted {
        opacity: 0.16;
    }

    .branch-node {
        cursor: default;
        border-color: color-mix(in srgb, var(--risu-theme-darkborderc) 85%, transparent);
        background: linear-gradient(145deg,
            color-mix(in srgb, var(--risu-theme-darkbg) 94%, var(--risu-theme-textcolor) 6%),
            color-mix(in srgb, var(--risu-theme-bgcolor) 92%, var(--risu-theme-selected) 8%));
        box-shadow: 0 16px 36px rgb(0 0 0 / 0.2), inset 0 1px 0 color-mix(in srgb, var(--risu-theme-textcolor) 7%, transparent);
        transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease, opacity 160ms ease;
    }

    .branch-node--git {
        border-left-width: 3px;
        border-radius: 0.8rem;
        box-shadow: 0 10px 24px rgb(0 0 0 / 0.18), inset 0 1px 0 color-mix(in srgb, var(--risu-theme-textcolor) 7%, transparent);
    }

    .branch-node--radial {
        box-shadow: 0 12px 30px rgb(0 0 0 / 0.24), inset 0 1px 0 color-mix(in srgb, var(--risu-theme-textcolor) 9%, transparent);
    }

    .branch-node--muted {
        opacity: 0.2;
    }

    /* LOD blocks: no border-radius, no gradients, no shadows — one solid
       paint rect per node so the compositor survives hundreds of nodes. */
    .branch-node--lod {
        cursor: default;
        border: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 85%, transparent);
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 92%, var(--risu-theme-selected) 8%);
        border-radius: 6px;
    }

    .branch-node--lod.branch-node--path {
        background: color-mix(in srgb, #22c55e 20%, var(--risu-theme-bgcolor));
    }

    .branch-node--lod.branch-node--active {
        background: #22c55e;
    }

    .branch-node--lod.branch-node--summary {
        border-style: dashed;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 76%, transparent);
    }

    .branch-node:hover {
        border-color: color-mix(in srgb, var(--risu-theme-darkborderc) 85%, transparent);
    }

    /* The base .branch-node transition covers border/shadow/transform/opacity;
       strip it from LOD blocks so switching classes never animates paint. */
    .branch-node--lod {
        transition: none;
    }

    .branch-node--lod:hover {
        transform: none;
        box-shadow: none;
    }

    .branch-node--selectable {
        cursor: pointer;
    }

    .branch-node--selectable:hover {
        z-index: 20;
        transform: translateY(-3px);
        border-color: color-mix(in srgb, var(--risu-theme-textcolor2) 70%, var(--risu-theme-darkborderc));
        box-shadow: 0 20px 42px rgb(0 0 0 / 0.3), inset 0 1px 0 color-mix(in srgb, var(--risu-theme-textcolor) 12%, transparent);
    }

    .branch-node--summary {
        border-style: dashed;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 76%, transparent);
        box-shadow: 0 10px 26px rgb(0 0 0 / 0.14);
    }

    .branch-node--path {
        border-color: color-mix(in srgb, #22c55e 38%, var(--risu-theme-darkborderc));
    }

    .branch-node--active {
        border-color: #22c55e;
        box-shadow: 0 18px 44px rgb(34 197 94 / 0.16), 0 0 0 2px rgb(34 197 94 / 0.3), inset 0 1px 0 rgb(255 255 255 / 0.08);
    }

    .branch-node--active .branch-node-glow {
        background: #22c55e;
        opacity: 0.18;
    }

    .graph-tool {
        display: flex;
        width: 2rem;
        height: 2rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.65rem;
        transition: color 140ms ease, background-color 140ms ease;
    }

    .graph-tool:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 65%, transparent);
    }
</style>
