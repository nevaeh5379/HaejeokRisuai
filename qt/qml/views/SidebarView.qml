import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"
import "../components"

Rectangle {
    id: root

    signal openCharacterEditor(string charId)
    signal openPresetSettings()
    signal openLorebookEditor()
    signal openPersonaEditor()
    signal openGlobalSettings()
    signal goHome()

    width: 80
    color: Theme.bgcolor
    border.color: Theme.darkborderc
    border.width: 1

    property bool menuOpen: false

    FileDialog {
        id: importCardDialog
        title: "Import Character Card"
        nameFilters: ["Character Cards (*.png *.json *.risum *.charx)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            charCtrl.importCard(path);
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 8

        Item { Layout.preferredHeight: 4 }

        // ==========================================
        // 1. TOP HOME BUTTON (Matching RisuAI Sidebar.svelte)
        // ==========================================
        Rectangle {
            id: homeBtn
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: 64
            Layout.preferredHeight: 52
            radius: Theme.radiusMedium
            color: (!charCtrl.hasSelectedCharacter) ? Theme.selected : (homeMouse.containsMouse ? Theme.darkbutton : "transparent")

            Behavior on color {
                ColorAnimation { duration: Theme.animFast }
            }

            Column {
                anchors.centerIn: parent
                spacing: 3

                RisuIcon {
                    name: "home"
                    size: 20
                    color: (!charCtrl.hasSelectedCharacter) ? Theme.textcolor : (homeMouse.containsMouse ? Theme.textcolor : Theme.textcolor2)
                    anchors.horizontalCenter: parent.horizontalCenter
                }

                Text {
                    text: "Home"
                    font.pixelSize: Theme.fontTiny
                    font.family: Theme.fontFamily
                    font.weight: Font.Medium
                    color: (!charCtrl.hasSelectedCharacter) ? Theme.textcolor : Theme.textcolor2
                    anchors.horizontalCenter: parent.horizontalCenter
                }
            }

            MouseArea {
                id: homeMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    charCtrl.clearSelection();
                    root.goHome();
                }
            }
        }

        // Subtle Divider Line
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 12
            Layout.rightMargin: 12
            Layout.preferredHeight: 1
            color: Theme.darkborderc
            opacity: 0.5
        }

        // ==========================================
        // 2. CHARACTER AVATAR VERTICAL RAIL
        // ==========================================
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            ScrollBar.vertical.policy: ScrollBar.AlwaysOff

            ColumnLayout {
                width: parent.width
                spacing: 10

                // Character Avatar List
                Repeater {
                    model: charCtrl.characterModel

                    delegate: Item {
                        id: avatarContainer
                        Layout.alignment: Qt.AlignHCenter
                        Layout.preferredWidth: 64
                        Layout.preferredHeight: 52

                        readonly property bool isSelected: charCtrl.hasSelectedCharacter && charCtrl.selectedCharacter.id === (model.charId || model.id)

                        // Active Selection Bar on left edge
                        Rectangle {
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            width: 3
                            height: 36
                            radius: 1.5
                            color: Theme.primary
                            visible: avatarContainer.isSelected
                        }

                        // Avatar Box
                        Rectangle {
                            id: avatarBox
                            anchors.centerIn: parent
                            width: 48
                            height: 48
                            radius: Theme.radiusMedium
                            color: avatarContainer.isSelected ? Theme.selected : (avatarMouse.containsMouse ? Theme.darkbutton : Theme.darkbg)
                            border.color: avatarContainer.isSelected ? Theme.primary : (avatarMouse.containsMouse ? Theme.borderc : Theme.darkborderc)
                            border.width: avatarContainer.isSelected ? 2 : 1
                            clip: true

                            scale: avatarMouse.containsMouse ? 1.05 : 1.0
                            Behavior on scale { NumberAnimation { duration: Theme.animFast } }
                            Behavior on border.color { ColorAnimation { duration: Theme.animFast } }

                            Image {
                                anchors.fill: parent
                                source: model.avatarPath ? (appConfig.resolveAssetUrl(model.avatarPath) || "") : ""
                                fillMode: Image.PreserveAspectCrop
                                smooth: true
                                visible: model.avatarPath !== ""
                                asynchronous: true
                                sourceSize.width: 96
                                sourceSize.height: 96
                            }

                            Text {
                                anchors.centerIn: parent
                                text: model.name ? model.name.charAt(0).toUpperCase() : "?"
                                font.pixelSize: 18
                                font.weight: Font.Bold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                visible: !model.avatarPath
                            }

                            MouseArea {
                                id: avatarMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                acceptedButtons: Qt.LeftButton | Qt.RightButton
                                cursorShape: Qt.PointingHandCursor

                                onClicked: function(mouse) {
                                    if (mouse.button === Qt.RightButton) {
                                        charContextMenu.targetCharId = model.charId || model.id;
                                        charContextMenu.open();
                                    } else {
                                        var targetId = model.charId || model.id;
                                        charCtrl.selectCharacter(targetId);
                                    }
                                }
                            }
                        }

                        ToolTip.visible: avatarMouse.containsMouse
                        ToolTip.text: model.name || "Character"
                        ToolTip.delay: 350
                    }
                }

                // Add Character Button
                Rectangle {
                    Layout.alignment: Qt.AlignHCenter
                    Layout.preferredWidth: 48
                    Layout.preferredHeight: 48
                    radius: Theme.radiusMedium
                    color: addMouse.containsMouse ? Theme.darkbutton : "transparent"
                    border.color: addMouse.containsMouse ? Theme.primary : Theme.darkborderc
                    border.width: 1

                    RisuIcon {
                        anchors.centerIn: parent
                        name: "plus"
                        size: 20
                        color: addMouse.containsMouse ? Theme.primaryLight : Theme.textcolor2
                    }

                    MouseArea {
                        id: addMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            charCtrl.createCharacter("New Character");
                            root.openCharacterEditor(charCtrl.selectedCharacter.id);
                        }
                    }

                    ToolTip.visible: addMouse.containsMouse
                    ToolTip.text: "Create Character / 캐릭터 생성"
                    ToolTip.delay: 350
                }

                Item { Layout.preferredHeight: 4 }
            }
        }

        // Subtle Divider Line
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 12
            Layout.rightMargin: 12
            Layout.preferredHeight: 1
            color: Theme.darkborderc
            opacity: 0.5
        }

        // ==========================================
        // 3. BOTTOM UTILITY TOOLS RAIL
        // ==========================================
        ColumnLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: 6

            RisuIconButton {
                iconName: "sliders"
                tooltipText: "Presets / 프리셋 설정"
                buttonSize: 42
                iconSize: 20
                onClicked: root.openPresetSettings()
            }

            RisuIconButton {
                iconName: "book"
                tooltipText: "Lorebook / 로어북"
                buttonSize: 42
                iconSize: 20
                onClicked: root.openLorebookEditor()
            }

            RisuIconButton {
                iconName: "user"
                tooltipText: "Persona / 페르소나"
                buttonSize: 42
                iconSize: 20
                onClicked: root.openPersonaEditor()
            }

            RisuIconButton {
                iconName: "settings"
                tooltipText: "Settings / 앱 설정"
                buttonSize: 42
                iconSize: 20
                onClicked: root.openGlobalSettings()
            }

            RisuIconButton {
                iconName: "menu"
                tooltipText: "More Options / 메뉴"
                buttonSize: 42
                iconSize: 20
                onClicked: root.menuOpen = !root.menuOpen
            }

            Item { Layout.preferredHeight: 6 }
        }
    }

    // ==========================================
    // 4. HAMBURGER MORE OPTIONS POPUP MENU
    // ==========================================
    Popup {
        id: menuPopup
        visible: root.menuOpen
        x: 84
        y: root.height - 240
        width: 220
        padding: 6
        modal: true
        focus: true
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

        onClosed: root.menuOpen = false

        background: Rectangle {
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1
            radius: Theme.radiusMedium
        }

        contentItem: ColumnLayout {
            spacing: 2

            // Import Card
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 36
                radius: Theme.radiusSmall
                color: itemImportMouse.containsMouse ? Theme.darkbutton : "transparent"

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 10

                    RisuIcon { name: "download"; size: 16; color: Theme.textcolor2 }
                    Text { text: "Import Card / 가져오기"; color: Theme.textcolor; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
                }

                MouseArea {
                    id: itemImportMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        menuPopup.close();
                        importCardDialog.open();
                    }
                }
            }

            // Presets
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 36
                radius: Theme.radiusSmall
                color: itemPresetMouse.containsMouse ? Theme.darkbutton : "transparent"

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 10

                    RisuIcon { name: "sliders"; size: 16; color: Theme.textcolor2 }
                    Text { text: "Presets / 프리셋"; color: Theme.textcolor; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
                }

                MouseArea {
                    id: itemPresetMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        menuPopup.close();
                        root.openPresetSettings();
                    }
                }
            }

            // Lorebook
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 36
                radius: Theme.radiusSmall
                color: itemLoreMouse.containsMouse ? Theme.darkbutton : "transparent"

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 10

                    RisuIcon { name: "book"; size: 16; color: Theme.textcolor2 }
                    Text { text: "Lorebook / 로어북"; color: Theme.textcolor; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
                }

                MouseArea {
                    id: itemLoreMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        menuPopup.close();
                        root.openLorebookEditor();
                    }
                }
            }

            // Settings
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 36
                radius: Theme.radiusSmall
                color: itemSetMouse.containsMouse ? Theme.darkbutton : "transparent"

                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 10

                    RisuIcon { name: "settings"; size: 16; color: Theme.textcolor2 }
                    Text { text: "Settings / 설정"; color: Theme.textcolor; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily }
                }

                MouseArea {
                    id: itemSetMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        menuPopup.close();
                        root.openGlobalSettings();
                    }
                }
            }
        }
    }

    // Context Menu for Character Avatar
    Menu {
        id: charContextMenu
        property string targetCharId: ""

        MenuItem {
            text: "Start New Session / 새 세션 시작"
            onTriggered: {
                charCtrl.selectCharacter(charContextMenu.targetCharId);
                chatCtrl.createNewChat();
                root.goHome();
            }
        }
        MenuItem {
            text: "Edit Character / 수정"
            onTriggered: root.openCharacterEditor(charContextMenu.targetCharId)
        }
        MenuItem {
            text: "Delete Character / 삭제"
            onTriggered: charCtrl.deleteCharacter(charContextMenu.targetCharId)
        }
    }
}
