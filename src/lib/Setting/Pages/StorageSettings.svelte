<script lang="ts">
  import { isNodeServer } from 'src/ts/platform';
  import { getActiveStorageRuntime } from 'src/ts/storage/runtime/activeStorageRuntime';
  import { summarizeStorageSyncAssets, type StorageSyncAssetSummary } from 'src/ts/storage/runtime/storageSyncAssetReader';
  import { syncLocalStorageToRemote, type StorageSyncStageProgress } from 'src/ts/storage/runtime/storageSyncCoordinator';
  import { connectRemoteStorageProfile } from 'src/ts/storage/runtime/storageProfileConnection';
  import { saveStorageProfile } from 'src/ts/storage/runtime/storageProfile';

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
      connectionMessage = '서버 연결과 인증을 확인했사와요.';
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
      syncMessage = '읽기 전용 미리보기를 갱신했사와요. 아직 어느 쪽 데이터도 변경하지 않았답니다.';
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
      `셀프 호스트 서버의 현재 데이터(리비전 ${syncPreview.remote.revision})를 이 기기의 로컬 데이터(리비전 ${syncPreview.local.revision})로 완전히 교체하시겠사와요?\n\n서버의 기존 데이터는 recovery snapshot으로 보존되며, 이 기기의 로컬 데이터는 변경하지 않사와요.`,
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
        ? '이미 완료된 동기화 결과를 서버에서 복구했사와요. 데이터 재적용은 하지 않았답니다.'
        : `동기화가 완료됐사와요. 서버 리비전은 ${result.finalized.revision}(으)로 갱신됐답니다.`;
    } catch (cause) {
      syncMessage = cause instanceof Error ? cause.message : String(cause);
    } finally {
      syncBusy = false;
      syncProgress = null;
    }
  }

  function switchLocal() {
    if (activeProfile.mode === 'local') return;
    if (!confirm('셀프 호스트 데이터는 그대로 보존하고 이 기기의 별도 로컬 저장소로 전환하시겠사와요?')) return;
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
<div class="flex flex-col gap-5 max-w-3xl">
  <div>
    <h2 class="text-2xl font-bold">저장소</h2>
    <p class="text-sm text-textcolor2 mt-1">SQL 데이터와 이미지·음성·플러그인 자산은 항상 같은 저장 위치를 사용한답니다.</p>
  </div>

  <section class="rounded-2xl border border-darkborderc bg-darkbg p-5 flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="text-xs text-textcolor2">현재 모드</div>
        <div class="font-bold text-lg">{activeProfile.mode === 'remote' ? '셀프 호스트 서버' : '이 기기'}</div>
      </div>
      <span class="rounded-full px-3 py-1 text-sm bg-selected">{activeProfile.mode === 'remote' ? '연결됨' : '로컬 사용 중'}</span>
    </div>
    {#if activeProfile.mode === 'remote'}
      <div class="rounded-xl bg-bgcolor border border-darkborderc px-3 py-2 break-all text-sm">{activeProfile.baseUrl}</div>
    {/if}
    <p class="text-xs text-textcolor2">저장 위치를 바꿔도 반대편 데이터는 삭제하지 않사와요. 전환은 전체 재로드 후 적용된답니다.</p>
  </section>

  {#if isNodeServer}
    <section class="rounded-2xl border border-darkborderc bg-darkbg p-5">
      <h3 class="font-bold">Node 서버 저장소가 강제되어 있사와요</h3>
      <p class="text-sm text-textcolor2 mt-2">Node 서버가 제공하는 웹앱은 같은 출처의 서버 SQL·자산 저장소만 사용하며 클라이언트에서 로컬 모드로 바꿀 수 없답니다.</p>
    </section>
  {:else}
    <section class="rounded-2xl border border-darkborderc bg-darkbg p-5 flex flex-col gap-4">
      <div>
        <h3 class="font-bold text-lg">셀프 호스트 서버 연결</h3>
        <p class="text-sm text-textcolor2 mt-1">새 서버는 연결 검사와 인증이 성공한 뒤에만 활성 프로필로 저장하와요.</p>
      </div>

      <label class="block">
        <span class="text-sm font-bold">서버 주소</span>
        <input class="mt-1 w-full rounded-lg border border-darkborderc bg-bgcolor px-3 py-2" bind:value={remoteUrl} oninput={resetVerification} placeholder="https://risu.example.com" autocomplete="url" />
      </label>
      <label class="block">
        <span class="text-sm font-bold">서버 비밀번호</span>
        <input class="mt-1 w-full rounded-lg border border-darkborderc bg-bgcolor px-3 py-2" type="password" bind:value={password} oninput={resetVerification} autocomplete="current-password" />
        <span class="block text-xs text-textcolor2 mt-1">빈 비밀번호도 그대로 인증하며, 값은 저장하지 않고 이 서버용 P-256 키 등록에만 사용하와요.</span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="checkbox" bind:checked={allowInsecureHttp} onchange={resetVerification} />
        <span>안전하지 않은 HTTP 허용</span>
      </label>

      {#if connectionState !== 'idle'}
        <div class="rounded-xl border p-3 text-sm {connectionState === 'ok' ? 'border-green-500/40 bg-green-500/10' : 'border-draculared/40 bg-draculared/10 text-draculared'}">
          {connectionMessage}
        </div>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button class="px-4 py-2 rounded-lg bg-darkbutton border border-darkborderc disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void verifyRemote()}>
          {checking ? '확인 중…' : '연결 확인'}
        </button>
        <button class="px-4 py-2 rounded-lg bg-selected font-bold disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void applyRemote()}>
          이 서버로 전환
        </button>
        <button class="px-4 py-2 rounded-lg border border-darkborderc disabled:opacity-50" disabled={activeProfile.mode === 'local' || syncBusy} onclick={switchLocal}>
          이 기기 저장소로 전환
        </button>
      </div>
    </section>

    {#if activeProfile.mode === 'local'}
      <section class="rounded-2xl border border-darkborderc bg-darkbg p-5 flex flex-col gap-4">
        <div>
          <h3 class="font-bold text-lg">로컬 → 셀프 호스트 동기화</h3>
          <p class="text-sm text-textcolor2 mt-1">프로필을 전환하지 않고 이 기기의 현재 SQL·자산을 서버에 복사한답니다. 실행 전 미리보기는 데이터를 변경하지 않사와요.</p>
        </div>

        <div class="flex flex-wrap gap-2">
          <button class="px-4 py-2 rounded-lg bg-darkbutton border border-darkborderc disabled:opacity-50" disabled={checking || syncBusy || !remoteUrl.trim()} onclick={() => void loadSyncPreview()}>
            {syncBusy && syncProgress?.phase === 'preview' ? '미리보기 계산 중…' : '동기화 미리보기'}
          </button>
          <button class="px-4 py-2 rounded-lg bg-selected font-bold disabled:opacity-50" disabled={syncBusy || !syncPreview || !verifiedConnection} onclick={() => void runLocalToRemoteSync()}>
            서버 데이터 교체 실행
          </button>
        </div>

        {#if syncPreview}
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-darkborderc bg-bgcolor p-3">
              <div class="font-bold">이 기기 · 원본</div>
              <div class="text-sm mt-2">리비전 {syncPreview.local.revision}</div>
              <div class="text-sm">SQL 레코드 {syncPreview.local.records.total.toLocaleString()}개</div>
              <div class="text-sm">자산 {syncPreview.local.assets.count.toLocaleString()}개 · {formatBytes(syncPreview.local.assets.sizeBytes)}</div>
            </div>
            <div class="rounded-xl border border-darkborderc bg-bgcolor p-3">
              <div class="font-bold">셀프 호스트 · 교체 대상</div>
              <div class="text-sm mt-2">리비전 {syncPreview.remote.revision}</div>
              <div class="text-sm">SQL 레코드 {syncPreview.remote.records.total.toLocaleString()}개</div>
              <div class="text-sm">자산 {syncPreview.remote.assets.count.toLocaleString()}개 · {formatBytes(syncPreview.remote.assets.sizeBytes)}</div>
            </div>
          </div>
          <p class="text-xs text-textcolor2">실행 시 서버의 기존 DB와 덮어쓰는 자산은 recovery snapshot으로 보존하와요. 동기화 도중 어느 쪽 revision이나 asset이 바뀌면 적용 전에 중단한답니다.</p>
        {/if}

        {#if syncProgress}
          <div class="rounded-xl border border-darkborderc bg-bgcolor p-3 text-sm">
            <div class="font-bold">{phaseLabel(syncProgress)}</div>
            {#if syncProgress.totalBytes && syncProgress.totalBytes > 0}
              <div class="text-textcolor2 mt-1">{formatBytes(syncProgress.transferredBytes ?? 0)} / {formatBytes(syncProgress.totalBytes)}</div>
            {/if}
            {#if syncProgress.currentKey}<div class="text-xs text-textcolor2 mt-1 break-all">{syncProgress.currentKey}</div>{/if}
          </div>
        {/if}

        {#if syncMessage}
          <div class="rounded-xl border border-darkborderc bg-bgcolor p-3 text-sm">{syncMessage}</div>
        {/if}
      </section>
    {:else}
      <section class="rounded-2xl border border-darkborderc bg-darkbg p-5">
        <h3 class="font-bold">셀프 호스트 → 로컬 동기화</h3>
        <p class="text-sm text-textcolor2 mt-2">원격 자산의 bounded Range reader까지 준비됐고, 로컬 SQLite staging/recovery 적용부를 구현 중이랍니다. 완성 전에는 destructive 버튼을 노출하지 않사와요.</p>
      </section>
    {/if}
  {/if}
</div>
