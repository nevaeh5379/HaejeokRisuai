<script lang="ts">
  import { isCapacitor, isTauri } from 'src/ts/platform';
  import { NodeStorage } from 'src/ts/storage/files/nodeStorage';
  import { createRemoteNodeApiClient } from 'src/ts/storage/runtime/nodeApiClient';
  import { storageProfileGate } from 'src/ts/storage/runtime/storageProfileGate';
  import {
    normalizeRemoteBaseUrl,
    saveStorageProfile,
    type StorageProfilePlatform,
  } from 'src/ts/storage/runtime/storageProfile';
  import AirisuMascot from '../UI/AirisuMascot.svelte';

  const initial = $storageProfileGate;
  let remoteUrl = $state(initial.status === 'failure' ? initial.profile.baseUrl : '');
  let allowInsecureHttp = $state(
    initial.status === 'failure' ? initial.profile.allowInsecureHttp : false,
  );
  let password = $state('');
  let showRemote = $state(initial.status === 'failure');
  let connecting = $state(false);
  let error = $state(initial.status === 'failure' ? initial.error : '');

  function platform(): StorageProfilePlatform {
    if (isTauri) return 'tauri';
    if (isCapacitor) return 'capacitor';
    return 'web';
  }

  function chooseLocal(requireConfirmation = false) {
    if (
      requireConfirmation &&
      !confirm('원격 저장소 대신 이 기기의 별도 로컬 데이터를 사용하시겠사와요?')
    ) {
      return;
    }
    saveStorageProfile({ version: 1, mode: 'local' });
    location.reload();
  }

  async function connectRemote() {
    connecting = true;
    error = '';
    try {
      const profile = {
        version: 1 as const,
        mode: 'remote' as const,
        baseUrl: normalizeRemoteBaseUrl(remoteUrl, {
          allowInsecureHttp,
          platform: platform(),
          pageProtocol: location.protocol,
        }),
        allowInsecureHttp,
      };
      const client = await createRemoteNodeApiClient(profile, platform());
      const storage = new NodeStorage(client);
      await storage.connectWithPassword(password);
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

<main class="w-full h-full overflow-auto bg-bgcolor text-textcolor p-5 flex items-center justify-center">
  <section class="w-full max-w-2xl rounded-2xl border border-borderc bg-darkbg p-5 md:p-7 shadow-xl">
    <div class="flex gap-4 items-center mb-5">
      <AirisuMascot variant={$storageProfileGate.status === 'failure' ? 'error' : 'welcome'} className="w-24 h-24 object-contain" eager />
      <div>
        <h1 class="text-xl font-bold">저장 위치를 선택하시와요</h1>
        <p class="text-sm text-textcolor2 mt-1">
          SQL 데이터와 이미지·음성·플러그인 자산은 언제나 같은 위치에 저장된답니다.
        </p>
      </div>
    </div>

    {#if $storageProfileGate.status === 'failure'}
      <div class="mb-4 rounded-xl border border-draculared/50 bg-draculared/10 p-3 text-sm">
        <p class="font-bold">원격 저장소에 연결하지 못했사와요.</p>
        <p class="mt-1 break-words">{error}</p>
      </div>
      <div class="flex flex-wrap gap-2 mb-5">
        <button class="px-4 py-2 rounded-lg bg-selected" onclick={() => location.reload()}>재시도</button>
        <button class="px-4 py-2 rounded-lg bg-darkbutton" onclick={() => { showRemote = true; error = ''; }}>주소/인증 수정</button>
        <button class="px-4 py-2 rounded-lg border border-draculared text-draculared" onclick={() => chooseLocal(true)}>로컬로 전환</button>
      </div>
    {/if}

    {#if $storageProfileGate.status === 'required' && !showRemote}
      <div class="grid md:grid-cols-2 gap-3">
        <button class="rounded-xl border border-borderc bg-darkbutton p-5 text-left hover:bg-selected" onclick={() => chooseLocal(false)}>
          <strong class="block text-lg">이 기기에 저장</strong>
          <span class="block text-sm text-textcolor2 mt-2">현재 기기에서만 사용하는 로컬 저장소를 시작하와요.</span>
        </button>
        <button class="rounded-xl border border-borderc bg-darkbutton p-5 text-left hover:bg-selected" onclick={() => showRemote = true}>
          <strong class="block text-lg">셀프 호스트 서버에 연결</strong>
          <span class="block text-sm text-textcolor2 mt-2">서버의 SQL과 자산 저장소를 이 기기에서 함께 사용하와요.</span>
        </button>
      </div>
    {:else if showRemote}
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
        <div class="flex justify-between gap-3">
          <button type="button" class="px-4 py-2 text-textcolor2" onclick={() => { showRemote = false; error = ''; }}>뒤로</button>
          <button type="submit" class="px-4 py-2 rounded-lg bg-selected font-bold disabled:opacity-50" disabled={connecting}>
            {connecting ? '연결 확인 중…' : '연결하고 사용'}
          </button>
        </div>
      </form>
    {/if}
  </section>
</main>
