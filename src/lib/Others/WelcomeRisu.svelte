<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import {
    Database,
    ArrowRight,
    ArrowLeft,
    CheckCircle2,
    AlertCircle,
    Globe,
    User,
    Key,
    RefreshCw,
    Bot,
    Zap,
    ChevronRight,
    FileUp,
    FolderCheck,
    ExternalLink,
    Server,
    Cpu,
    Hash
  } from '@lucide/svelte';

  import { changeLanguage, language } from 'src/lang';
  import { setPreset, setDatabaseLite } from 'src/ts/storage/database.svelte';
  import { settingsStore } from 'src/ts/stores/domain';
  import { prebuiltPresets } from 'src/ts/process/templates/templates';
  import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
  import { getSqlRuntime } from 'src/ts/storage/sqlRuntime';
  import { getSqlStorage } from 'src/ts/storage/sqlStorageFactory';
  import {
    detectLocalLegacyDatabase,
    migrateLegacyDatabase,
    type LegacyDatabaseInfo
  } from 'src/ts/storage/migration';
  import { LoadLocalBackup, restoreLocalBackupFile } from 'src/ts/drive/backuplocal';
  import { MobileGUI } from 'src/ts/stores.svelte';
  import AirisuMascot from '../UI/AirisuMascot.svelte';
  import WelcomeRisuMobile from './WelcomeRisuMobile.svelte';

  let innerWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1200);
  let isMobile = $derived(innerWidth < 768 || $MobileGUI);

  type Stage = 'gateway' | 'migration' | 'quick-setup' | 'done';

  let currentStage = $state<Stage>('gateway');
  let quickStep = $state<number>(1); // 1: Username, 2: Provider, 3: Key, Model & Context, 4: Done

  // Reactive Language Tracking
  let langCodeState = $state(settingsStore.state.language || 'ko');
  let langTick = $state(0);

  // Derived reactive language accessor
  let l = $derived.by(() => {
    langTick; // Track reactivity tick
    return language;
  });

  // Form State
  let username = $state(settingsStore.state.username || 'User');
  let selectedProvider = $state('claude');
  let modelName = $state('claude-3-7-sonnet-20250219');
  let customURL = $state('');
  let apiKey = $state('');
  let maxContext = $state<number>(settingsStore.state.maxContext || 16000);
  let maxResponse = $state<number>(settingsStore.state.maxResponse || 1000);
  let chatLang = $state(0); // 0: English, 1: Auto translate, 2: Direct

  // Common context preset tokens for quick chips
  const contextPresets = [
    { label: '8k', value: 8192 },
    { label: '16k', value: 16384 },
    { label: '32k', value: 32768 },
    { label: '64k', value: 65536 },
    { label: '128k', value: 128000 },
    { label: '200k', value: 200000 },
  ];

  // Migration State
  let detectedLocalDb = $state<LegacyDatabaseInfo | null>(null);
  let isDragging = $state(false);
  let isMigrating = $state(false);
  let migrationProgress = $state('');
  let migrationDone = $state(false);
  let migrationError = $state<string | null>(null);

  // Available Languages
  const languages = [
    { code: 'ko', label: '한국어', flag: '🇰🇷' },
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'zh-Hant', label: '繁體中文', flag: '🇹🇼' },
    { code: 'cn', label: '简体中文', flag: '🇨🇳' },
    { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
    { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
    { code: 'es', label: 'Español', flag: '🇪🇸' },
  ];

  // AI Providers list
  const providers = [
    {
      id: 'claude',
      name: 'Anthropic Claude',
      sub: 'Claude 3.7 Sonnet, 3.5 Sonnet',
      defaultModel: 'claude-3-7-sonnet-20250219',
      models: [
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ],
      keyLink: 'https://console.anthropic.com/settings/keys',
      keyPlaceholder: 'sk-ant-api03-...',
    },
    {
      id: 'openai',
      name: 'OpenAI (ChatGPT)',
      sub: 'GPT-4o, o3-mini, o1',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1'],
      keyLink: 'https://platform.openai.com/api-keys',
      keyPlaceholder: 'sk-proj-...',
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      sub: 'Gemini 2.5 Flash, 2.5 Pro',
      defaultModel: 'gemini-2.5-flash',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
      keyLink: 'https://aistudio.google.com/app/apikey',
      keyPlaceholder: 'AIzaSy...',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      sub: 'Multi-Model Hub',
      defaultModel: 'anthropic/claude-3.7-sonnet',
      models: [
        'anthropic/claude-3.7-sonnet',
        'deepseek/deepseek-r1',
        'meta-llama/llama-3.3-70b-instruct',
        'google/gemini-2.5-flash',
      ],
      keyLink: 'https://openrouter.ai/keys',
      keyPlaceholder: 'sk-or-v1-...',
    },
    {
      id: 'reverse_proxy',
      name: '커스텀 / 리버스 프록시',
      sub: 'OpenAI 호환 엔드포인트 / 프록시',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'claude-3-7-sonnet', 'deepseek-chat'],
      keyLink: '',
      keyPlaceholder: 'API 키 또는 프록시 비밀번호 (선택)',
    },
    {
      id: 'ollama',
      name: 'Ollama / 로컬 LLM',
      sub: '오프라인 로컬 서버',
      defaultModel: 'llama3.3',
      models: ['llama3.3', 'qwen2.5:32b', 'mistral', 'deepseek-r1:14b'],
      keyLink: '',
      keyPlaceholder: '',
    },
    {
      id: 'horde',
      name: 'AI Horde',
      sub: '무료 분산형 커뮤니티',
      defaultModel: 'horde:::auto',
      models: ['horde:::auto'],
      keyLink: 'https://aihorde.net/register',
      keyPlaceholder: '0000000000 또는 Horde API Key',
    },
    {
      id: 'self',
      name: '나중에 설정하기',
      sub: '설정 화면에서 직접 구성',
      defaultModel: '',
      models: [],
      keyLink: '',
      keyPlaceholder: '',
    },
  ];

  function selectProvider(provId: string) {
    selectedProvider = provId;
    const found = providers.find((p) => p.id === provId);
    if (found && found.defaultModel) {
      modelName = found.defaultModel;
    }
  }

  // Dynamic Iris Companion Speech Bubble text
  let irisDialogue = $derived.by(() => {
    langTick; // Reactivity dependency
    if (migrationDone) {
      return l.setup?.migrationSuccessDesc || '성공적으로 이전되었어요! 이제 즐겨보세요~ 🎉';
    }
    if (isMigrating) {
      return migrationProgress || (l.setup?.migrationInProgress || '열심히 데이터를 변환하고 있어요...');
    }
    if (migrationError) {
      return l.setup?.migrationFailedDesc || '앗, 파일을 읽는 도중 오류가 발생했어요...';
    }
    if (currentStage === 'migration') {
      if (detectedLocalDb) {
        return l.setup?.detectedLegacyDbDesc || '기존 database.bin을 찾았어요! 바로 마이그레이션할까요?';
      }
      return l.setup?.irisMigrationDrop || '백업 파일(.bin, .risubackup)을 올려주시면 캐릭터와 대화를 고성능 SQL로 척척 복원해드릴게요!';
    }
    if (currentStage === 'quick-setup') {
      if (quickStep === 1) return l.setup?.irisStep1 || '대화할 때 불릴 멋진 닉네임을 알려주세요!';
      if (quickStep === 2) return l.setup?.irisStep2 || '사용하실 AI 모델 또는 커스텀 설정을 골라주세요!';
      if (quickStep === 3) return l.setup?.irisStep3 || 'API 키와 컨텍스트 용량을 직접 설정해주세요.';
      if (quickStep === 4) return l.setup?.irisStep4 || '모든 준비가 완료되었습니다. 이제 Haejeok RisuAI를 시작합니다.';
    }
    if (detectedLocalDb) {
      return l.setup?.irisGatewayDetected || '이전 데이터(database.bin)를 발견했습니다. 바로 복원하시겠습니까?';
    }
    return l.setup?.irisGatewayDefault || '원하시는 시작 방식을 선택해 주세요.';
  });

  async function handleLanguageSelect(langCode: string) {
    settingsStore.state.language = langCode;
    langCodeState = langCode;
    await changeLanguage(langCode);
    langTick++;
  }

  // Check for existing database.bin on mount
  onMount(() => {
    const browserLang = navigator.language.split('-')[0];
    const usableLangs = ['de', 'en', 'ko', 'cn', 'vi', 'zh-Hant', 'es'];
    const targetLang = settingsStore.state.language || (usableLangs.includes(browserLang) ? browserLang : 'ko');
    settingsStore.state.language = targetLang;
    langCodeState = targetLang;
    void changeLanguage(targetLang).then(() => {
      langTick++;
    });

    void detectLocalLegacyDatabase().then((info) => {
      if (info && info.stats.characterCount > 0) {
        detectedLocalDb = info;
      }
    }).catch(() => {});
  });

  // Handle drag and drop or manual file selection
  async function processSelectedFile(file: File) {
    if (!file) return;
    migrationError = null;
    try {
      await restoreLocalBackupFile(file);
    } catch (err: any) {
      console.error('File restore error:', err);
      migrationError = err?.message || (l.setup?.migrationFailedDesc || '파일을 읽는 중 오류가 발생했습니다.');
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void processSelectedFile(e.dataTransfer.files[0]);
    }
  }

  // Execute database migration for detected local database
  async function performMigration(info: LegacyDatabaseInfo) {
    isMigrating = true;
    migrationError = null;
    migrationProgress = l.setup?.migrationInProgress || '데이터를 SQL 저장소로 변환하는 중...';

    try {
      const storage = getSqlRuntime().storage ?? (await getSqlStorage());
      const isLocal = info.source === 'local_file' || info.source === 'opfs';
      const success = await migrateLegacyDatabase(
        storage,
        info.db,
        (status) => {
          migrationProgress = status;
        },
        isLocal
      );

      if (success) {
        const reloaded = await storage.loadDatabase({ shallow: true });
        if (reloaded && reloaded.database) {
          setDatabaseLite(reloaded.database, storage);
        }
        migrationDone = true;
        isMigrating = false;
      } else {
        isMigrating = false;
        migrationError = l.setup?.migrationFailedDesc || '마이그레이션에 실패했습니다.';
      }
    } catch (err: any) {
      console.error('Migration error:', err);
      isMigrating = false;
      migrationError = err?.message || '마이그레이션 중 오류가 발생했습니다.';
    }
  }

  // Complete onboarding & enter app
  async function finishAndEnterApp() {
    setPreset(settingsStore.state as any, prebuiltPresets.OAI2);
    settingsStore.state.textTheme = 'highcontrast';
    updateTextThemeAndCSS();

    const trimmedUsername = username.trim();
    const trimmedModel = modelName.trim();
    const trimmedUrl = customURL.trim();
    const trimmedApiKey = apiKey.trim();
    const contextTokens = Number(maxContext);
    const responseTokens = Number(maxResponse);

    if (trimmedUsername) {
      settingsStore.state.username = trimmedUsername;
    }

    // Match the limits enforced by the numeric inputs even when values are set programmatically.
    settingsStore.state.maxContext = Number.isFinite(contextTokens)
      ? Math.min(2_000_000, Math.max(1_000, contextTokens))
      : 16_000;
    settingsStore.state.maxResponse = Number.isFinite(responseTokens)
      ? Math.min(8_192, Math.max(100, responseTokens))
      : 1_000;

    // Provider & model setup. aiModel stores Risu's registry ID, not always the API model slug.
    if (selectedProvider === 'claude') {
      const targetModel = trimmedModel || 'claude-3-7-sonnet-20250219';
      settingsStore.state.aiModel = targetModel;
      settingsStore.state.subModel = targetModel;
      if (trimmedApiKey) settingsStore.state.claudeAPIKey = trimmedApiKey;
      settingsStore.state.claudeCachingExperimental = true;
    } else if (selectedProvider === 'openai') {
      const apiModel = trimmedModel || 'gpt-4o';
      const targetModel = apiModel === 'gpt-4o' ? 'gpt4o' : apiModel === 'gpt-4o-mini' ? 'gpt4om' : apiModel;
      settingsStore.state.aiModel = targetModel;
      settingsStore.state.subModel = targetModel;
      if (trimmedApiKey) settingsStore.state.openAIKey = trimmedApiKey;
    } else if (selectedProvider === 'gemini') {
      const targetModel = trimmedModel || 'gemini-2.5-flash';
      settingsStore.state.aiModel = targetModel;
      settingsStore.state.subModel = targetModel;
      if (trimmedApiKey) settingsStore.state.google.accessToken = trimmedApiKey;
    } else if (selectedProvider === 'openrouter') {
      settingsStore.state.aiModel = 'openrouter';
      settingsStore.state.subModel = 'openrouter';
      settingsStore.state.openrouterRequestModel = trimmedModel || 'anthropic/claude-3.7-sonnet';
      if (trimmedApiKey) settingsStore.state.openrouterKey = trimmedApiKey;
    } else if (selectedProvider === 'reverse_proxy') {
      settingsStore.state.aiModel = 'reverse_proxy';
      settingsStore.state.subModel = 'reverse_proxy';
      if (trimmedUrl) settingsStore.state.forceReplaceUrl = trimmedUrl;
      if (trimmedModel) settingsStore.state.customProxyRequestModel = trimmedModel;
      if (trimmedApiKey) settingsStore.state.proxyKey = trimmedApiKey;
    } else if (selectedProvider === 'ollama') {
      settingsStore.state.aiModel = 'ollama-hosted';
      settingsStore.state.subModel = 'ollama-hosted';
      if (trimmedModel) settingsStore.state.ollamaModel = trimmedModel;
      if (trimmedUrl) settingsStore.state.ollamaURL = trimmedUrl;
      settingsStore.state.ollamaModelSource = 'local';
    } else if (selectedProvider === 'horde') {
      settingsStore.state.aiModel = 'horde:::auto';
      settingsStore.state.subModel = 'horde:::auto';
      if (trimmedApiKey) settingsStore.state.hordeConfig.apiKey = trimmedApiKey;
    }

    // Translation setup
    if (chatLang !== 0) {
      const curLang = settingsStore.state.language;
      settingsStore.state.translator = curLang === 'zh-Hant' ? 'zh-TW' : (curLang === 'cn' ? 'zh' : curLang);
    }
    if (chatLang === 1) {
      settingsStore.state.autoTranslate = true;
      settingsStore.state.translatorType = 'google';
      settingsStore.state.useAutoTranslateInput = true;
    }

    await settingsStore.set('didFirstSetup', true);
  }
