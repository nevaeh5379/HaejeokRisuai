<script lang="ts">
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import { language } from "src/lang";
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
