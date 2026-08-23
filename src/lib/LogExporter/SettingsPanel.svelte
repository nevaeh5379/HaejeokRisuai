<script lang="ts">
    import { Palette, ArrowLeftRight, FileOutput, SlidersHorizontal, CheckSquare, Square, User, Check } from '@lucide/svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import ReplaceTab from './ReplaceTab.svelte'
    import { THEMES, COLORS, resolveEffectiveColor } from 'src/ts/logexporter/constants'
    import {
        HEADER_LAYOUT_OPTIONS,
        IMAGE_ALIGN_OPTIONS,
        IMAGE_STYLE_OPTIONS,
        CROP_ASPECT_RATIO_OPTIONS,
        AVATAR_SHAPE_OPTIONS,
        SCALE_MODE_OPTIONS,
        IMAGE_RESOLUTION_OPTIONS,
        IMAGE_FORMAT_OPTIONS,
        SPLIT_IMAGE_OPTIONS,
    } from 'src/ts/logexporter/constants'
    import type {
        AvatarShape,
        ColorKey,
        ColorPalette,
        HeaderLayout,
        HtmlScaleMode,
        ImageAlign,
        ImageCropAspectRatio,
        ImageFormat,
        ImageStyle,
        LogExporterSettings,
        SplitImageMode,
        ThemeKey,
    } from 'src/ts/logexporter/types'

    interface Props {
        activeTab?: 'style' | 'replace' | 'export' | 'advanced'
        showTabBar?: boolean
        settings: LogExporterSettings
        onChange: <K extends keyof LogExporterSettings>(key: K, value: LogExporterSettings[K]) => void
        participants: string[]
        excludedParticipants: string[]
        onToggleParticipant: (name: string, excluded: boolean) => void
    }

    let {
        activeTab = $bindable('style'),
        showTabBar = true,
        settings,
        onChange,
        participants,
        excludedParticipants,
        onToggleParticipant,
    }: Props = $props()

    const tabs = $derived([
        { id: 'style' as const, label: '스타일', icon: Palette, badge: 0 },
        { id: 'replace' as const, label: '치환', icon: ArrowLeftRight, badge: settings.replacementRules?.length || 0 },
        { id: 'export' as const, label: '내보내기', icon: FileOutput, badge: 0 },
        { id: 'advanced' as const, label: '고급', icon: SlidersHorizontal, badge: 0 },
    ])

    const palette: ColorPalette = $derived(resolveEffectiveColor(settings.theme, settings.color))

    function swatches(p: ColorPalette): string[] {
        return [p.cardBg, p.cardBgUser, p.text, p.nameColor]
    }

    const resolutionValue = $derived(settings.imageResolution === 'auto' ? 'auto' : String(settings.imageResolution))

    function excludeAllParticipants() {
        participants.forEach((name) => {
            if (!excludedParticipants.includes(name)) {
                onToggleParticipant(name, true)
            }
        })
    }

    function includeAllParticipants() {
        participants.forEach((name) => {
            if (excludedParticipants.includes(name)) {
                onToggleParticipant(name, false)
            }
        })
    }
</script>

