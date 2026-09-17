<script lang="ts">
    import Button from '../../UI/GUI/Button.svelte';
    import {
        refreshAndroidNativeSurfaces,
    } from 'src/ts/androidNativeSurfaces';
    import {
        requestAndroidQuickSettingsTile,
        requestAndroidWidget,
        type AndroidWidgetType,
    } from 'src/ts/androidNativeIntegration';

    const ko = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ko');
    let busy = $state(false);
    let status = $state('');

    async function addWidget(type: AndroidWidgetType) {
        busy = true;
        try {
            await refreshAndroidNativeSurfaces();
            const result = await requestAndroidWidget(type);
            status = result.supported
                ? (result.accepted
                    ? (ko ? '홈 화면 위젯 추가 요청을 보냈습니다.' : 'Widget pin request sent.')
                    : (ko ? '런처가 위젯 추가 요청을 받지 않았습니다.' : 'The launcher did not accept the widget request.'))
                : (ko ? '이 런처는 앱의 위젯 추가 요청을 지원하지 않습니다.' : 'This launcher does not support widget pin requests.');
        } finally {
            busy = false;
        }
    }

    async function addTile() {
        busy = true;
        try {
            const result = await requestAndroidQuickSettingsTile();
            status = result.supported
                ? (ko ? '빠른 설정 타일 추가 요청을 보냈습니다.' : 'Quick Settings tile request sent.')
                : (ko ? 'Android 13 이상에서 앱이 타일 추가를 요청할 수 있습니다.' : 'Programmatic tile requests require Android 13 or newer.');
        } finally {
            busy = false;
        }
    }

    async function refreshSurfaces() {
        busy = true;
        try {
            await refreshAndroidNativeSurfaces();
            status = ko ? 'Android 시스템 항목을 갱신했습니다.' : 'Android system surfaces refreshed.';
        } finally {
            busy = false;
        }
    }
</script>

<section class="mt-6 border border-darkborderc rounded-xl p-4 bg-darkbg/40">
    <h3 class="text-lg font-semibold text-textcolor">Android integration</h3>
    <p class="mt-1 text-sm text-textcolor2">
        {ko
            ? '최근 채팅을 위젯, 빠른 설정, 공유 메뉴와 연결합니다.'
            : 'Connect recent chats to widgets, Quick Settings, and Android sharing.'}
    </p>
    <div class="mt-4 flex flex-wrap gap-2">
        <Button onclick={() => addWidget('recent')} disabled={busy}>
            {ko ? '최근 채팅 카드 추가' : 'Add recent chat card'}
        </Button>
        <Button onclick={() => addWidget('compact')} disabled={busy}>
            {ko ? '최근 봇 아이콘 추가' : 'Add recent bot icon'}
        </Button>
        <Button onclick={() => addWidget('grid')} disabled={busy}>
            {ko ? '최근 봇 그리드 추가' : 'Add recent bot grid'}
        </Button>
        <Button onclick={() => addWidget('strip')} disabled={busy}>
            {ko ? '최근 봇 가로줄 추가' : 'Add recent bot strip'}
        </Button>
        <Button onclick={addTile} disabled={busy}>
            {ko ? '빠른 설정 타일 추가' : 'Add Quick Settings tile'}
        </Button>
        <Button styled="outlined" onclick={refreshSurfaces} disabled={busy}>
            {ko ? '시스템 항목 새로고침' : 'Refresh system surfaces'}
        </Button>
    </div>
    {#if status}
        <p class="mt-3 text-sm text-textcolor2" aria-live="polite">{status}</p>
    {/if}
</section>
