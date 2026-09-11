<script lang="ts">
  import { storageProfileGate } from 'src/ts/storage/runtime/storageProfileGate';
  import { saveStorageProfile } from 'src/ts/storage/runtime/storageProfile';
  import { connectRemoteStorageProfile } from 'src/ts/storage/runtime/storageProfileConnection';
  import { isTauriMacOS } from 'src/ts/platform';
  import AirisuMascot from '../UI/AirisuMascot.svelte';

  const initial = $storageProfileGate;
  let remoteUrl = $state(initial.status === 'failure' ? initial.profile.baseUrl : '');
  let allowInsecureHttp = $state(
    initial.status === 'failure' ? initial.profile.allowInsecureHttp : false,
  );
  let password = $state('');
  let connecting = $state(false);
  let error = $state(initial.status === 'failure' ? initial.error : '');

  function chooseLocal() {
    saveStorageProfile({ version: 1, mode: 'local' });
    location.reload();
  }

  async function connectRemote() {
    connecting = true;
    error = '';
    try {
      const { profile } = await connectRemoteStorageProfile({
        baseUrl: remoteUrl,
        allowInsecureHttp,
        password,
        pageProtocol: location.protocol,
      });
      saveStorageProfile(profile);
      location.reload();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      connecting = false;
      password = '';
    }
  }
</script>

<main class="relative w-full h-full overflow-auto bg-bgcolor text-textcolor p-5 flex items-center justify-center">
  {#if isTauriMacOS}
    <div
      class="absolute top-0 left-0 right-1 h-10 z-[1]"
      data-tauri-drag-region="true"
      aria-hidden="true"
    ></div>
  {/if}
  <section class="w-full max-w-2xl rounded-2xl border border-borderc bg-darkbg p-5 md:p-7 shadow-xl">
    <div class="flex gap-4 items-center mb-5">
      <AirisuMascot variant="error" className="w-24 h-24 object-contain" eager />
      <div>
        <h1 class="text-xl font-bold">원격 저장소에 연결하지 못했사와요</h1>
        <p class="text-sm text-textcolor2 mt-1 break-words">{error}</p>
      </div>
    </div>

    <div class="flex flex-wrap gap-2 mb-5">
      <button class="px-4 py-2 rounded-lg bg-selected" onclick={() => location.reload()}>재시도</button>
      <button class="px-4 py-2 rounded-lg bg-darkbutton" onclick={() => { error = ''; }}>주소/인증 수정</button>
      <button class="px-4 py-2 rounded-lg border border-draculared text-draculared" onclick={() => chooseLocal()}>로컬로 전환</button>
    </div>

    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void connectRemote(); }}>
      <label class="block">
        <span class="text-sm font-bold">서버 주소</span>
        <input class="mt-1 w-full rounded-lg border border-borderc bg-bgcolor px-3 py-2" bind:value={remoteUrl} placeholder="https://risu.example.com" autocomplete="url" />
      </label>
      <label class="block">
        <span class="text-sm font-bold">서버 비밀번호</span>
        <input class="mt-1 w-full rounded-lg border border-borderc bg-bgcolor px-3 py-2" type="password" bind:value={password} autocomplete="current-password" />
        <span class="block text-xs text-textcolor2 mt-1">비밀번호는 저장하지 않고 공개키 등록에만 사용하와요.</span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="checkbox" bind:checked={allowInsecureHttp} />
        <span>안전하지 않은 HTTP 허용 — 네트워크에서 내용과 인증이 노출될 수 있사와요.</span>
      </label>
      {#if error}
        <p class="rounded-lg bg-draculared/10 border border-draculared/40 p-3 text-sm text-draculared">{error}</p>
      {/if}
      <button type="submit" class="w-full px-4 py-2 rounded-lg bg-selected font-bold disabled:opacity-50" disabled={connecting}>
        {connecting ? '연결 확인 중…' : '연결하고 사용'}
      </button>
    </form>
  </section>
</main>