<div class="flex flex-col h-full min-h-0 text-sm bg-bgcolor">
    <!-- Tab bar (if enabled) -->
    {#if showTabBar}
        <div class="flex shrink-0 border-b border-darkborderc bg-darkbg p-2 gap-1.5">
            {#each tabs as tab (tab.id)}
                <button
                    type="button"
                    class="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-semibold transition-all relative {activeTab === tab.id ? 'bg-selected text-white shadow-xs' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton/80 bg-darkbutton/40'}"
                    onclick={() => (activeTab = tab.id)}
                >
                    <tab.icon size={15} strokeWidth={2.2} />
                    <span>{tab.label}</span>
                    {#if tab.badge && tab.badge > 0}
                        <span class="text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums {activeTab === tab.id ? 'bg-white text-selected' : 'bg-selected/25 text-selected'}">
                            {tab.badge}
                        </span>
                    {/if}
                </button>
            {/each}
        </div>
    {/if}

    <!-- Tab content -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {#if activeTab === 'style'}
            <!-- Theme & Palette Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <div class="flex items-center justify-between pb-2 border-b border-darkborderc/60">
                    <span class="text-xs font-bold text-textcolor">테마 & 색상</span>
                    <span class="text-[11px] px-2 py-0.5 rounded-md bg-darkbutton border border-darkborderc text-textcolor font-medium">
                        {THEMES[settings.theme]?.name || settings.theme}
                    </span>
                </div>

                <div>
                    <label for="setting-theme-select" class="block text-xs font-medium text-textcolor/90 mb-1.5">테마 프리셋</label>
                    <SelectInput id="setting-theme-select" value={settings.theme} size="sm" onchange={(e) => onChange('theme', e.currentTarget.value as ThemeKey)}>
                        {#each Object.entries(THEMES) as [key, info] (key)}
                            <option value={key}>{info.name}</option>
                        {/each}
                    </SelectInput>
                    <p class="text-[11px] text-textcolor2 mt-1.5 leading-relaxed">{THEMES[settings.theme]?.description}</p>
                </div>

                <!-- Color palette (basic/custom themes only) -->
                {#if settings.theme === 'basic' || settings.theme === 'custom'}
                    <div class="border-t border-darkborderc/60 pt-3">
                        <span class="block text-xs font-medium text-textcolor/90 mb-2">색상 팔레트</span>
                        <div class="grid grid-cols-2 gap-2">
                            {#each Object.entries(COLORS) as [key, c] (key)}
                                {@const pal = c as ColorPalette}
                                {@const isSelected = settings.color === key}
                                <button
                                    type="button"
                                    class="flex flex-col gap-1.5 p-2.5 rounded-xl border text-left transition-all active:scale-98 {isSelected ? 'border-selected bg-selected/20 ring-2 ring-selected/60 shadow-xs' : 'border-darkborderc bg-darkbutton/60 hover:bg-darkbutton'}"
                                    onclick={() => onChange('color', key as ColorKey)}
                                >
                                    <div class="flex items-center justify-between gap-1.5">
                                        <div class="flex items-center gap-1.5">
                                            {#each swatches(pal) as sc}
                                                <span class="w-3.5 h-3.5 rounded-full border border-black/30 shadow-xs inline-block shrink-0" style="background:{sc}"></span>
                                            {/each}
                                        </div>
                                        {#if isSelected}
                                            <span class="w-4 h-4 rounded-full bg-selected text-white flex items-center justify-center shrink-0 shadow-xs">
                                                <Check size={11} strokeWidth={3} />
                                            </span>
                                        {/if}
                                    </div>
                                    <span class="text-xs font-bold text-textcolor truncate">
                                        {pal.name}
                                    </span>
                                </button>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>

            <!-- Header & Footer Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">헤더 및 푸터</span>

                <div class="grid grid-cols-2 gap-2">
                    <CheckInput bind:check={() => settings.showHeader, (v) => onChange('showHeader', v)} name="헤더 표시" />
                    <CheckInput bind:check={() => settings.showHeaderIcon, (v) => onChange('showHeaderIcon', v)} name="헤더 아이콘" />
                    <CheckInput bind:check={() => settings.showFooter, (v) => onChange('showFooter', v)} name="푸터 표시" />
                </div>

                <div class="border-t border-darkborderc/60 pt-3 space-y-3">
                    <div>
                        <label for="setting-header-tags" class="block text-xs font-medium text-textcolor/90 mb-1.5">태그 (쉼표로 구분)</label>
                        <input
                            id="setting-header-tags"
                            class="border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 text-textcolor text-xs px-2.5 py-1.5 w-full focus:outline-hidden focus:ring-1 focus:ring-selected transition-colors"
                            value={settings.headerTags}
                            oninput={(e) => onChange('headerTags', (e.currentTarget as HTMLInputElement).value)}
                            placeholder="예: 로맨스, 판타지, 일상"
                        />
                    </div>

                    <div>
                        <label for="setting-header-layout" class="block text-xs font-medium text-textcolor/90 mb-1.5">헤더 레이아웃</label>
                        <SelectInput id="setting-header-layout" value={settings.headerLayout} size="sm" onchange={(e) => onChange('headerLayout', e.currentTarget.value as HeaderLayout)}>
                            {#each HEADER_LAYOUT_OPTIONS as opt (opt.value)}
                                <option value={opt.value}>{opt.label}</option>
                            {/each}
                        </SelectInput>
                    </div>

                    {#if settings.headerLayout === 'banner' || settings.headerLayout === 'cover'}
                        <div class="space-y-2.5 bg-darkbutton/40 p-3 rounded-lg border border-darkborderc/80">
                            <CheckInput bind:check={() => settings.headerBannerBlur, (v) => onChange('headerBannerBlur', v)} name="배너 흐림 효과" />
                            <div>
                                <label for="setting-banner-align" class="block text-[11px] font-medium text-textcolor/90 mb-1">
                                    배너 세로 위치 ({settings.headerBannerAlign}%)
                                </label>
                                <input
                                    id="setting-banner-align"
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={settings.headerBannerAlign}
                                    oninput={(e) => onChange('headerBannerAlign', Number((e.currentTarget as HTMLInputElement).value))}
                                    class="w-full accent-selected cursor-pointer"
                                />
                            </div>
                        </div>
                    {/if}
                </div>

                <!-- Footer texts -->
                <div class="border-t border-darkborderc/60 pt-3 space-y-2">
                    <label for="setting-footer-left" class="block text-xs font-medium text-textcolor/90">푸터 텍스트 (왼쪽 / 중앙 / 오른쪽)</label>
                    <div class="grid grid-cols-3 gap-1.5">
                        <input
                            id="setting-footer-left"
                            class="border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 px-2 py-1.5 text-xs text-textcolor focus:outline-hidden focus:ring-1 focus:ring-selected"
                            placeholder="왼쪽"
                            value={settings.footerLeft}
                            oninput={(e) => onChange('footerLeft', (e.currentTarget as HTMLInputElement).value)}
                        />
                        <input
                            id="setting-footer-center"
                            class="border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 px-2 py-1.5 text-xs text-textcolor focus:outline-hidden focus:ring-1 focus:ring-selected"
                            placeholder="중앙"
                            value={settings.footerCenter}
                            oninput={(e) => onChange('footerCenter', (e.currentTarget as HTMLInputElement).value)}
                        />
                        <input
                            id="setting-footer-right"
                            class="border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 px-2 py-1.5 text-xs text-textcolor focus:outline-hidden focus:ring-1 focus:ring-selected"
                            placeholder="오른쪽"
                            value={settings.footerRight}
                            oninput={(e) => onChange('footerRight', (e.currentTarget as HTMLInputElement).value)}
                        />
                    </div>
                </div>
            </div>

            <!-- Message & Avatar Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">메시지 & 아바타</span>

                <div class="grid grid-cols-2 gap-2">
                    <CheckInput bind:check={() => settings.showAvatar, (v) => onChange('showAvatar', v)} name="아바타 표시" />
                    <CheckInput bind:check={() => settings.showBubble, (v) => onChange('showBubble', v)} name="말풍선 배경" />
                </div>

                <div class="border-t border-darkborderc/60 pt-3">
                    <label for="setting-avatar-shape" class="block text-xs font-medium text-textcolor/90 mb-1.5">아바타 모양</label>
                    <SelectInput id="setting-avatar-shape" value={settings.avatarShape} size="sm" onchange={(e) => onChange('avatarShape', e.currentTarget.value as AvatarShape)}>
                        {#each AVATAR_SHAPE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>
            </div>

            <!-- Participants Filter Card -->
            {#if participants.length > 0}
                <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3 shadow-sm">
                    <div class="flex items-center justify-between pb-2 border-b border-darkborderc/60">
                        <div class="flex items-center gap-1.5">
                            <span class="text-xs font-bold text-textcolor">참여자 필터</span>
                            <span class="text-[11px] px-2 py-0.2 rounded-full bg-selected/15 text-selected border border-selected/30 font-semibold tabular-nums">
                                {participants.length - excludedParticipants.length}/{participants.length}
                            </span>
                        </div>
                        <div class="flex items-center gap-1">
                            <button
                                type="button"
                                class="p-1 px-2 rounded-md text-[11px] font-medium text-textcolor hover:bg-darkbutton border border-darkborderc transition-colors active:scale-95"
                                onclick={includeAllParticipants}
                                title="모두 포함"
                            >
                                모두 포함
                            </button>
                            <button
                                type="button"
                                class="p-1 px-2 rounded-md text-[11px] font-medium text-textcolor2 hover:text-textcolor hover:bg-darkbutton border border-darkborderc transition-colors active:scale-95"
                                onclick={excludeAllParticipants}
                                title="모두 제외"
                            >
                                모두 제외
                            </button>
                        </div>
                    </div>

                    <p class="text-[11px] text-textcolor2 leading-relaxed">체크 해제된 참여자의 메시지는 내보내기에서 제외됩니다.</p>

                    <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {#each participants as name (name)}
                            {@const isExcluded = excludedParticipants.includes(name)}
                            <div class="flex items-center justify-between p-2.5 rounded-lg bg-darkbutton/50 border border-darkborderc hover:bg-darkbutton transition-colors">
                                <div class="flex items-center gap-2 min-w-0">
                                    <div class="w-6 h-6 rounded-full bg-selected/20 border border-selected/40 text-selected flex items-center justify-center shrink-0 text-[11px] font-bold">
                                        {name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <span class="text-xs font-medium truncate" class:text-textcolor2={isExcluded} class:line-through={isExcluded} class:text-textcolor={!isExcluded}>
                                        {name}
                                    </span>
                                </div>
                                <CheckInput
                                    check={!isExcluded}
                                    onChange={(v) => onToggleParticipant(name, !v)}
                                    name=""
                                    hiddenName={true}
                                    margin={false}
                                />
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

        {:else if activeTab === 'replace'}
            <ReplaceTab {settings} {onChange} />

        {:else if activeTab === 'export'}
            <!-- Export Image Options Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">이미지 내보내기 설정</span>

                <div>
                    <label for="setting-img-format" class="block text-xs font-medium text-textcolor/90 mb-1.5">이미지 포맷</label>
                    <SelectInput id="setting-img-format" value={settings.imageFormat} size="sm" onchange={(e) => onChange('imageFormat', e.currentTarget.value as ImageFormat)}>
                        {#each IMAGE_FORMAT_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label for="setting-img-resolution" class="block text-xs font-medium text-textcolor/90 mb-1.5">캡처 해상도 배율</label>
                    <SelectInput id="setting-img-resolution" value={resolutionValue} size="sm" onchange={(e) => {
                        const v = e.currentTarget.value
                        onChange('imageResolution', v === 'auto' ? 'auto' : Number(v))
                    }}>
                        {#each IMAGE_RESOLUTION_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label for="setting-split-image" class="block text-xs font-medium text-textcolor/90 mb-1.5">긴 로그 분할 방식</label>
                    <SelectInput id="setting-split-image" value={settings.splitImage} size="sm" onchange={(e) => onChange('splitImage', e.currentTarget.value as SplitImageMode)}>
                        {#each SPLIT_IMAGE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                    <p class="text-[11px] text-textcolor2 mt-1">분할된 조각은 ffmpeg으로 하나의 고화질 이미지로 이어 붙여집니다.</p>
                </div>

                <div>
                    <label for="setting-max-image-height" class="block text-xs font-medium text-textcolor/90 mb-1.5">조각당 최대 높이 (px)</label>
                    <NumberInput id="setting-max-image-height" value={settings.maxImageHeight} size="sm" min={1000} onChange={(e) => onChange('maxImageHeight', Math.max(1000, Number((e.currentTarget as HTMLInputElement).value) || 10000))} fullwidth />
                </div>

                <div class="border-t border-darkborderc/60 pt-2.5">
                    <CheckInput bind:check={() => settings.convertWebM, (v) => onChange('convertWebM', v)} name="WebM을 WebP로 변환 (ffmpeg)" />
                </div>
            </div>

            <!-- Preview Sizing Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">미리보기 크기 & 글꼴</span>

                <div>
                    <label for="setting-preview-width" class="block text-xs font-medium text-textcolor/90 mb-1.5">미리보기 너비 (px)</label>
                    <NumberInput id="setting-preview-width" value={settings.previewWidth} size="sm" min={320} onChange={(e) => onChange('previewWidth', Math.max(320, Number((e.currentTarget as HTMLInputElement).value) || 800))} fullwidth />
                </div>

                <div>
                    <label for="setting-preview-font-size" class="block text-xs font-medium text-textcolor/90 mb-1.5">기본 글꼴 크기 (px)</label>
                    <NumberInput id="setting-preview-font-size" value={settings.previewFontSize} size="sm" min={10} onChange={(e) => onChange('previewFontSize', Math.max(10, Number((e.currentTarget as HTMLInputElement).value) || 16))} fullwidth />
                </div>
            </div>

        {:else}
            <!-- Advanced Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">렌더링 & 스케일</span>

                <div class="space-y-2">
                    <CheckInput bind:check={() => settings.embedImages, (v) => onChange('embedImages', v)} name="이미지 임베드 (Base64 data URL)" />
                    <CheckInput bind:check={() => settings.disableAnimations, (v) => onChange('disableAnimations', v)} name="애니메이션 비활성화" />
                    <CheckInput bind:check={() => settings.allowHtmlRendering, (v) => onChange('allowHtmlRendering', v)} name="원본 HTML 태그 유지" />
                </div>

                <div class="border-t border-darkborderc/60 pt-3 space-y-3">
                    <div>
                        <label for="setting-html-scale-mode" class="block text-xs font-medium text-textcolor/90 mb-1.5">HTML 스케일 모드</label>
                        <SelectInput id="setting-html-scale-mode" value={settings.htmlScaleMode} size="sm" onchange={(e) => onChange('htmlScaleMode', e.currentTarget.value as HtmlScaleMode)}>
                            {#each SCALE_MODE_OPTIONS as opt (opt.value)}
                                <option value={opt.value}>{opt.label}</option>
                            {/each}
                        </SelectInput>
                    </div>

                    <div>
                        <label for="setting-html-scale-factor" class="block text-xs font-medium text-textcolor/90 mb-1">
                            HTML 스케일 배율 ({settings.htmlScaleFactor}x)
                        </label>
                        <input
                            id="setting-html-scale-factor"
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.05"
                            value={settings.htmlScaleFactor}
                            oninput={(e) => onChange('htmlScaleFactor', Number((e.currentTarget as HTMLInputElement).value))}
                            class="w-full accent-selected cursor-pointer"
                        />
                    </div>
                </div>
            </div>

            <!-- Image display options card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <span class="text-xs font-bold text-textcolor block pb-2 border-b border-darkborderc/60">이미지 표시 & 크롭</span>

                <div>
                    <label for="setting-image-align" class="block text-xs font-medium text-textcolor/90 mb-1.5">정렬</label>
                    <SelectInput id="setting-image-align" value={settings.imageAlign} size="sm" onchange={(e) => onChange('imageAlign', e.currentTarget.value as ImageAlign)}>
                        {#each IMAGE_ALIGN_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label for="setting-image-style" class="block text-xs font-medium text-textcolor/90 mb-1.5">프레임 스타일</label>
                    <SelectInput id="setting-image-style" value={settings.imageStyle} size="sm" onchange={(e) => onChange('imageStyle', e.currentTarget.value as ImageStyle)}>
                        {#each IMAGE_STYLE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label for="setting-image-scale" class="block text-xs font-medium text-textcolor/90 mb-1">
                        이미지 크기 ({settings.imageScale}%)
                    </label>
                    <input
                        id="setting-image-scale"
                        type="range"
                        min="10"
                        max="100"
                        step="5"
                        value={settings.imageScale}
                        oninput={(e) => onChange('imageScale', Number((e.currentTarget as HTMLInputElement).value))}
                        class="w-full accent-selected cursor-pointer"
                    />
                </div>

                <div class="border-t border-darkborderc/60 pt-3 space-y-2.5">
                    <CheckInput bind:check={() => settings.imageCropActive, (v) => onChange('imageCropActive', v)} name="이미지 크롭 활성화" />
                    {#if settings.imageCropActive}
                        <div class="space-y-2.5 bg-darkbutton/40 p-3 rounded-lg border border-darkborderc/80">
                            <div>
                                <label for="setting-crop-ratio" class="block text-[11px] font-medium text-textcolor/90 mb-1">크롭 비율</label>
                                <SelectInput id="setting-crop-ratio" value={settings.imageCropAspectRatio} size="sm" onchange={(e) => onChange('imageCropAspectRatio', e.currentTarget.value as ImageCropAspectRatio)}>
                                    {#each CROP_ASPECT_RATIO_OPTIONS as opt (opt.value)}
                                        <option value={opt.value}>{opt.label}</option>
                                    {/each}
                                </SelectInput>
                            </div>
                            <div>
                                <label for="setting-crop-valign" class="block text-[11px] font-medium text-textcolor/90 mb-1">세로 초점 ({settings.imageCropVAlign}%)</label>
                                <input id="setting-crop-valign" type="range" min="0" max="100" value={settings.imageCropVAlign} oninput={(e) => onChange('imageCropVAlign', Number((e.currentTarget as HTMLInputElement).value))} class="w-full accent-selected cursor-pointer" />
                            </div>
                            <div>
                                <label for="setting-crop-halign" class="block text-[11px] font-medium text-textcolor/90 mb-1">가로 초점 ({settings.imageCropHAlign}%)</label>
                                <input id="setting-crop-halign" type="range" min="0" max="100" value={settings.imageCropHAlign} oninput={(e) => onChange('imageCropHAlign', Number((e.currentTarget as HTMLInputElement).value))} class="w-full accent-selected cursor-pointer" />
                            </div>
                            {#if settings.imageCropAspectRatio === 'custom'}
                                <div>
                                    <label for="setting-crop-height" class="block text-[11px] font-medium text-textcolor/90 mb-1">사용자 지정 세로 배율</label>
                                    <NumberInput id="setting-crop-height" value={settings.imageCropHeight} size="sm" min={0.5} onChange={(e) => onChange('imageCropHeight', Number((e.currentTarget as HTMLInputElement).value) || 1)} fullwidth />
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>

            <!-- Custom CSS Card -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-2 shadow-sm">
                <label for="setting-custom-css" class="block text-xs font-bold text-textcolor">커스텀 CSS</label>
                <p class="text-[11px] text-textcolor2 leading-relaxed">커스텀 테마 적용 시 렌더링에 주입되는 CSS 스타일입니다.</p>
                <textarea
                    id="setting-custom-css"
                    class="w-full h-32 border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 p-2.5 text-xs font-mono text-textcolor focus:outline-hidden focus:ring-1 focus:ring-selected transition-colors"
                    placeholder={`.risu-log-container {\n  /* Custom styling */\n}`}
                    value={settings.customCss}
                    oninput={(e) => onChange('customCss', (e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
            </div>
        {/if}
    </div>
</div>
