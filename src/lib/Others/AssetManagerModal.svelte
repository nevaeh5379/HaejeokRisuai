<script lang="ts">
    import { onMount } from "svelte";
    import {
        XIcon,
        PlusIcon,
        TrashIcon,
        CopyIcon,
        CheckIcon,
        ImageIcon,
        ImageOffIcon,
        SearchIcon,
        MusicIcon,
        VideoIcon,
        FileTextIcon,
        LayoutGridIcon,
        ListIcon,
        UploadCloudIcon,
        ArrowUpDownIcon,
        CheckSquareIcon,
        SquareIcon,
        EyeIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        LayersIcon,
        Edit3Icon,
        Maximize2Icon,
        FolderIcon,
        FolderPlusIcon,
        HomeIcon
    } from "@lucide/svelte";
    import { selectedCharID, assetManagerModalStore } from "src/ts/stores.svelte";
    import { characterStore, settingsStore } from "src/ts/stores/domain";
    import type { character } from "src/ts/storage/database.svelte";
    import { language } from "src/lang";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { selectMultipleFile } from "src/ts/util";
    import { alertConfirm, alertInput } from "src/ts/alert";
    import { v4 as uuidv4 } from "uuid";
    import {
        getAssetCategory,
        getDefaultMacroTag,
        copyTextToClipboard,
        processAssetUploads,
        SUPPORTED_ASSET_EXTENSIONS,
        type AssetCategory
    } from "src/ts/assetUtils";
    import {
        applyBatchRenamePreview,
        buildBatchRenamePreview,
        collectAssetFolderSubtree,
        remapAssetFolderAssignments,
        selectAssetRange,
        type AssetFolder
    } from "src/ts/assetManagerUtils";

    // View & layout states
    let viewMode: "grid" | "list" = $state("grid");
    let gridSize: "sm" | "md" | "lg" = $state("md");
    let searchQuery = $state("");
    let selectedCategory: AssetCategory = $state(assetManagerModalStore.filterType || "all");
    let sortOption: "index" | "nameAsc" | "nameDesc" | "ext" = $state("index");
    let selectedIndices = $state<Set<number>>(new Set());
    let selectionAnchor: number | null = $state(null);
    let currentFolderId: string | null = $state(null);

    type MarqueeRect = { left: number; top: number; width: number; height: number };
    let marqueeRect: MarqueeRect | null = $state(null);
    let marqueePointerId: number | null = $state(null);
    let marqueeStart = { x: 0, y: 0 };
    let marqueeInitialSelection = new Set<number>();
    let marqueeAdditive = false;
    let marqueeKeepBulkBar = $state(false);

    // Professional batch rename workspace
    let batchRenameOpen = $state(false);
    let batchRenamePattern = $state("");
    let batchRenameReplacement = $state("");
    let batchRenameFlags = $state("g");
    let batchRenameStartAt = $state(1);
    let batchRenameScope: "selected" | "filtered" = $state("selected");

    // Lightbox full-size preview state
    let inspectingIndex: number | null = $state(
        assetManagerModalStore.selectedAssetIndex >= 0 ? assetManagerModalStore.selectedAssetIndex : null
    );

    // Editing states in lightbox
    let isEditingName = $state(false);
    let renameInput = $state("");
    let renameError = $state("");

    // Toast & feedback state
    let copiedTagKey: string | null = $state(null);
    let isDraggingFiles = $state(false);

    let currentChar = $derived(
        characterStore.characters[$selectedCharID] as character | undefined
    );

    let rawAssets = $derived(currentChar?.additionalAssets ?? []);
    let assetFolders = $derived((currentChar?.additionalAssetFolders ?? []) as AssetFolder[]);
    let assetFolderAssignments = $derived(currentChar?.additionalAssetFolderAssignments ?? {});
    let validFolderIds = $derived(new Set(assetFolders.map((folder) => folder.id)));
    let visibleFolders = $derived.by(() => {
        const q = searchQuery.trim().toLowerCase();
        return assetFolders.filter((folder) =>
            (folder.parentId ?? null) === currentFolderId && (!q || folder.name.toLowerCase().includes(q))
        );
    });
    let folderBreadcrumbs = $derived.by(() => {
        const result: AssetFolder[] = [];
        let id = currentFolderId;
        const seen = new Set<string>();
        while (id && !seen.has(id)) {
            seen.add(id);
            const folder = assetFolders.find((candidate) => candidate.id === id);
            if (!folder) break;
            result.unshift(folder);
            id = folder.parentId ?? null;
        }
        return result;
    });

    // Category counts for filter badges
    let categoryCounts = $derived.by(() => {
        const counts: Record<AssetCategory, number> = {
            all: rawAssets.length,
            image: 0,
            audio: 0,
            video: 0,
            font: 0,
            other: 0
        };
        for (const a of rawAssets) {
            const ext = a[2] || a[1]?.split(".").pop() || "";
            const cat = getAssetCategory(ext);
            counts[cat] = (counts[cat] || 0) + 1;
        }
        return counts;
    });

    // Keep only near-viewport thumbnail URLs in component state. getFileSrc's
    // thumbnail caches are bounded, so old Blob URLs are revoked automatically.
    let assetSrcMap = $state<Record<string, string>>({});

    type AssetPreviewTarget = { assetId: string; category: AssetCategory };

    function resolveAssetSrc(assetId: string, thumbnail = false) {
        if (/^(https?:|data:|blob:|\/)/i.test(assetId)) {
            return Promise.resolve(assetId);
        }
        return getFileSrc(assetId, thumbnail ? { thumbnail: true } : undefined);
    }

    type AssetPreviewRegistration = {
        target: AssetPreviewTarget;
        isNearViewport: boolean;
        activeAssetId: string | null;
        loadVersion: number;
    };

    const previewRegistrations = new Map<HTMLElement, AssetPreviewRegistration>();
    const activePreviewRefs = new Map<string, number>();
    let galleryEl = $state<HTMLDivElement | null>(null);
    let previewObserver: IntersectionObserver | null = null;

    function removeThumbnailSource(assetId: string) {
        if (!assetSrcMap[assetId]) return;
        const next = { ...assetSrcMap };
        delete next[assetId];
        assetSrcMap = next;
    }

    function deactivatePreview(registration: AssetPreviewRegistration) {
        registration.loadVersion++;
        const assetId = registration.activeAssetId;
        if (!assetId) return;

        registration.activeAssetId = null;
        const nextRefCount = (activePreviewRefs.get(assetId) ?? 1) - 1;
        if (nextRefCount > 0) {
            activePreviewRefs.set(assetId, nextRefCount);
        } else {
            activePreviewRefs.delete(assetId);
            removeThumbnailSource(assetId);
        }
    }

    async function activatePreview(registration: AssetPreviewRegistration) {
        const { assetId, category } = registration.target;
        if (
            category !== "image" ||
            !assetId ||
            registration.activeAssetId === assetId
        ) return;

        registration.activeAssetId = assetId;
        activePreviewRefs.set(assetId, (activePreviewRefs.get(assetId) ?? 0) + 1);
        if (assetSrcMap[assetId]) return;

        const version = ++registration.loadVersion;
        try {
            const url = await resolveAssetSrc(assetId, true);
            if (
                version !== registration.loadVersion ||
                !registration.isNearViewport ||
                registration.activeAssetId !== assetId
            ) return;
            if (url && url !== "/none.webp") {
                assetSrcMap = { ...assetSrcMap, [assetId]: url };
            }
        } catch (error) {
            console.error("Failed to load asset thumbnail", error);
        }
    }

    function getPreviewObserver() {
        previewObserver ??= new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const registration = previewRegistrations.get(entry.target as HTMLElement);
                    if (!registration) continue;
                    const isNearViewport = entry.isIntersecting;
                    if (registration.isNearViewport === isNearViewport) continue;
                    registration.isNearViewport = isNearViewport;
                    if (isNearViewport) void activatePreview(registration);
                    else deactivatePreview(registration);
                }
            },
            {
                root: galleryEl,
                rootMargin: settingsStore.state.lowSpecMode ? "100px 0px" : "200px 0px",
                threshold: 0
            }
        );
        return previewObserver;
    }

    function observeAssetPreview(node: HTMLElement, initialTarget: AssetPreviewTarget) {
        const registration: AssetPreviewRegistration = {
            target: initialTarget,
            isNearViewport: false,
            activeAssetId: null,
            loadVersion: 0
        };
        previewRegistrations.set(node, registration);
        getPreviewObserver().observe(node);

        return {
            update(nextTarget: AssetPreviewTarget) {
                if (
                    nextTarget.assetId === registration.target.assetId &&
                    nextTarget.category === registration.target.category
                ) return;
                deactivatePreview(registration);
                registration.target = nextTarget;
                if (registration.isNearViewport) void activatePreview(registration);
            },
            destroy() {
                previewObserver?.unobserve(node);
                deactivatePreview(registration);
                previewRegistrations.delete(node);
                if (previewRegistrations.size === 0) {
                    previewObserver?.disconnect();
                    previewObserver = null;
                }
            }
        };
    }

    // Processed and filtered list of assets
    let processedAssets = $derived.by(() => {
        let list = rawAssets.map((item, originalIndex) => ({
            item,
            originalIndex,
            name: item[0] || "",
            assetId: item[1] || "",
            ext: (item[2] || item[1]?.split(".").pop() || "png").toLowerCase(),
            category: getAssetCategory(item[2] || item[1]?.split(".").pop() || "png")
        }));

        // Folder metadata is deliberately separate from the legacy asset tuple.
        list = list.filter((asset) => {
            const assignedFolder = assetFolderAssignments[asset.name];
            const normalizedFolder = assignedFolder && validFolderIds.has(assignedFolder)
                ? assignedFolder
                : null;
            return normalizedFolder === currentFolderId;
        });

        // Filter by category
        if (selectedCategory !== "all") {
            list = list.filter((a) => a.category === selectedCategory);
        }

        // Filter by search query
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(
                (a) =>
                    a.name.toLowerCase().includes(q) ||
                    a.ext.toLowerCase().includes(q) ||
                    a.assetId.toLowerCase().includes(q)
            );
        }

        // Sort
        if (sortOption === "nameAsc") {
            list.sort((a, b) => a.name.localeCompare(b.name));
        } else if (sortOption === "nameDesc") {
            list.sort((a, b) => b.name.localeCompare(a.name));
        } else if (sortOption === "ext") {
            list.sort((a, b) => a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name));
        }

        return list;
    });

    // Progressive rendering limit for instantaneous modal rendering with large asset lists
    let displayLimit = $state(48);

    $effect(() => {
        void selectedCategory;
        void searchQuery;
        void sortOption;
        void currentFolderId;
        displayLimit = 48;
    });

    $effect(() => {
        if (currentFolderId && !validFolderIds.has(currentFolderId)) currentFolderId = null;
    });

    let displayedAssets = $derived(processedAssets.slice(0, displayLimit));

    let batchRenameTargetIndices = $derived.by(() => {
        if (batchRenameScope === "filtered") {
            return processedAssets.map((asset) => asset.originalIndex);
        }
        const ordered = processedAssets
            .filter((asset) => selectedIndices.has(asset.originalIndex))
            .map((asset) => asset.originalIndex);
        const visibleSet = new Set(ordered);
        const hidden = Array.from(selectedIndices)
            .filter((index) => !visibleSet.has(index))
            .sort((a, b) => a - b);
        return [...ordered, ...hidden];
    });

    let batchRenamePreview = $derived(
        buildBatchRenamePreview(rawAssets, batchRenameTargetIndices, {
            pattern: batchRenamePattern,
            replacement: batchRenameReplacement,
            flags: batchRenameFlags,
            startAt: batchRenameStartAt
        })
    );

    function handleGalleryScroll(e: UIEvent) {
        const target = e.currentTarget as HTMLElement;
        if (target.scrollTop + target.clientHeight >= target.scrollHeight - 400) {
            if (displayLimit < processedAssets.length) {
                displayLimit = Math.min(displayLimit + 48, processedAssets.length);
            }
        }
    }

    // Current inspecting asset item for lightbox
    let inspectingAsset = $derived.by(() => {
        if (inspectingIndex === null || !rawAssets[inspectingIndex]) return null;
        const item = rawAssets[inspectingIndex];
        const ext = (item[2] || item[1]?.split(".").pop() || "png").toLowerCase();
        return {
            originalIndex: inspectingIndex,
            name: item[0],
            assetId: item[1],
            ext,
            category: getAssetCategory(ext),
            isExcluded: currentChar?.prebuiltAssetExclude?.includes(item[1]) ?? false,
            defaultTag: getDefaultMacroTag(ext, item[0])
        };
    });

    let inspectingSrcUrl = $state("");
    let inspectingLoadVersion = 0;

    $effect(() => {
        const assetId = inspectingAsset?.assetId;
        const version = ++inspectingLoadVersion;
        inspectingSrcUrl = "";
        if (!assetId) return;

        resolveAssetSrc(assetId)
            .then((url) => {
                if (
                    version === inspectingLoadVersion &&
                    inspectingAsset?.assetId === assetId
                ) {
                    inspectingSrcUrl = url;
                }
            })
            .catch((error) => {
                console.error("Failed to load full asset preview", error);
            });

        return () => {
            inspectingLoadVersion++;
            inspectingSrcUrl = "";
        };
    });

    $effect(() => {
        if (inspectingAsset) {
            renameInput = inspectingAsset.name;
            renameError = "";
            isEditingName = false;
        }
    });

    function closeModal() {
        assetManagerModalStore.open = false;
        assetManagerModalStore.selectedAssetIndex = -1;
    }

    function handleKeyDown(e: KeyboardEvent) {
        const target = e.target as HTMLElement | null;
        const isInputFocused = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));

        if (e.key === "Escape") {
            if (batchRenameOpen) {
                batchRenameOpen = false;
            } else if (inspectingIndex !== null) {
                inspectingIndex = null;
            } else {
                closeModal();
            }
            return;
        }

        if (!isInputFocused && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            selectAll();
            return;
        }

        if (!isInputFocused && (e.key === "Delete" || e.key === "Backspace") && selectedIndices.size > 0) {
            e.preventDefault();
            void handleBatchDelete();
            return;
        }

        if (inspectingIndex !== null && !isInputFocused) {
            if (e.key === "ArrowLeft") navigateInspector(-1);
            else if (e.key === "ArrowRight") navigateInspector(1);
        }
    }

    function getGalleryPoint(e: PointerEvent) {
        if (!galleryEl) return null;
        const bounds = galleryEl.getBoundingClientRect();
        return {
            x: e.clientX - bounds.left + galleryEl.scrollLeft,
            y: e.clientY - bounds.top + galleryEl.scrollTop
        };
    }

    function updateMarqueeSelection() {
        if (!galleryEl || !marqueeRect) return;
        const galleryBounds = galleryEl.getBoundingClientRect();
        const selectionBounds = {
            left: galleryBounds.left + marqueeRect.left - galleryEl.scrollLeft,
            top: galleryBounds.top + marqueeRect.top - galleryEl.scrollTop,
            right: galleryBounds.left + marqueeRect.left + marqueeRect.width - galleryEl.scrollLeft,
            bottom: galleryBounds.top + marqueeRect.top + marqueeRect.height - galleryEl.scrollTop
        };
        const next = marqueeAdditive
            ? new Set(marqueeInitialSelection)
            : new Set<number>();

        for (const element of galleryEl.querySelectorAll<HTMLElement>("[data-asset-index]")) {
            const index = Number(element.dataset.assetIndex);
            if (!Number.isInteger(index)) continue;
            const bounds = element.getBoundingClientRect();
            const intersects =
                selectionBounds.left <= bounds.right &&
                selectionBounds.right >= bounds.left &&
                selectionBounds.top <= bounds.bottom &&
                selectionBounds.bottom >= bounds.top;
            if (intersects) next.add(index);
        }
        selectedIndices = next;
    }

    function handleGalleryPointerDown(e: PointerEvent) {
        if (!galleryEl || e.pointerType !== "mouse" || e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-asset-index], [data-folder-id], button, input, textarea, select, a, table")) return;
        const point = getGalleryPoint(e);
        if (!point) return;

        e.preventDefault();
        marqueePointerId = e.pointerId;
        marqueeStart = point;
        marqueeInitialSelection = new Set(selectedIndices);
        marqueeAdditive = e.ctrlKey || e.metaKey;
        marqueeKeepBulkBar = selectedIndices.size > 0;
        if (!marqueeAdditive) selectedIndices = new Set();
        selectionAnchor = null;
        marqueeRect = { left: point.x, top: point.y, width: 0, height: 0 };
        galleryEl.setPointerCapture?.(e.pointerId);
    }

    function handleGalleryPointerMove(e: PointerEvent) {
        if (!galleryEl || marqueePointerId !== e.pointerId) return;
        e.preventDefault();

        const bounds = galleryEl.getBoundingClientRect();
        const edge = 36;
        if (e.clientY < bounds.top + edge) galleryEl.scrollTop -= 14;
        else if (e.clientY > bounds.bottom - edge) galleryEl.scrollTop += 14;

        const point = getGalleryPoint(e);
        if (!point) return;
        marqueeRect = {
            left: Math.min(marqueeStart.x, point.x),
            top: Math.min(marqueeStart.y, point.y),
            width: Math.abs(point.x - marqueeStart.x),
            height: Math.abs(point.y - marqueeStart.y)
        };
        updateMarqueeSelection();
    }

    function finishMarqueeSelection(e: PointerEvent, cancelled = false) {
        if (!galleryEl || marqueePointerId !== e.pointerId) return;
        if (cancelled) selectedIndices = new Set(marqueeInitialSelection);
        if (galleryEl.hasPointerCapture?.(e.pointerId)) {
            galleryEl.releasePointerCapture(e.pointerId);
        }
        marqueePointerId = null;
        marqueeRect = null;
        marqueeInitialSelection = new Set();
        marqueeAdditive = false;
        marqueeKeepBulkBar = false;
    }

    onMount(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    });

    function assignNewAssetsToFolder(
        previousLength: number,
        updated: [string, string, string][],
        folderId: string | null
    ) {
        if (!currentChar || !folderId) return;
        const assignments = { ...(currentChar.additionalAssetFolderAssignments ?? {}) };
        for (const asset of updated.slice(previousLength)) assignments[asset[0]] = folderId;
        currentChar.additionalAssetFolderAssignments = assignments;
    }

    async function handleAddFiles() {
        if (currentChar?.type !== "character") return;
        const files = await selectMultipleFile(SUPPORTED_ASSET_EXTENSIONS);
        if (!files || files.length === 0) return;

        const previousLength = currentChar.additionalAssets?.length ?? 0;
        const updated = await processAssetUploads(files, currentChar.additionalAssets ?? []);
        currentChar.additionalAssets = updated;
        assignNewAssetsToFolder(previousLength, updated, currentFolderId);
    }

    async function handleDropFiles(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        isDraggingFiles = false;
        if (currentChar?.type !== "character") return;

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const previousLength = currentChar.additionalAssets?.length ?? 0;
        const fileArray = Array.from(files);
        const updated = await processAssetUploads(fileArray, currentChar.additionalAssets ?? []);
        currentChar.additionalAssets = updated;
        assignNewAssetsToFolder(previousLength, updated, currentFolderId);
    }

    function navigateToFolder(folderId: string | null) {
        currentFolderId = folderId;
        selectedIndices = new Set();
        selectionAnchor = null;
        displayLimit = 48;
    }

    function getFolderPathLabel(folder: AssetFolder) {
        const parts = [folder.name];
        let parentId = folder.parentId;
        const seen = new Set<string>([folder.id]);
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const parent = assetFolders.find((candidate) => candidate.id === parentId);
            if (!parent) break;
            parts.unshift(parent.name);
            parentId = parent.parentId;
        }
        return parts.join(" / ");
    }

    async function createFolder() {
        if (!currentChar) return;
        const name = (await alertInput("Folder name"))?.trim();
        if (!name) return;
        const duplicate = assetFolders.some(
            (folder) => (folder.parentId ?? null) === currentFolderId && folder.name === name
        );
        if (duplicate) return;
        currentChar.additionalAssetFolders = [
            ...(currentChar.additionalAssetFolders ?? []),
            { id: uuidv4(), name, ...(currentFolderId ? { parentId: currentFolderId } : {}) }
        ];
    }

    async function renameFolder(folder: AssetFolder) {
        if (!currentChar) return;
        const name = (await alertInput("Rename folder", undefined, folder.name))?.trim();
        if (!name || name === folder.name) return;
        const duplicate = assetFolders.some(
            (candidate) => candidate.id !== folder.id &&
                (candidate.parentId ?? null) === (folder.parentId ?? null) &&
                candidate.name === name
        );
        if (duplicate) return;
        currentChar.additionalAssetFolders = assetFolders.map((candidate) =>
            candidate.id === folder.id ? { ...candidate, name } : candidate
        );
    }

    async function deleteFolder(folder: AssetFolder) {
        if (!currentChar) return;
        const confirmed = await alertConfirm(
            `Delete folder "${folder.name}"? Assets inside it will be moved to the parent folder.`
        );
        if (!confirmed) return;
        const removedIds = collectAssetFolderSubtree(assetFolders, folder.id);
        const assignments = { ...(currentChar.additionalAssetFolderAssignments ?? {}) };
        for (const [assetName, folderId] of Object.entries(assignments)) {
            if (!removedIds.has(folderId)) continue;
            if (folder.parentId) assignments[assetName] = folder.parentId;
            else delete assignments[assetName];
        }
        currentChar.additionalAssetFolderAssignments = assignments;
        currentChar.additionalAssetFolders = assetFolders.filter((candidate) => !removedIds.has(candidate.id));
        if (currentFolderId && removedIds.has(currentFolderId)) navigateToFolder(folder.parentId ?? null);
    }

    function moveAssetIndicesToFolder(indices: Iterable<number>, folderId: string | null) {
        if (!currentChar?.additionalAssets) return;
        const assignments = { ...(currentChar.additionalAssetFolderAssignments ?? {}) };
        for (const index of indices) {
            const asset = currentChar.additionalAssets[index];
            if (!asset) continue;
            if (folderId) assignments[asset[0]] = folderId;
            else delete assignments[asset[0]];
        }
        currentChar.additionalAssetFolderAssignments = assignments;
        selectedIndices = new Set();
        selectionAnchor = null;
    }

    function moveSelectedToFolder(folderId: string | null) {
        if (selectedIndices.size === 0) return;
        moveAssetIndicesToFolder(selectedIndices, folderId);
    }

    const INTERNAL_ASSET_DRAG_TYPE = "application/x-risu-additional-assets";

    function handleAssetDragStart(e: DragEvent, originalIndex: number) {
        if (!e.dataTransfer) return;
        const indices = selectedIndices.has(originalIndex)
            ? Array.from(selectedIndices)
            : [originalIndex];
        if (!selectedIndices.has(originalIndex)) {
            selectedIndices = new Set(indices);
            selectionAnchor = originalIndex;
        }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(INTERNAL_ASSET_DRAG_TYPE, JSON.stringify(indices));
    }

    function handleFolderDragOver(e: DragEvent) {
        const types = e.dataTransfer?.types;
        if (!types?.includes(INTERNAL_ASSET_DRAG_TYPE) && !types?.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = types.includes(INTERNAL_ASSET_DRAG_TYPE) ? "move" : "copy";
        }
    }

    async function handleFolderDrop(e: DragEvent, folderId: string | null) {
        const dataTransfer = e.dataTransfer;
        if (!dataTransfer) return;

        const encoded = dataTransfer.getData(INTERNAL_ASSET_DRAG_TYPE);
        if (encoded) {
            e.preventDefault();
            e.stopPropagation();
            try {
                const indices = JSON.parse(encoded);
                if (Array.isArray(indices)) {
                    moveAssetIndicesToFolder(
                        indices.filter((index): index is number => Number.isInteger(index)),
                        folderId
                    );
                }
            } catch {}
            return;
        }

        if (!dataTransfer.types.includes("Files") || dataTransfer.files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        isDraggingFiles = false;
        if (currentChar?.type !== "character") return;
        const previousLength = currentChar.additionalAssets?.length ?? 0;
        const updated = await processAssetUploads(
            Array.from(dataTransfer.files),
            currentChar.additionalAssets ?? []
        );
        currentChar.additionalAssets = updated;
        assignNewAssetsToFolder(previousLength, updated, folderId);
    }

    async function handleCopyTag(tag: string, keyIdentifier: string) {
        const success = await copyTextToClipboard(tag);
        if (success) {
            copiedTagKey = keyIdentifier;
            setTimeout(() => {
                if (copiedTagKey === keyIdentifier) copiedTagKey = null;
            }, 1500);
        }
    }

    function togglePromptExclude(assetId: string) {
        if (!currentChar) return;
        currentChar.prebuiltAssetExclude ??= [];
        if (currentChar.prebuiltAssetExclude.includes(assetId)) {
            currentChar.prebuiltAssetExclude = currentChar.prebuiltAssetExclude.filter(
                (id) => id !== assetId
            );
        } else {
            currentChar.prebuiltAssetExclude = [
                ...currentChar.prebuiltAssetExclude,
                assetId
            ];
        }
    }

    async function handleDeleteSingle(originalIndex: number) {
        const assetName = rawAssets[originalIndex]?.[0] ?? "";
        const confirmed = await alertConfirm(
            `${language.deleteAssetConfirm}\n(${assetName})`
        );
        if (!confirmed) return;

        if (currentChar?.type !== "character" || !currentChar.additionalAssets) return;
        if (currentChar.chats?.[currentChar.chatPage]) {
            currentChar.chats[currentChar.chatPage].fmIndex = -1;
        }

        const updated = [...currentChar.additionalAssets];
        updated.splice(originalIndex, 1);
        currentChar.additionalAssets = updated;
        if (assetName && currentChar.additionalAssetFolderAssignments?.[assetName]) {
            const assignments = { ...currentChar.additionalAssetFolderAssignments };
            delete assignments[assetName];
            currentChar.additionalAssetFolderAssignments = assignments;
        }

        if (inspectingIndex === originalIndex) {
            inspectingIndex = null;
        } else if (inspectingIndex !== null && inspectingIndex > originalIndex) {
            inspectingIndex--;
        }
        selectedIndices = new Set(
            Array.from(selectedIndices)
                .filter((index) => index !== originalIndex)
                .map((index) => index > originalIndex ? index - 1 : index)
        );
        if (selectionAnchor === originalIndex) selectionAnchor = null;
        else if (selectionAnchor !== null && selectionAnchor > originalIndex) selectionAnchor--;
    }

    function applySelectionMode(originalIndex: number, mode: "select" | "deselect") {
        const next = new Set(selectedIndices);
        if (mode === "select") next.add(originalIndex);
        else next.delete(originalIndex);
        selectedIndices = next;
    }

    function toggleSelect(originalIndex: number, e?: MouseEvent) {
        e?.stopPropagation();
        if (e?.shiftKey && selectionAnchor !== null) {
            const range = selectAssetRange(
                processedAssets.map((asset) => asset.originalIndex),
                selectionAnchor,
                originalIndex
            );
            const next = e.ctrlKey || e.metaKey ? new Set(selectedIndices) : new Set<number>();
            for (const index of range) next.add(index);
            selectedIndices = next;
            return;
        }

        applySelectionMode(
            originalIndex,
            selectedIndices.has(originalIndex) ? "deselect" : "select"
        );
        selectionAnchor = originalIndex;
    }

    function handleAssetClick(e: MouseEvent, originalIndex: number) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            toggleSelect(originalIndex, e);
        } else {
            inspectingIndex = originalIndex;
        }
    }

    function selectAll() {
        selectedIndices = new Set(processedAssets.map((item) => item.originalIndex));
        selectionAnchor = processedAssets[0]?.originalIndex ?? null;
    }

    function deselectAll() {
        selectedIndices = new Set();
        selectionAnchor = null;
    }

    function invertSelection() {
        const next = new Set<number>();
        for (const item of processedAssets) {
            if (!selectedIndices.has(item.originalIndex)) next.add(item.originalIndex);
        }
        selectedIndices = next;
        selectionAnchor = null;
    }

    async function handleBatchDelete() {
        if (selectedIndices.size === 0 || !currentChar?.additionalAssets) return;
        const confirmed = await alertConfirm(
            `${language.deleteAssetConfirm} (${selectedIndices.size})`
        );
        if (!confirmed) return;

        if (currentChar.chats?.[currentChar.chatPage]) {
            currentChar.chats[currentChar.chatPage].fmIndex = -1;
        }

        const deletedNames = Array.from(selectedIndices)
            .map((index) => currentChar.additionalAssets?.[index]?.[0])
            .filter(Boolean) as string[];
        const updated = currentChar.additionalAssets.filter(
            (_, idx) => !selectedIndices.has(idx)
        );
        currentChar.additionalAssets = updated;
        if (deletedNames.length > 0) {
            const assignments = { ...(currentChar.additionalAssetFolderAssignments ?? {}) };
            for (const name of deletedNames) delete assignments[name];
            currentChar.additionalAssetFolderAssignments = assignments;
        }
        selectedIndices = new Set();
        selectionAnchor = null;
        inspectingIndex = null;
    }

    function handleBatchExcludeToggle() {
        if (!currentChar || selectedIndices.size === 0 || !currentChar.additionalAssets) return;
        currentChar.prebuiltAssetExclude ??= [];

        const selectedAssetIds = Array.from(selectedIndices)
            .map((idx) => currentChar?.additionalAssets?.[idx]?.[1])
            .filter(Boolean) as string[];

        const allExcluded = selectedAssetIds.every((id) =>
            currentChar?.prebuiltAssetExclude?.includes(id)
        );

        if (allExcluded) {
            currentChar.prebuiltAssetExclude = currentChar.prebuiltAssetExclude.filter(
                (id) => !selectedAssetIds.includes(id)
            );
        } else {
            const next = new Set([...currentChar.prebuiltAssetExclude, ...selectedAssetIds]);
            currentChar.prebuiltAssetExclude = Array.from(next);
        }
    }

    async function handleBatchCopyTags() {
        if (!currentChar?.additionalAssets || selectedIndices.size === 0) return;
        const tags = Array.from(selectedIndices)
            .map((idx) => {
                const asset = currentChar?.additionalAssets?.[idx];
                if (!asset) return "";
                const ext = asset[2] || asset[1]?.split(".").pop() || "png";
                return getDefaultMacroTag(ext, asset[0]);
            })
            .filter(Boolean)
            .join("\n");

        await handleCopyTag(tags, "batch-tags");
    }

    function openBatchRename() {
        batchRenameScope = selectedIndices.size > 0 ? "selected" : "filtered";
        batchRenameOpen = true;
    }

    async function handleApplyBatchRename() {
        if (
            !currentChar?.additionalAssets ||
            batchRenamePreview.error ||
            batchRenamePreview.conflictCount > 0 ||
            batchRenamePreview.changedCount === 0
        ) return;

        const confirmed = await alertConfirm(
            `Rename ${batchRenamePreview.changedCount} asset${batchRenamePreview.changedCount === 1 ? "" : "s"}?`
        );
        if (!confirmed) return;

        currentChar.additionalAssetFolderAssignments = remapAssetFolderAssignments(
            currentChar.additionalAssetFolderAssignments,
            batchRenamePreview.items
                .filter((item) => item.changed)
                .map((item) => ({ oldName: item.oldName, newName: item.newName }))
        );
        currentChar.additionalAssets = applyBatchRenamePreview(
            currentChar.additionalAssets,
            batchRenamePreview
        );
        batchRenameOpen = false;
    }

    function handleInlineRename(originalIndex: number, value: string) {
        if (!currentChar?.additionalAssets?.[originalIndex]) return;
        const trimmed = value.trim();
        if (!trimmed) return;
        const collision = currentChar.additionalAssets.some(
            (asset, index) => index !== originalIndex && asset[0] === trimmed
        );
        if (collision) return;
        const oldName = currentChar.additionalAssets[originalIndex][0];
        currentChar.additionalAssetFolderAssignments = remapAssetFolderAssignments(
            currentChar.additionalAssetFolderAssignments,
            [{ oldName, newName: trimmed }]
        );
        currentChar.additionalAssets[originalIndex][0] = trimmed;
    }

    function handleRenameSave() {
        if (!inspectingAsset || !currentChar?.additionalAssets) return;
        const trimmed = renameInput.trim();
        if (!trimmed) {
            renameError = "Name cannot be empty";
            return;
        }

        const collision = currentChar.additionalAssets.some(
            (a, idx) => idx !== inspectingAsset.originalIndex && a[0] === trimmed
        );
        if (collision) {
            renameError = language.duplicateNameWarn;
            return;
        }

        const oldName = currentChar.additionalAssets[inspectingAsset.originalIndex][0];
        currentChar.additionalAssetFolderAssignments = remapAssetFolderAssignments(
            currentChar.additionalAssetFolderAssignments,
            [{ oldName, newName: trimmed }]
        );
        currentChar.additionalAssets[inspectingAsset.originalIndex][0] = trimmed;
        renameError = "";
        isEditingName = false;
    }

    function navigateInspector(direction: -1 | 1) {
        if (inspectingIndex === null || processedAssets.length === 0) return;
        const currentPos = processedAssets.findIndex((a) => a.originalIndex === inspectingIndex);
        if (currentPos === -1) return;
        const nextPos = (currentPos + direction + processedAssets.length) % processedAssets.length;
        inspectingIndex = processedAssets[nextPos].originalIndex;
    }
