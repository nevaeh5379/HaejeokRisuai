<script lang="ts">
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";

    const characterSets = [
        'Latn', 'Hani', 'Arab', 'Deva', 'Cyrl', 'Beng', 'Hira', 'Kana', 'Telu', 'Hang',
        'Taml', 'Thai', 'Gujr', 'Knda', 'Ethi', 'Khmr', 'Grek', 'Hebr',
    ];

    const characterSetsPreview: Record<string, string> = {
        'Latn': "ABC", 'Hani': "汉漢", 'Arab': "اعب", 'Deva': "अआइ", 'Cyrl': "АБВ",
        'Beng': "অআই", 'Hira': "あい", 'Kana': "アイ", 'Telu': "అఆఇ", 'Hang': "가나다",
        'Taml': "அஆஇ", 'Thai': "กขค", 'Gujr': "અઆઇ", 'Knda': "ಅಆಇ", 'Ethi': "ሀሁሂ",
        'Khmr': "កខគ", 'Grek': "ΑΒΓ", 'Hebr': "אבג",
    };
</script>

<Accordion styled name={language.banCharacterset}>
    {#each characterSets as set}
        <Button styled={settingsStore.state.banCharacterset.includes(set) ? 'primary' : "outlined"} onclick={(e) => {
            if (settingsStore.state.banCharacterset.includes(set)) {
                settingsStore.state.banCharacterset = settingsStore.state.banCharacterset.filter((item: string) => item !== set)
            } else {
                settingsStore.state.banCharacterset.push(set)
            }
        }}>
            {new Intl.DisplayNames([navigator.language,'en'], { type: 'script' }).of(set)} ({characterSetsPreview[set]})
        </Button>
    {/each}
</Accordion>
