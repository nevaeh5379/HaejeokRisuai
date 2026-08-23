<script lang="ts">
    import { Plus, Trash2 } from '@lucide/svelte'
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
        updateRules([...rules, {
            id: uuidv4(),
            pattern: '',
            replacement: '',
            isRegex: false,
            isEnabled: true,
        }])
    }

    function removeRule(id: string) {
        updateRules(rules.filter((r) => r.id !== id))
    }

    function patchRule(id: string, patch: Partial<ReplacementRule>) {
        updateRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    }
</script>

<div class="flex flex-col h-full min-h-0 text-sm">
    <div class="flex shrink-0 items-center justify-between px-4 py-3 border-b border-darkborderc">
        <span class="text-xs font-medium">텍스트 치환 규칙 ({rules.length})</span>
        <button type="button" class="flex items-center gap-1 px-2 py-1.5 rounded-md border border-darkborderc hover:bg-darkbutton text-xs transition-colors" onclick={addRule}>
            <Plus size={13}/> 추가
        </button>
    </div>

    <div class="flex-1 overflow-y-auto p-4 space-y-3">
        {#if rules.length === 0}
            <p class="text-textcolor2 text-xs leading-relaxed">
                내보내는 로그에서 특정 텍스트를 다른 텍스트로 바꿉니다.<br/>
                정규식을 사용하려면 "정규식" 체크박스를 활성화하세요.
            </p>
        {/if}

        {#each rules as rule, i (rule.id)}
            <div class="rounded-lg border border-darkborderc bg-darkbg/50 p-3 space-y-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] text-textcolor2">규칙 {i + 1}</span>
                    <button type="button" class="p-1 rounded hover:bg-darkbutton text-red-400" title="삭제" onclick={() => removeRule(rule.id)}>
                        <Trash2 size={13}/>
                    </button>
                </div>

                <CheckInput
                    check={rule.isEnabled !== false}
                    onChange={(v) => patchRule(rule.id, { isEnabled: v })}
                    name="활성화"
                    grayText={true}
                />

                <label class="block text-[11px] text-textcolor2">찾을 패턴</label>
                <input
                    class="w-full border border-darkborderc rounded-md bg-transparent px-2 py-1.5 text-xs font-mono text-textcolor focus:outline-hidden focus:ring-2 focus:ring-borderc"
                    value={rule.pattern}
                    oninput={(e) => patchRule(rule.id, { pattern: (e.currentTarget as HTMLInputElement).value })}
                    placeholder={rule.isRegex ? '예: \\d{4}-\\d{2}' : '예: 찾을 단어'}
                />

                <label class="block text-[11px] text-textcolor2">바꿀 내용</label>
                <input
                    class="w-full border border-darkborderc rounded-md bg-transparent px-2 py-1.5 text-xs font-mono text-textcolor focus:outline-hidden focus:ring-2 focus:ring-borderc"
                    value={rule.replacement}
                    oninput={(e) => patchRule(rule.id, { replacement: (e.currentTarget as HTMLInputElement).value })}
                    placeholder="$1로 캡처 그룹 참조 가능"
                />

                <div class="flex items-center gap-3">
                    <CheckInput
                        check={rule.isRegex === true}
                        onChange={(v) => patchRule(rule.id, { isRegex: v })}
                        name="정규식"
                        hiddenName={false}
                        margin={false}
                    />
                    {#if rule.isRegex}
                        <input
                            class="flex-1 border border-darkborderc rounded-md bg-transparent px-2 py-1 text-xs font-mono text-textcolor"
                            value={rule.flags ?? 'g'}
                            onchange={(e) => patchRule(rule.id, { flags: (e.currentTarget as HTMLInputElement).value || 'g' })}
                            placeholder="flags"
                        />
                    {/if}
                </div>
            </div>
        {/each}
    </div>
</div>