</script>

<svelte:window bind:innerWidth />

{#if isMobile}
  <WelcomeRisuMobile />
{:else}
<div class="relative w-full h-full min-h-screen bg-bgcolor text-textcolor flex flex-col items-center justify-center p-3 md:p-6 overflow-y-auto selection:bg-blue-600 selection:text-white">
  <!-- Header: Brand & Language Bar -->
  <header class="w-full max-w-4xl flex items-center justify-between py-2 px-1 mb-3 z-10">
    <div class="flex items-center gap-2">
      <img src="/logo_192.png" alt="Haejeok RisuAI" class="w-6 h-6 object-contain" />
      <span class="font-bold text-base md:text-lg tracking-tight text-textcolor">Haejeok RisuAI</span>
    </div>

    <!-- Language Selector Pills -->
    <div class="flex items-center gap-1 bg-darkbg border border-borderc/40 px-2 py-1 rounded-full text-xs shadow-sm overflow-x-auto max-w-[70vw]">
      <Globe class="w-3.5 h-3.5 text-textcolor2 shrink-0 mr-0.5" />
      {#each languages as item}
        <button
          onclick={() => handleLanguageSelect(item.code)}
          class="px-2 py-0.5 rounded-full transition-colors flex items-center gap-1 font-medium whitespace-nowrap {langCodeState === item.code ? 'bg-selected text-white' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
        >
          <span>{item.flag}</span>
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  </header>

  <!-- Main Container -->
  <main class="w-full max-w-4xl bg-darkbg border border-borderc/40 rounded-2xl p-5 md:p-7 shadow-xl flex flex-col md:flex-row gap-6 relative z-10">

    <!-- Left Column: Iris Mascot & Dialogue Companion -->
    <aside class="flex flex-col items-center md:items-start md:w-64 shrink-0 gap-3.5">
      <!-- Iris Sprite Avatar -->
      <div class="relative w-36 h-36 md:w-48 md:h-48 rounded-2xl overflow-hidden border border-borderc/30 bg-textcolor/5 shadow flex items-end justify-center p-1">
        <AirisuMascot
          variant="welcome"
          alt="Airisu welcoming you to Haejeok RisuAI"
          className="w-full h-full"
          eager
        />
        <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-textcolor font-semibold border border-borderc/30 flex items-center gap-1">
          Airisu
        </span>
      </div>

      <!-- Mascot Speech Bubble -->
      <div class="w-full bg-bgcolor border border-borderc/30 rounded-xl p-3.5 shadow-sm text-xs leading-relaxed text-textcolor">
        <div class="flex items-center gap-1 font-bold text-textcolor mb-1">
          <span>{l.setup?.irisName || '아이리스 (Iris)'}</span>
        </div>
        <p class="text-textcolor/90">
          {irisDialogue}
        </p>
      </div>
    </aside>

    <!-- Right Column: Interactive Step Stages -->
    <section class="flex-1 flex flex-col justify-between min-h-[360px]">

      <!-- ================= STAGE 1: GATEWAY ================= -->
      {#if currentStage === 'gateway'}
        <div class="flex flex-col gap-4" in:fade={{ duration: 150 }}>
          <div>
            <h1 class="text-xl md:text-2xl font-bold tracking-tight text-textcolor flex items-center gap-2">
              <span>{l.setup?.welcomeTitle || 'Haejeok RisuAI에 오신 것을 환영합니다.'}</span>
            </h1>
            <p class="text-textcolor2 text-xs md:text-sm mt-0.5">
              {l.setup?.welcomeSubGreeting || '원하시는 시작 방법을 선택해주세요.'}
            </p>
          </div>

          <!-- Highlight Banner: Detected Local database.bin -->
          {#if detectedLocalDb}
            <div
              in:fly={{ y: 10, duration: 200 }}
              class="rounded-xl border border-blue-500/50 bg-blue-500/10 p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
            >
              <div class="flex items-start gap-3">
                <div class="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                  <Database class="w-4 h-4" />
                </div>
                <div>
                  <h3 class="font-bold text-sm text-textcolor">
                    {l.setup?.detectedLegacyDbTitle || '기존 저장 데이터(database.bin) 발견!'}
                  </h3>
                  <p class="text-xs text-textcolor2 mt-0.5">
                    {l.setup?.migrationCharacters || '캐릭터'} {detectedLocalDb.stats.characterCount} · {l.setup?.migrationChats || '대화'} {detectedLocalDb.stats.chatCount} · {l.setup?.migrationPresets || '프리셋'} {detectedLocalDb.stats.presetCount}
                  </p>
                </div>
              </div>

              <button
                onclick={() => {
                  if (detectedLocalDb) void performMigration(detectedLocalDb);
                }}
                class="w-full sm:w-auto px-3.5 py-1.5 rounded-lg bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-semibold text-xs transition-colors flex items-center justify-center gap-1.5 shrink-0"
              >
                <span>{l.setup?.migrateDetectedBtn || '바로 마이그레이션'}</span>
                <Zap class="w-3 h-3 text-textcolor2" />
              </button>
            </div>
          {/if}

          <!-- 2 Main Choice Cards -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
            <!-- Option 1: Data Migration / Restore -->
            <button
              onclick={() => {
                currentStage = 'migration';
              }}
              class="text-left p-4 rounded-xl border border-borderc/40 bg-darkbutton/30 hover:bg-darkbutton/70 hover:border-borderc transition-all flex flex-col justify-between"
            >
              <div class="flex items-start justify-between w-full mb-2.5">
                <div class="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Database class="w-4 h-4" />
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded bg-darkbg text-textcolor2 border border-borderc/30 font-medium">
                  {detectedLocalDb ? (l.setup?.badgeDetected || '발견됨') : (l.setup?.badgeBackupFile || '백업 파일')}
                </span>
              </div>
              <div>
                <h2 class="font-bold text-sm md:text-base text-textcolor break-keep">
                  {l.setup?.gatewayMigrationTitle || '데이터 가져오기'}
                </h2>
                <p class="text-xs text-textcolor2 mt-1 leading-normal break-keep">
                  {l.setup?.gatewayMigrationDesc || 'database.bin 또는 .risum 백업 파일에서 캐릭터와 대화를 복원합니다.'}
                </p>
              </div>
              <div class="flex items-center text-xs text-blue-400 font-semibold mt-3 gap-1">
                <span>{l.setup?.actionRestore || '불러오기'}</span>
                <ChevronRight class="w-3.5 h-3.5" />
              </div>
            </button>

            <!-- Option 2: Quick AI Setup -->
            <button
              onclick={() => {
                currentStage = 'quick-setup';
                quickStep = 1;
              }}
              class="text-left p-4 rounded-xl border border-borderc/40 bg-darkbutton/30 hover:bg-darkbutton/70 hover:border-borderc transition-all flex flex-col justify-between"
            >
              <div class="flex items-start justify-between w-full mb-2.5">
                <div class="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <Bot class="w-4 h-4" />
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 font-medium whitespace-nowrap shrink-0">
                  {l.setup?.badgeNewRecommended || '추천'}
                </span>
              </div>
              <div>
                <h2 class="font-bold text-sm md:text-base text-textcolor break-keep">
                  {l.setup?.gatewayQuickSetupTitle || 'AI 빠른 설정'}
                </h2>
                <p class="text-xs text-textcolor2 mt-1 leading-normal break-keep">
                  {l.setup?.gatewayQuickSetupDesc || '닉네임과 AI 모델을 빠르게 설정합니다.'}
                </p>
              </div>
              <div class="flex items-center text-xs text-emerald-400 font-semibold mt-3 gap-1">
                <span>{l.setup?.actionStart || '시작하기'}</span>
                <ChevronRight class="w-3.5 h-3.5" />
              </div>
            </button>
          </div>

          <!-- Option 3: Skip / Explore directly -->
          <div class="flex justify-end mt-1">
            <button
              onclick={finishAndEnterApp}
              class="text-xs text-textcolor2 hover:text-textcolor px-2.5 py-1 rounded hover:bg-darkbutton transition-colors flex items-center gap-1"
            >
              <span>{l.setup?.gatewaySkipTitle || '직접 설정할래요 (건너뛰기)'}</span>
              <ArrowRight class="w-3 h-3" />
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= STAGE 2: MIGRATION ================= -->
      {#if currentStage === 'migration'}
        <div class="flex flex-col gap-3.5" in:fade={{ duration: 150 }}>
          <!-- Top Navigation Header -->
          <div class="flex items-center justify-between border-b border-borderc pb-2.5">
            <button
              onclick={() => {
                if (!isMigrating) {
                  currentStage = 'gateway';
                  migrationError = null;
                }
              }}
              disabled={isMigrating}
              class="text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 disabled:opacity-50 transition-colors"
            >
              <ArrowLeft class="w-3.5 h-3.5" />
              <span>{l.setup?.prevStep || '이전으로'}</span>
            </button>
            <h2 class="font-bold text-xs md:text-sm text-textcolor flex items-center gap-1.5">
              <Database class="w-4 h-4 text-blue-400" />
              <span>{l.setup?.gatewayMigrationTitle || '데이터 마이그레이션'}</span>
            </h2>
          </div>

          <!-- Error Alert Banner -->
          {#if migrationError}
            <div in:fly={{ y: -5, duration: 150 }} class="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle class="w-4 h-4 text-red-400 shrink-0" />
              <span>{migrationError}</span>
            </div>
          {/if}

          <!-- Sub-state 1: File selection / Drag-and-drop & Local Detection -->
          {#if !migrationDone}
            <div class="flex flex-col gap-3">
              <!-- Local detection quick load card (if available) -->
              {#if detectedLocalDb}
                <div class="p-3 rounded-xl border border-blue-500/40 bg-blue-500/10 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2.5">
                    <FolderCheck class="w-4 h-4 text-blue-400 shrink-0" />
                    <div>
                      <h4 class="font-bold text-xs text-textcolor">
                        {l.setup?.detectedLegacyDbTitle || '로컬 저장소에서 database.bin 감지됨'}
                      </h4>
                      <p class="text-[11px] text-textcolor2">
                        {l.setup?.migrationCharacters || '캐릭터'} {detectedLocalDb.stats.characterCount} · {l.setup?.migrationChats || '대화'} {detectedLocalDb.stats.chatCount}
                      </p>
                    </div>
                  </div>
                  {#if isMigrating}
                    <div class="flex items-center gap-1.5 text-xs text-blue-400">
                      <RefreshCw class="w-3.5 h-3.5 animate-spin" />
                      <span>{migrationProgress}</span>
                    </div>
                  {:else}
                    <button
                      onclick={() => {
                        if (detectedLocalDb) void performMigration(detectedLocalDb);
                      }}
                      class="px-3 py-1 rounded-lg bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-medium text-xs transition-colors shrink-0"
                    >
                      {l.setup?.startMigrationBtn || '바로 복원하기'}
                    </button>
                  {/if}
                </div>
              {/if}

              <!-- Interactive Drag & Drop Area (Reuses LoadLocalBackup & restoreLocalBackupFile) -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                ondragover={(e) => {
                  e.preventDefault();
                  isDragging = true;
                }}
                ondragleave={() => {
                  isDragging = false;
                }}
                ondrop={handleDrop}
                onclick={() => LoadLocalBackup()}
                class="border border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors gap-2.5 {isDragging ? 'border-blue-400 bg-blue-500/10' : 'border-borderc bg-darkbutton/30 hover:border-blue-400/60'}"
              >
                <div class="relative flex h-24 w-24 items-center justify-center">
                  <AirisuMascot variant="progress" decorative className="h-24 w-24 drop-shadow-md" />
                  <span class="absolute bottom-1 right-0 rounded-full border border-borderc bg-darkbg p-1.5 text-blue-400 shadow-md">
                    <FileUp class="h-3.5 w-3.5" />
                  </span>
                </div>
                <div>
                  <h3 class="font-bold text-xs md:text-sm text-textcolor">
                    {l.setup?.dropDatabaseBinTitle || '백업 파일(.bin, .risubackup)을 여기에 끌어다 놓으세요'}
                  </h3>
                  <p class="text-[11px] text-textcolor2 mt-0.5">
                    {l.setup?.dropDatabaseBinDesc || '또는 클릭하여 파일 탐색기에서 백업 파일 선택'}
                  </p>
                </div>
                <button
                  type="button"
                  class="px-3 py-1 rounded-lg bg-darkbg border border-borderc text-xs font-semibold text-textcolor pointer-events-none"
                >
                  {l.setup?.selectFileBtn || '파일 선택'}
                </button>
              </div>
            </div>

          <!-- Sub-state 3: Migration Completed -->
          {:else if migrationDone}
            <div class="flex flex-col items-center justify-center text-center p-5 gap-3" in:scale={{ duration: 200 }}>
              <div class="p-3 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <CheckCircle2 class="w-8 h-8" />
              </div>
              <div>
                <h3 class="text-lg font-bold text-textcolor">
                  {l.setup?.migrationSuccessTitle || '마이그레이션 완료'}
                </h3>
                <p class="text-xs text-textcolor2 mt-0.5 max-w-sm">
                  {l.setup?.migrationSuccessDesc || '모든 캐릭터와 대화 기록이 새로운 고성능 SQL 저장소로 이전되었습니다.'}
                </p>
              </div>

              <button
                onclick={finishAndEnterApp}
                class="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs md:text-sm transition-colors flex items-center gap-2 mt-1"
              >
                <span>{l.setup?.finishSetup || 'Haejeok RisuAI 시작하기'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- ================= STAGE 3: QUICK AI SETUP ================= -->
      {#if currentStage === 'quick-setup'}
        <div class="flex-1 flex flex-col justify-between gap-3.5" in:fade={{ duration: 150 }}>
          <!-- Step Nav Indicator -->
          <div class="flex items-center justify-between border-b border-borderc/40 pb-2.5 shrink-0">
            <button
              onclick={() => {
                if (quickStep > 1) {
                  quickStep--;
                } else {
                  currentStage = 'gateway';
                }
              }}
              class="text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 transition-colors"
            >
              <ArrowLeft class="w-3.5 h-3.5" />
              <span>{l.setup?.prevStep || '이전'}</span>
            </button>

            <!-- Step Dots -->
            <div class="flex items-center gap-1.5">
              {#each [1, 2, 3, 4] as s}
                <div class="h-1.5 rounded-full transition-all {quickStep === s ? 'w-5 bg-selected border border-borderc/40' : 'w-2 bg-borderc/30'}"></div>
              {/each}
            </div>

            <span class="text-xs font-semibold text-textcolor2">{l.setup?.stepIndicator || 'Step'} {quickStep}/4</span>
          </div>

          <!-- Sub-Step 1: Nickname Input (Full Height & Bottom Anchor Button) -->
          {#if quickStep === 1}
            <div class="flex-1 flex flex-col justify-between py-2" in:fly={{ x: 8, duration: 150 }}>
              <div class="flex flex-col gap-3 pt-1">
                <div>
                  <h3 class="text-base md:text-lg font-bold text-textcolor flex items-center gap-2">
                    <User class="w-4 h-4 text-textcolor2" />
                    <span>{l.setup?.nicknameTitle || '닉네임 설정'}</span>
                  </h3>
                </div>

                <div class="max-w-md">
                  <input
                    type="text"
                    bind:value={username}
                    placeholder={l.setup?.nicknameInputPlaceholder || '사용하실 닉네임을 입력해주세요'}
                    class="w-full px-4 py-3 rounded-xl bg-darkbutton/40 border border-borderc/40 text-textcolor text-sm focus:border-borderc focus:ring-1 focus:ring-selected outline-none transition-colors"
                    onkeydown={(e) => {
                      if (e.key === 'Enter' && username.trim()) quickStep = 2;
                    }}
                  />
                </div>
              </div>

              <!-- Bottom Action Button -->
              <div class="flex items-center justify-end mt-auto pt-4 border-t border-borderc/30 shrink-0">
                <button
                  onclick={() => {
                    if (username.trim()) quickStep = 2;
                  }}
                  disabled={!username.trim()}
                  class="px-6 py-2.5 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-bold text-xs md:text-sm transition-all active:scale-[0.98] flex items-center gap-1.5 disabled:opacity-40 disabled:pointer-events-none shadow-sm"
                >
                  <span>{l.setup?.nextStep || '다음'}</span>
                  <ArrowRight class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

          <!-- Sub-Step 2: AI Provider / Model Selection -->
          {:else if quickStep === 2}
            <div class="flex flex-col gap-3" in:fly={{ x: 8, duration: 150 }}>
              <div>
                <h3 class="text-base md:text-lg font-bold text-textcolor flex items-center gap-2">
                  <Bot class="w-4 h-4 text-purple-400" />
                  <span>{l.setup?.selectAiModel || 'AI 모델 제공자 선택'}</span>
                </h3>
                <p class="text-xs text-textcolor2 mt-0.5">
                  {l.setup?.selectAiModelDesc || '주로 사용하실 AI 제공자를 선택해주세요.'}
                </p>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[280px] overflow-y-auto pr-1">
                {#each providers as prov}
                  <button
                    onclick={() => selectProvider(prov.id)}
                    class="text-left p-3 rounded-xl border transition-all flex flex-col justify-between {selectedProvider === prov.id ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500' : 'border-borderc bg-darkbutton/30 hover:bg-darkbutton/70'}"
                  >
                    <div class="flex items-center justify-between w-full">
                      <span class="font-bold text-xs text-textcolor">{prov.name}</span>
                      {#if selectedProvider === prov.id}
                        <span class="text-[10px] text-blue-400 font-semibold">✓ 선택됨</span>
                      {/if}
                    </div>
                    <span class="text-[11px] text-textcolor2 mt-0.5 leading-tight">{prov.sub}</span>
                  </button>
                {/each}
              </div>

              <div class="flex justify-between items-center mt-1">
                <button
                  onclick={() => (quickStep = 1)}
                  class="px-3.5 py-1.5 rounded-lg border border-borderc text-xs font-semibold text-textcolor2 hover:text-textcolor transition-colors"
                >
                  {l.setup?.prevStep || '이전'}
                </button>

                <button
                  onclick={() => (quickStep = 3)}
                  class="px-5 py-2 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-bold text-xs md:text-sm transition-all active:scale-[0.98] flex items-center gap-1.5 shadow-sm"
                >
                  <span>{l.setup?.nextStep || '다음 단계로'}</span>
                  <ArrowRight class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

          <!-- Sub-Step 3: Custom Model, API Key & Direct Context Token Inputs -->
          {:else if quickStep === 3}
            {@const curProv = providers.find((p) => p.id === selectedProvider)}
            <div class="flex flex-col gap-3 max-h-[340px] overflow-y-auto pr-1" in:fly={{ x: 8, duration: 150 }}>
              <!-- Header -->
              <div>
                <h3 class="text-sm md:text-base font-bold text-textcolor flex items-center gap-2">
                  <Key class="w-4 h-4 text-amber-400" />
                  <span>{curProv?.name} {l.setup?.inputApiKeyTitle || '설정 및 컨텍스트'}</span>
                </h3>
                {#if curProv?.keyLink}
                  <a
                    href={curProv.keyLink}
                    target="_blank"
                    rel="noreferrer"
                    class="text-xs text-blue-400 hover:underline flex items-center gap-1 mt-0.5"
                  >
                    <span>{l.setup?.apiKeyLink || 'API 키 발급 페이지 바로가기'}</span>
                    <ExternalLink class="w-3 h-3" />
                  </a>
                {/if}
              </div>

              <!-- Endpoint URL for Reverse Proxy or Ollama -->
              {#if selectedProvider === 'reverse_proxy' || selectedProvider === 'ollama'}
                <div class="flex flex-col gap-1">
                  <span class="text-xs font-semibold text-textcolor flex items-center gap-1">
                    <Server class="w-3 h-3 text-blue-400" />
                    {l.setup?.endpointUrlLabel || '엔드포인트 / 프록시 URL'}
                  </span>
                  <input
                    type="text"
                    bind:value={customURL}
                    placeholder={selectedProvider === 'ollama' ? 'http://127.0.0.1:11434' : (l.setup?.endpointUrlPlaceholder || 'https://api.openai.com/v1')}
                    class="w-full px-3 py-2 rounded-xl bg-darkbutton/50 border border-borderc text-textcolor text-xs md:text-sm focus:border-blue-500 outline-none transition-colors"
                  />
                </div>
              {/if}

              <!-- Model Name Selection & Direct Input (For all customizable providers) -->
              {#if selectedProvider !== 'self' && selectedProvider !== 'horde'}
                <div class="flex flex-col gap-1">
                  <span class="text-xs font-semibold text-textcolor flex items-center gap-1">
                    <Cpu class="w-3 h-3 text-purple-400" />
                    {l.setup?.modelNameLabel || '모델 이름 (선택/직접 입력)'}
                  </span>
                  <div class="flex flex-col gap-1.5">
                    <input
                      type="text"
                      bind:value={modelName}
                      placeholder={l.setup?.modelNamePlaceholder || '예: claude-3-7-sonnet, deepseek-chat, gpt-4o'}
                      class="w-full px-3 py-2 rounded-xl bg-darkbutton/50 border border-borderc text-textcolor text-xs md:text-sm focus:border-blue-500 outline-none transition-colors"
                    />

                    <!-- Quick Model Chips if available -->
                    {#if curProv && curProv.models.length > 0}
                      <div class="flex items-center gap-1.5 flex-wrap">
                        {#each curProv.models as m}
                          <button
                            type="button"
                            onclick={() => (modelName = m)}
                            class="px-2 py-0.5 rounded text-[11px] border transition-colors {modelName === m ? 'bg-selected text-white border-blue-500 font-semibold' : 'bg-darkbutton/40 border-borderc text-textcolor2 hover:text-textcolor'}"
                          >
                            {m}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

              <!-- API Key Input -->
              {#if curProv?.keyPlaceholder && selectedProvider !== 'ollama'}
                <div class="flex flex-col gap-1">
                  <span class="text-xs font-semibold text-textcolor">API 키</span>
                  <input
                    type="password"
                    bind:value={apiKey}
                    placeholder={curProv.keyPlaceholder}
                    class="w-full px-3 py-2 rounded-xl bg-darkbutton/50 border border-borderc text-textcolor text-xs md:text-sm focus:border-blue-500 outline-none transition-colors"
                  />
                  <span class="text-[10px] text-textcolor2">
                    {l.setup?.apiKeyDesc || '키는 기기 내부에만 안전하게 저장됩니다.'}
                  </span>
                </div>
              {/if}

              <!-- Direct Context Token Input (직접 입력!) -->
              <div class="flex flex-col gap-1.5 pt-1 border-t border-borderc/40">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold text-textcolor flex items-center gap-1">
                    <Hash class="w-3 h-3 text-emerald-400" />
                    {l.setup?.maxContextLabel || '최대 컨텍스트 토큰 (Max Context)'}
                  </span>
                  <span class="text-[11px] text-textcolor2">{maxContext.toLocaleString()} Tokens</span>
                </div>

                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    min="1000"
                    max="2000000"
                    step="1000"
                    bind:value={maxContext}
                    placeholder="16000"
                    class="w-32 px-3 py-1.5 rounded-lg bg-darkbutton/50 border border-borderc text-textcolor text-xs md:text-sm focus:border-blue-500 outline-none transition-colors"
                  />

                  <!-- Quick Chips for Context Size -->
                  <div class="flex items-center gap-1 flex-wrap">
                    {#each contextPresets as cp}
                      <button
                        type="button"
                        onclick={() => (maxContext = cp.value)}
                        class="px-2 py-1 rounded text-[11px] border transition-colors {maxContext === cp.value ? 'bg-selected text-white border-blue-500 font-semibold' : 'bg-darkbutton/40 border-borderc text-textcolor2 hover:text-textcolor'}"
                      >
                        {cp.label}
                      </button>
                    {/each}
                  </div>
                </div>
              </div>

              <!-- Max Response Tokens (Output size) -->
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-textcolor">
                  {l.setup?.maxResponseLabel || '최대 응답 토큰 (Max Output)'}
                </span>
                <input
                  type="number"
                  min="100"
                  max="8192"
                  step="100"
                  bind:value={maxResponse}
                  placeholder="1000"
                  class="w-24 px-2.5 py-1 rounded-lg bg-darkbutton/50 border border-borderc text-textcolor text-xs focus:border-blue-500 outline-none transition-colors text-right"
                />
              </div>

              <!-- Chat Translation Preference -->
              <div class="flex flex-col gap-1 pt-1 border-t border-borderc/40">
                <span class="text-xs font-semibold text-textcolor">{l.setup?.chatTranslationMode || '채팅 번역 모드'}</span>
                <div class="grid grid-cols-3 gap-1.5">
                  <button
                    onclick={() => (chatLang = 0)}
                    class="p-1.5 rounded-lg border text-xs font-medium transition-colors {chatLang === 0 ? 'bg-selected text-white border-blue-500' : 'bg-darkbutton/40 border-borderc text-textcolor2 hover:text-textcolor'}"
                  >
                    {l.setup?.chatTransModeEnglish || '영어 원문'}
                  </button>
                  <button
                    onclick={() => (chatLang = 1)}
                    class="p-1.5 rounded-lg border text-xs font-medium transition-colors {chatLang === 1 ? 'bg-selected text-white border-blue-500' : 'bg-darkbutton/40 border-borderc text-textcolor2 hover:text-textcolor'}"
                  >
                    {l.setup?.chatTransModeAuto || '자동 번역'}
                  </button>
                  <button
                    onclick={() => (chatLang = 2)}
                    class="p-1.5 rounded-lg border text-xs font-medium transition-colors {chatLang === 2 ? 'bg-selected text-white border-blue-500' : 'bg-darkbutton/40 border-borderc text-textcolor2 hover:text-textcolor'}"
                  >
                    {l.setup?.chatTransModeDirect || '직접 입력'}
                  </button>
                </div>
              </div>

              <!-- Nav Action -->
              <div class="flex justify-between items-center mt-2 pt-2 border-t border-borderc/40">
                <button
                  onclick={() => (quickStep = 2)}
                  class="px-3.5 py-1.5 rounded-lg border border-borderc text-xs font-semibold text-textcolor2 hover:text-textcolor transition-colors"
                >
                  {l.setup?.prevStep || '이전'}
                </button>

                <button
                  onclick={() => (quickStep = 4)}
                  class="px-5 py-2 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-bold text-xs md:text-sm transition-all active:scale-[0.98] flex items-center gap-1.5 shadow-sm"
                >
                  <span>{l.setup?.completeSetupBtn || '설정 완료하기'}</span>
                  <ArrowRight class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

          <!-- Sub-Step 4: All Ready Celebration -->
          {:else if quickStep === 4}
            <div class="flex flex-col items-center justify-center text-center p-5 gap-3.5 my-auto" in:scale={{ duration: 200 }}>
              <div class="p-3 rounded-full bg-selected/30 text-textcolor border border-borderc/40">
                <CheckCircle2 class="w-8 h-8" />
              </div>
              <div>
                <h3 class="text-lg md:text-xl font-bold text-textcolor">
                  {l.setup?.allDone || '모든 설정이 끝났어요!'}
                </h3>
                <p class="text-xs text-textcolor2 mt-1 max-w-sm">
                  {l.setup?.allSetMessage || 'Haejeok RisuAI를 시작합니다.'}
                </p>
              </div>

              <button
                onclick={finishAndEnterApp}
                class="px-6 py-2.5 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc/40 text-textcolor font-bold text-xs md:text-sm shadow-sm transition-all active:scale-[0.98] flex items-center gap-2 mt-1"
              >
                <span>{l.setup?.finishSetup || 'Haejeok RisuAI 시작하기'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          {/if}
        </div>
      {/if}

    </section>
  </main>
</div>
{/if}
