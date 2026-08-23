<script lang="ts">
    import Palette from '@lucide/svelte/icons/palette'
    import FileOutput from '@lucide/svelte/icons/file-output'
    import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
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
        activeTab?: 'style' | 'export' | 'advanced'
        settings: LogExporterSettings
        onChange: <K extends keyof LogExporterSettings>(key: K, value: LogExporterSettings[K]) => void
        participants: string[]
        excludedParticipants: string[]
        onToggleParticipant: (name: string, excluded: boolean) => void
    }

    let {
        activeTab = $bindable('style'),
        settings,
        onChange,
        participants,
        excludedParticipants,
        onToggleParticipant,
    }: Props = $props()

    const tabs = [
        { id: 'style' as const, label: '스타일', icon: Palette },
        { id: 'export' as const, label: '내보내기', icon: FileOutput },
        { id: 'advanced' as const, label: '고급', icon: SlidersHorizontal },
    ]

    const palette: ColorPalette = $derived(resolveEffectiveColor(settings.theme, settings.color))

    function swatches(p: ColorPalette): string[] {
        return [p.background, p.cardBg, p.text, p.nameColor]
    }

    const resolutionValue = $derived(settings.imageResolution === 'auto' ? 'auto' : String(settings.imageResolution))
</script>

<div class="flex flex-col h-full min-h-0">
    <!-- Tab bar -->
    <div class="flex shrink-0 border-b border-darkborderc">
        {#each tabs as tab (tab.id)}
            <button
                type="button"
                class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors border-b-2"
                class:border-selected={activeTab === tab.id}
                class:text-textcolor={activeTab === tab.id}
                class:text-textcolor2={activeTab !== tab.id}
                class:border-darkborderc={activeTab !== tab.id}
                onclick={() => (activeTab = tab.id)}
            >
                <tab.icon size={13}/>
                {tab.label}
            </button>
        {/each}
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-y-auto p-4 space-y-5 text-sm">
        {#if activeTab === 'style'}
            <!-- Theme -->
            <div>
                <label class="block text-xs font-medium mb-1.5">테마</label>
                <SelectInput value={settings.theme} size="sm" onchange={(e) => onChange('theme', e.currentTarget.value as ThemeKey)}>
                    {#each Object.entries(THEMES) as [key, info] (key)}
                        <option value={key}>{info.name}</option>
                    {/each}
                </SelectInput>
                <p class="text-[11px] text-textcolor2 mt-1">{THEMES[settings.theme]?.description}</p>
            </div>

            <!-- Color palette (basic/custom themes only) -->
            {#if settings.theme === 'basic' || settings.theme === 'custom'}
                <div>
                    <label class="block text-xs font-medium mb-1.5">색상 팔레트</label>
                    <div class="grid grid-cols-2 gap-1.5">
                        {#each Object.entries(COLORS) as [key, c] (key)}
                            {@const pal = c as ColorPalette}
                            <button
                                type="button"
                                class="flex items-center gap-2 px-2 py-1.5 rounded-md border text-xs transition-colors"
                                class:border-borderc={settings.color === key}
                                class:bg-darkbutton={settings.color === key}
                                class:border-darkborderc={settings.color !== key}
                                onclick={() => onChange('color', key as ColorKey)}
                            >
                                <span class="flex gap-0.5">
                                    {#each swatches(pal) as sc}
                                        <span class="w-3 h-3 rounded-sm border border-black/20 inline-block" style="background:{sc}"></span>
                                    {/each}
                                </span>
                                <span class="truncate">{pal.name}</span>
                            </button>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Header / Footer toggles -->
            <div class="space-y-2.5 border-t border-darkborderc pt-4">
                <CheckInput bind:check={() => settings.showHeader, (v) => onChange('showHeader', v)} name="헤더 표시" />
                <CheckInput bind:check={() => settings.showHeaderIcon, (v) => onChange('showHeaderIcon', v)} name="헤더 아이콘" />
                <CheckInput bind:check={() => settings.showFooter, (v) => onChange('showFooter', v)} name="푸터 표시" />

                <div>
                    <label class="block text-xs font-medium mb-1.5">태그 (쉼표로 구분)</label>
                    <input
                        class="border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent text-sm px-2 py-1.5 w-full focus:outline-hidden focus:ring-2 focus:ring-borderc"
                        value={settings.headerTags}
                        onchange={(e) => onChange('headerTags', (e.currentTarget as HTMLInputElement).value)}
                        placeholder="예: 로맨스, 판타지"
                    />
                </div>

                <div>
                    <label class="block text-xs font-medium mb-1.5">헤더 레이아웃</label>
                    <SelectInput value={settings.headerLayout} size="sm" onchange={(e) => onChange('headerLayout', e.currentTarget.value as HeaderLayout)}>
                        {#each HEADER_LAYOUT_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                {#if settings.headerLayout === 'banner' || settings.headerLayout === 'cover'}
                    <CheckInput bind:check={() => settings.headerBannerBlur, (v) => onChange('headerBannerBlur', v)} name="배너 흐림 효과" />
                    <div>
                        <label class="block text-xs font-medium mb-1.5">배너 위치 ({settings.headerBannerAlign}%)</label>
                        <input type="range" min="0" max="100" value={settings.headerBannerAlign} oninput={(e) => onChange('headerBannerAlign', Number((e.currentTarget as HTMLInputElement).value))} class="w-full" />
                    </div>
                {/if}
            </div>

            <!-- Avatar & bubble -->
            <div class="space-y-2.5 border-t border-darkborderc pt-4">
                <CheckInput bind:check={() => settings.showAvatar, (v) => onChange('showAvatar', v)} name="아바타 표시" />
                <CheckInput bind:check={() => settings.showBubble, (v) => onChange('showBubble', v)} name="말풍선 배경" />

                <div>
                    <label class="block text-xs font-medium mb-1.5">아바타 모양</label>
                    <SelectInput value={settings.avatarShape} size="sm" onchange={(e) => onChange('avatarShape', e.currentTarget.value as AvatarShape)}>
                        {#each AVATAR_SHAPE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>
            </div>

            <!-- Participants filter -->
            {#if participants.length > 0}
                <div class="space-y-2 border-t border-darkborderc pt-4">
                    <label class="block text-xs font-medium">참여자 필터</label>
                    <p class="text-[11px] text-textcolor2">체크하면 해당 참여자의 메시지가 제외됩니다.</p>
                    {#each participants as name (name)}
                        {@const isExcluded = excludedParticipants.includes(name)}
                        <CheckInput
                            check={isExcluded}
                            onChange={(v) => onToggleParticipant(name, v)}
                            name={name}
                            grayText={!isExcluded}
                        />
                    {/each}
                </div>
            {/if}

            <!-- Footer texts -->
            <div class="space-y-2 border-t border-darkborderc pt-4">
                <label class="block text-xs font-medium">푸터 텍스트</label>
                <div class="grid grid-cols-1 gap-2">
                    <input class="border border-darkborderc rounded-md bg-transparent px-2 py-1.5 text-xs text-textcolor" placeholder="왼쪽" value={settings.footerLeft} oninput={(e) => onChange('footerLeft', (e.currentTarget as HTMLInputElement).value)} />
                    <input class="border border-darkborderc rounded-md bg-transparent px-2 py-1.5 text-xs text-textcolor" placeholder="중앙" value={settings.footerCenter} oninput={(e) => onChange('footerCenter', (e.currentTarget as HTMLInputElement).value)} />
                    <input class="border border-darkborderc rounded-md bg-transparent px-2 py-1.5 text-xs text-textcolor" placeholder="오른쪽" value={settings.footerRight} oninput={(e) => onChange('footerRight', (e.currentTarget as HTMLInputElement).value)} />
                </div>
            </div>
        {:else if activeTab === 'export'}
            <!-- Image options -->
            <div class="space-y-3">
                <div>
                    <label class="block text-xs font-medium mb-1.5">이미지 포맷</label>
                    <SelectInput value={settings.imageFormat} size="sm" onchange={(e) => onChange('imageFormat', e.currentTarget.value as ImageFormat)}>
                        {#each IMAGE_FORMAT_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label class="block text-xs font-medium mb-1.5">캡처 해상도</label>
                    <SelectInput value={resolutionValue} size="sm" onchange={(e) => {
                        const v = e.currentTarget.value
                        onChange('imageResolution', v === 'auto' ? 'auto' : Number(v))
                    }}>
                        {#each IMAGE_RESOLUTION_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label class="block text-xs font-medium mb-1.5">분할 방식 (긴 로그)</label>
                    <SelectInput value={settings.splitImage} size="sm" onchange={(e) => onChange('splitImage', e.currentTarget.value as SplitImageMode)}>
                        {#each SPLIT_IMAGE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                    <p class="text-[11px] text-textcolor2 mt-1">분할된 조각은 ffmpeg으로 하나의 이미지로 이어 붙여집니다.</p>
                </div>

                <div>
                    <label class="block text-xs font-medium mb-1.5">최대 이미지 높이 (px)</label>
                    <NumberInput value={settings.maxImageHeight} size="sm" min={1000} onChange={(e) => onChange('maxImageHeight', Math.max(1000, Number((e.currentTarget as HTMLInputElement).value) || 10000))} fullwidth />
                </div>

                <CheckInput bind:check={() => settings.convertWebM, (v) => onChange('convertWebM', v)} name="WebM을 WebP로 변환 (ffmpeg)" />
            </div>

            <!-- Preview sizing -->
            <div class="space-y-3 border-t border-darkborderc pt-4">
                <div>
                    <label class="block text-xs font-medium mb-1.5">미리보기 너비 (px)</label>
                    <NumberInput value={settings.previewWidth} size="sm" min={320} onChange={(e) => onChange('previewWidth', Math.max(320, Number((e.currentTarget as HTMLInputElement).value) || 800))} fullwidth />
                </div>
                <div>
                    <label class="block text-xs font-medium mb-1.5">글꼴 크기 (px)</label>
                    <NumberInput value={settings.previewFontSize} size="sm" min={10} onChange={(e) => onChange('previewFontSize', Math.max(10, Number((e.currentTarget as HTMLInputElement).value) || 16))} fullwidth />
                </div>
            </div>
        {:else}
            <!-- Advanced -->
            <div class="space-y-3">
                <CheckInput bind:check={() => settings.embedImages, (v) => onChange('embedImages', v)} name="이미지 임베드 (data URL)" />
                <CheckInput bind:check={() => settings.disableAnimations, (v) => onChange('disableAnimations', v)} name="애니메이션 비활성화" />
                <CheckInput bind:check={() => settings.allowHtmlRendering, (v) => onChange('allowHtmlRendering', v)} name="원본 HTML 유지" />

                <div>
                    <label class="block text-xs font-medium mb-1.5">HTML 스케일 모드</label>
                    <SelectInput value={settings.htmlScaleMode} size="sm" onchange={(e) => onChange('htmlScaleMode', e.currentTarget.value as HtmlScaleMode)}>
                        {#each SCALE_MODE_OPTIONS as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </SelectInput>
                </div>

                <div>
                    <label class="block text-xs font-medium mb-1.5">HTML 스케일 배율 ({settings.htmlScaleFactor}x)</label>
                    <input type="range" min="0.5" max="2" step="0.05" value={settings.htmlScaleFactor} oninput={(e) => onChange('htmlScaleFactor', Number((e.currentTarget as HTMLInputElement).value))} class="w-full" />
                </div>

                <!-- Image display options -->
                <div class="border-t border-darkborderc pt-3 space-y-3">
                    <label class="block text-xs font-medium">이미지 표시 옵션</label>
                    <div>
                        <label class="block text-[11px] text-textcolor2 mb-1">정렬</label>
                        <SelectInput value={settings.imageAlign} size="sm" onchange={(e) => onChange('imageAlign', e.currentTarget.value as ImageAlign)}>
                            {#each IMAGE_ALIGN_OPTIONS as opt (opt.value)}
                                <option value={opt.value}>{opt.label}</option>
                            {/each}
                        </SelectInput>
                    </div>
                    <div>
                        <label class="block text-[11px] text-textcolor2 mb-1">프레임 스타일</label>
                        <SelectInput value={settings.imageStyle} size="sm" onchange={(e) => onChange('imageStyle', e.currentTarget.value as ImageStyle)}>
                            {#each IMAGE_STYLE_OPTIONS as opt (opt.value)}
                                <option value={opt.value}>{opt.label}</option>
                            {/each}
                        </SelectInput>
                    </div>
                    <div>
                        <label class="block text-[11px] text-textcolor2 mb-1">이미지 크기 ({settings.imageScale}%)</label>
                        <input type="range" min="10" max="100" step="5" value={settings.imageScale} oninput={(e) => onChange('imageScale', Number((e.currentTarget as HTMLInputElement).value))} class="w-full" />
                    </div>
                    <CheckInput bind:check={() => settings.imageCropActive, (v) => onChange('imageCropActive', v)} name="이미지 크롭 활성화" />
                    {#if settings.imageCropActive}
                        <div>
                            <label class="block text-[11px] text-textcolor2 mb-1">크롭 비율</label>
                            <SelectInput value={settings.imageCropAspectRatio} size="sm" onchange={(e) => onChange('imageCropAspectRatio', e.currentTarget.value as ImageCropAspectRatio)}>
                                {#each CROP_ASPECT_RATIO_OPTIONS as opt (opt.value)}
                                    <option value={opt.value}>{opt.label}</option>
                                {/each}
                            </SelectInput>
                        </div>
                        <div>
                            <label class="block text-[11px] text-textcolor2 mb-1">세로 초점 ({settings.imageCropVAlign}%)</label>
                            <input type="range" min="0" max="100" value={settings.imageCropVAlign} oninput={(e) => onChange('imageCropVAlign', Number((e.currentTarget as HTMLInputElement).value))} class="w-full" />
                        </div>
                        <div>
                            <label class="block text-[11px] text-textcolor2 mb-1">가로 초점 ({settings.imageCropHAlign}%)</label>
                            <input type="range" min="0" max="100" value={settings.imageCropHAlign} oninput={(e) => onChange('imageCropHAlign', Number((e.currentTarget as HTMLInputElement).value))} class="w-full" />
                        </div>
                        {#if settings.imageCropAspectRatio === 'custom'}
                            <div>
                                <label class="block text-[11px] text-textcolor2 mb-1">사용자 지정 세로 배율</label>
                                <NumberInput value={settings.imageCropHeight} size="sm" min={0.5} onChange={(e) => onChange('imageCropHeight', Number((e.currentTarget as HTMLInputElement).value) || 1)} fullwidth />
                            </div>
                        {/if}
                    {/if}
                </div>

                <!-- Custom CSS (custom theme) -->
                <div class="border-t border-darkborderc pt-3">
                    <label class="block text-xs font-medium mb-1.5">커스텀 CSS (커스텀 테마)</label>
                    <textarea
                        class="w-full h-32 border border-darkborderc rounded-md bg-transparent p-2 text-xs font-mono text-textcolor focus:outline-hidden focus:ring-2 focus:ring-borderc"
                        placeholder={'.risu-log-container { ... }'}
                        value={settings.customCss}
                        oninput={(e) => onChange('customCss', (e.currentTarget as HTMLTextAreaElement).value)}
                    ></textarea>
                </div>
            </div>
        {/if}
    </div>
</div>
