<script lang="ts">
  import { isNodeServer } from 'src/ts/platform';
  import { getActiveStorageRuntime } from 'src/ts/storage/runtime/activeStorageRuntime';
  import { connectRemoteStorageProfile } from 'src/ts/storage/runtime/storageProfileConnection';
  import { saveStorageProfile, type StorageProfile } from 'src/ts/storage/runtime/storageProfile';

  const activeProfile = getActiveStorageRuntime().profile;
  let remoteUrl = $state(activeProfile.mode === 'remote' ? activeProfile.baseUrl : '');
  let allowInsecureHttp = $state(activeProfile.mode === 'remote' ? activeProfile.allowInsecureHttp : false);
  let password = $state('');
  let checking = $state(false);
  let connectionState = $state<'idle' | 'ok' | 'error'>('idle');
  let connectionMessage = $state('');
  let verifiedProfile = $state<Extract<StorageProfile, { mode: 'remote' }> | null>(null);

  function resetVerification() {
    connectionState = 'idle';
    connectionMessage = '';
    verifiedProfile = null;
  }

  async function verifyRemote(): Promise<Extract<StorageProfile, { mode: 'remote' }> | null> {
    checking = true;
    connectionState = 'idle';
    connectionMessage = '';
    try {
      const result = await connectRemoteStorageProfile({
        baseUrl: remoteUrl,
        allowInsecureHttp,
        password,        pageProtocol: location.protocol,
      });
      verifiedProfile = result.profile;
      connectionState = 'ok';
      connectionMessage = '서버 연결과 인증을 확인했사와요.';
      return result.profile;
    } catch (cause) {
      verifiedProfile = null;
      connectionState = 'error';
      connectionMessage = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      checking = false;
      password = '';
    }
  }

  async function applyRemote() {
    const profile = verifiedProfile ?? (await verifyRemote());
    if (!profile) return;
    saveStorageProfile(profile);
    location.reload();
  }

  function switchLocal() {
    if (activeProfile.mode === 'local') return;
    if (!confirm('셀프 호스트 데이터는 그대로 보존하고 이 기기의 별도 로컬 저장소로 전환하시겠사와요?')) return;
    saveStorageProfile({ version: 1, mode: 'local' });
    location.reload();
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
    <section class="rounded-2xl border border-darkborderc bg-darkbg p-5 flex flex-col gap-4">      <div>
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
        <span class="block text-xs text-textcolor2 mt-1">비밀번호는 저장하지 않고 이 서버용 P-256 키 등록에만 사용하와요.</span>
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
        <button class="px-4 py-2 rounded-lg bg-darkbutton border border-darkborderc disabled:opacity-50" disabled={checking || !remoteUrl.trim()} onclick={() => void verifyRemote()}>
          {checking ? '확인 중…' : '연결 확인'}
        </button>        <button class="px-4 py-2 rounded-lg bg-selected font-bold disabled:opacity-50" disabled={checking || !remoteUrl.trim()} onclick={() => void applyRemote()}>
          이 서버로 전환
        </button>
        <button class="px-4 py-2 rounded-lg border border-darkborderc disabled:opacity-50" disabled={activeProfile.mode === 'local'} onclick={switchLocal}>
          이 기기 저장소로 전환
        </button>
      </div>
    </section>
  {/if}
</div>
