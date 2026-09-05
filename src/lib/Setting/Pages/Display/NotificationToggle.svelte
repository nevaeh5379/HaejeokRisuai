<script lang="ts">
    import { language } from 'src/lang';
    import { alertError } from 'src/ts/alert';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
    import {
        requestNativeChatNotificationPermission,
        usesNativeChatLifecycle,
    } from 'src/ts/androidChatLifecycle';
    import {
        subscribeChatResponsePush,
        unsubscribeChatResponsePush,
    } from 'src/ts/network/pushSubscriptions';
</script>

<div class="flex items-center mt-2">
    <Check
        bind:check={settingsStore.state.notification}
        name={language.notification}
        onChange={async () => {
            if (!settingsStore.state.notification) {
                await unsubscribeChatResponsePush();
                return;
            }
            if (usesNativeChatLifecycle()) {
                const granted = await requestNativeChatNotificationPermission();
                if (!granted) {
                    alertError(language.permissionDenied);
                    settingsStore.state.notification = false;
                }
                return;
            }
            if (typeof Notification === 'undefined') {
                alertError(language.permissionDenied);
                settingsStore.state.notification = false;
                return;
            }
            if (Notification.permission !== 'granted') {
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    alertError(language.permissionDenied);
                    settingsStore.state.notification = false;
                    return;
                }
            }
            await subscribeChatResponsePush();
        }}
    />
</div>
