<script lang="ts">
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import { language } from "src/lang";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { changeColorScheme } from "src/ts/gui/colorscheme";
    import { isWindowsFluentTheme, setUITheme } from "src/ts/gui/uiTheme";
    import {
        getWindowsTransparencyPreferences,
        applyWindowsTransparencyToDocument,
        setWindowsTransparencyPreferences,
        type WindowsBackdropEffect,
        type WindowsTransparencyPreferences,
    } from "src/ts/windowsTransparency";

    let preferences = $state(getWindowsTransparencyPreferences());

    function updatePreferences(
        changes: Partial<WindowsTransparencyPreferences>,
    ) {
        preferences = { ...preferences, ...changes };
        void setWindowsTransparencyPreferences(preferences);
    }

    function previewOpacity(opacity: number) {
        preferences = { ...preferences, opacity };
        applyWindowsTransparencyToDocument(preferences);
    }
</script>

<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/35 p-4">
    <!-- Windows 11 Fluent Theme Section -->
    <div class="mb-5 border-b border-darkborderc pb-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
                <h4 class="text-md font-semibold text-textcolor flex items-center gap-2">
                    <svg class="w-4 h-4 text-borderc shrink-0" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M0 2.222L6.5 1.333V7.5H0V2.222zm7.5-1.467L16 0v7.5H7.5V.755zM0 8.5h6.5v6.167L0 13.778V8.5zm7.5 0H16V16l-8.5-.755V8.5z"/>
                    </svg>
                    <span>{language.windowsNativeTheme}</span>
                </h4>
                <p class="mt-1 text-xs text-textcolor2">
                    {language.windowsNativeThemeDesc}
                </p>
            </div>
            <div class="flex flex-wrap gap-2 shrink-0">
                <button
                    type="button"
                    class="rounded px-3 py-1.5 text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5"
                    class:border-borderc={isWindowsFluentTheme() && settingsStore.state.colorSchemeName === "fluent-dark"}
                    class:bg-selected={isWindowsFluentTheme() && settingsStore.state.colorSchemeName === "fluent-dark"}
                    class:text-textcolor={true}
                    class:border-darkborderc={!isWindowsFluentTheme() || settingsStore.state.colorSchemeName !== "fluent-dark"}
                    class:bg-darkbutton={!isWindowsFluentTheme() || settingsStore.state.colorSchemeName !== "fluent-dark"}
                    onclick={() => {
                        setUITheme("windows");
                        changeColorScheme("fluent-dark");
                        if (!preferences.enabled) {
                            updatePreferences({ enabled: true, effect: "mica" });
                        }
                    }}
                >
                    <span class="w-2.5 h-2.5 rounded-full bg-[#202020] border border-[#60cdff]"></span>
                    Fluent Dark
                </button>
                <button
                    type="button"
                    class="rounded px-3 py-1.5 text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5"
                    class:border-borderc={isWindowsFluentTheme() && settingsStore.state.colorSchemeName === "fluent-light"}
                    class:bg-selected={isWindowsFluentTheme() && settingsStore.state.colorSchemeName === "fluent-light"}
                    class:text-textcolor={true}
                    class:border-darkborderc={!isWindowsFluentTheme() || settingsStore.state.colorSchemeName !== "fluent-light"}
                    class:bg-darkbutton={!isWindowsFluentTheme() || settingsStore.state.colorSchemeName !== "fluent-light"}
                    onclick={() => {
                        setUITheme("windows");
                        changeColorScheme("fluent-light");
                        if (!preferences.enabled) {
                            updatePreferences({ enabled: true, effect: "mica" });
                        }
                    }}
                >
                    <span class="w-2.5 h-2.5 rounded-full bg-[#f3f3f3] border border-[#005fb8]"></span>
                    Fluent Light
                </button>
                {#if isWindowsFluentTheme()}
                    <button
                        type="button"
                        class="rounded px-2.5 py-1.5 text-xs text-textcolor2 hover:text-textcolor border border-darkborderc hover:bg-darkbutton transition-all cursor-pointer"
                        onclick={() => {
                            setUITheme("default");
                            changeColorScheme("default");
                        }}
                        title="기본 테마로 복원"
                    >
                        기본 테마
                    </button>
                {/if}
            </div>
        </div>
    </div>

    <h3 class="text-lg font-semibold text-textcolor">
        {language.windowsTransparency}
    </h3>
    <p class="mt-1 mb-4 text-sm text-textcolor2">
        {language.windowsTransparencyDescription}
    </p>

    <Check
        check={preferences.enabled}
        onChange={(enabled) => updatePreferences({ enabled })}
        name={language.useWindowsTransparency}
    />

    <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <label class="flex flex-col gap-2 text-sm text-textcolor">
            <span>{language.windowsBackdropEffect}</span>
            <SelectInput
                value={preferences.effect}
                onchange={(event) =>
                    updatePreferences({
                        effect: event.currentTarget.value as WindowsBackdropEffect,
                    })}
                className="w-full disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!preferences.enabled}
            >
                <option class="bg-darkbg text-textcolor" value="acrylic">{language.windowsBackdropAcrylic}</option>
                <option class="bg-darkbg text-textcolor" value="mica">{language.windowsBackdropMica}</option>
                <option class="bg-darkbg text-textcolor" value="tabbed">{language.windowsBackdropTabbed}</option>
            </SelectInput>
        </label>

        <label class="flex flex-col gap-2 text-sm text-textcolor">
            <span>{language.windowsMaterialOpacity}: {preferences.opacity}%</span>
            <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={preferences.opacity}
                disabled={!preferences.enabled}
                oninput={(event) =>
                    previewOpacity(Number(event.currentTarget.value))}
                onchange={() =>
                    void setWindowsTransparencyPreferences(preferences)}
                class="h-10 w-full cursor-pointer accent-borderc disabled:cursor-not-allowed disabled:opacity-50"
            />
        </label>
    </div>

    <p class="mt-3 text-xs text-textcolor2">
        {language.windowsBackdropCompatibility}
    </p>
</section>
