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
    ChevronDown,
    FileUp,
    FolderCheck,
    ExternalLink,
    Server,
    Cpu,
    Hash,
    Check,
    X
  } from '@lucide/svelte';

  import ModelBrowser from 'src/lib/UI/Model/ModelBrowser.svelte';
  import { getModelInfo, LLMProvider } from 'src/ts/model/modellist';
  import { changeLanguage, language } from 'src/lang';
  import { setPreset } from '../../ts/storage/presets/presetService';
  import { installStartupData } from 'src/ts/storage/database/databaseLifecycle';
  import { settingsStore, personaStore } from 'src/ts/stores/domain';
  import { prebuiltPresets } from 'src/ts/process/templates/templates';
  import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
  import { getSqlRuntime } from 'src/ts/storage/sql/sqlRuntime';
  import { getSqlStorage } from 'src/ts/storage/sql/sqlStorageFactory';
  import {
    detectLocalLegacyDatabase,
    migrateLegacyDatabase,
    type LegacyDatabaseInfo
  } from 'src/ts/storage/database/migration';
  import { LoadLocalBackup, restoreLocalBackupFile } from 'src/ts/drive/backuplocal';
  import AirisuMascot from '../UI/AirisuMascot.svelte';

  type Stage = 'gateway' | 'migration' | 'quick-setup' | 'done';

  let currentStage = $state<Stage>('gateway');
  let quickStep = $state<number>(1); // 1: Username, 2: AI Model & API Key, 3: Done
  let showAdvanced = $state<boolean>(false);
  let showMoreProviders = $state<boolean>(false);
  let showModelBrowser = $state<boolean>(false);

  // Reactive Language Tracking
  let langCodeState = $state(settingsStore.state.language || 'ko');
  let langTick = $state(0);
  let langMenuOpen = $state(false);

  // Derived reactive language accessor
  let l = $derived.by(() => {
    langTick; // Track reactivity tick
    return language;
  });

  // Form State
  let username = $state(personaStore.activePersona?.name ?? 'User');
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
  let isMigrating = $state(false);
  let migrationProgress = $state('');
  let migrationDone = $state(false);
  let migrationError = $state<string | null>(null);

  // Available Languages
  const languages = [
    { code: 'ko', label: '한국어' },
    { code: 'en', label: 'English' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'cn', label: '简体中文' },
    { code: 'de', label: 'Deutsch' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'es', label: 'Español' },
  ];

  let currentLangItem = $derived(
    languages.find((lang) => lang.code === langCodeState) || languages[0]
  );

  // AI Providers list with badges and quick categorization
  const providers = [
    {
      id: 'claude',
      name: 'Anthropic Claude',
      badge: 'Claude 3.7',
      sub: 'Claude 3.7 Sonnet, 3.5 Sonnet',
      defaultModel: 'claude-3-7-sonnet-20250219',
      keyLink: 'https://console.anthropic.com/settings/keys',
      keyPlaceholder: 'sk-ant-api03-...',
    },
    {
      id: 'openai',
      name: 'OpenAI (ChatGPT)',
      badge: 'GPT-4o',
      sub: 'GPT-4o, o3-mini, o1',
      defaultModel: 'gpt-4o',
      keyLink: 'https://platform.openai.com/api-keys',
      keyPlaceholder: 'sk-proj-...',
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      badge: 'Gemini 2.5',
      sub: 'Gemini 2.5 Flash, 2.5 Pro',
      defaultModel: 'gemini-2.5-flash',
      keyLink: 'https://aistudio.google.com/app/apikey',
      keyPlaceholder: 'AIzaSy...',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      badge: '다양한 모델',
      sub: 'Claude, DeepSeek, Llama 등',
      defaultModel: 'anthropic/claude-3.7-sonnet',
      keyLink: 'https://openrouter.ai/keys',
      keyPlaceholder: 'sk-or-v1-...',
    },
    {
      id: 'reverse_proxy',
      name: '커스텀 / 프록시',
      badge: '프록시',
      sub: '외부/사설 리버스 프록시',
      defaultModel: 'gpt-4o',
      keyLink: '',
      keyPlaceholder: 'API 키 또는 프록시 비밀번호 (선택)',
    },
    {
      id: 'ollama',
      name: 'Ollama (로컬 LLM)',
      badge: '로컬',
      sub: '127.0.0.1:11434 로컬',
      defaultModel: 'llama3.3',
      keyLink: '',
      keyPlaceholder: '',
    },
    {
      id: 'horde',
      name: 'AI Horde',
      badge: '무료',
      sub: '무료 분산형 AI 네트워크',
      defaultModel: 'horde:::auto',
      keyLink: 'https://aihorde.net/register',
      keyPlaceholder: '0000000000 또는 Horde API Key',
    },
    {
      id: 'self',
      name: '나중에 설정하기',
      badge: '건너뛰기',
      sub: '설정 화면에서 직접 구성',
      defaultModel: '',
      keyLink: '',
      keyPlaceholder: '',
    },
  ];

  function selectModelQuick(mId: string) {
    modelName = mId;
    const info = getModelInfo(mId);
    if (info.provider === LLMProvider.Anthropic || info.provider === LLMProvider.AWS) {
      selectedProvider = 'claude';
    } else if (info.provider === LLMProvider.OpenAI) {
      selectedProvider = 'openai';
    } else if (info.provider === LLMProvider.GoogleCloud || info.provider === LLMProvider.VertexAI) {
      selectedProvider = 'gemini';
    } else if (mId.startsWith('openrouter') || info.id.startsWith('openrouter')) {
      selectedProvider = 'openrouter';
    }
  }

  // Dynamic Iris Companion Speech Bubble text (Friendly & Cheerful, No Emojis)
  let irisDialogue = $derived.by(() => {
    langTick; // Reactivity dependency
    if (migrationDone) {
      return l.setup?.migrationSuccessDesc || '성공적으로 이전되었어요! 이제 즐겁게 대화해 보세요.';
    }
    if (isMigrating) {
      return migrationProgress || (l.setup?.migrationInProgress || '데이터를 열심히 변환하고 있어요...');
    }
    if (migrationError) {
      return l.setup?.migrationFailedDesc || '파일을 읽는 도중 오류가 발생했어요...';
    }
    if (currentStage === 'migration') {
      if (detectedLocalDb) {
        return l.setup?.detectedLegacyDbDesc || '기존 database.bin을 찾았어요! 바로 복원해드릴까요?';
      }
      return l.setup?.irisMigrationDrop || '백업 파일(.bin, .risubackup)을 선택하시면 캐릭터와 대화를 복원해 드릴게요!';
    }
    if (currentStage === 'quick-setup') {
      if (quickStep === 1) return l.setup?.irisStep1 || '대화할 때 불릴 멋진 닉네임을 알려주세요!';
      if (quickStep === 2) return '사용하실 AI 모델을 골라주세요. 나중에 설정하셔도 돼요!';
      if (quickStep === 3) return l.setup?.irisStep4 || '모든 준비가 끝났어요! 이제 함께 시작해봐요.';
    }
    if (detectedLocalDb) {
      return l.setup?.irisGatewayDetected || '이전 데이터(database.bin)를 찾았어요! 바로 복원해드릴까요?';
    }
    return l.setup?.irisGatewayDefault || '만나서 반가워요! 원하는 시작 방식을 골라주세요. 처음이시라면 빠른 설정을 추천해요!';
  });

  async function handleLanguageSelect(langCode: string) {
    settingsStore.state.language = langCode;
    langCodeState = langCode;
    langMenuOpen = false;
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

    void personaStore.ensureLoaded().then(() => {
      const activeName = personaStore.activePersona?.name;
      if (activeName && username === 'User') username = activeName;
    }).catch(() => {});

    void detectLocalLegacyDatabase().then((info) => {
      if (info && info.stats.characterCount > 0) {
        detectedLocalDb = info;
      }
    }).catch(() => {});
  });

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
        const reloaded = await storage.loadStartupData();
        if (!reloaded) {
          throw new Error('SQL storage returned no startup data after migration');
        }
        installStartupData(reloaded, storage);
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

    await personaStore.ensureLoaded();
    if (trimmedUsername) {
      personaStore.requireActive(finishAndEnterApp.name).name = trimmedUsername;
    }

    settingsStore.state.maxContext = Number.isFinite(contextTokens)
      ? Math.min(2_000_000, Math.max(1_000, contextTokens))
      : 16_000;
    settingsStore.state.maxResponse = Number.isFinite(responseTokens)
      ? Math.min(8_192, Math.max(100, responseTokens))
      : 1_000;

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
      const targetModel = trimmedModel || 'anthropic/claude-3.7-sonnet';
      settingsStore.state.aiModel = 'openrouter';
      settingsStore.state.subModel = 'openrouter';
      settingsStore.state.openrouterRequestModel = targetModel;
      settingsStore.state.openrouterSubRequestModel = targetModel;
      if (trimmedApiKey) settingsStore.state.openrouterKey = trimmedApiKey;
    } else if (selectedProvider === 'reverse_proxy') {
      settingsStore.state.aiModel = 'reverse_proxy';
      settingsStore.state.subModel = 'reverse_proxy';
      if (trimmedUrl) settingsStore.state.forceReplaceUrl = trimmedUrl;
      if (trimmedModel) {
        settingsStore.state.customProxyRequestModel = trimmedModel;
        settingsStore.state.customProxySubRequestModel = trimmedModel;
      }
      if (trimmedApiKey) settingsStore.state.proxyKey = trimmedApiKey;
    } else if (selectedProvider === 'ollama') {
      settingsStore.state.aiModel = 'ollama-hosted';
      settingsStore.state.subModel = 'ollama-hosted';
      if (trimmedModel) {
        settingsStore.state.ollamaModel = trimmedModel;
        settingsStore.state.ollamaSubModel = trimmedModel;
      }
      if (trimmedUrl) settingsStore.state.ollamaURL = trimmedUrl;
      settingsStore.state.ollamaModelSource = 'local';
    } else if (selectedProvider === 'horde') {
      settingsStore.state.aiModel = 'horde:::auto';
      settingsStore.state.subModel = 'horde:::auto';
      if (trimmedApiKey) settingsStore.state.hordeConfig.apiKey = trimmedApiKey;
    }

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

