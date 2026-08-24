import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "theme"
import "components"
import "views"

ApplicationWindow {
    id: window
    visible: true
    width: 1280
    height: 860
    minimumWidth: 960
    minimumHeight: 640
    title: "RisuAI Native Desktop"
    color: Theme.bgcolor

    // View state index:
    // 0 = Chat View / Home View
    // 1 = Character Editor
    // 2 = Preset & Model Settings
    // 3 = Lorebook & World Info
    // 4 = Persona Profiles
    // 5 = Global Settings
    // 6 = Visual Novel View
    property int currentViewIndex: 0
    property bool sidebarExpanded: true

    // Global Toast listener
    Connections {
        target: appCtrl
        function onToastTriggered(type, message) {
            toast.show(type, message);
        }
    }

    // Keyboard Shortcuts
    Shortcut {
        sequence: "Ctrl+1"
        onActivated: window.currentViewIndex = 0
    }
    Shortcut {
        sequence: "Ctrl+2"
        onActivated: window.currentViewIndex = 1
    }
    Shortcut {
        sequence: "Ctrl+3"
        onActivated: window.currentViewIndex = 2
    }
    Shortcut {
        sequence: "Ctrl+B"
        onActivated: window.sidebarExpanded = !window.sidebarExpanded
    }
    Shortcut {
        sequence: "Ctrl+K"
        onActivated: cmdPalette.open()
    }
    Shortcut {
        sequence: "Ctrl+P"
        onActivated: cmdPalette.open()
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        // ==========================================
        // 1. UNIFIED RISUAI SIDEBAR (80px)
        // ==========================================
        SidebarView {
            id: mainSidebar
            Layout.preferredWidth: (window.sidebarExpanded && window.currentViewIndex !== 6) ? 80 : 0
            Layout.fillHeight: true
            visible: window.sidebarExpanded && window.currentViewIndex !== 6
            clip: true

            Behavior on Layout.preferredWidth {
                NumberAnimation { duration: Theme.animNormal; easing.type: Easing.OutQuad }
            }

            onGoHome: {
                window.currentViewIndex = 0;
            }
            onOpenCharacterEditor: function(charId) {
                window.currentViewIndex = 1;
            }
            onOpenPresetSettings: {
                window.currentViewIndex = 2;
            }
            onOpenLorebookEditor: {
                window.currentViewIndex = 3;
            }
            onOpenPersonaEditor: {
                window.currentViewIndex = 4;
            }
            onOpenGlobalSettings: {
                window.currentViewIndex = 5;
            }
        }

        // ==========================================
        // 2. MAIN WORKSPACE / VIEWS STACK
        // ==========================================
        StackLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            currentIndex: window.currentViewIndex

            // View 0: Chat View (Default Chat Screen / MainMenu Home)
            ChatView {
                onToggleSidebarRequested: {
                    window.sidebarExpanded = !window.sidebarExpanded;
                }
                onEditCharacterRequested: function(charId) {
                    window.currentViewIndex = 1;
                }
                onOpenPresetSettingsRequested: {
                    window.currentViewIndex = 2;
                }
                onOpenVisualNovelRequested: {
                    window.currentViewIndex = 6;
                    window.sidebarExpanded = false;
                }
            }

            // View 1: Character Editor
            CharacterEditorView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                }
            }

            // View 2: Preset Settings
            PresetSettingsView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                }
            }

            // View 3: Lorebook Editor
            LorebookEditorView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                }
            }

            // View 4: Persona Editor
            PersonaEditorView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                }
            }

            // View 5: Global Settings
            GlobalSettingsView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                }
            }

            // View 6: Visual Novel Mode
            VisualNovelView {
                onCloseRequested: {
                    window.currentViewIndex = 0;
                    window.sidebarExpanded = true;
                }
                onExitRequested: {
                    window.currentViewIndex = 0;
                    window.sidebarExpanded = true;
                }
            }
        }
    }

    // Global Command Palette Overlay (Ctrl+K / Ctrl+P)
    CommandPalette {
        id: cmdPalette
        anchors.centerIn: parent

        onOpenViewRequested: function(viewIndex) {
            window.currentViewIndex = viewIndex;
        }
        onClearChatRequested: {
            chatCtrl.clearChat();
            window.currentViewIndex = 0;
        }
        onExportChatRequested: {
            var exp = chatCtrl.exportChatHistory("markdown");
            appCtrl.triggerToast("info", "Chat history exported to clipboard.");
        }
    }

    // Global Toast Banner Notification
    RisuToast {
        id: toast
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: 24
        z: 9999
    }
}
