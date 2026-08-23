<script lang="ts">
    import { Plus, Trash2, ArrowLeftRight } from '@lucide/svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import { v4 as uuidv4 } from 'uuid'
    import type { LogExporterSettings, ReplacementRule } from 'src/ts/logexporter/types'

    interface Props {
        settings: LogExporterSettings
        onChange: <K extends keyof LogExporterSettings>(key: K, value: LogExporterSettings[K]) => void
    }

    let { settings, onChange }: Props = $props()

    const rules = $derived(settings.replacementRules ?? [])

    function updateRules(next: ReplacementRule[]) {
        onChange('replacementRules', next)
    }

    function addRule() {
        updateRules([
            ...rules,
            {
                id: uuidv4(),
                pattern: '',
                replacement: '',
                isRegex: false,
                isEnabled: true,
                flags: 'g',
            },
        ])
    }

    function removeRule(id: string) {
        updateRules(rules.filter((r) => r.id !== id))
    }

    function patchRule(id: string, patch: Partial<ReplacementRule>) {
        updateRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    }
</script>

<div class="flex flex-col h-full min-h-0 text-sm">
    <!-- Header -->
    <div class="flex shrink-0 items-center justify-between px-4 py-3 border-b border-darkborderc bg-darkbg/40">
        <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-textcolor">텍스트 치환 규칙</span>
            <span class="text-[11px] px-2 py-0.2 rounded-full bg-selected/20 text-textcolor border border-selected/40 font-bold tabular-nums">
                {rules.length}
            </span>
        </div>
        <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-selected text-white hover:brightness-110 active:scale-95 text-xs font-medium transition shadow-xs"
            onclick={addRule}
        >
            <Plus size={13} strokeWidth={2.5} />
            규칙 추가
        </button>
    </div>

    <!-- Rule list -->
    <div class="flex-1 overflow-y-auto p-4 space-y-3.5">
        {#if rules.length === 0}
            <div class="flex flex-col items-center justify-center py-10 px-4 text-center rounded-xl border border-dashed border-darkborderc bg-darkbg/20">
                <div class="w-10 h-10 rounded-xl bg-darkbutton border border-darkborderc flex items-center justify-center text-textcolor2 mb-3">
                    <ArrowLeftRight size={20} />
                </div>
                <h4 class="text-xs font-semibold text-textcolor mb-1">치환 규칙이 없습니다</h4>
                <p class="text-[11px] text-textcolor2 max-w-xs leading-relaxed mb-4">
                    로그 내보내기 시 특정 텍스트나 정규식 패턴을 원하는 내용으로 자동 변환합니다.
                </p>
                <button
                    type="button"
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-darkbutton hover:bg-darkborderc border border-darkborderc text-xs font-medium text-textcolor transition active:scale-95"
                    onclick={addRule}
                >
                    <Plus size={13} />
                    첫 번째 규칙 만들기
                </button>
            </div>
        {/if}

        {#each rules as rule, i (rule.id)}
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 space-y-3.5 shadow-sm">
                <!-- Rule Header Bar -->
                <div class="flex items-center justify-between gap-2 pb-2 border-b border-darkborderc/60">
                    <div class="flex items-center gap-2">
                        <span class="text-[11px] font-bold px-2 py-0.5 rounded-md bg-darkbutton border border-darkborderc text-textcolor">
                            #{i + 1}
                        </span>
                        <CheckInput
                            check={rule.isEnabled !== false}
                            onChange={(v) => patchRule(rule.id, { isEnabled: v })}
                            name="활성화"
                            grayText={rule.isEnabled === false}
                            margin={false}
                        />
                    </div>
                    <button
                        type="button"
                        class="p-1.5 rounded-md hover:bg-red-500/15 text-textcolor2 hover:text-red-400 transition-colors active:scale-95"
                        title="규칙 삭제"
                        onclick={() => removeRule(rule.id)}
                        aria-label={`규칙 ${i + 1} 삭제`}
                    >
                        <Trash2 size={14} />
                    </button>
                </div>

                <!-- Pattern Input -->
                <div>
                    <label for={`rule-pattern-${rule.id}`} class="block text-[11px] font-medium text-textcolor/90 mb-1">
                        찾을 패턴
                    </label>
                    <input
                        id={`rule-pattern-${rule.id}`}
                        class="w-full border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 px-2.5 py-1.5 text-xs font-mono text-textcolor placeholder:text-textcolor2/50 focus:outline-hidden focus:ring-1 focus:ring-selected transition-colors"
                        value={rule.pattern}
                        oninput={(e) => patchRule(rule.id, { pattern: (e.currentTarget as HTMLInputElement).value })}
                        placeholder={rule.isRegex ? '예: \\d{4}-\\d{2}' : '예: 찾을 단어'}
                    />
                </div>

                <!-- Replacement Input -->
                <div>
                    <label for={`rule-replace-${rule.id}`} class="block text-[11px] font-medium text-textcolor/90 mb-1">
                        바꿀 내용
                    </label>
                    <input
                        id={`rule-replace-${rule.id}`}
                        class="w-full border border-darkborderc focus:border-selected rounded-lg bg-darkbutton/60 px-2.5 py-1.5 text-xs font-mono text-textcolor placeholder:text-textcolor2/50 focus:outline-hidden focus:ring-1 focus:ring-selected transition-colors"
                        value={rule.replacement}
                        oninput={(e) => patchRule(rule.id, { replacement: (e.currentTarget as HTMLInputElement).value })}
                        placeholder={rule.isRegex ? '$1로 캡처 그룹 참조 가능' : '바꿀 단어'}
                    />
                </div>

                <!-- Regex Options Row -->
                <div class="flex items-center justify-between gap-3 pt-1 border-t border-darkborderc/40">
                    <CheckInput
                        check={rule.isRegex === true}
                        onChange={(v) => patchRule(rule.id, { isRegex: v })}
                        name="정규식 (Regex)"
                        hiddenName={false}
                        margin={false}
                    />
                    {#if rule.isRegex}
                        <div class="flex items-center gap-1.5">
                            <label for={`rule-flags-${rule.id}`} class="text-[11px] text-textcolor2 font-mono">flags:</label>
                            <input
                                id={`rule-flags-${rule.id}`}
                                class="w-16 border border-darkborderc focus:border-selected rounded-md bg-darkbutton/60 px-2 py-1 text-xs font-mono text-textcolor focus:outline-hidden focus:ring-1 focus:ring-selected"
                                value={rule.flags ?? 'g'}
                                onchange={(e) => patchRule(rule.id, { flags: (e.currentTarget as HTMLInputElement).value || 'g' })}
                                placeholder="g"
                            />
                        </div>
                    {/if}
                </div>
            </div>
        {/each}
    </div>
</div>
