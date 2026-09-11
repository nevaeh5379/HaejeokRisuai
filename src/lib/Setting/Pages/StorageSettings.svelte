<script lang="ts">
  import { isNodeServer } from 'src/ts/platform';
  import { getActiveStorageRuntime } from 'src/ts/storage/runtime/activeStorageRuntime';
  import { summarizeStorageSyncAssets, type StorageSyncAssetSummary } from 'src/ts/storage/runtime/storageSyncAssetReader';
  import { syncLocalStorageToRemote, type StorageSyncStageProgress } from 'src/ts/storage/runtime/storageSyncCoordinator';
  import { connectRemoteStorageProfile } from 'src/ts/storage/runtime/storageProfileConnection';
  import { saveStorageProfile } from 'src/ts/storage/runtime/storageProfile';
  import Help from 'src/lib/Others/Help.svelte';
  import { ArrowRight, Check, ChevronDown, Database, FolderSync, HardDrive, Server, ShieldAlert } from '@lucide/svelte';

  type RemoteConnection = Awaited<ReturnType<typeof connectRemoteStorageProfile>>;
  type SyncPreview = {
    local: {
      revision: number;
      records: { settings: number; characters: number; chats: number; messages: number; total: number };
      assets: StorageSyncAssetSummary;
    };
    remote: {
      revision: number;
      records: { settings: number; characters: number; chats: number; messages: number; total: number };
      assets: { count: number; sizeBytes: number };
    };
  };

  const activeRuntime = getActiveStorageRuntime();
  const activeProfile = activeRuntime.profile;
  let remoteUrl = $state(activeProfile.mode === 'remote' ? activeProfile.baseUrl : '');
  let allowInsecureHttp = $state(activeProfile.mode === 'remote' ? activeProfile.allowInsecureHttp : false);
  let password = $state('');
  let checking = $state(false);
  let connectionState = $state<'idle' | 'ok' | 'error'>('idle');
  let connectionMessage = $state('');
  let verifiedConnection = $state.raw<RemoteConnection | null>(null);
  let syncPreview = $state<SyncPreview | null>(null);
  let syncBusy = $state(false);
  let syncProgress = $state<StorageSyncStageProgress | null>(null);
  let syncMessage = $state('');
  let serverFormOpen = $state(false);
  let usesRegisteredKey = $derived(activeProfile.mode === 'remote' && remoteUrl.trim() === activeProfile.baseUrl);

  const storageHelp = `저장 위치는 **SQL 데이터와 모든 자산**에 함께 적용됩니다.

- SQL: 설정, 캐릭터, 채팅, 메시지
- 자산: 이미지, 음성, 첨부 파일, 플러그인 파일

저장 위치를 바꿔도 반대편 데이터는 삭제되지 않습니다. 새 위치는 앱을 다시 불러온 뒤 적용됩니다.`;
  const serverConnectionHelp = `새 셀프 호스트 서버는 연결 검사와 인증이 모두 성공한 뒤에만 저장 위치로 사용할 수 있습니다.

서버 비밀번호는 저장하지 않습니다. 처음 연결하거나 기기 인증 키(P-256)를 다시 등록할 때만 사용합니다. 등록된 인증 키가 유효하면 비밀번호를 입력하지 않아도 연결을 확인할 수 있습니다.`;
  const insecureHttpHelp = `HTTP 연결은 전송 내용을 암호화하지 않으므로 신뢰할 수 있는 로컬 네트워크에서만 사용하세요.

HTTPS 페이지에서 HTTP 서버로 연결하는 것은 브라우저의 mixed-content 정책에 따라 차단될 수 있습니다.`;
  const syncHelp = `이 기기의 현재 데이터를 셀프 호스트 서버로 **한 방향 복사**합니다. 저장 위치는 바뀌지 않습니다.

미리보기는 양쪽 데이터를 읽기만 합니다. 실행하면 서버의 SQL과 자산을 이 기기의 데이터로 교체합니다. 서버의 기존 데이터는 recovery snapshot으로 보존되며, 전송 중 원본이나 대상이 바뀌면 적용 전에 중단됩니다.`;

  function resetVerification() {
    connectionState = 'idle';
    connectionMessage = '';
    verifiedConnection = null;
    syncPreview = null;
    syncProgress = null;
    syncMessage = '';
  }

  async function verifyRemote(): Promise<RemoteConnection | null> {
    checking = true;
    connectionState = 'idle';
    connectionMessage = '';
    try {
      const result = await connectRemoteStorageProfile({
        baseUrl: remoteUrl,
        allowInsecureHttp,
        password,
        pageProtocol: location.protocol,
      });
      verifiedConnection = result;
      connectionState = 'ok';
      connectionMessage = '서버 연결과 인증을 확인했습니다.';
      return result;
    } catch (cause) {
      verifiedConnection = null;
      connectionState = 'error';
      connectionMessage = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      checking = false;
      password = '';
    }
  }

  async function applyRemote() {
    const connection = verifiedConnection ?? (await verifyRemote());
    if (!connection) return;
    saveStorageProfile(connection.profile);
    location.reload();
  }

  async function loadSyncPreview() {
    if (activeProfile.mode !== 'local' || syncBusy) return;
    syncBusy = true;
    syncMessage = '';
    syncProgress = { phase: 'preview' };
    try {
      const connection = verifiedConnection ?? (await verifyRemote());
      if (!connection) return;
      const [localSql, localAssets, remote] = await Promise.all([
        activeRuntime.sql.getStorageSyncSummary(),
        activeRuntime.assets.getStorageSyncAssetReader().then((reader) => summarizeStorageSyncAssets(reader)),
        connection.storage.getStorageSyncSummary(),
      ]);
      syncPreview = {
        local: { revision: localSql.revision, records: localSql.records, assets: localAssets },
        remote: { revision: remote.revision, records: remote.records, assets: remote.assets },
      };
      syncMessage = '읽기 전용 미리보기를 갱신했습니다. 아직 어느 쪽 데이터도 변경하지 않았습니다.';
    } catch (cause) {
      syncPreview = null;
      syncMessage = cause instanceof Error ? cause.message : String(cause);
    } finally {
      syncBusy = false;
      syncProgress = null;
    }
  }

  async function runLocalToRemoteSync() {
    if (activeProfile.mode !== 'local' || !syncPreview || syncBusy) return;
    const connection = verifiedConnection;
    if (!connection) return;
    const confirmed = confirm(
      `셀프 호스트 서버의 현재 데이터(리비전 ${syncPreview.remote.revision})를 이 기기의 로컬 데이터(리비전 ${syncPreview.local.revision})로 완전히 교체할까요?\n\n서버의 기존 데이터는 recovery snapshot으로 보존되며, 이 기기의 로컬 데이터는 변경하지 않습니다.`,
    );
    if (!confirmed) return;
    syncBusy = true;
    syncMessage = '';
    try {
      const sourceAssets = await activeRuntime.assets.getStorageSyncAssetReader();
      const result = await syncLocalStorageToRemote({
        sourceSql: activeRuntime.sql,
        sourceAssets,
        target: connection.storage,
        onProgress: (progress) => {
          syncProgress = progress;
        },
      });
      syncPreview = null;
      syncMessage = result.resumedFinalized
        ? '이미 완료된 동기화 결과를 서버에서 복구했습니다. 데이터는 다시 적용하지 않았습니다.'
        : `동기화가 완료되었습니다. 서버 리비전이 ${result.finalized.revision}(으)로 갱신되었습니다.`;
    } catch (cause) {
      syncMessage = cause instanceof Error ? cause.message : String(cause);
    } finally {
      syncBusy = false;
      syncProgress = null;
    }
  }

  function switchLocal() {
    if (activeProfile.mode === 'local') return;
    if (!confirm('셀프 호스트 데이터는 그대로 보존하고 이 기기의 별도 로컬 저장소로 전환할까요?')) return;
    saveStorageProfile({ version: 1, mode: 'local' });
    location.reload();
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function phaseLabel(progress: StorageSyncStageProgress | null): string {
    if (!progress) return '';
    return ({
      preview: '미리보기 확인 중',
      assets: '자산 전송 중',
      sql: 'SQL 전송 중',
      verifying: '원본·대상 재검증 중',
      staged: '전송 완료',
      finalizing: '서버에 원자적으로 적용 중',
      completed: '완료',
    } as const)[progress.phase];
  }
</script>
<div class="flex max-w-3xl flex-col gap-5 pb-6">
  <header class="flex items-center gap-3">
    <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-textcolor/5 text-textcolor2">
      <Database size={22} />
    </span>
    <div class="flex min-w-0 items-center gap-2">
      <h2 class="text-2xl font-bold">저장소</h2>
      <Help name="저장소" text={storageHelp} />
    </div>
  </header>

  {#if isNodeServer}
    <section class="flex items-center gap-3 rounded-xl border border-textcolor/10 bg-textcolor/5 p-4">
      <Server class="shrink-0 text-textcolor2" size={20} />
      <div class="min-w-0 flex-1 font-medium">Node 서버에서 관리하는 저장소</div>
      <Help name="Node 서버 저장소" text="Node 서버가 제공하는 웹앱은 같은 출처의 서버 SQL·자산 저장소만 사용하며, 클라이언트에서 로컬 모드로 바꿀 수 없습니다." />
    </section>
  {:else}
    <section class="overflow-hidden rounded-2xl border border-textcolor/10 bg-darkbg">
      <div class="flex items-center gap-2 border-b border-textcolor/10 px-4 py-3.5 sm:px-5">
        <h3 class="font-bold">저장 위치</h3>
        <Help name="저장 위치" text={serverConnectionHelp} />
      </div>

      <div class="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors {activeProfile.mode === 'local' ? 'border-selected bg-selected/10' : 'border-textcolor/10 bg-textcolor/5 hover:border-textcolor/25 hover:bg-textcolor/10'}"
          disabled={activeProfile.mode === 'local' || syncBusy}
          onclick={switchLocal}
        >
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bgcolor"><HardDrive size={20} /></span>
          <span class="min-w-0 flex-1">
            <span class="block font-bold">이 기기</span>
            <span class="block text-xs text-textcolor2">{activeProfile.mode === 'local' ? '사용 중' : '전환하기'}</span>
          </span>
          {#if activeProfile.mode === 'local'}<Check class="shrink-0" size={18} />{:else}<ArrowRight class="shrink-0 text-textcolor2" size={18} />{/if}
        </button>

        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border p-4 text-left transition-colors {activeProfile.mode === 'remote' ? 'border-selected bg-selected/10' : 'border-textcolor/10 bg-textcolor/5 hover:border-textcolor/25 hover:bg-textcolor/10'}"
          aria-expanded={serverFormOpen}
          onclick={() => {
            serverFormOpen = !serverFormOpen;
          }}
        >
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bgcolor"><Server size={20} /></span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="font-bold">셀프 호스트 (베타)</span>
              {#if activeProfile.mode === 'remote'}
                <span class="inline-flex items-center gap-1 rounded-full bg-selected/15 px-2 py-0.5 text-[11px] font-bold"><Check size={11} /> 사용 중</span>
              {/if}
            </span>
            <span class="block truncate text-xs text-textcolor2">{activeProfile.mode === 'remote' ? activeProfile.baseUrl : '연결하기'}</span>
          </span>
          {#if activeProfile.mode === 'remote'}
            <ChevronDown class="shrink-0 text-textcolor2 transition-transform {serverFormOpen ? 'rotate-180' : ''}" size={18} />
          {:else}
            <ArrowRight class="shrink-0 text-textcolor2" size={18} />
          {/if}
        </button>
      </div>

      {#if serverFormOpen}
        <div class="flex flex-col gap-4 border-t border-textcolor/10 p-4 sm:p-5">
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="text-sm font-bold">서버 주소</span>
              <input class="mt-1.5 w-full rounded-lg border border-textcolor/15 bg-bgcolor px-3 py-2 outline-none transition-colors placeholder:text-textcolor2/60 focus:border-selected" bind:value={remoteUrl} oninput={resetVerification} placeholder="https://risu.example.com" autocomplete="url" />
            </label>
            <label class="block">
              <span class="flex flex-wrap items-center gap-1.5 text-sm font-bold">
                서버 비밀번호
                <Help name="서버 비밀번호" text={serverConnectionHelp} />
                {#if usesRegisteredKey}<span class="rounded-full bg-textcolor/5 px-2 py-0.5 text-[11px] font-medium text-textcolor2">인증 키 등록됨</span>{/if}
              </span>
              <input
                class="mt-1.5 w-full rounded-lg border border-textcolor/15 bg-bgcolor px-3 py-2 outline-none transition-colors placeholder:text-textcolor2/60 focus:border-selected"
                type="password"
                bind:value={password}
                oninput={resetVerification}
                placeholder={usesRegisteredKey ? '다시 인증할 때만 입력' : '서버 비밀번호 입력'}
                autocomplete="current-password"
              />
            </label>
          </div>

          {#if connectionState !== 'idle'}
            <div class="rounded-xl border p-3 text-sm {connectionState === 'ok' ? 'border-green-500/40 bg-green-500/10' : 'border-draculared/40 bg-draculared/10 text-draculared'}">
              {connectionMessage}
            </div>
          {/if}

          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label class="flex w-fit items-center gap-2 text-sm text-textcolor2">
              <input type="checkbox" bind:checked={allowInsecureHttp} onchange={resetVerification} />
              <ShieldAlert size={15} />
              <span>HTTP 허용</span>
              <Help name="HTTP 연결" text={insecureHttpHelp} />
            </label>

            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="rounded-lg border border-textcolor/15 bg-textcolor/5 px-4 py-2 text-sm font-medium hover:bg-textcolor/10 disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void verifyRemote()}>
                {checking ? '확인 중…' : '연결 확인'}
              </button>
              <button type="button" class="rounded-lg bg-selected px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void applyRemote()}>
                {activeProfile.mode === 'remote' ? '연결 다시 적용' : '이 서버 사용'}
              </button>
            </div>
          </div>
        </div>
      {/if}
    </section>

    <section class="overflow-hidden rounded-2xl border border-textcolor/10 bg-darkbg">
      <div class="flex items-center justify-between gap-3 border-b border-textcolor/10 px-4 py-3.5 sm:px-5">
        <div class="flex items-center gap-2">
          <h3 class="font-bold">데이터 옮기기</h3>
          <Help name="데이터 옮기기" text={syncHelp} />
        </div>
        {#if activeProfile.mode === 'remote'}
          <span class="rounded-full bg-textcolor/5 px-2.5 py-1 text-xs font-medium text-textcolor2">준비 중</span>
        {/if}
      </div>

      {#if activeProfile.mode === 'local'}
        <div class="flex flex-col gap-4 p-4 sm:p-5">
          <div class="flex min-w-0 items-center gap-3 rounded-xl border border-textcolor/10 bg-textcolor/5 p-3">
            <FolderSync class="shrink-0 text-textcolor2" size={20} />
            <div class="min-w-0 flex-1">
              <div class="text-xs text-textcolor2">보낼 곳</div>
              <div class="truncate text-sm font-medium">{remoteUrl.trim() || '셀프 호스트 서버를 선택하세요'}</div>
            </div>
            <button type="button" class="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-textcolor/10" onclick={() => (serverFormOpen = true)}>서버 선택</button>
          </div>

          <div class="flex flex-wrap gap-2">
            <button type="button" class="rounded-lg border border-textcolor/15 bg-textcolor/5 px-4 py-2 text-sm font-medium hover:bg-textcolor/10 disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void loadSyncPreview()}>
              {syncBusy && syncProgress?.phase === 'preview' ? '계산 중…' : '미리보기'}
            </button>
            <button type="button" class="rounded-lg bg-selected px-4 py-2 text-sm font-bold disabled:opacity-50" disabled={syncBusy || !syncPreview || !verifiedConnection} onclick={() => void runLocalToRemoteSync()}>
              서버 데이터 교체
            </button>
          </div>

          {#if syncPreview}
            <div class="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
              <div class="rounded-xl border border-textcolor/10 bg-bgcolor p-3">
                <div class="font-bold">이 기기 · 원본</div>
                <div class="mt-2 text-sm">리비전 {syncPreview.local.revision}</div>
                <div class="text-sm">SQL 레코드 {syncPreview.local.records.total.toLocaleString()}개</div>
                <div class="text-sm">자산 {syncPreview.local.assets.count.toLocaleString()}개 · {formatBytes(syncPreview.local.assets.sizeBytes)}</div>
              </div>
              <div class="hidden items-center text-textcolor2 sm:flex"><ArrowRight size={18} /></div>
              <div class="rounded-xl border border-textcolor/10 bg-bgcolor p-3">
                <div class="font-bold">셀프 호스트 · 교체 대상</div>
                <div class="mt-2 text-sm">리비전 {syncPreview.remote.revision}</div>
                <div class="text-sm">SQL 레코드 {syncPreview.remote.records.total.toLocaleString()}개</div>
                <div class="text-sm">자산 {syncPreview.remote.assets.count.toLocaleString()}개 · {formatBytes(syncPreview.remote.assets.sizeBytes)}</div>
              </div>
            </div>
          {/if}

          {#if syncProgress}
            <div class="rounded-xl border border-textcolor/10 bg-bgcolor p-3 text-sm">
              <div class="font-bold">{phaseLabel(syncProgress)}</div>
              {#if syncProgress.totalBytes && syncProgress.totalBytes > 0}
                <div class="mt-1 text-textcolor2">{formatBytes(syncProgress.transferredBytes ?? 0)} / {formatBytes(syncProgress.totalBytes)}</div>
              {/if}
              {#if syncProgress.currentKey}<div class="mt-1 break-all text-xs text-textcolor2">{syncProgress.currentKey}</div>{/if}
            </div>
          {/if}

          {#if syncMessage}
            <div class="rounded-xl border border-textcolor/10 bg-bgcolor p-3 text-sm">{syncMessage}</div>
          {/if}
        </div>
      {:else}
        <div class="flex items-center gap-3 p-4 text-sm text-textcolor2 sm:p-5">
          <FolderSync class="shrink-0" size={20} />
          <span class="min-w-0 flex-1">셀프 호스트 → 이 기기</span>
          <Help name="셀프 호스트에서 로컬로 동기화" text="원격 자산의 bounded Range reader는 준비되었지만, 로컬 SQLite staging/recovery 적용부는 아직 구현 중입니다. 완성 전에는 데이터를 변경하는 버튼을 표시하지 않습니다." />
        </div>
      {/if}
    </section>
  {/if}
</div>
