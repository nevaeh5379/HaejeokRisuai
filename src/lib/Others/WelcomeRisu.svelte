<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import {
    Sparkles,
    Database,
    Upload,
    ArrowRight,
    ArrowLeft,
    Check,
    CheckCircle2,
    AlertCircle,
    Globe,
    User,
    Key,
    RefreshCw,
    FileText,
    Layers,
    Bot,
    Zap,
    ChevronRight,
    FileUp,
    X,
    FolderCheck,
    MessageSquare,
    ExternalLink
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
    parseLegacyDatabaseBytes,
    migrateLegacyDatabase,
    type LegacyDatabaseInfo
  } from 'src/ts/storage/migration';
  import Airisu from '../../etc/Airisu.webp';

  type Stage = 'gateway' | 'migration' | 'quick-setup' | 'done';

  let currentStage = $state<Stage>('gateway');
  let quickStep = $state<number>(1); // 1: Username, 2: Provider, 3: Key & Options, 4: Done

  // Form State
  let username = $state(settingsStore.state.username || '');
  let selectedProvider = $state('claude');
  let apiKey = $state('');
  let chatLang = $state(0); // 0: English, 1: Auto translate, 2: Direct
  let chatMemory = $state(2); // 0: 16k, 1: 8k, 2: 12k (Balanced), 3: 100k

  // Migration State
  let isCheckingLocal = $state(true);
  let detectedLocalDb = $state<LegacyDatabaseInfo | null>(null);
  let parsedDbInfo = $state<LegacyDatabaseInfo | null>(null);
  let isDragging = $state(false);
  let isMigrating = $state(false);
  let migrationProgress = $state('');
  let migrationDone = $state(false);
  let migrationError = $state<string | null>(null);
  let fileInputRef = $state<HTMLInputElement | null>(null);

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
      sub: 'Claude 3.7 Sonnet',
      badge: '추천 (Recommended)',
      badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
      activeClass: 'ring-2 ring-amber-500 bg-amber-500/10',
      descKey: 'modelClaudeDesc',
      keyLink: 'https://console.anthropic.com/settings/keys',
      keyPlaceholder: 'sk-ant-api03-...',
    },
    {
      id: 'openai',
      name: 'OpenAI (ChatGPT)',
      sub: 'GPT-4o',
      badge: '인기 (Popular)',
      badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      activeClass: 'ring-2 ring-emerald-500 bg-emerald-500/10',
      descKey: 'modelOpenAIDesc',
      keyLink: 'https://platform.openai.com/api-keys',
      keyPlaceholder: 'sk-proj-...',
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      sub: 'Gemini 2.5 Flash',
      badge: '무료 티어 (Free Tier)',
      badgeClass: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
      activeClass: 'ring-2 ring-blue-500 bg-blue-500/10',
      descKey: 'modelGeminiDesc',
      keyLink: 'https://aistudio.google.com/app/apikey',
      keyPlaceholder: 'AIzaSy...',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      sub: 'Multi-model Hub',
      badge: '다양한 모델 (Flexible)',
      badgeClass: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
      activeClass: 'ring-2 ring-purple-500 bg-purple-500/10',
      descKey: 'modelOpenRouterDesc',
      keyLink: 'https://openrouter.ai/keys',
      keyPlaceholder: 'sk-or-v1-...',
    },
    {
      id: 'ollama',
      name: 'Ollama / Local',
      sub: 'Offline Private',
      badge: '로컬/오프라인',
      badgeClass: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
      activeClass: 'ring-2 ring-slate-400 bg-slate-500/10',
      descKey: 'modelOllamaDesc',
      keyLink: '',
      keyPlaceholder: '',
    },
    {
      id: 'horde',
      name: 'AI Horde',
      sub: 'Distributed Community',
      badge: '무료 (Free)',
      badgeClass: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
      activeClass: 'ring-2 ring-yellow-500 bg-yellow-500/10',
      descKey: 'modelHordeDesc',
      keyLink: '',
      keyPlaceholder: '',
    },
  ];

  // Dynamic Iris Speech Bubble text
  let irisDialogue = $derived.by(() => {
    if (migrationDone) {
      return language.setup?.migrationSuccessDesc || '성공적으로 이전되었어요! 이제 즐겨보세요~';
    }
    if (isMigrating) {
      return migrationProgress || (language.setup?.migrationInProgress || '열심히 데이터를 변환하고 있어요...');
    }
    if (migrationError) {
      return language.setup?.migrationFailedDesc || '앗, 파일을 읽는 도중 오류가 발생했어요...';
    }
    if (currentStage === 'migration') {
      if (parsedDbInfo) {
        return `데이터를 확인했어요! 캐릭터 ${parsedDbInfo.stats.characterCount}명, 대화 ${parsedDbInfo.stats.chatCount}개를 복원할까요?`;
      }
      if (detectedLocalDb) {
        return language.setup?.detectedLegacyDbDesc || '기존 database.bin을 찾았어요! 바로 마이그레이션할까요?';
      }
      return language.setup?.dropDatabaseBinTitle || 'database.bin 파일을 올려주시면 제가 척척 복원해드릴게요!';
    }
    if (currentStage === 'quick-setup') {
      if (quickStep === 1) return language.setup?.welcome || '만나서 반가워요! 먼저 닉네임을 알려주시겠어요?';
      if (quickStep === 2) return language.setup?.selectAiModelDesc || '사용하고 싶으신 AI 모델을 골라주세요!';
      if (quickStep === 3) return language.setup?.chooseChatType || 'API 키와 채팅 설정을 확인해주세요!';
      if (quickStep === 4) return language.setup?.allSetMessage || '모든 준비가 끝났어요! 리스AI를 시작해볼까요~? ✨';
    }
    if (detectedLocalDb) {
      return `우와! 이전 데이터(캐릭터 ${detectedLocalDb.stats.characterCount}명)를 발견했어요! 바로 복원해드릴까요? ✨`;
    }
    return language.setup?.welcomeGreeting || '안녕하세요~! 리스AI에 오신 걸 환영해요! ✨ 저는 시작을 도와드릴 아이리스예요.';
  });

  async function handleLanguageSelect(langCode: string) {
    settingsStore.state.language = langCode;
    await changeLanguage(langCode);
  }

  // Check for existing database.bin on mount
  onMount(() => {
    const browserLang = navigator.language.split('-')[0];
    const usableLangs = ['de', 'en', 'ko', 'cn', 'vi', 'zh-Hant', 'es'];
    if (usableLangs.includes(browserLang) && settingsStore.state.language !== browserLang) {
      settingsStore.state.language = browserLang;
      void changeLanguage(browserLang);
    }

    void detectLocalLegacyDatabase().then((info) => {
      isCheckingLocal = false;
      if (info && info.stats.characterCount > 0) {
        detectedLocalDb = info;
      }
    }).catch(() => {
      isCheckingLocal = false;
    });
  });

  // Handle drag and drop or manual file selection
  async function processSelectedFile(file: File) {
    if (!file) return;
    migrationError = null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const info = await parseLegacyDatabaseBytes(bytes, 'uploaded', file.name);
      if (!info || info.stats.characterCount === 0) {
        migrationError = language.setup?.migrationFailedDesc || '올바른 데이터베이스 파일이 아니거나 데이터가 비어 있습니다.';
        return;
      }
      parsedDbInfo = info;
    } catch (err: any) {
      console.error('File parsing error:', err);
      migrationError = err?.message || '파일을 읽는 중 오류가 발생했습니다.';
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      void processSelectedFile(e.dataTransfer.files[0]);
    }
  }

  function handleFileInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      void processSelectedFile(target.files[0]);
    }
  }

  // Execute database migration
  async function performMigration(info: LegacyDatabaseInfo) {
    isMigrating = true;
    migrationError = null;
    migrationProgress = language.setup?.migrationInProgress || '데이터를 SQL 저장소로 변환하는 중...';

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
        migrationError = language.setup?.migrationFailedDesc || '마이그레이션에 실패했습니다.';
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

    if (username.trim()) {
      settingsStore.state.username = username.trim();
    }

    // Context & Memory setup
    switch (chatMemory) {
      case 0:
        settingsStore.state.maxContext = 16000;
        settingsStore.state.maxResponse = 1000;
        break;
      case 1:
        settingsStore.state.maxContext = 8000;
        settingsStore.state.maxResponse = 500;
        break;
      case 2:
        settingsStore.state.maxContext = 12000;
        settingsStore.state.maxResponse = 800;
        break;
      case 3:
        settingsStore.state.maxContext = 100000;
        settingsStore.state.maxResponse = 1000;
        break;
    }

    // Provider & model setup
    if (selectedProvider === 'claude') {
      settingsStore.state.aiModel = 'claude-3-7-sonnet-20250219';
      settingsStore.state.subModel = 'claude-3-7-sonnet-20250219';
      if (apiKey.trim()) settingsStore.state.claudeAPIKey = apiKey.trim();
      settingsStore.state.claudeCachingExperimental = true;
    } else if (selectedProvider === 'openai') {
      settingsStore.state.aiModel = 'gpt-4o';
      settingsStore.state.subModel = 'gpt-4o';
      if (apiKey.trim()) settingsStore.state.openAIKey = apiKey.trim();
    } else if (selectedProvider === 'gemini') {
      settingsStore.state.aiModel = 'gemini-2.5-flash';
      settingsStore.state.subModel = 'gemini-2.5-flash';
      if (apiKey.trim()) settingsStore.state.googleKey = apiKey.trim();
    } else if (selectedProvider === 'openrouter') {
      settingsStore.state.aiModel = 'openrouter';
      settingsStore.state.subModel = 'openrouter';
      settingsStore.state.openrouterRequestModel = 'anthropic/claude-3.7-sonnet';
      if (apiKey.trim()) settingsStore.state.openrouterKey = apiKey.trim();
    } else if (selectedProvider === 'ollama') {
      settingsStore.state.aiModel = 'ollama';
      settingsStore.state.subModel = 'ollama';
    } else if (selectedProvider === 'horde') {
      settingsStore.state.aiModel = 'horde:::auto';
      settingsStore.state.subModel = 'horde:::auto';
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

<div class="relative w-full h-full min-h-screen bg-bgcolor text-textcolor flex flex-col items-center justify-center p-3 md:p-6 overflow-y-auto selection:bg-blue-500 selection:text-white">
  <!-- Subtle Background Glows -->
  <div class="absolute -top-32 -left-32 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none"></div>
  <div class="absolute -bottom-32 -right-32 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>

  <!-- Header: Language Bar -->
  <header class="w-full max-w-4xl flex items-center justify-between py-2 px-1 mb-4 z-10">
    <div class="flex items-center gap-2">
      <img src="/logo_192.png" alt="RisuAI" class="w-7 h-7 object-contain drop-shadow" />
      <span class="font-bold text-lg tracking-tight text-textcolor">RisuAI</span>
    </div>

    <!-- Language Selector Pills -->
    <div class="flex items-center gap-1 bg-darkbg/80 border border-borderc/40 backdrop-blur-md px-2 py-1 rounded-full text-xs shadow-sm overflow-x-auto max-w-[70vw]">
      <Globe class="w-3.5 h-3.5 text-textcolor2 shrink-0 mr-1" />
      {#each languages as item}
        <button
          onclick={() => handleLanguageSelect(item.code)}
          class="px-2 py-0.5 rounded-full transition-all flex items-center gap-1 font-medium whitespace-nowrap {settingsStore.state.language === item.code ? 'bg-selected text-white shadow-sm' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
        >
          <span>{item.flag}</span>
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
  </header>

  <!-- Main Container -->
  <main class="w-full max-w-4xl bg-darkbg/70 border border-borderc/60 backdrop-blur-xl rounded-3xl p-5 md:p-8 shadow-2xl flex flex-col md:flex-row gap-6 relative z-10 transition-all">

    <!-- Left Column: Cute Iris Mascot & Dialogue -->
    <aside class="flex flex-col items-center md:items-start md:w-72 shrink-0 gap-4">
      <div class="relative group">
        <!-- Mascot Ambient Ring -->
        <div class="absolute inset-0 rounded-full bg-gradient-to-tr from-blue-500/30 to-indigo-400/20 blur-xl scale-95 group-hover:scale-105 transition-transform duration-500"></div>
        
        <!-- Iris Sprite Avatar -->
        <div class="relative w-36 h-36 md:w-48 md:h-48 rounded-2xl overflow-hidden border-2 border-borderc/40 bg-gradient-to-b from-darkbutton to-darkbg shadow-lg flex items-center justify-center">
          <img
            src={Airisu}
            alt="Iris"
            class="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-300"
          />
          <span class="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[10px] text-blue-300 font-semibold border border-blue-400/30 flex items-center gap-1">
            <Sparkles class="w-2.5 h-2.5 text-blue-400 animate-pulse" />
            Airisu
          </span>
        </div>
      </div>

      <!-- Mascot Speech Bubble -->
      <div class="w-full bg-bgcolor/80 border border-borderc/50 rounded-2xl p-4 shadow-md relative text-sm leading-relaxed text-textcolor transition-all">
        <div class="flex items-center gap-1.5 font-bold text-xs text-blue-400 mb-1">
          <Sparkles class="w-3.5 h-3.5" />
          <span>아이리스 (Iris)</span>
        </div>
        <p class="text-textcolor/90">
          {irisDialogue}
        </p>
      </div>
    </aside>

    <!-- Right Column: Interactive Step Stages -->
    <section class="flex-1 flex flex-col justify-between min-h-[380px]">

      <!-- ================= STAGE 1: GATEWAY ================= -->
      {#if currentStage === 'gateway'}
        <div class="flex flex-col gap-4" in:fade={{ duration: 200 }}>
          <div>
            <h1 class="text-2xl md:text-3xl font-extrabold tracking-tight text-textcolor flex items-center gap-2">
              <span>{language.setup?.welcomeGreeting || '리스AI에 오신 걸 환영해요! ✨'}</span>
            </h1>
            <p class="text-textcolor2 text-sm mt-1">
              {language.setup?.welcomeSubGreeting || '원하시는 시작 방법을 선택해주세요.'}
            </p>
          </div>

          <!-- Highlight Banner: Detected Local database.bin -->
          {#if detectedLocalDb}
            <div
              in:fly={{ y: 10, duration: 300 }}
              class="relative overflow-hidden rounded-2xl border-2 border-blue-500/60 bg-gradient-to-r from-blue-500/15 via-indigo-500/10 to-transparent p-4 shadow-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
            >
              <div class="flex items-start gap-3">
                <div class="p-2.5 rounded-xl bg-blue-500/20 text-blue-400 border border-blue-500/30">
                  <Database class="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <h3 class="font-bold text-base text-textcolor">
                      {language.setup?.detectedLegacyDbTitle || '기존 저장 데이터(database.bin) 발견!'}
                    </h3>
                    <span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-500 text-white font-bold">DETECTED</span>
                  </div>
                  <p class="text-xs text-textcolor2 mt-0.5">
                    캐릭터 {detectedLocalDb.stats.characterCount}명 · 대화 {detectedLocalDb.stats.chatCount}개 · 프리셋 {detectedLocalDb.stats.presetCount}개
                  </p>
                </div>
              </div>

              <button
                onclick={() => {
                  parsedDbInfo = detectedLocalDb;
                  currentStage = 'migration';
                }}
                class="w-full sm:w-auto px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md transition-all flex items-center justify-center gap-1.5 shrink-0"
              >
                <span>{language.setup?.migrateDetectedBtn || '바로 마이그레이션'}</span>
                <Zap class="w-3.5 h-3.5 fill-current" />
              </button>
            </div>
          {/if}

          <!-- 3-Way Choice Cards -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
            <!-- Option 1: Data Migration / Restore -->
            <button
              onclick={() => {
                currentStage = 'migration';
              }}
              class="group relative text-left p-4 rounded-2xl border border-borderc/60 bg-darkbutton/50 hover:bg-darkbutton hover:border-blue-400/50 hover:shadow-lg transition-all flex flex-col justify-between"
            >
              <div class="flex items-start justify-between w-full mb-3">
                <div class="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 group-hover:scale-110 transition-transform">
                  <Database class="w-5 h-5" />
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded-full bg-darkbg text-textcolor2 border border-borderc/40 font-medium">
                  {detectedLocalDb ? '발견됨' : '백업 파일'}
                </span>
              </div>
              <div>
                <h2 class="font-bold text-base text-textcolor group-hover:text-blue-400 transition-colors">
                  {language.setup?.gatewayMigrationTitle || '기존 데이터 가져오기'}
                </h2>
                <p class="text-xs text-textcolor2 mt-1 leading-normal">
                  {language.setup?.gatewayMigrationDesc || 'database.bin 또는 .risum 백업 파일에서 캐릭터와 대화를 복원합니다.'}
                </p>
              </div>
              <div class="flex items-center text-xs text-blue-400 font-semibold mt-3 gap-1">
                <span>불러오기</span>
                <ChevronRight class="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </button>

            <!-- Option 2: Quick AI Setup -->
            <button
              onclick={() => {
                currentStage = 'quick-setup';
                quickStep = 1;
              }}
              class="group relative text-left p-4 rounded-2xl border border-borderc/60 bg-darkbutton/50 hover:bg-darkbutton hover:border-emerald-400/50 hover:shadow-lg transition-all flex flex-col justify-between"
            >
              <div class="flex items-start justify-between w-full mb-3">
                <div class="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:scale-110 transition-transform">
                  <Bot class="w-5 h-5" />
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold">
                  신규 추천
                </span>
              </div>
              <div>
                <h2 class="font-bold text-base text-textcolor group-hover:text-emerald-400 transition-colors">
                  {language.setup?.gatewayQuickSetupTitle || 'AI 빠른 추천 설정'}
                </h2>
                <p class="text-xs text-textcolor2 mt-1 leading-normal">
                  {language.setup?.gatewayQuickSetupDesc || '닉네임과 Claude, OpenAI, Gemini 등 AI 모델을 빠르게 설정합니다.'}
                </p>
              </div>
              <div class="flex items-center text-xs text-emerald-400 font-semibold mt-3 gap-1">
                <span>시작하기</span>
                <ChevronRight class="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </button>
          </div>

          <!-- Option 3: Skip / Explore directly -->
          <div class="flex justify-end mt-2">
            <button
              onclick={finishAndEnterApp}
              class="text-xs text-textcolor2 hover:text-textcolor px-3 py-1.5 rounded-lg hover:bg-darkbutton transition-all flex items-center gap-1.5"
            >
              <span>{language.setup?.gatewaySkipTitle || '직접 설정할래요 (건너뛰기)'}</span>
              <ArrowRight class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      {/if}

      <!-- ================= STAGE 2: MIGRATION ================= -->
      {#if currentStage === 'migration'}
        <div class="flex flex-col gap-4" in:fade={{ duration: 200 }}>
          <!-- Top Navigation Header -->
          <div class="flex items-center justify-between border-b border-borderc/40 pb-3">
            <button
              onclick={() => {
                if (!isMigrating) {
                  currentStage = 'gateway';
                  parsedDbInfo = null;
                  migrationError = null;
                }
              }}
              disabled={isMigrating}
              class="text-xs text-textcolor2 hover:text-textcolor flex items-center gap-1 disabled:opacity-50 transition-colors"
            >
              <ArrowLeft class="w-3.5 h-3.5" />
              <span>{language.setup?.prevStep || '이전으로'}</span>
            </button>
            <h2 class="font-bold text-sm text-textcolor flex items-center gap-1.5">
              <Database class="w-4 h-4 text-blue-400" />
              <span>{language.setup?.gatewayMigrationTitle || '데이터 마이그레이션'}</span>
            </h2>
          </div>

          <!-- Error Alert Banner -->
          {#if migrationError}
            <div in:fly={{ y: -5, duration: 200 }} class="p-3 rounded-xl bg-red-500/10 border border-red-500/40 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle class="w-4 h-4 text-red-400 shrink-0" />
              <span>{migrationError}</span>
            </div>
          {/if}

          <!-- Sub-state 1: File selection / Drag-and-drop if no parsed data yet -->
          {#if !parsedDbInfo && !migrationDone}
            <div class="flex flex-col gap-3">
              <!-- Local detection quick load card (if available) -->
              {#if detectedLocalDb}
                <div class="p-3.5 rounded-2xl border border-blue-500/40 bg-blue-500/10 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2.5">
                    <FolderCheck class="w-5 h-5 text-blue-400 shrink-0" />
                    <div>
                      <h4 class="font-bold text-xs text-textcolor">
                        {language.setup?.detectedLegacyDbTitle || '로컬 저장소에서 database.bin 감지됨'}
                      </h4>
                      <p class="text-[11px] text-textcolor2">
                        캐릭터 {detectedLocalDb.stats.characterCount}명 · 대화 {detectedLocalDb.stats.chatCount}개
                      </p>
                    </div>
                  </div>
                  <button
                    onclick={() => {
                      parsedDbInfo = detectedLocalDb;
                    }}
                    class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition-colors shrink-0"
                  >
                    데이터 확인하기
                  </button>
                </div>
              {/if}

              <!-- Interactive Drag & Drop Area -->
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
                onclick={() => fileInputRef?.click()}
                class="border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all gap-3 {isDragging ? 'border-blue-400 bg-blue-500/10 scale-[1.01]' : 'border-borderc/60 bg-darkbutton/30 hover:border-blue-400/50 hover:bg-darkbutton/60'}"
              >
                <input
                  type="file"
                  accept=".bin,.risum,.risup"
                  bind:this={fileInputRef}
                  onchange={handleFileInputChange}
                  class="hidden"
                />
                <div class="p-3.5 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <FileUp class="w-7 h-7" />
                </div>
                <div>
                  <h3 class="font-bold text-sm text-textcolor">
                    {language.setup?.dropDatabaseBinTitle || 'database.bin 파일을 여기에 끌어다 놓으세요'}
                  </h3>
                  <p class="text-xs text-textcolor2 mt-1">
                    {language.setup?.dropDatabaseBinDesc || '또는 클릭하여 database.bin / .risum / .risup 백업 파일 선택'}
                  </p>
                </div>
                <button
                  type="button"
                  class="px-4 py-1.5 rounded-xl bg-darkbg border border-borderc/60 hover:bg-darkbutton text-xs font-semibold text-textcolor shadow-sm transition-all pointer-events-none"
                >
                  {language.setup?.selectFileBtn || '파일 선택'}
                </button>
              </div>
            </div>

          <!-- Sub-state 2: Parsed Preview -->
          {:else if parsedDbInfo && !migrationDone}
            <div class="flex flex-col gap-4" in:scale={{ duration: 200, start: 0.98 }}>
              <div class="flex items-center justify-between">
                <h3 class="font-bold text-sm text-textcolor flex items-center gap-1.5">
                  <Sparkles class="w-4 h-4 text-amber-400" />
                  <span>{language.setup?.migrationPreviewTitle || '가져올 데이터 미리보기'}</span>
                </h3>
                {#if !isMigrating}
                  <button
                    onclick={() => {
                      parsedDbInfo = null;
                      migrationError = null;
                    }}
                    class="text-xs text-textcolor2 hover:text-textcolor underline"
                  >
                    {language.setup?.chooseAnotherFile || '다른 파일 선택'}
                  </button>
                {/if}
              </div>

              <!-- Stats Summary Cards Grid -->
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div class="p-3 rounded-2xl bg-darkbutton/60 border border-borderc/40 flex flex-col">
                  <span class="text-[11px] text-textcolor2 flex items-center gap-1 mb-1">
                    <User class="w-3.5 h-3.5 text-blue-400" />
                    {language.setup?.migrationCharacters || '캐릭터'}
                  </span>
                  <span class="text-lg font-extrabold text-textcolor">{parsedDbInfo.stats.characterCount}명</span>
                </div>

                <div class="p-3 rounded-2xl bg-darkbutton/60 border border-borderc/40 flex flex-col">
                  <span class="text-[11px] text-textcolor2 flex items-center gap-1 mb-1">
                    <MessageSquare class="w-3.5 h-3.5 text-emerald-400" />
                    {language.setup?.migrationChats || '대화 기록'}
                  </span>
                  <span class="text-lg font-extrabold text-textcolor">{parsedDbInfo.stats.chatCount}개</span>
                </div>

                <div class="p-3 rounded-2xl bg-darkbutton/60 border border-borderc/40 flex flex-col">
                  <span class="text-[11px] text-textcolor2 flex items-center gap-1 mb-1">
                    <Bot class="w-3.5 h-3.5 text-purple-400" />
                    {language.setup?.migrationPresets || '프리셋'}
                  </span>
                  <span class="text-lg font-extrabold text-textcolor">{parsedDbInfo.stats.presetCount}개</span>
                </div>

                <div class="p-3 rounded-2xl bg-darkbutton/60 border border-borderc/40 flex flex-col">
                  <span class="text-[11px] text-textcolor2 flex items-center gap-1 mb-1">
                    <Layers class="w-3.5 h-3.5 text-amber-400" />
                    {language.setup?.migrationModules || '모듈'}
                  </span>
                  <span class="text-lg font-extrabold text-textcolor">{parsedDbInfo.stats.moduleCount}개</span>
                </div>
              </div>

              <!-- Nickname Preview -->
              {#if parsedDbInfo.stats.username}
                <div class="text-xs text-textcolor2 px-1">
                  기존 닉네임: <strong class="text-textcolor">{parsedDbInfo.stats.username}</strong>
                </div>
              {/if}

              <!-- Migration Progress / Action -->
              {#if isMigrating}
                <div class="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex flex-col items-center gap-3">
                  <RefreshCw class="w-6 h-6 text-blue-400 animate-spin" />
                  <span class="text-xs font-semibold text-textcolor">{migrationProgress}</span>
                </div>
              {:else}
                <button
                  onclick={() => {
                    if (parsedDbInfo) void performMigration(parsedDbInfo);
                  }}
                  class="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm shadow-lg transition-all flex items-center justify-center gap-2"
                >
                  <span>{language.setup?.startMigrationBtn || '이 데이터로 마이그레이션 시작 🚀'}</span>
                </button>
              {/if}
            </div>

          <!-- Sub-state 3: Migration Completed -->
          {:else if migrationDone}
            <div class="flex flex-col items-center justify-center text-center p-6 gap-4" in:scale={{ duration: 250 }}>
              <div class="p-4 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-bounce">
                <CheckCircle2 class="w-10 h-10" />
              </div>
              <div>
                <h3 class="text-xl font-extrabold text-textcolor">
                  {language.setup?.migrationSuccessTitle || '마이그레이션 완료! 🎉'}
                </h3>
                <p class="text-xs text-textcolor2 mt-1 max-w-sm">
                  {language.setup?.migrationSuccessDesc || '모든 캐릭터와 대화 기록이 새로운 고성능 SQL 저장소로 이전되었습니다.'}
                </p>
              </div>

              <button
                onclick={finishAndEnterApp}
                class="px-8 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg transition-all flex items-center gap-2"
              >
                <span>{language.setup?.finishSetup || '리스AI 시작하기 🚀'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- ================= STAGE 3: QUICK AI SETUP ================= -->
      {#if currentStage === 'quick-setup'}
        <div class="flex flex-col gap-4" in:fade={{ duration: 200 }}>
          <!-- Step Nav Indicator -->
          <div class="flex items-center justify-between border-b border-borderc/40 pb-3">
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
              <span>{language.setup?.prevStep || '이전'}</span>
            </button>

            <!-- Step Dots -->
            <div class="flex items-center gap-1.5">
              {#each [1, 2, 3, 4] as s}
                <div class="h-1.5 rounded-full transition-all {quickStep === s ? 'w-6 bg-blue-500' : 'w-2 bg-borderc/60'}"></div>
              {/each}
            </div>

            <span class="text-xs font-semibold text-textcolor2">Step {quickStep}/4</span>
          </div>

          <!-- Sub-Step 1: Nickname Input -->
          {#if quickStep === 1}
            <div class="flex flex-col gap-4 my-auto" in:fly={{ x: 10, duration: 200 }}>
              <div>
                <h3 class="text-lg font-bold text-textcolor flex items-center gap-2">
                  <User class="w-5 h-5 text-blue-400" />
                  <span>{language.setup?.inputName || '닉네임을 입력해주세요'}</span>
                </h3>
                <p class="text-xs text-textcolor2 mt-1">
                  대화에서 사용할 본인의 이름을 정해주세요.
                </p>
              </div>

              <input
                type="text"
                bind:value={username}
                placeholder={language.setup?.nicknameInputPlaceholder || '예: 모험가, 지훈, User'}
                class="w-full px-4 py-3 rounded-2xl bg-darkbutton/60 border border-borderc text-textcolor text-base focus:border-blue-400 outline-none transition-colors"
                onkeydown={(e) => {
                  if (e.key === 'Enter') quickStep = 2;
                }}
              />

              <button
                onclick={() => (quickStep = 2)}
                class="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm transition-colors flex items-center justify-center gap-1.5"
              >
                <span>{language.setup?.nextStep || '다음'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>

          <!-- Sub-Step 2: AI Provider Selection -->
          {:else if quickStep === 2}
            <div class="flex flex-col gap-3" in:fly={{ x: 10, duration: 200 }}>
              <div>
                <h3 class="text-lg font-bold text-textcolor flex items-center gap-2">
                  <Bot class="w-5 h-5 text-purple-400" />
                  <span>{language.setup?.selectAiModel || 'AI 모델 제공자 선택'}</span>
                </h3>
                <p class="text-xs text-textcolor2 mt-0.5">
                  {language.setup?.selectAiModelDesc || '주로 사용하실 AI 제공자를 선택해주세요.'}
                </p>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[260px] overflow-y-auto pr-1">
                {#each providers as prov}
                  <button
                    onclick={() => {
                      selectedProvider = prov.id;
                    }}
                    class="text-left p-3 rounded-2xl border transition-all flex flex-col justify-between {selectedProvider === prov.id ? prov.activeClass : 'border-borderc/60 bg-darkbutton/40 hover:bg-darkbutton'}"
                  >
                    <div class="flex items-center justify-between w-full">
                      <span class="font-bold text-xs text-textcolor">{prov.name}</span>
                      <span class="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold {prov.badgeClass}">
                        {prov.badge}
                      </span>
                    </div>
                    <span class="text-[11px] text-textcolor2 mt-1">{prov.sub}</span>
                  </button>
                {/each}
              </div>

              <button
                onclick={() => (quickStep = 3)}
                class="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm transition-colors flex items-center justify-center gap-1.5 mt-2"
              >
                <span>{language.setup?.nextStep || '다음 단계로'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>

          <!-- Sub-Step 3: API Key & Options -->
          {:else if quickStep === 3}
            {@const curProv = providers.find((p) => p.id === selectedProvider)}
            <div class="flex flex-col gap-3" in:fly={{ x: 10, duration: 200 }}>
              <div>
                <h3 class="text-base font-bold text-textcolor flex items-center gap-2">
                  <Key class="w-4 h-4 text-amber-400" />
                  <span>{curProv?.name} {language.setup?.inputApiKeyTitle || 'API 키 및 설정'}</span>
                </h3>
                {#if curProv?.keyLink}
                  <a
                    href={curProv.keyLink}
                    target="_blank"
                    rel="noreferrer"
                    class="text-xs text-blue-400 hover:underline flex items-center gap-1 mt-0.5"
                  >
                    <span>API 키 발급 페이지 바로가기</span>
                    <ExternalLink class="w-3 h-3" />
                  </a>
                {/if}
              </div>

              {#if curProv?.keyPlaceholder}
                <div class="flex flex-col gap-1">
                  <input
                    type="password"
                    bind:value={apiKey}
                    placeholder={curProv.keyPlaceholder}
                    class="w-full px-3.5 py-2.5 rounded-xl bg-darkbutton/60 border border-borderc text-textcolor text-sm focus:border-blue-400 outline-none transition-colors"
                  />
                  <span class="text-[11px] text-textcolor2">
                    키는 브라우저/기기 내부에만 안전하게 저장되며 외부로 유출되지 않습니다. (나중에 설정 가능)
                  </span>
                </div>
              {/if}

              <!-- Chat Language Preference -->
              <div class="flex flex-col gap-1 mt-1">
                <span class="text-xs font-semibold text-textcolor">채팅 번역 모드</span>
                <div class="grid grid-cols-3 gap-1.5">
                  <button
                    onclick={() => (chatLang = 0)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatLang === 0 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    영어 원문
                  </button>
                  <button
                    onclick={() => (chatLang = 1)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatLang === 1 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    자동 번역 (권장)
                  </button>
                  <button
                    onclick={() => (chatLang = 2)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatLang === 2 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    직접 입력
                  </button>
                </div>
              </div>

              <!-- Context Memory Preference -->
              <div class="flex flex-col gap-1 mt-1">
                <span class="text-xs font-semibold text-textcolor">기억 용량 (컨텍스트)</span>
                <div class="grid grid-cols-3 gap-1.5">
                  <button
                    onclick={() => (chatMemory = 1)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatMemory === 1 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    절약 (8k)
                  </button>
                  <button
                    onclick={() => (chatMemory = 2)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatMemory === 2 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    균형 (12k)
                  </button>
                  <button
                    onclick={() => (chatMemory = 0)}
                    class="p-2 rounded-xl border text-xs font-medium transition-all {chatMemory === 0 ? 'bg-blue-600 text-white border-blue-500' : 'bg-darkbutton/40 border-borderc/40 text-textcolor2'}"
                  >
                    대용량 (16k)
                  </button>
                </div>
              </div>

              <button
                onclick={() => (quickStep = 4)}
                class="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm transition-colors flex items-center justify-center gap-1.5 mt-2"
              >
                <span>{language.setup?.nextStep || '설정 완료하기'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>

          <!-- Sub-Step 4: All Ready Celebration -->
          {:else if quickStep === 4}
            <div class="flex flex-col items-center justify-center text-center p-6 gap-4" in:scale={{ duration: 250 }}>
              <div class="p-4 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-bounce">
                <Sparkles class="w-10 h-10" />
              </div>
              <div>
                <h3 class="text-xl font-extrabold text-textcolor">
                  {language.setup?.allDone || '모든 설정이 끝났어요!'}
                </h3>
                <p class="text-xs text-textcolor2 mt-1 max-w-sm">
                  {language.setup?.allSetMessage || '아이리스와 함께 리스AI를 시작해볼까요~? ✨'}
                </p>
              </div>

              <button
                onclick={finishAndEnterApp}
                class="px-8 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm shadow-lg transition-all flex items-center gap-2"
              >
                <span>{language.setup?.finishSetup || '리스AI 시작하기 🚀'}</span>
                <ArrowRight class="w-4 h-4" />
              </button>
            </div>
          {/if}
        </div>
      {/if}

    </section>
  </main>
</div>
