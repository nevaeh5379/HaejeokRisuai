<script lang="ts">
    import { language } from 'src/lang';
    import { saveImage } from '../../../../ts/storage/assetPersistence';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { selectSingleFile } from 'src/ts/util';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
</script>

<div class="flex items-center mt-2">
    <Check
        check={settingsStore.state.customBackground !== ''}
        onChange={async (check) => {
            if (check) {
                settingsStore.state.customBackground = '-';
                const d = await selectSingleFile(['png', 'webp', 'gif']);
                if (!d) {
                    settingsStore.state.customBackground = '';
                    return;
                }
                const img = await saveImage(d.data);
                settingsStore.state.customBackground = img;
            } else {
                settingsStore.state.customBackground = '';
            }
        }}
        name={language.useCustomBackground}
    />
</div>
