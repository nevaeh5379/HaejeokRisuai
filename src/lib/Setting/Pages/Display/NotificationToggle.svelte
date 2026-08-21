<script lang="ts">
    import { language } from 'src/lang';
    import { alertError } from 'src/ts/alert';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
</script>

<div class="flex items-center mt-2">
    <Check
        bind:check={settingsStore.state.notification}
        name={language.notification}
        onChange={async () => {
            let hasPermission = { state: 'denied' };
            try {
                hasPermission = await navigator.permissions.query({ name: 'notifications' });
            } catch (error) {
                // Some browsers do not support the Permissions API.
            }
            if (!settingsStore.state.notification) {
                return;
            }
            if (hasPermission.state === 'denied') {
                const permission = await Notification.requestPermission();
                if (permission === 'denied') {
                    alertError(language.permissionDenied);
                    settingsStore.state.notification = false;
                }
            }
        }}
    />
</div>