</script>

<!-- Backdrop Modal Overlay -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-2 sm:p-4 md:p-6 animate-in fade-in duration-200 select-none"
    onclick={closeModal}
>
    <!-- Modal Dialog Window -->
    <div
        class="relative flex flex-col w-full max-w-7xl h-[92vh] max-h-[920px] bg-darkbg border border-darkborderc rounded-2xl shadow-2xl overflow-hidden text-textcolor"
        onclick={(e) => e.stopPropagation()}
        ondragover={(e) => {
            if (!e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            isDraggingFiles = true;
        }}
        ondragleave={(e) => {
            if (!e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            isDraggingFiles = false;
        }}
        ondrop={handleDropFiles}
    >
        <!-- Drag & Drop Full Window Overlay Feedback -->
        {#if isDraggingFiles}
            <div class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm border-2 border-dashed border-blue-400 rounded-2xl text-blue-400 gap-4 pointer-events-none animate-in fade-in duration-150">
                <UploadCloudIcon size={64} class="animate-bounce" />
                <span class="text-xl font-bold">{language.dropFilesToUpload}</span>
            </div>
        {/if}

        <!-- Top Header Bar -->
        <header class="flex items-center justify-between px-5 py-3.5 border-b border-darkborderc bg-bgcolor/40 shrink-0">
            <div class="flex items-center gap-3">
                <div class="p-2 rounded-xl bg-selected/20 text-selected border border-selected/30">
                    <LayersIcon size={20} />
                </div>
                <div class="flex flex-col">
                    <div class="flex items-center gap-2">
                        <h2 class="text-base sm:text-lg font-bold text-textcolor">
                            {language.assetManager}
                        </h2>
                        <span class="text-xs px-2.5 py-0.5 rounded-full bg-selected/20 text-selected border border-selected/30 font-medium">
                            {rawAssets.length}
                        </span>
                    </div>
                    {#if currentChar}
                        <span class="text-xs text-textcolor2">
                            {currentChar.name || "Unnamed Character"}
                        </span>
                    {/if}
                </div>
            </div>

            <div class="flex items-center gap-2">
                <!-- View Mode Switcher -->
                <div class="flex items-center bg-darkbg border border-darkborderc rounded-lg p-0.5">
                    <button
                        type="button"
                        class="p-1.5 rounded-md transition-colors cursor-pointer {viewMode === 'grid' ? 'bg-selected text-white shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                        title={language.viewGrid}
                        onclick={() => { viewMode = "grid"; }}
                    >
                        <LayoutGridIcon size={16} />
                    </button>
                    <button
                        type="button"
                        class="p-1.5 rounded-md transition-colors cursor-pointer {viewMode === 'list' ? 'bg-selected text-white shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                        title={language.viewList}
                        onclick={() => { viewMode = "list"; }}
                    >
                        <ListIcon size={16} />
                    </button>
                </div>

                <!-- Grid size switcher (when grid view) -->
                {#if viewMode === "grid"}
                    <div class="hidden sm:flex items-center bg-darkbg border border-darkborderc rounded-lg p-0.5 text-xs">
                        <button
                            type="button"
                            class="px-2.5 py-1 rounded transition-colors cursor-pointer {gridSize === 'sm' ? 'bg-selected text-white font-semibold' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => { gridSize = "sm"; }}
                        >
                            {language.smallSize}
                        </button>
                        <button
                            type="button"
                            class="px-2.5 py-1 rounded transition-colors cursor-pointer {gridSize === 'md' ? 'bg-selected text-white font-semibold' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => { gridSize = "md"; }}
                        >
                            {language.mediumSize}
                        </button>
                        <button
                            type="button"
                            class="px-2.5 py-1 rounded transition-colors cursor-pointer {gridSize === 'lg' ? 'bg-selected text-white font-semibold' : 'text-textcolor2 hover:text-textcolor'}"
                            onclick={() => { gridSize = "lg"; }}
                        >
                            {language.largeSize}
                        </button>
                    </div>
                {/if}

                <!-- Close button -->
                <button
                    type="button"
                    class="p-1.5 rounded-lg text-textcolor2 hover:text-textcolor hover:bg-textcolor/10 transition-colors cursor-pointer"
                    onclick={closeModal}
                    aria-label="Close"
                >
                    <XIcon size={20} />
                </button>
            </div>
        </header>

        <!-- Secondary Toolbar: Search, Filters, Sort, and Upload -->
        <div class="flex flex-wrap items-center justify-between gap-2.5 px-5 py-3 border-b border-darkborderc/80 bg-bgcolor/20 shrink-0">
            <!-- Search Bar -->
            <div class="relative flex-1 min-w-[200px] max-w-md">
                <div class="absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none">
                    <SearchIcon size={15} />
                </div>
                <input
                    type="text"
                    bind:value={searchQuery}
                    placeholder={language.searchAssets}
                    class="w-full bg-darkbg border border-darkborderc rounded-lg pl-9 pr-8 py-1.5 text-xs sm:text-sm text-textcolor placeholder-textcolor2/50 focus:outline-none focus:border-selected transition-colors"
                />
                {#if searchQuery}
                    <button
                        type="button"
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-textcolor2 hover:text-textcolor cursor-pointer"
                        onclick={() => { searchQuery = ""; }}
                    >
                        <XIcon size={14} />
                    </button>
                {/if}
            </div>

            <!-- Category Filter Chips -->
            <div class="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
                {#each [
                    { id: "all", label: language.filterAll, count: categoryCounts.all, icon: LayersIcon },
                    { id: "image", label: language.filterImages, count: categoryCounts.image, icon: ImageIcon },
                    { id: "audio", label: language.filterAudio, count: categoryCounts.audio, icon: MusicIcon },
                    { id: "video", label: language.filterVideo, count: categoryCounts.video, icon: VideoIcon },
                    { id: "font", label: language.filterFonts, count: categoryCounts.font + categoryCounts.other, icon: FileTextIcon }
                ] as cat}
                    <button
                        type="button"
                        class="px-2.5 py-1.5 rounded-lg text-xs transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer {selectedCategory === cat.id ? 'bg-selected text-white font-semibold shadow' : 'bg-darkbg text-textcolor2 hover:text-textcolor border border-darkborderc'}"
                        onclick={() => { selectedCategory = cat.id as AssetCategory; }}
                    >
                        <cat.icon size={13} />
                        <span>{cat.label}</span>
                        <span class="text-[10px] opacity-80 px-1.5 py-0.2 rounded-full {selectedCategory === cat.id ? 'bg-black/30' : 'bg-textcolor/10'}">
                            {cat.count}
                        </span>
                    </button>
                {/each}
            </div>

            <!-- Right Actions: Sort, Rename, Upload -->
            <div class="flex items-center gap-2 ml-auto">
                <!-- Sort Dropdown -->
                <div class="flex items-center bg-darkbg border border-darkborderc rounded-lg px-2 py-1 text-xs gap-1.5">
                    <ArrowUpDownIcon size={13} class="text-textcolor2" />
                    <select
                        bind:value={sortOption}
                        class="bg-transparent text-textcolor focus:outline-none cursor-pointer text-xs"
                    >
                        <option value="index" class="bg-darkbg">{language.sortIndex}</option>
                        <option value="nameAsc" class="bg-darkbg">{language.sortNameAsc}</option>
                        <option value="nameDesc" class="bg-darkbg">{language.sortNameDesc}</option>
                        <option value="ext" class="bg-darkbg">{language.sortExtension}</option>
                    </select>
                </div>

                <button
                    type="button"
                    class="p-2 rounded-lg border bg-darkbg text-textcolor2 hover:text-textcolor hover:border-selected border-darkborderc transition-colors cursor-pointer flex items-center gap-1 text-xs"
                    title="Create folder"
                    onclick={createFolder}
                >
                    <FolderPlusIcon size={15} />
                    <span class="hidden lg:inline">New Folder</span>
                </button>

                <!-- Regex batch rename -->
                <button
                    type="button"
                    class="p-2 rounded-lg border bg-darkbg text-textcolor2 hover:text-textcolor hover:border-selected border-darkborderc transition-colors cursor-pointer flex items-center gap-1 text-xs"
                    title="Regex batch rename"
                    onclick={openBatchRename}
                >
                    <Edit3Icon size={15} />
                    <span class="hidden lg:inline">Regex Rename</span>
                </button>

                <!-- Add Files Button -->
                <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg bg-selected hover:bg-selected/90 text-white font-medium transition-all shadow-sm flex items-center gap-1.5 text-xs cursor-pointer"
                    onclick={handleAddFiles}
                >
                    <PlusIcon size={15} />
                    <span>{language.addAsset}</span>
                </button>
            </div>
        </div>

        <!-- Bulk Actions Floating Bar (when items are selected) -->
        {#if selectedIndices.size > 0 || (marqueePointerId !== null && marqueeKeepBulkBar)}
            <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 bg-selected/10 border-b border-selected/20 animate-in slide-in-from-top-2 duration-150 shrink-0">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-semibold text-selected">
                        {selectedIndices.size} selected
                    </span>
                    <button
                        type="button"
                        class="text-xs text-textcolor2 hover:text-textcolor underline cursor-pointer"
                        onclick={selectAll}
                    >
                        {language.selectAll}
                    </button>
                    <button
                        type="button"
                        class="text-xs text-textcolor2 hover:text-textcolor underline cursor-pointer"
                        onclick={deselectAll}
                    >
                        {language.deselectAll}
                    </button>
                    <button
                        type="button"
                        class="text-xs text-textcolor2 hover:text-textcolor underline cursor-pointer"
                        onclick={invertSelection}
                    >
                        Invert
                    </button>
                </div>

                <div class="flex items-center gap-2">
                    <select
                        aria-label="Move selected assets"
                        class="px-2 py-1 rounded-md bg-darkbg border border-darkborderc text-textcolor text-xs cursor-pointer"
                        value=""
                        onchange={(e) => {
                            if (!e.currentTarget.value) return;
                            moveSelectedToFolder(e.currentTarget.value === "__root__" ? null : e.currentTarget.value);
                            e.currentTarget.value = "";
                        }}
                    >
                        <option value="">Move to…</option>
                        <option value="__root__" disabled={currentFolderId === null}>Assets (root)</option>
                        {#each assetFolders.filter((folder) => folder.id !== currentFolderId) as folder}
                            <option value={folder.id}>{getFolderPathLabel(folder)}</option>
                        {/each}
                    </select>

                    <button
                        type="button"
                        disabled={selectedIndices.size === 0}
                        class="px-2.5 py-1 rounded-md bg-darkbg border border-darkborderc hover:bg-textcolor/10 text-textcolor text-xs transition-colors disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                        onclick={handleBatchCopyTags}
                    >
                        <CopyIcon size={13} />
                        <span>{language.copyTag}</span>
                    </button>

                    <button
                        type="button"
                        disabled={selectedIndices.size === 0}
                        class="px-2.5 py-1 rounded-md bg-darkbg border border-darkborderc hover:bg-textcolor/10 text-textcolor text-xs transition-colors disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                        onclick={handleBatchExcludeToggle}
                    >
                        <ImageOffIcon size={13} />
                        <span>{language.batchExclude}</span>
                    </button>

                    <button
                        type="button"
                        disabled={selectedIndices.size === 0}
                        class="px-2.5 py-1 rounded-md bg-red-500/20 border border-red-500/40 hover:bg-red-500/30 text-red-300 text-xs transition-colors disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                        onclick={handleBatchDelete}
                    >
                        <TrashIcon size={13} />
                        <span>{language.batchDelete}</span>
                    </button>
                </div>
            </div>
        {/if}

        {#if batchRenameOpen}
            <div class="shrink-0 border-b border-selected/30 bg-bgcolor/70 px-5 py-3.5">
                <div class="flex flex-wrap items-start gap-3">
                    <div class="min-w-[180px] flex-1">
                        <label for="asset-batch-regex" class="mb-1 block text-[11px] font-semibold text-textcolor2">Regular expression</label>
                        <input
                            id="asset-batch-regex"
                            type="text"
                            bind:value={batchRenamePattern}
                            placeholder="^prefix_(.*)$"
                            class="w-full rounded-lg border border-darkborderc bg-darkbg px-2.5 py-1.5 font-mono text-xs text-textcolor focus:border-selected focus:outline-none"
                        />
                    </div>
                    <div class="min-w-[180px] flex-1">
                        <label for="asset-batch-replacement" class="mb-1 block text-[11px] font-semibold text-textcolor2">Replacement</label>
                        <input
                            id="asset-batch-replacement"
                            type="text"
                            bind:value={batchRenameReplacement}
                            placeholder="renamed_$1_&#123;n:03&#125;"
                            class="w-full rounded-lg border border-darkborderc bg-darkbg px-2.5 py-1.5 font-mono text-xs text-textcolor focus:border-selected focus:outline-none"
                        />
                    </div>
                    <div class="w-20">
                        <label for="asset-batch-flags" class="mb-1 block text-[11px] font-semibold text-textcolor2">Flags</label>
                        <input
                            id="asset-batch-flags"
                            type="text"
                            bind:value={batchRenameFlags}
                            placeholder="gi"
                            class="w-full rounded-lg border border-darkborderc bg-darkbg px-2.5 py-1.5 font-mono text-xs text-textcolor focus:border-selected focus:outline-none"
                        />
                    </div>
                    <div class="w-24">
                        <label for="asset-batch-start" class="mb-1 block text-[11px] font-semibold text-textcolor2">Start #</label>
                        <input
                            id="asset-batch-start"
                            type="number"
                            bind:value={batchRenameStartAt}
                            class="w-full rounded-lg border border-darkborderc bg-darkbg px-2.5 py-1.5 text-xs text-textcolor focus:border-selected focus:outline-none"
                        />
                    </div>
                    <div class="min-w-[150px]">
                        <label for="asset-batch-scope" class="mb-1 block text-[11px] font-semibold text-textcolor2">Scope</label>
                        <select
                            id="asset-batch-scope"
                            bind:value={batchRenameScope}
                            class="w-full rounded-lg border border-darkborderc bg-darkbg px-2.5 py-1.5 text-xs text-textcolor focus:border-selected focus:outline-none"
                        >
                            <option value="selected" disabled={selectedIndices.size === 0}>Selected ({selectedIndices.size})</option>
                            <option value="filtered">Filtered ({processedAssets.length})</option>
                        </select>
                    </div>
                </div>

                <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div class="text-[11px] text-textcolor2">
                        JS replacement groups such as <code>$1</code> are supported.
                        Use <code>&#123;n&#125;</code>/<code>&#123;n:03&#125;</code> for sequence numbers and
                        <code>&#123;index&#125;</code> for the original asset index.
                    </div>
                    <div class="flex items-center gap-2">
                        {#if batchRenamePreview.error}
                            <span class="max-w-[360px] truncate text-xs text-red-400" title={batchRenamePreview.error}>
                                {batchRenamePreview.error}
                            </span>
                        {:else if batchRenamePreview.conflictCount > 0}
                            <span class="text-xs font-semibold text-red-400">
                                {batchRenamePreview.conflictCount} conflict(s)
                            </span>
                        {:else}
                            <span class="text-xs text-textcolor2">
                                {batchRenamePreview.changedCount} change(s)
                            </span>
                        {/if}
                        <button
                            type="button"
                            class="rounded-lg border border-darkborderc bg-darkbg px-3 py-1.5 text-xs text-textcolor2 hover:text-textcolor cursor-pointer"
                            onclick={() => { batchRenameOpen = false; }}
                        >Cancel</button>
                        <button
                            type="button"
                            disabled={batchRenamePreview.changedCount === 0 || batchRenamePreview.conflictCount > 0 || Boolean(batchRenamePreview.error)}
                            class="rounded-lg bg-selected px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 cursor-pointer"
                            onclick={handleApplyBatchRename}
                        >Apply Rename</button>
                    </div>
                </div>

                {#if batchRenamePreview.items.length > 0}
                    <div class="mt-3 max-h-32 overflow-auto rounded-lg border border-darkborderc bg-darkbg/70">
                        {#each batchRenamePreview.items.slice(0, 40) as item}
                            <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-darkborderc/50 px-2.5 py-1 text-[11px] last:border-b-0">
                                <span class="truncate font-mono text-textcolor2" title={item.oldName}>{item.oldName}</span>
                                <span class="text-textcolor2/50">→</span>
                                <span class="truncate font-mono {item.error ? 'text-red-400' : item.changed ? 'text-textcolor' : 'text-textcolor2/50'}" title={item.error || item.newName}>
                                    {item.newName || "(empty)"}{item.error ? ` — ${item.error}` : ""}
                                </span>
                            </div>
                        {/each}
                        {#if batchRenamePreview.items.length > 40}
                            <div class="px-2.5 py-1.5 text-center text-[10px] text-textcolor2">
                                +{batchRenamePreview.items.length - 40} more
                            </div>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- Workspace Gallery (Full Width Clean Layout) -->
        <div
            bind:this={galleryEl}
            class="relative flex-1 overflow-y-auto p-5 scrollbar-thin"
            onscroll={handleGalleryScroll}
            onpointerdown={handleGalleryPointerDown}
            onpointermove={handleGalleryPointerMove}
            onpointerup={(e) => finishMarqueeSelection(e)}
            onpointercancel={(e) => finishMarqueeSelection(e, true)}
        >
            {#if marqueeRect}
                <div
                    class="absolute z-40 pointer-events-none border border-selected bg-selected/15 shadow-sm"
                    style="left: {marqueeRect.left}px; top: {marqueeRect.top}px; width: {marqueeRect.width}px; height: {marqueeRect.height}px;"
                ></div>
            {/if}

            <div class="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-textcolor2">
                <button
                    type="button"
                    class="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-textcolor/10 hover:text-textcolor cursor-pointer"
                    onclick={() => navigateToFolder(null)}
                    ondragover={handleFolderDragOver}
                    ondrop={(e) => handleFolderDrop(e, null)}
                >
                    <HomeIcon size={13} />
                    <span>Assets</span>
                </button>
                {#each folderBreadcrumbs as folder}
                    <ChevronRightIcon size={12} class="opacity-50" />
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 hover:bg-textcolor/10 hover:text-textcolor cursor-pointer"
                        onclick={() => navigateToFolder(folder.id)}
                        ondragover={handleFolderDragOver}
                        ondrop={(e) => handleFolderDrop(e, folder.id)}
                    >{folder.name}</button>
                {/each}
            </div>

            {#if visibleFolders.length > 0}
                <div class="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {#each visibleFolders as folder}
                        <div
                            data-folder-id={folder.id}
                            class="group relative flex items-center gap-2 rounded-xl border border-darkborderc bg-bgcolor/70 p-2.5 hover:border-selected/70 hover:bg-bgcolor transition-colors"
                            ondragover={handleFolderDragOver}
                            ondrop={(e) => handleFolderDrop(e, folder.id)}
                        >
                            <button
                                type="button"
                                class="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                                onclick={() => navigateToFolder(folder.id)}
                            >
                                <FolderIcon size={22} class="shrink-0 text-selected" />
                                <span class="truncate text-xs font-semibold text-textcolor" title={folder.name}>{folder.name}</span>
                            </button>
                            <div class="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    type="button"
                                    class="rounded p-1 text-textcolor2 hover:bg-textcolor/10 hover:text-textcolor cursor-pointer"
                                    title="Rename folder"
                                    onclick={() => renameFolder(folder)}
                                ><Edit3Icon size={12} /></button>
                                <button
                                    type="button"
                                    class="rounded p-1 text-textcolor2 hover:bg-red-500/15 hover:text-red-400 cursor-pointer"
                                    title="Delete folder"
                                    onclick={() => deleteFolder(folder)}
                                ><TrashIcon size={12} /></button>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if rawAssets.length === 0 && visibleFolders.length === 0}
                <!-- Empty State -->
                <div class="flex flex-col items-center justify-center h-full min-h-[300px] text-center text-textcolor2 gap-4">
                    <div class="p-6 rounded-2xl bg-bgcolor/50 border border-darkborderc">
                        <UploadCloudIcon size={48} class="opacity-50 text-selected" />
                    </div>
                    <div class="flex flex-col gap-1 max-w-sm">
                        <span class="text-base font-semibold text-textcolor">{language.noAssetsFound}</span>
                        <span class="text-xs text-textcolor2">{language.dropFilesToUpload}</span>
                    </div>
                    <button
                        type="button"
                        class="px-4 py-2 rounded-xl bg-selected hover:bg-selected/90 text-white font-medium text-xs transition-all shadow cursor-pointer flex items-center gap-2"
                        onclick={handleAddFiles}
                    >
                        <PlusIcon size={16} />
                        <span>{language.addAsset}</span>
                    </button>
                </div>
            {:else if processedAssets.length === 0 && visibleFolders.length === 0}
                <div class="flex flex-col items-center justify-center h-full min-h-[300px] text-center text-textcolor2 gap-2">
                    <SearchIcon size={36} class="opacity-40" />
                    <span class="text-sm font-medium">{language.noAssetsFound}</span>
                </div>
            {:else if viewMode === "grid"}
                <!-- Full-Width Responsive Grid View -->
                <div class="grid gap-3 sm:gap-4 {gridSize === 'sm' ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10' : gridSize === 'lg' ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7'}">
                    {#each displayedAssets as { originalIndex, name, assetId, ext, category }}
                        {@const srcUrl = assetSrcMap[assetId]}
                        {@const isExcluded = currentChar?.prebuiltAssetExclude?.includes(assetId)}
                        {@const isSelected = selectedIndices.has(originalIndex)}

                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div
                            data-asset-index={originalIndex}
                            draggable="true"
                            class="group relative flex flex-col rounded-xl bg-bgcolor/80 border transition-all duration-150 overflow-hidden cursor-pointer {isSelected ? 'border-selected ring-2 ring-selected/40 shadow-lg' : 'border-darkborderc hover:border-selected/80 hover:shadow-md'}"
                            onclick={(e) => handleAssetClick(e, originalIndex)}
                            ondragstart={(e) => handleAssetDragStart(e, originalIndex)}
                        >
                            <!-- Card Thumbnail Container -->
                            <div
                                class="relative w-full aspect-square bg-black/40 flex items-center justify-center overflow-hidden"
                                use:observeAssetPreview={{ assetId, category }}
                            >
                                {#if category === "image" && srcUrl}
                                    <img src={srcUrl} alt={name} class="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105" loading="lazy" />
                                {:else if category === "image"}
                                    <div class="flex items-center justify-center w-full h-full text-textcolor2/40 animate-pulse">
                                        <ImageIcon size={32} />
                                    </div>
                                {:else if category === "audio"}
                                    <div class="flex flex-col items-center justify-center gap-1 text-purple-400 p-2">
                                        <MusicIcon size={32} />
                                    </div>
                                {:else if category === "video"}
                                    <div class="flex flex-col items-center justify-center gap-1 text-blue-400">
                                        <VideoIcon size={32} />
                                    </div>
                                {:else}
                                    <div class="flex flex-col items-center justify-center gap-1 text-yellow-400">
                                        <FileTextIcon size={32} />
                                    </div>
                                {/if}

                                <!-- Top Extension Badge -->
                                <span class="absolute top-2 right-2 px-1.5 py-0.5 text-[9px] uppercase font-bold bg-black/80 backdrop-blur-sm text-white rounded-md border border-white/10 pointer-events-none">
                                    {ext}
                                </span>

                                <!-- Selection Checkbox -->
                                <button
                                    type="button"
                                    class="absolute top-2 left-2 p-1 rounded-md bg-black/70 text-white backdrop-blur-sm transition-opacity cursor-pointer {isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
                                    onclick={(e) => toggleSelect(originalIndex, e)}
                                >
                                    {#if isSelected}
                                        <CheckSquareIcon size={16} class="text-selected" />
                                    {:else}
                                        <SquareIcon size={16} />
                                    {/if}
                                </button>

                                <!-- Excluded Badge -->
                                {#if isExcluded}
                                    <div class="absolute bottom-2 left-2 px-1.5 py-0.5 rounded text-[10px] bg-red-950/80 text-red-300 border border-red-500/30 flex items-center gap-1 pointer-events-none">
                                        <ImageOffIcon size={10} />
                                    </div>
                                {/if}

                                <!-- Hover Action Bar Overlay -->
                                <div class="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <!-- Copy tag -->
                                    <button
                                        type="button"
                                        class="p-1 rounded-md bg-white/15 hover:bg-white/30 text-white transition-colors cursor-pointer"
                                        title={language.copyTag}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            handleCopyTag(getDefaultMacroTag(ext, name), `card-${originalIndex}`);
                                        }}
                                    >
                                        {#if copiedTagKey === `card-${originalIndex}`}
                                            <CheckIcon size={13} class="text-green-400" />
                                        {:else}
                                            <CopyIcon size={13} />
                                        {/if}
                                    </button>

                                    <!-- Toggle Exclude -->
                                    <button
                                        type="button"
                                        class="p-1 rounded-md bg-white/15 hover:bg-white/30 text-white transition-colors cursor-pointer {isExcluded ? 'text-red-400' : 'text-blue-300'}"
                                        title={isExcluded ? language.promptExcluded : language.promptIncluded}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            togglePromptExclude(assetId);
                                        }}
                                    >
                                        {#if isExcluded}
                                            <ImageOffIcon size={13} />
                                        {:else}
                                            <ImageIcon size={13} />
                                        {/if}
                                    </button>

                                    <!-- Delete -->
                                    <button
                                        type="button"
                                        class="p-1 rounded-md bg-white/15 hover:bg-red-500 text-white transition-colors cursor-pointer"
                                        title={language.delete}
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteSingle(originalIndex);
                                        }}
                                    >
                                        <TrashIcon size={13} />
                                    </button>
                                </div>
                            </div>

                            <!-- Card Footer: Name & Tag Info -->
                            <div class="p-2 flex flex-col gap-0.5 bg-darkbg border-t border-darkborderc/50">
                                <span class="text-xs font-semibold text-textcolor truncate" title={name}>
                                    {name}
                                </span>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <!-- List / Table View -->
                <div class="w-full border border-darkborderc rounded-xl overflow-hidden bg-darkbg">
                    <table class="w-full text-left text-xs border-collapse">
                        <thead>
                            <tr class="border-b border-darkborderc bg-bgcolor/50 text-textcolor2 font-medium">
                                <th class="py-2.5 px-3 w-8 text-center">
                                    <button
                                        type="button"
                                        class="cursor-pointer"
                                        onclick={selectAll}
                                    >
                                        <SquareIcon size={14} />
                                    </button>
                                </th>
                                <th class="py-2.5 px-3 w-16">{language.viewScreen}</th>
                                <th class="py-2.5 px-3">{language.assetKey}</th>
                                <th class="py-2.5 px-3 w-32">{language.macroFormats}</th>
                                <th class="py-2.5 px-3 w-28 text-center">{language.promptInclusion}</th>
                                <th class="py-2.5 px-3 w-28 text-right">{language.editDisplay}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each displayedAssets as { originalIndex, name, assetId, ext, category }}
                                {@const srcUrl = assetSrcMap[assetId]}
                                {@const isExcluded = currentChar?.prebuiltAssetExclude?.includes(assetId)}
                                {@const isSelected = selectedIndices.has(originalIndex)}

                                <tr
                                    data-asset-index={originalIndex}
                                    draggable="true"
                                    class="border-b border-darkborderc/60 hover:bg-bgcolor/40 transition-colors {isSelected ? 'bg-selected/10' : ''}"
                                    ondragstart={(e) => handleAssetDragStart(e, originalIndex)}
                                >
                                    <!-- Checkbox -->
                                    <td class="py-2 px-3 text-center">
                                        <button
                                            type="button"
                                            class="cursor-pointer text-textcolor2 hover:text-textcolor"
                                            onclick={(e) => toggleSelect(originalIndex, e)}
                                        >
                                            {#if isSelected}
                                                <CheckSquareIcon size={15} class="text-selected" />
                                            {:else}
                                                <SquareIcon size={15} />
                                            {/if}
                                        </button>
                                    </td>

                                    <!-- Thumbnail (click to open Lightbox) -->
                                    <td class="py-2 px-3">
                                        <button
                                            type="button"
                                            class="w-12 h-12 rounded bg-black/40 border border-darkborderc flex items-center justify-center overflow-hidden cursor-pointer"
                                            onclick={() => { inspectingIndex = originalIndex; }}
                                            use:observeAssetPreview={{ assetId, category }}
                                        >
                                            {#if category === "image" && srcUrl}
                                                <img src={srcUrl} alt={name} class="w-full h-full object-cover" />
                                            {:else if category === "image"}
                                                <div class="flex items-center justify-center w-full h-full text-textcolor2/40 animate-pulse">
                                                    <ImageIcon size={18} />
                                                </div>
                                            {:else if category === "audio"}
                                                <MusicIcon size={18} class="text-purple-400" />
                                            {:else if category === "video"}
                                                <VideoIcon size={18} class="text-blue-400" />
                                            {:else}
                                                <FileTextIcon size={18} class="text-yellow-400" />
                                            {/if}
                                        </button>
                                    </td>

                                    <!-- Asset Key (Name & Extension) -->
                                    <td class="py-2 px-3 font-medium">
                                        <div class="flex items-center gap-2">
                                            <input
                                                type="text"
                                                value={currentChar.additionalAssets[originalIndex][0]}
                                                onchange={(e) => {
                                                    handleInlineRename(originalIndex, e.currentTarget.value);
                                                    e.currentTarget.value = currentChar.additionalAssets[originalIndex][0];
                                                }}
                                                class="bg-transparent text-textcolor font-medium hover:bg-bgcolor focus:bg-bgcolor rounded px-1.5 py-0.5 border border-transparent focus:border-selected text-xs transition-colors max-w-sm truncate"
                                            />
                                            <span class="px-1.5 py-0.5 text-[10px] font-mono uppercase bg-textcolor/10 text-textcolor2 rounded">
                                                {ext}
                                            </span>
                                        </div>
                                    </td>

                                    <!-- Quick Macro Copy -->
                                    <td class="py-2 px-3">
                                        <button
                                            type="button"
                                            class="px-2 py-1 rounded bg-darkbg border border-darkborderc hover:border-selected text-textcolor2 hover:text-textcolor font-mono text-[11px] flex items-center gap-1.5 cursor-pointer transition-colors"
                                            onclick={() => handleCopyTag(getDefaultMacroTag(ext, name), `list-${originalIndex}`)}
                                        >
                                            {#if copiedTagKey === `list-${originalIndex}`}
                                                <CheckIcon size={12} class="text-green-400" />
                                                <span class="text-green-400">{language.copied}</span>
                                            {:else}
                                                <CopyIcon size={12} />
                                                <span class="truncate max-w-[130px]">{getDefaultMacroTag(ext, name)}</span>
                                            {/if}
                                        </button>
                                    </td>

                                    <!-- Prompt Inclusion Toggle -->
                                    <td class="py-2 px-3 text-center">
                                        <button
                                            type="button"
                                            class="p-1 rounded text-xs transition-colors cursor-pointer {isExcluded ? 'text-textcolor2/50 hover:text-textcolor2' : 'text-blue-400 hover:text-blue-300'}"
                                            title={isExcluded ? language.promptExcluded : language.promptIncluded}
                                            onclick={() => togglePromptExclude(assetId)}
                                        >
                                            {#if isExcluded}
                                                <ImageOffIcon size={16} />
                                            {:else}
                                                <ImageIcon size={16} />
                                            {/if}
                                        </button>
                                    </td>

                                    <!-- Action Buttons -->
                                    <td class="py-2 px-3 text-right">
                                        <div class="flex items-center justify-end gap-1.5">
                                            <button
                                                type="button"
                                                class="p-1.5 rounded hover:bg-textcolor/10 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                                title={language.viewScreen}
                                                onclick={() => { inspectingIndex = originalIndex; }}
                                            >
                                                <EyeIcon size={15} />
                                            </button>
                                            <button
                                                type="button"
                                                class="p-1.5 rounded hover:bg-red-500/20 text-textcolor2 hover:text-red-400 transition-colors cursor-pointer"
                                                title={language.delete}
                                                onclick={() => handleDeleteSingle(originalIndex)}
                                            >
                                                <TrashIcon size={15} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}

            <!-- Progressive Load Indicator when more assets are available -->
            {#if displayLimit < processedAssets.length}
                <div class="flex justify-center items-center py-4 text-xs text-textcolor2">
                    <button
                        type="button"
                        class="px-4 py-1.5 rounded-lg bg-darkbg border border-darkborderc hover:bg-bgcolor text-textcolor transition-colors cursor-pointer"
                        onclick={() => { displayLimit = Math.min(displayLimit + 48, processedAssets.length); }}
                    >
                        Load More ({displayedAssets.length} / {processedAssets.length})
                    </button>
                </div>
            {/if}
        </div>
    </div>
</div>

<!-- Immersive High-Res Lightbox Preview Overlay -->
{#if inspectingAsset}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-60 flex flex-col items-center justify-between bg-black/90 backdrop-blur-xl p-3 sm:p-5 animate-in fade-in duration-150 select-none"
        onclick={() => { inspectingIndex = null; }}
    >
        <!-- Lightbox Top Navigation & Info Bar -->
        <div
            class="flex items-center justify-between w-full max-w-6xl px-4 py-2 bg-darkbg/80 border border-darkborderc/80 rounded-2xl backdrop-blur-md shrink-0 shadow-lg text-textcolor"
            onclick={(e) => e.stopPropagation()}
        >
            <!-- Left: Asset Name (editable) -->
            <div class="flex items-center gap-2 max-w-[60%]">
                {#if isEditingName}
                    <input
                        type="text"
                        bind:value={renameInput}
                        onkeydown={(e) => { if (e.key === "Enter") handleRenameSave(); }}
                        class="bg-darkbg border border-selected rounded-lg px-2.5 py-1 text-sm text-textcolor focus:outline-none"
                    />
                    <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg bg-selected text-white text-xs font-semibold cursor-pointer"
                        onclick={handleRenameSave}
                    >
                        Save
                    </button>
                    <button
                        type="button"
                        class="px-2 py-1 rounded-lg text-textcolor2 hover:text-textcolor text-xs cursor-pointer"
                        onclick={() => { isEditingName = false; }}
                    >
                        Cancel
                    </button>
                {:else}
                    <span class="text-sm sm:text-base font-bold truncate text-textcolor" title={inspectingAsset.name}>
                        {inspectingAsset.name}
                    </span>
                    <button
                        type="button"
                        class="p-1 rounded-md text-textcolor2 hover:text-textcolor hover:bg-textcolor/10 transition-colors cursor-pointer"
                        title={language.renameAsset}
                        onclick={() => { isEditingName = true; }}
                    >
                        <Edit3Icon size={14} />
                    </button>
                {/if}
                <span class="px-1.5 py-0.5 text-[10px] font-mono uppercase bg-textcolor/10 text-textcolor2 rounded">
                    {inspectingAsset.ext}
                </span>
            </div>

            <!-- Right: Item Index & Prev/Next/Close -->
            <div class="flex items-center gap-2">
                <span class="text-xs text-textcolor2 font-medium font-mono hidden sm:inline">
                    {processedAssets.findIndex((a) => a.originalIndex === inspectingAsset.originalIndex) + 1} / {processedAssets.length}
                </span>

                <button
                    type="button"
                    class="p-1.5 rounded-lg bg-bgcolor/80 hover:bg-textcolor/20 text-textcolor transition-colors cursor-pointer"
                    title="Previous (Left Arrow)"
                    onclick={() => navigateInspector(-1)}
                >
                    <ChevronLeftIcon size={18} />
                </button>
                <button
                    type="button"
                    class="p-1.5 rounded-lg bg-bgcolor/80 hover:bg-textcolor/20 text-textcolor transition-colors cursor-pointer"
                    title="Next (Right Arrow)"
                    onclick={() => navigateInspector(1)}
                >
                    <ChevronRightIcon size={18} />
                </button>
                <button
                    type="button"
                    class="p-1.5 rounded-lg bg-bgcolor/80 hover:bg-textcolor/20 text-textcolor transition-colors cursor-pointer ml-1"
                    title="Close (ESC)"
                    onclick={() => { inspectingIndex = null; }}
                >
                    <XIcon size={18} />
                </button>
            </div>
        </div>

        <!-- Lightbox Center Content (Large Image / Media Player) -->
        <div
            class="relative flex-1 flex items-center justify-center w-full max-w-6xl my-3 overflow-hidden"
            onclick={(e) => e.stopPropagation()}
        >
            <!-- Large Left Arrow Floating Button -->
            <button
                type="button"
                class="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white/80 hover:text-white backdrop-blur-md transition-all shadow-xl cursor-pointer"
                title="Previous (Left Arrow)"
                onclick={() => navigateInspector(-1)}
            >
                <ChevronLeftIcon size={24} />
            </button>

            <!-- Media Preview -->
            {#if inspectingAsset.category === "image" && inspectingSrcUrl}
                <img
                    src={inspectingSrcUrl}
                    alt={inspectingAsset.name}
                    class="max-h-[75vh] max-w-[85vw] object-contain rounded-xl shadow-2xl animate-in zoom-in-95 duration-150"
                />
            {:else if inspectingAsset.category === "audio" && inspectingSrcUrl}
                <div class="flex flex-col items-center justify-center gap-6 p-8 bg-darkbg border border-darkborderc rounded-2xl shadow-2xl max-w-md w-full">
                    <div class="p-6 rounded-full bg-purple-500/20 text-purple-400">
                        <MusicIcon size={64} />
                    </div>
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <audio src={inspectingSrcUrl} controls class="w-full" autoplay></audio>
                </div>
            {:else if inspectingAsset.category === "video" && inspectingSrcUrl}
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                    src={inspectingSrcUrl}
                    controls
                    class="max-h-[75vh] max-w-[85vw] rounded-xl shadow-2xl"
                    autoplay
                ></video>
            {:else}
                <div class="flex flex-col items-center justify-center p-8 bg-darkbg border border-darkborderc rounded-2xl shadow-2xl text-textcolor2 gap-3">
                    <FileTextIcon size={64} class="text-yellow-400" />
                    <span class="text-base font-bold text-textcolor">{inspectingAsset.name}</span>
                </div>
            {/if}

            <!-- Large Right Arrow Floating Button -->
            <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white/80 hover:text-white backdrop-blur-md transition-all shadow-xl cursor-pointer"
                title="Next (Right Arrow)"
                onclick={() => navigateInspector(1)}
            >
                <ChevronRightIcon size={24} />
            </button>
        </div>

        <!-- Lightbox Bottom Quick Action Bar -->
        <div
            class="flex items-center justify-between w-full max-w-2xl px-5 py-2.5 bg-darkbg/90 border border-darkborderc/80 rounded-2xl backdrop-blur-md shrink-0 shadow-lg text-textcolor gap-3"
            onclick={(e) => e.stopPropagation()}
        >
            <!-- Copy Tag Button -->
            <button
                type="button"
                class="flex-1 py-1.5 px-3 rounded-xl bg-selected/20 hover:bg-selected/30 border border-selected/40 text-selected font-mono text-xs font-semibold transition-all flex items-center justify-center gap-2 cursor-pointer truncate"
                onclick={() => handleCopyTag(inspectingAsset.defaultTag, "lightbox-tag")}
            >
                {#if copiedTagKey === "lightbox-tag"}
                    <CheckIcon size={15} class="text-green-400" />
                    <span class="text-green-400">{language.tagCopied}</span>
                {:else}
                    <CopyIcon size={15} />
                    <span class="truncate">{inspectingAsset.defaultTag}</span>
                {/if}
            </button>

            <!-- Toggle Exclude Button -->
            <button
                type="button"
                class="py-1.5 px-3 rounded-xl border text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer {inspectingAsset.isExcluded ? 'bg-red-500/20 text-red-300 border-red-500/40' : 'bg-darkbg hover:bg-textcolor/10 border-darkborderc text-textcolor2 hover:text-textcolor'}"
                onclick={() => togglePromptExclude(inspectingAsset.assetId)}
            >
                {#if inspectingAsset.isExcluded}
                    <ImageOffIcon size={15} />
                    <span>{language.promptExcluded}</span>
                {:else}
                    <ImageIcon size={15} />
                    <span>{language.promptIncluded}</span>
                {/if}
            </button>

            <!-- Delete Button -->
            <button
                type="button"
                class="py-1.5 px-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer"
                onclick={() => handleDeleteSingle(inspectingAsset.originalIndex)}
            >
                <TrashIcon size={15} />
                <span>{language.delete}</span>
            </button>
        </div>
    </div>
{/if}
