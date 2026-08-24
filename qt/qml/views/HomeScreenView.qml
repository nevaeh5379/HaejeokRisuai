import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"
import "../components"

Rectangle {
    id: root

    signal characterSelected(string charId)
    signal newCharacterRequested()
    signal importCharacterRequested()

    color: Theme.bgcolor

    property string searchQuery: ""
    property bool showFavoritesOnly: false
    property bool showHidden: false
    property int sortMode: 0 // 0: Default, 1: Name, 2: Recent, 3: Favorites

    FileDialog {
        id: importCardDialog
        title: "Import Character Card or Backup (PNG / JSON / BIN)"
        nameFilters: ["All Supported (*.png *.json *.risum *.charx *.bin *.risubackup)", "Character Cards (*.png *.json *.risum *.charx)", "Binary Backups (*.bin *.risubackup)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            if (path.endsWith(".bin", Qt.CaseInsensitive) || path.endsWith(".risubackup", Qt.CaseInsensitive)) {
                appCtrl.restoreData(path);
            } else {
                charCtrl.importCard(path);
            }
        }
    }

    ScrollView {
        anchors.fill: parent
        clip: true
        contentWidth: parent.width

        ColumnLayout {
            width: Math.min(1150, parent.width - 48)
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 16

            Item { Layout.preferredHeight: 12 }

            // ==========================================
            // 1. RISUAI BRAND TITLE (Matching Title.svelte)
            // ==========================================
            ColumnLayout {
                Layout.alignment: Qt.AlignHCenter
                spacing: 2

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "Risuai"
                    font.pixelSize: 38
                    font.weight: Font.Black
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                }

                Text {
                    Layout.alignment: Qt.AlignHCenter
                    text: "Version 3.0-Native"
                    font.pixelSize: Theme.fontSmall
                    font.family: Theme.fontFamily
                    color: Theme.textcolor2
                }
            }

            // Divider Line (border-t border-t-selected)
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: Theme.selected
                opacity: 0.6
            }

            // ==========================================
            // 2. SECTION HEADER & GET MORE BUTTON
            // ==========================================
            RowLayout {
                Layout.fillWidth: true

                Text {
                    text: "Character"
                    font.pixelSize: 22
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                }

                Item { Layout.fillWidth: true }

                RisuButton {
                    text: "Get More"
                    variant: "secondary"
                    onClicked: {
                        if (typeof appCtrl !== "undefined") {
                            appCtrl.triggerToast("info", "Realm Hub integration coming soon");
                        }
                    }
                }
            }

            // ==========================================
            // 3. SEARCH & FILTER TOOLBAR (Matching MainMenu.svelte)
            // ==========================================
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                // Search Input Field
                Rectangle {
                    Layout.preferredWidth: Math.min(380, parent.width * 0.4)
                    Layout.preferredHeight: 36
                    radius: Theme.radiusMedium
                    color: Theme.darkbg
                    border.color: searchInput.activeFocus ? Theme.primary : Theme.darkborderc
                    border.width: 1

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        spacing: 8

                        RisuIcon {
                            name: "search"
                            size: 16
                            color: Theme.textcolor2
                        }

                        TextInput {
                            id: searchInput
                            Layout.fillWidth: true
                            color: Theme.textcolor
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            selectByMouse: true
                            clip: true

                            Text {
                                text: "Search characters..."
                                color: Qt.rgba(Theme.textcolor2.r, Theme.textcolor2.g, Theme.textcolor2.b, 0.6)
                                font.pixelSize: Theme.fontSmall
                                font.family: Theme.fontFamily
                                visible: !searchInput.text && !searchInput.activeFocus
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            onTextChanged: {
                                root.searchQuery = text.toLowerCase().trim();
                            }
                        }
                    }
                }

                // Favorites Filter Button
                Rectangle {
                    Layout.preferredHeight: 36
                    radius: Theme.radiusMedium
                    color: root.showFavoritesOnly ? Theme.selected : Theme.darkbg
                    border.color: Theme.darkborderc
                    border.width: 1
                    implicitWidth: favRow.implicitWidth + 24

                    Row {
                        id: favRow
                        anchors.centerIn: parent
                        spacing: 6

                        RisuIcon {
                            name: "star"
                            size: 15
                            color: root.showFavoritesOnly ? "#facc15" : Theme.textcolor2
                            filled: root.showFavoritesOnly
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "Favorites"
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            font.weight: Font.Medium
                            color: root.showFavoritesOnly ? Theme.textcolor : Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.showFavoritesOnly = !root.showFavoritesOnly
                    }
                }

                // Sort Dropdown Box
                RisuComboBox {
                    Layout.preferredWidth: 160
                    Layout.preferredHeight: 36
                    model: ["Default", "Name (A-Z)", "Recently Used", "Favorites First"]
                    currentIndex: root.sortMode
                    onActivated: function(index) {
                        root.sortMode = index;
                    }
                }

                Item { Layout.fillWidth: true }

                // Import Button
                RisuButton {
                    text: "Import"
                    iconName: "download"
                    variant: "secondary"
                    onClicked: importCardDialog.open()
                }

                // + New Character Button
                RisuButton {
                    text: "+ New"
                    variant: "primary"
                    onClicked: root.newCharacterRequested()
                }
            }

            // ==========================================
            // 4. RESPONSIVE CHARACTER CARD GRID (Masonry Look)
            // ==========================================
            GridLayout {
                id: charGrid
                Layout.fillWidth: true
                columns: Math.max(2, Math.min(6, Math.floor(parent.width / 170)))
                rowSpacing: 16
                columnSpacing: 16

                Repeater {
                    model: charCtrl.characterModel

                    delegate: Rectangle {
                        id: cardRoot
                        Layout.fillWidth: true
                        Layout.preferredHeight: 240
                        radius: Theme.radiusLarge
                        color: Theme.darkbg
                        border.color: cardMouse.containsMouse ? Theme.primary : Theme.darkborderc
                        border.width: cardMouse.containsMouse ? 2 : 1
                        clip: true

                        // Search Filter Logic
                        visible: {
                            if (root.searchQuery !== "") {
                                var matchName = (model.name || "").toLowerCase().includes(root.searchQuery);
                                var matchDesc = (model.description || "").toLowerCase().includes(root.searchQuery);
                                if (!matchName && !matchDesc) return false;
                            }
                            return true;
                        }

                        // Smooth Lift on Hover
                        transform: Translate {
                            y: cardMouse.containsMouse ? -4 : 0
                            Behavior on y { NumberAnimation { duration: Theme.animFast } }
                        }

                        Behavior on border.color { ColorAnimation { duration: Theme.animFast } }

                        // Background Avatar Image
                        Image {
                            id: cardImg
                            anchors.fill: parent
                            source: model.avatarPath ? (model.avatarPath.startsWith("file://") ? model.avatarPath : ("file://" + model.avatarPath)) : ""
                            fillMode: Image.PreserveAspectCrop
                            smooth: true
                            visible: model.avatarPath !== ""
                            scale: cardMouse.containsMouse ? 1.05 : 1.0
                            Behavior on scale { NumberAnimation { duration: Theme.animNormal } }
                        }

                        // Fallback Initial Letter if no image
                        Rectangle {
                            anchors.fill: parent
                            color: Theme.darkbutton
                            visible: !model.avatarPath

                            Text {
                                anchors.centerIn: parent
                                text: model.name ? model.name.charAt(0).toUpperCase() : "?"
                                font.pixelSize: 44
                                font.weight: Font.Bold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor2
                            }
                        }

                        // Bottom Gradient Overlay with Character Name
                        Rectangle {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            height: 70
                            gradient: Gradient {
                                GradientStop { position: 0.0; color: "transparent" }
                                GradientStop { position: 0.5; color: Qt.rgba(0, 0, 0, 0.6) }
                                GradientStop { position: 1.0; color: Qt.rgba(0, 0, 0, 0.9) }
                            }

                            ColumnLayout {
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.bottom: parent.bottom
                                anchors.margins: 10
                                spacing: 2

                                Text {
                                    text: model.name || "Unnamed"
                                    font.pixelSize: Theme.fontMedium
                                    font.weight: Font.Bold
                                    font.family: Theme.fontFamily
                                    color: "#ffffff"
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }

                                Text {
                                    text: (model.firstMessage || model.description || "Start chatting...").replace(/\n/g, " ")
                                    font.pixelSize: Theme.fontTiny
                                    font.family: Theme.fontFamily
                                    color: Qt.rgba(255, 255, 255, 0.75)
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                            }
                        }

                        MouseArea {
                            id: cardMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            acceptedButtons: Qt.LeftButton | Qt.RightButton
                            cursorShape: Qt.PointingHandCursor

                            onClicked: function(mouse) {
                                var targetId = model.charId || model.id || "";
                                if (mouse.button === Qt.RightButton) {
                                    cardContextMenu.targetCharId = targetId;
                                    cardContextMenu.open();
                                } else {
                                    if (targetId !== "") {
                                        charCtrl.selectCharacter(targetId);
                                        root.characterSelected(targetId);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Item { Layout.preferredHeight: 32 }
        }
    }

    // Context Menu for Cards
    Menu {
        id: cardContextMenu
        property string targetCharId: ""

        MenuItem {
            text: "Edit Character / 수정"
            onTriggered: charCtrl.selectCharacter(cardContextMenu.targetCharId)
        }
        MenuItem {
            text: "Delete Character / 삭제"
            onTriggered: charCtrl.deleteCharacter(cardContextMenu.targetCharId)
        }
    }
}