<div class="relative w-full h-full min-h-[100dvh] bg-bgcolor text-textcolor flex flex-col justify-between p-3.5 selection:bg-blue-600 selection:text-white overflow-x-hidden overflow-y-auto">
  <!-- Top Navigation & Language Bar -->
  <header class="w-full flex items-center justify-between py-1.5 px-0.5 shrink-0 z-30">
    <div class="flex items-center gap-2">
      <img src="/logo_192.png" alt="Haejeok RisuAI" class="w-6 h-6 object-contain" />
      <span class="font-bold text-sm tracking-tight text-textcolor">Haejeok RisuAI</span>
    </div>

    <!-- Mobile Compact Language Selector Button -->
    <div class="relative">
      <button
        onclick={() => (langMenuOpen = !langMenuOpen)}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-darkbg border border-borderc text-xs font-medium text-textcolor shadow-sm active:scale-95 transition-all"
        aria-label="Select Language"
      >
        <Globe class="w-3.5 h-3.5 text-textcolor2 shrink-0" />
        <span class="text-[11px] font-semibold">{currentLangItem.label}</span>
        <ChevronDown class="w-3 h-3 text-textcolor2 transition-transform duration-150 {langMenuOpen ? 'rotate-180' : ''}" />
      </button>

      <!-- Language Dropdown Menu / Popover -->
      {#if langMenuOpen}
        <!-- Backdrop to close dropdown on outside click -->
        <button
          type="button"
          tabindex="-1"
          class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] cursor-default w-full h-full border-none outline-none"
          onclick={() => (langMenuOpen = false)}
          aria-label="Close menu"
        ></button>

        <div
          in:scale={{ duration: 150, start: 0.95 }}
          class="absolute right-0 top-9 z-50 bg-darkbg border border-borderc rounded-2xl p-1.5 shadow-2xl min-w-[170px] flex flex-col gap-1 backdrop-blur-md"
        >
          <div class="px-2.5 py-1 text-[10px] font-bold text-textcolor2 uppercase tracking-wider border-b border-borderc/40 flex items-center gap-1">
            <Globe class="w-3 h-3 text-textcolor2" />
            <span>{l.language || 'Language'}</span>
          </div>

          <div class="flex flex-col gap-0.5 max-h-60 overflow-y-auto">
            {#each languages as item}
              <button
                onclick={() => handleLanguageSelect(item.code)}
                class="flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors {langCodeState === item.code ? 'bg-selected text-white font-semibold' : 'text-textcolor hover:bg-darkbutton/60'}"
              >
                <span>{item.label}</span>
                {#if langCodeState === item.code}
                  <Check class="w-3.5 h-3.5 text-white shrink-0" />
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </header>

  <!-- Main Mobile Content Area -->
  <main class="w-full flex-1 flex flex-col z-10">

    <!-- Compact Mascot Hero Banner (Row Layout) - Only for Migration & Quick Setup Steps 2+ -->
    {#if currentStage === 'migration' || (currentStage === 'quick-setup' && quickStep > 1)}
      <div class="w-full bg-darkbg border border-borderc/40 rounded-2xl p-3 shadow-md flex items-center gap-3 mb-3 shrink-0">
        <!-- Mini Airisu Avatar -->
        <div class="relative w-14 h-14 shrink-0 rounded-xl overflow-hidden border border-borderc/30 bg-textcolor/5 flex items-end justify-center p-0.5">
          <AirisuMascot
            variant="welcome"
            alt="Airisu"
            className="w-full h-full object-contain"
            eager
          />
          <span class="absolute bottom-0.5 right-0.5 px-1 py-0.2 rounded bg-black/70 text-[9px] text-textcolor font-semibold border border-borderc/30 flex items-center gap-0.5">
            Airisu
          </span>
        </div>

        <!-- Dialogue Bubble -->
        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
          <div class="flex items-center gap-1 font-bold text-xs text-textcolor">
            <span>{l.setup?.irisName || '아이리스 (Iris)'}</span>
          </div>
          <p class="text-xs text-textcolor/90 leading-snug line-clamp-3">
            {irisDialogue}
          </p>
        </div>
      </div>
    {/if}

    <!-- ================= STAGE 1: GATEWAY ================= -->
    {#if currentStage === 'gateway'}
      <div class="flex-1 flex flex-col justify-between py-2 sm:py-4 gap-4" in:fade={{ duration: 150 }}>
        <!-- Central Iris Hero Section (Fills Vertical Space Elegantly) -->
        <div class="flex flex-col items-center text-center gap-3 my-auto pt-2">
          <!-- Large Mascot Sprite -->
          <div class="relative w-36 h-36 sm:w-44 sm:h-44 rounded-3xl overflow-hidden border border-borderc/30 bg-textcolor/5 shadow-xl flex items-end justify-center p-1">
            <AirisuMascot
              variant="welcome"
              alt="Airisu"
              className="w-full h-full object-contain"
              eager
            />
            <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-lg bg-black/70 text-[10px] text-textcolor font-semibold border border-borderc/30">
              Airisu
            </span>
          </div>

          <!-- Hero Speech Bubble -->
          <div class="w-full max-w-sm bg-darkbg border border-borderc/30 rounded-2xl p-3.5 shadow-sm text-xs leading-relaxed text-textcolor">
            <div class="font-bold text-xs text-textcolor mb-1">
              {l.setup?.irisName || '아이리스 (Iris)'}
            </div>
            <p class="text-textcolor/90 leading-normal">
              {irisDialogue}
            </p>
          </div>
        </div>

        <!-- Action Cards & Bottom Links Section -->
        <div class="flex flex-col gap-3 w-full shrink-0 pb-1">
          <!-- Highlight Banner: Detected Local database.bin (Compact) -->
          {#if detectedLocalDb}
            <div
              in:fly={{ y: 10, duration: 200 }}
              class="rounded-2xl border border-blue-500/40 bg-blue-500/10 p-3 flex items-center justify-between gap-2"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <div class="p-2 rounded-xl bg-blue-500/20 text-blue-400 shrink-0">
                  <Database class="w-4 h-4" />
                </div>
                <div class="flex flex-col min-w-0">
                  <span class="font-bold text-xs text-textcolor truncate">
                    {l.setup?.detectedLegacyDbTitle || '기존 database.bin 발견'}
                  </span>
                  <span class="text-[11px] text-textcolor2 truncate">
                    {detectedLocalDb.stats.characterCount} {l.setup?.migrationCharacters || '캐릭터'} · {detectedLocalDb.stats.chatCount} {l.setup?.migrationChats || '대화'}
                  </span>
                </div>
              </div>

              <button
                onclick={() => {
                  if (detectedLocalDb) void performMigration(detectedLocalDb);
                }}
                class="px-3 py-1.5 rounded-xl bg-darkbutton hover:bg-selected border border-borderc/40 text-textcolor font-semibold text-xs shrink-0 transition-colors"
              >
                {l.setup?.actionRestore || '복원'}
              </button>
            </div>
          {/if}

          <!-- 2 Main Streamlined Cards -->
          <div class="flex flex-col gap-2.5">
            <!-- Choice 1: Quick AI Setup -->
            <button
              onclick={() => {
                currentStage = 'quick-setup';
                quickStep = 1;
              }}
              class="text-left p-4 rounded-2xl border border-borderc/40 bg-darkbutton/30 hover:bg-selected/30 active:bg-selected/40 transition-all flex items-center justify-between shadow-sm"
            >
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="p-3 rounded-2xl bg-darkbutton border border-borderc/30 text-textcolor shrink-0">
                  <Bot class="w-5 h-5 text-textcolor" />
                </div>
                <div class="flex flex-col min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-sm text-textcolor whitespace-nowrap truncate">
                      {l.setup?.gatewayQuickSetupTitle || 'AI 빠른 설정'}
                    </span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-selected border border-borderc/30 text-textcolor font-semibold shrink-0 whitespace-nowrap">
                      {l.setup?.badgeRecommended || '추천'}
                    </span>
                  </div>
                  <span class="text-xs text-textcolor2 mt-0.5 truncate">
                    닉네임 및 AI 모델 구성
                  </span>
                </div>
              </div>
              <ChevronRight class="w-5 h-5 text-textcolor2 shrink-0 ml-2" />
            </button>

            <!-- Choice 2: Data Migration / Restore -->
            <button
              onclick={() => {
                currentStage = 'migration';
              }}
              class="text-left p-4 rounded-2xl border border-borderc/40 bg-darkbutton/30 hover:bg-selected/30 active:bg-selected/40 transition-all flex items-center justify-between shadow-sm"
            >
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="p-3 rounded-2xl bg-darkbutton border border-borderc/30 text-textcolor shrink-0">
                  <Database class="w-5 h-5 text-textcolor" />
                </div>
                <div class="flex flex-col min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-sm text-textcolor whitespace-nowrap truncate">
                      {l.setup?.gatewayMigrationTitle || '데이터 가져오기'}
                    </span>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-darkbutton border border-borderc/30 text-textcolor2 font-medium shrink-0 whitespace-nowrap">
                      {detectedLocalDb ? (l.setup?.badgeDetected || '발견됨') : (l.setup?.badgeBackupFile || '백업 파일')}
                    </span>
                  </div>
                  <span class="text-xs text-textcolor2 mt-0.5 truncate">
                    기존 캐릭터와 대화 복원
                  </span>
                </div>
              </div>
              <ChevronRight class="w-5 h-5 text-textcolor2 shrink-0 ml-2" />
            </button>
          </div>

          <!-- Skip Action Link -->
          <div class="pt-1">
            <button
              onclick={finishAndEnterApp}
              class="w-full py-2.5 rounded-xl border border-transparent text-center text-xs text-textcolor2 hover:text-textcolor active:bg-darkbutton/50 transition-colors flex items-center justify-center gap-1"
            >
              <span>{l.setup?.gatewaySkipTitle || '직접 설정할래요 (건너뛰기)'}</span>
              <ArrowRight class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ================= STAGE 2: MIGRATION ================= -->
    {#if currentStage === 'migration'}
      <div class="flex-1 flex flex-col justify-between gap-3" in:fade={{ duration: 150 }}>
        <!-- Mobile Top Navigation Header -->
        <div class="flex items-center justify-between border-b border-borderc/60 pb-2">
          <button
            onclick={() => {
              if (!isMigrating) {
                currentStage = 'gateway';
                migrationError = null;
              }
            }}
            disabled={isMigrating}
            class="text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 py-1 px-2 rounded-lg bg-darkbutton/50 disabled:opacity-50 transition-colors"
          >
            <ArrowLeft class="w-3.5 h-3.5" />
            <span>{l.setup?.prevStep || '이전'}</span>
          </button>

          <h2 class="font-bold text-xs text-textcolor flex items-center gap-1.5">
            <Database class="w-3.5 h-3.5 text-blue-400" />
            <span>{l.setup?.gatewayMigrationTitle || '데이터 마이그레이션'}</span>
          </h2>
        </div>

        <!-- Error Alert Banner -->
        {#if migrationError}
          <div in:fly={{ y: -5, duration: 150 }} class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle class="w-4 h-4 text-red-400 shrink-0" />
            <span>{migrationError}</span>
          </div>
        {/if}

        {#if !migrationDone}
          <div class="flex flex-col gap-3">
            <!-- Local Detection Quick Load Card -->
            {#if detectedLocalDb}
              <div class="p-3 rounded-2xl border border-blue-500/40 bg-blue-500/10 flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <FolderCheck class="w-4 h-4 text-blue-400 shrink-0" />
                  <div class="flex-1 min-w-0">
                    <h4 class="font-bold text-xs text-textcolor">
                      {l.setup?.detectedLegacyDbTitle || '로컬 저장소에서 database.bin 감지됨'}
                    </h4>
                    <p class="text-[11px] text-textcolor2 truncate">
                      {l.setup?.migrationCharacters || '캐릭터'} {detectedLocalDb.stats.characterCount} · {l.setup?.migrationChats || '대화'} {detectedLocalDb.stats.chatCount}
                    </p>
                  </div>
                </div>

                {#if isMigrating}
                  <div class="flex items-center justify-center gap-2 py-2 text-xs text-blue-400 font-semibold">
                    <RefreshCw class="w-3.5 h-3.5 animate-spin" />
                    <span>{migrationProgress}</span>
                  </div>
                {:else}
                  <button
                    onclick={() => {
                      if (detectedLocalDb) void performMigration(detectedLocalDb);
                    }}
                    class="w-full py-2 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc text-textcolor font-semibold text-xs active:scale-[0.98] transition-all shadow-sm"
                  >
                    {l.setup?.startMigrationBtn || '바로 복원하기'}
                  </button>
                {/if}
              </div>
            {/if}

            <!-- Mobile Touch-friendly File Upload Card -->
            <button
              type="button"
              onclick={() => LoadLocalBackup()}
              class="border-2 border-dashed border-borderc rounded-2xl p-5 flex flex-col items-center justify-center text-center bg-darkbg active:border-borderc active:bg-darkbutton/30 transition-all gap-2.5 shadow-sm"
            >
              <div class="relative flex h-20 w-20 items-center justify-center">
                <AirisuMascot variant="progress" decorative className="h-20 w-20 drop-shadow-sm" />
                <span class="absolute bottom-0 right-0 rounded-full border border-borderc bg-darkbg p-1 text-textcolor2 shadow-md">
                  <FileUp class="h-3.5 w-3.5" />
                </span>
              </div>

              <div>
                <h3 class="font-bold text-xs text-textcolor">
                  {l.setup?.selectFileBtn || '백업 파일 선택'} (.bin, .risum, .risubackup)
                </h3>
                <p class="text-[11px] text-textcolor2 mt-0.5">
                  {l.setup?.dropDatabaseBinDesc || '기기에서 백업 파일을 찾아 선택해 주세요.'}
                </p>
              </div>

              <div class="px-4 py-1.5 rounded-xl bg-darkbutton border border-borderc text-xs font-semibold text-textcolor pointer-events-none mt-1">
                {l.setup?.selectFileBtn || '파일 선택하기'}
              </div>
            </button>
          </div>

        <!-- Migration Completed -->
        {:else if migrationDone}
          <div class="flex flex-col items-center justify-center text-center p-4 gap-3" in:scale={{ duration: 200 }}>
            <div class="p-3 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <CheckCircle2 class="w-8 h-8" />
            </div>
            <div>
              <h3 class="text-base font-bold text-textcolor">
                {l.setup?.migrationSuccessTitle || '마이그레이션 완료'}
              </h3>
              <p class="text-xs text-textcolor2 mt-0.5">
                {l.setup?.migrationSuccessDesc || '모든 캐릭터와 대화 기록이 고성능 SQL 저장소로 이전되었습니다.'}
              </p>
            </div>

            <button
              onclick={finishAndEnterApp}
              class="w-full py-3 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc text-textcolor font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2 mt-2 shadow-sm"
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
      <div class="flex-1 flex flex-col justify-between gap-3" in:fade={{ duration: 150 }}>
        <!-- Step Navigation Header (3 Steps) -->
        <div class="flex items-center justify-between border-b border-borderc/60 pb-2 shrink-0">
          <button
            onclick={() => {
              if (quickStep > 1) {
                quickStep--;
              } else {
                currentStage = 'gateway';
              }
            }}
            class="text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 py-1 px-2 rounded-lg bg-darkbutton/50 transition-colors"
          >
            <ArrowLeft class="w-3.5 h-3.5" />
            <span>{l.setup?.prevStep || '이전'}</span>
          </button>

          <!-- Step Indicators (3 Steps) -->
          <div class="flex items-center gap-1.5">
            {#each [1, 2, 3] as s}
              <div class="h-1.5 rounded-full transition-all {quickStep === s ? 'w-6 bg-selected border border-borderc' : 'w-2 bg-borderc/50'}"></div>
            {/each}
          </div>

          <span class="text-xs font-semibold text-textcolor2">{l.setup?.stepIndicator || 'Step'} {quickStep}/3</span>
        </div>

        <!-- Sub-Step 1: Nickname Input (Centered Iris Hero + Clean Input + Bottom Action Button) -->
        {#if quickStep === 1}
          <div class="flex-1 flex flex-col justify-between py-2" in:fly={{ x: 8, duration: 150 }}>
            <!-- Central Hero: Airisu + Dialogue + Nickname Input -->
            <div class="flex flex-col items-center text-center gap-3.5 my-auto pt-2">
              <!-- Mascot Sprite -->
              <div class="relative w-32 h-32 sm:w-40 sm:h-40 rounded-3xl overflow-hidden border border-borderc bg-textcolor/5 shadow-xl flex items-end justify-center p-1">
                <AirisuMascot
                  variant="welcome"
                  alt="Airisu"
                  className="w-full h-full object-contain"
                  eager
                />
                <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-lg bg-black/70 text-[10px] text-textcolor font-semibold border border-borderc">
                  Airisu
                </span>
              </div>

              <!-- Hero Speech Bubble -->
              <div class="w-full max-w-sm bg-darkbg border border-borderc rounded-2xl p-3.5 shadow-sm text-xs leading-relaxed text-textcolor">
                <div class="font-bold text-xs text-textcolor mb-1">
                  {l.setup?.irisName || '아이리스 (Iris)'}
                </div>
                <p class="text-textcolor/90 leading-normal">
                  {irisDialogue}
                </p>
              </div>

              <!-- Clean Nickname Input Field (No chips, no clutter) -->
              <div class="w-full max-w-sm mt-1">
                <input
                  type="text"
                  bind:value={username}
                  placeholder={l.setup?.nicknameInputPlaceholder || '사용하실 닉네임을 입력해주세요'}
                  class="w-full px-4 py-3.5 rounded-2xl bg-darkbutton/40 border border-borderc text-textcolor text-center text-base focus:border-borderc focus:ring-1 focus:ring-selected outline-none transition-colors"
                  onkeydown={(e) => {
                    if (e.key === 'Enter' && username.trim()) quickStep = 2;
                  }}
                />
              </div>
            </div>

            <!-- Bottom Anchored Action Button -->
            <div class="mt-auto pt-4 border-t border-borderc/30 shrink-0">
              <button
                onclick={() => {
                  if (username.trim()) quickStep = 2;
                }}
                disabled={!username.trim()}
                class="w-full py-3.5 rounded-2xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc text-textcolor font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm disabled:opacity-40 disabled:pointer-events-none"
              >
                <span>{l.setup?.nextStep || '다음 단계로'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          </div>

        <!-- Sub-Step 2: AI Model Selection & API Key (Clean Flat Layout - NO MULTI-NESTED BOXES & NO UNNECESSARY SCROLL) -->
        {:else if quickStep === 2}
          {@const curProv = providers.find((p) => p.id === selectedProvider) || providers[0]}
          <div class="flex-1 flex flex-col justify-between py-1 gap-3.5" in:fly={{ x: 8, duration: 150 }}>
            <div class="flex flex-col gap-3.5">
              <!-- Title -->
              <div>
                <h3 class="text-base font-bold text-textcolor">AI 모델 및 API 키 설정</h3>
              </div>

              <!-- Quick Model Selector Bar -->
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-semibold text-textcolor">AI 모델</span>
                  <button
                    type="button"
                    onclick={() => (showModelBrowser = true)}
                    class="text-textcolor2 hover:text-textcolor underline text-[11px]"
                  >
                    기존 모델 브라우저에서 찾기
                  </button>
                </div>

                <!-- 4 Quick Choice Buttons -->
                <div class="grid grid-cols-4 gap-1.5">
                  <button
                    type="button"
                    onclick={() => selectModelQuick('claude-3-7-sonnet-20250219')}
                    class="py-2 px-1 rounded-xl text-xs text-center border transition-all {modelName === 'claude-3-7-sonnet-20250219' ? 'bg-selected text-textcolor border-borderc font-bold shadow-xs' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                  >
                    Claude
                  </button>
                  <button
                    type="button"
                    onclick={() => selectModelQuick('gpt-4o')}
                    class="py-2 px-1 rounded-xl text-xs text-center border transition-all {modelName === 'gpt-4o' ? 'bg-selected text-textcolor border-borderc font-bold shadow-xs' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                  >
                    GPT-4o
                  </button>
                  <button
                    type="button"
                    onclick={() => selectModelQuick('gemini-2.5-flash')}
                    class="py-2 px-1 rounded-xl text-xs text-center border transition-all {modelName === 'gemini-2.5-flash' ? 'bg-selected text-textcolor border-borderc font-bold shadow-xs' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                  >
                    Gemini
                  </button>
                  <button
                    type="button"
                    onclick={() => (showModelBrowser = true)}
                    class="py-2 px-1 rounded-xl text-xs text-center border bg-darkbutton/40 border-borderc/60 text-textcolor2 hover:text-textcolor"
                  >
                    브라우저...
                  </button>
                </div>

                <!-- Current Model Display & Direct Change Button -->
                <button
                  type="button"
                  onclick={() => (showModelBrowser = true)}
                  class="w-full px-3.5 py-2.5 rounded-xl bg-darkbutton/30 border border-borderc text-left flex items-center justify-between transition-colors hover:bg-darkbutton/60 mt-0.5"
                >
                  <div class="flex flex-col min-w-0 pr-2">
                    <span class="font-bold text-xs text-textcolor truncate">
                      {getModelInfo(modelName).name || modelName}
                    </span>
                    <span class="text-[10px] text-textcolor2 font-mono truncate">
                      {modelName}
                    </span>
                  </div>
                  <span class="text-[10px] px-2 py-1 rounded-lg bg-darkbutton border border-borderc text-textcolor font-medium shrink-0">
                    변경
                  </span>
                </button>
              </div>

              <!-- API Key Input Field (Clean single input, NO extra card nesting!) -->
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-semibold text-textcolor">{curProv.name} API 키</span>
                  {#if curProv.keyLink}
                    <a
                      href={curProv.keyLink}
                      target="_blank"
                      rel="noreferrer"
                      class="text-[11px] text-textcolor2 hover:text-textcolor underline"
                    >
                      키 발급 페이지
                    </a>
                  {/if}
                </div>

                <input
                  type="password"
                  bind:value={apiKey}
                  placeholder={curProv.keyPlaceholder || 'API 키를 입력하세요'}
                  class="w-full px-3.5 py-2.5 rounded-xl bg-darkbutton/40 border border-borderc text-textcolor text-xs focus:border-borderc focus:ring-1 focus:ring-selected outline-none transition-colors"
                />
                <span class="text-[10px] text-textcolor2 leading-tight">
                  키는 기기 내부에만 저장됩니다. (지금 비워두셔도 됩니다)
                </span>

                <!-- Custom URL for Ollama / Reverse Proxy -->
                {#if selectedProvider === 'reverse_proxy' || selectedProvider === 'ollama'}
                  <div class="flex flex-col gap-1 pt-1.5 mt-1 border-t border-borderc/40">
                    <span class="text-xs font-semibold text-textcolor">엔드포인트 URL</span>
                    <input
                      type="text"
                      bind:value={customURL}
                      placeholder={selectedProvider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'}
                      class="w-full px-3.5 py-2.5 rounded-xl bg-darkbutton/40 border border-borderc text-textcolor text-xs focus:border-borderc focus:ring-1 focus:ring-selected outline-none transition-colors"
                    />
                  </div>
                {/if}
              </div>

              <!-- Collapsible Advanced Settings (No nested cards!) -->
              <div class="flex flex-col gap-2">
                <button
                  type="button"
                  onclick={() => (showAdvanced = !showAdvanced)}
                  class="text-left text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 py-0.5 transition-colors"
                >
                  <span>세부 옵션 (컨텍스트 토큰, 번역 모드)</span>
                  <ChevronDown class="w-3 h-3 transition-transform duration-150 {showAdvanced ? 'rotate-180' : ''}" />
                </button>

                {#if showAdvanced}
                  <div class="flex flex-col gap-3 pt-1 border-t border-borderc/30" in:fade={{ duration: 120 }}>
                    <!-- Manual Model ID Input -->
                    <div class="flex flex-col gap-1">
                      <span class="text-[11px] font-semibold text-textcolor">모델 ID 직접 입력</span>
                      <input
                        type="text"
                        bind:value={modelName}
                        placeholder="예: claude-3-7-sonnet"
                        class="w-full px-3 py-2 rounded-lg bg-darkbutton/40 border border-borderc text-textcolor text-xs focus:border-borderc focus:ring-1 focus:ring-selected outline-none transition-colors"
                      />
                    </div>

                    <!-- Context Token Setting -->
                    <div class="flex flex-col gap-1">
                      <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold text-textcolor">최대 컨텍스트 토큰</span>
                        <span class="text-[10px] text-textcolor2 font-medium">{maxContext.toLocaleString()}</span>
                      </div>
                      <div class="grid grid-cols-6 gap-1">
                        {#each contextPresets as cp}
                          <button
                            type="button"
                            onclick={() => (maxContext = cp.value)}
                            class="py-1 rounded text-[10px] border text-center font-medium transition-colors {maxContext === cp.value ? 'bg-selected text-textcolor border-borderc font-semibold' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                          >
                            {cp.label}
                          </button>
                        {/each}
                      </div>
                    </div>

                    <!-- Chat Translation Mode Tabs -->
                    <div class="flex flex-col gap-1">
                      <span class="text-[11px] font-semibold text-textcolor">채팅 번역 모드</span>
                      <div class="grid grid-cols-3 gap-1">
                        <button
                          type="button"
                          onclick={() => (chatLang = 0)}
                          class="py-1.5 rounded-lg border text-[10px] font-medium transition-colors {chatLang === 0 ? 'bg-selected text-textcolor border-borderc font-semibold' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                        >
                          영어 원문
                        </button>
                        <button
                          type="button"
                          onclick={() => (chatLang = 1)}
                          class="py-1.5 rounded-lg border text-[10px] font-medium transition-colors {chatLang === 1 ? 'bg-selected text-textcolor border-borderc font-semibold' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                        >
                          자동 번역
                        </button>
                        <button
                          type="button"
                          onclick={() => (chatLang = 2)}
                          class="py-1.5 rounded-lg border text-[10px] font-medium transition-colors {chatLang === 2 ? 'bg-selected text-textcolor border-borderc font-semibold' : 'bg-darkbutton/40 border-borderc/60 text-textcolor2'}"
                        >
                          직접 입력
                        </button>
                      </div>
                    </div>
                  </div>
                {/if}
              </div>
            </div>

            <!-- Sub-Step 2 Buttons (At bottom, no scroll needed!) -->
            <div class="flex items-center gap-2 pt-2 border-t border-borderc/40 mt-auto">
              <button
                onclick={() => (quickStep = 1)}
                class="w-1/3 py-2.5 rounded-xl border border-borderc text-xs font-semibold text-textcolor2 active:bg-darkbutton transition-colors text-center"
              >
                이전
              </button>

              <button
                onclick={() => (quickStep = 3)}
                class="w-2/3 py-2.5 rounded-xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc text-textcolor font-semibold text-xs transition-all active:scale-[0.98] flex items-center justify-center gap-1.5 shadow-sm"
              >
                <span>설정 완료하기</span>
                <ArrowRight class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

        <!-- Sub-Step 3: All Ready Celebration -->
        {:else if quickStep === 3}
          <div class="flex flex-col items-center justify-center text-center p-4 gap-3 my-auto" in:scale={{ duration: 200 }}>
            <div class="p-3 rounded-full bg-selected/30 text-textcolor border border-borderc">
              <CheckCircle2 class="w-8 h-8" />
            </div>
            <div>
              <h3 class="text-base font-bold text-textcolor">
                {l.setup?.allDone || '모든 설정이 완료되었습니다.'}
              </h3>
              <p class="text-xs text-textcolor2 mt-1 max-w-xs leading-relaxed">
                {l.setup?.allSetMessage || 'Haejeok RisuAI를 시작합니다.'}
              </p>
            </div>

            <button
              onclick={finishAndEnterApp}
              class="w-full py-3.5 rounded-2xl bg-darkbutton hover:bg-selected active:bg-selected border border-borderc text-textcolor font-bold text-sm shadow-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-2"
            >
              <span>{l.setup?.finishSetup || 'Haejeok RisuAI 시작하기'}</span>
              <ArrowRight class="w-4 h-4" />
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Official Model Browser Modal -->
    {#if showModelBrowser}
      <div
        class="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex flex-col justify-end sm:justify-center p-0 sm:p-4"
        in:fade={{ duration: 150 }}
      >
        <div
          class="bg-bgcolor border border-borderc rounded-t-3xl sm:rounded-2xl max-h-[85vh] h-[80vh] flex flex-col p-4 shadow-2xl overflow-hidden"
          in:fly={{ y: 20, duration: 200 }}
        >
          <!-- Modal Header -->
          <div class="flex items-center justify-between pb-3 border-b border-borderc shrink-0">
            <div class="flex items-center gap-2">
              <Bot class="w-4 h-4 text-textcolor" />
              <h3 class="font-bold text-sm text-textcolor">AI 모델 브라우저 (기존 공식 목록)</h3>
            </div>
            <button
              onclick={() => (showModelBrowser = false)}
              class="p-1.5 rounded-xl hover:bg-darkbutton text-textcolor2 hover:text-textcolor transition-colors"
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          <!-- Official ModelBrowser Component -->
          <div class="flex-1 overflow-y-auto min-h-0 pt-3">
            <ModelBrowser
              bind:value={modelName}
              onChange={(newModelId) => {
                modelName = newModelId;
                const info = getModelInfo(newModelId);
                if (info.provider === LLMProvider.Anthropic || info.provider === LLMProvider.AWS) {
                  selectedProvider = 'claude';
                } else if (info.provider === LLMProvider.OpenAI) {
                  selectedProvider = 'openai';
                } else if (info.provider === LLMProvider.GoogleCloud || info.provider === LLMProvider.VertexAI) {
                  selectedProvider = 'gemini';
                } else if (newModelId.startsWith('openrouter') || info.id.startsWith('openrouter') || info.format === 11) {
                  selectedProvider = 'openrouter';
                } else if (info.provider === LLMProvider.Ollama) {
                  selectedProvider = 'ollama';
                } else if (info.provider === LLMProvider.Horde) {
                  selectedProvider = 'horde';
                }
                showModelBrowser = false;
              }}
            />
          </div>
        </div>
      </div>
    {/if}

  </main>
</div>
