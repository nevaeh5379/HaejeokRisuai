<script lang="ts">
    import { PackageIcon, GlobeIcon } from "@lucide/svelte";
    import { selectedCharID, openMobileSettingsPage } from "src/ts/stores.svelte";
    import { characterStore } from "src/ts/stores/domain";
    import Toggles from "../SideBars/Toggles.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";

    let chara = $derived(characterStore.characters[$selectedCharID]);
    let openModuleMenu = $state(false);

    function handleGoGlobalModules() {
        openMobileSettingsPage(14, $selectedCharID, 6);
    }
</script>

<div class="w-full h-full flex flex-col bg-bgcolor text-textcolor overflow-y-auto px-2 py-1 gap-2 select-none">
    <!-- Module Action Buttons (대화 모듈 / 전역 모듈) -->
    <div class="grid grid-cols-2 gap-1.5 shrink-0">
        <!-- 1. 대화 모듈 -->
        <button
            onclick={() => { openModuleMenu = true; }}
            class="py-2 px-2.5 rounded-xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor text-xs font-semibold flex items-center justify-between transition-colors shadow-xs cursor-pointer"
            title="대화 모듈 설정"
        >
            <div class="flex items-center gap-1.5 truncate">
                <PackageIcon size={15} class="text-orange-400 shrink-0" />
                <span class="truncate">대화 모듈</span>
            </div>
            <span class="text-[10px] text-textcolor2 shrink-0">&rarr;</span>
        </button>

        <!-- 2. 전역 모듈 (설정 화면으로 즉시 이동) -->
        <button
            onclick={handleGoGlobalModules}
            class="py-2 px-2.5 rounded-xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor text-xs font-semibold flex items-center justify-between transition-colors shadow-xs cursor-pointer"
            title="전역 모듈 설정 (설정 화면)"
        >
            <div class="flex items-center gap-1.5 truncate">
                <GlobeIcon size={15} class="text-blue-400 shrink-0" />
                <span class="truncate">전역 모듈</span>
            </div>
            <span class="text-[10px] text-textcolor2 shrink-0">&rarr;</span>
        </button>
    </div>

    <!-- Toggles Content -->
    <Toggles chara={chara} noContainer={true} />
</div>

{#if openModuleMenu}
    <div class="fixed inset-0 z-50">
        <ModuleChatMenu close={() => { openModuleMenu = false; }} />
    </div>
{/if}
