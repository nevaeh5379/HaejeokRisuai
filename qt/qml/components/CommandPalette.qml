import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "../theme"

Item {
    id: root
    anchors.fill: parent
    visible: false
    z: 9999

    signal openViewRequested(int viewIndex)
    signal selectCharacterRequested(string charId)
    signal selectPresetRequested(string presetId)
    signal toggleVisualNovelRequested()
    signal exportChatRequested()
    signal clearChatRequested()

    // Semi-transparent Backdrop
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, 0.6)

        MouseArea {
            anchors.fill: parent
            onClicked: root.close()
        }
    }

    // Modal Floating Palette Box
    Rectangle {
        id: paletteBox
        width: Math.min(600, parent.width - 40)
        height: Math.min(420, parent.height - 80)
        anchors.centerIn: parent
        radius: Theme.radiusLarge
        color: Theme.bgcolor
        border.color: Theme.darkborderc
        border.width: 1
        clip: true

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 14
            spacing: 10

            // Search Header Input
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                RisuIcon {
                    name: "search"
                    size: 18
                    color: Theme.textcolor2
                }

                TextField {
                    id: searchField
                    Layout.fillWidth: true
                    placeholderText: "Type a command, character, preset, or action... (Esc to close)"
                    font.pixelSize: Theme.fontMedium
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                    placeholderTextColor: Qt.rgba(Theme.textcolor2.r, Theme.textcolor2.g, Theme.textcolor2.b, 0.6)
                    background: null
                    selectByMouse: true

                    Keys.onEscapePressed: root.close()
                    Keys.onDownPressed: {
                        if (commandList.currentIndex < commandList.count - 1) {
                            commandList.currentIndex++;
                        }
                    }
                    Keys.onUpPressed: {
                        if (commandList.currentIndex > 0) {
                            commandList.currentIndex--;
                        }
                    }
                    Keys.onReturnPressed: {
                        if (commandList.currentItem) {
                            commandList.currentItem.trigger();
                        }
                    }
                }

                RisuBadge {
                    text: "ESC"
                    badgeColor: Theme.darkbutton
                    textColor: Theme.textcolor2
                }
            }

            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: Theme.darkborderc
            }

            // Filtered Command List View
            ListView {
                id: commandList
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: 4
                highlightFollowsCurrentItem: true
                model: filteredModel()

                delegate: Rectangle {
                    id: itemDelegate
                    width: commandList.width
                    height: 40
                    radius: Theme.radiusSmall
                    color: (commandList.currentIndex === index || itemMouse.containsMouse) ? Theme.selected : "transparent"

                    function trigger() {
                        modelData.action();
                        root.close();
                    }

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        spacing: 10

                        RisuIcon {
                            name: modelData.iconKey || "sparkles"
                            size: 16
                            color: (commandList.currentIndex === index || itemMouse.containsMouse) ? Theme.primaryLight : Theme.textcolor2
                        }

                        Text {
                            text: modelData.title
                            font.pixelSize: Theme.fontRegular
                            font.weight: Font.DemiBold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }

                        RisuBadge {
                            text: modelData.category
                            badgeColor: Theme.darkbg
                            textColor: Theme.textcolor2
                        }
                    }

                    MouseArea {
                        id: itemMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: itemDelegate.trigger()
                    }
                }
            }
        }
    }

    function open() {
        searchField.text = "";
        root.visible = true;
        searchField.forceActiveFocus();
        commandList.currentIndex = 0;
    }

    function close() {
        root.visible = false;
    }

    function filteredModel() {
        var query = searchField.text.trim().toLowerCase();
        var all = [
            { iconKey: "message-square", title: "View: Chat Screen", category: "Navigation", action: function() { root.openViewRequested(0); } },
            { iconKey: "sparkles", title: "View: Visual Novel Immersion Mode", category: "Navigation", action: function() { root.toggleVisualNovelRequested(); } },
            { iconKey: "user", title: "View: Character Editor", category: "Navigation", action: function() { root.openViewRequested(1); } },
            { iconKey: "sliders", title: "View: Generation Presets", category: "Navigation", action: function() { root.openViewRequested(2); } },
            { iconKey: "book", title: "View: Global Lorebook", category: "Navigation", action: function() { root.openViewRequested(3); } },
            { iconKey: "user", title: "View: User Personas", category: "Navigation", action: function() { root.openViewRequested(4); } },
            { iconKey: "settings", title: "View: Global Settings & APIs", category: "Navigation", action: function() { root.openViewRequested(5); } },
            { iconKey: "download", title: "Action: Export Chat to Markdown / HTML / JSON", category: "Action", action: function() { root.exportChatRequested(); } },
            { iconKey: "trash", title: "Action: Clear Current Chat Messages", category: "Action", action: function() { root.clearChatRequested(); } },
            { iconKey: "download", title: "Action: Create Local Auto-Backup", category: "Data", action: function() { if (typeof appCtrl !== "undefined") appCtrl.backupData(""); } }
        ];

        if (query === "") return all;

        return all.filter(function(item) {
            return item.title.toLowerCase().indexOf(query) !== -1 || item.category.toLowerCase().indexOf(query) !== -1;
        });
    }
}
