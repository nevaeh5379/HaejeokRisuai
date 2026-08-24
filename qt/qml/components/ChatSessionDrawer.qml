import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"

Rectangle {
    id: drawerRoot

    property bool isOpen: false
    property string searchQuery: ""

    // Target session for modal operations
    property int targetSessionIndex: -1
    property string targetSessionName: ""

    width: isOpen ? 340 : 0
    visible: width > 0
    clip: true
    color: Theme.bgcolor
    border.color: Theme.darkborderc
    border.width: 1
    z: 50

    Behavior on width {
        NumberAnimation { duration: Theme.animNormal; easing.type: Easing.OutQuad }
    }

    // ==========================================
    // 1. DIALOGS
    // ==========================================

    // New Session Dialog (with Greeting Picker)
    RisuDialog {
        id: newSessionDialog
        dialogTitle: "New Chat Session / 새 대화 세션"
        width: 440

        ColumnLayout {
            width: parent.width
            spacing: 14

            Text {
                text: "Session Name / 세션 이름"
                color: Theme.textcolor2
                font.pixelSize: Theme.fontSmall
                font.family: Theme.fontFamily
                font.weight: Font.Medium
            }

            RisuTextField {
                id: newSessionNameInput
                Layout.fillWidth: true
                placeholderText: "Chat " + (chatCtrl.chatSessionCount + 1)
                text: "Chat " + (chatCtrl.chatSessionCount + 1)
            }

            Text {
                text: "Starting Greeting / 시작 인사말"
                color: Theme.textcolor2
                font.pixelSize: Theme.fontSmall
                font.family: Theme.fontFamily
                font.weight: Font.Medium
                visible: chatCtrl.availableGreetings.length > 1
            }

            RisuComboBox {
                id: greetingSelector
                Layout.fillWidth: true
                visible: chatCtrl.availableGreetings.length > 1
                model: {
                    var list = [];
                    var arr = chatCtrl.availableGreetings;
                    for (var i = 0; i < arr.length; ++i) {
                        var snippet = arr[i].replace(/[\r\n]+/g, " ");
                        if (snippet.length > 45) snippet = snippet.substring(0, 45) + "...";
                        list.push("Greeting #" + (i + 1) + ": " + snippet);
                    }
                    return list;
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: 10
                spacing: 10

                Item { Layout.fillWidth: true }

                RisuButton {
                    text: "Cancel"
                    variant: "ghost"
                    onClicked: newSessionDialog.close()
                }

                RisuButton {
                    text: "Create Session / 생성"
                    variant: "primary"
                    onClicked: {
                        var name = newSessionNameInput.text.trim();
                        if (name === "") name = "Chat " + (chatCtrl.chatSessionCount + 1);
                        var gIdx = (chatCtrl.availableGreetings.length > 1) ? greetingSelector.currentIndex : 0;
                        chatCtrl.createNewChatWithGreeting(gIdx, name);
                        newSessionDialog.close();
                    }
                }
            }
        }
    }

    // Rename Session Dialog
    RisuDialog {
        id: renameSessionDialog
        dialogTitle: "Rename Session / 세션 이름 변경"
        width: 400

        ColumnLayout {
            width: parent.width
            spacing: 14

            Text {
                text: "New Session Name / 새 이름"
                color: Theme.textcolor2
                font.pixelSize: Theme.fontSmall
                font.family: Theme.fontFamily
                font.weight: Font.Medium
            }

            RisuTextField {
                id: renameInput
                Layout.fillWidth: true
                text: drawerRoot.targetSessionName
                onAccepted: {
                    if (text.trim() !== "" && drawerRoot.targetSessionIndex >= 0) {
                        chatCtrl.renameChat(drawerRoot.targetSessionIndex, text.trim());
                        renameSessionDialog.close();
                    }
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: 8
                spacing: 10

                Item { Layout.fillWidth: true }

                RisuButton {
                    text: "Cancel"
                    variant: "ghost"
                    onClicked: renameSessionDialog.close()
                }

                RisuButton {
                    text: "Save / 저장"
                    variant: "primary"
                    onClicked: {
                        if (renameInput.text.trim() !== "" && drawerRoot.targetSessionIndex >= 0) {
                            chatCtrl.renameChat(drawerRoot.targetSessionIndex, renameInput.text.trim());
                            renameSessionDialog.close();
                        }
                    }
                }
            }
        }
    }

    // Delete Session Confirmation Dialog
    RisuDialog {
        id: deleteConfirmDialog
        dialogTitle: "Delete Chat Session / 세션 삭제"
        width: 400

        ColumnLayout {
            width: parent.width
            spacing: 14

            Text {
                Layout.fillWidth: true
                text: "Are you sure you want to delete session '" + drawerRoot.targetSessionName + "'?\nThis action cannot be undone.\n\n정말로 이 대화 세션을 삭제하시겠습니까?"
                color: Theme.textcolor
                font.pixelSize: Theme.fontNormal
                font.family: Theme.fontFamily
                wrapMode: Text.Wrap
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: 10
                spacing: 10

                Item { Layout.fillWidth: true }

                RisuButton {
                    text: "Cancel"
                    variant: "ghost"
                    onClicked: deleteConfirmDialog.close()
                }

                RisuButton {
                    text: "Delete / 삭제"
                    variant: "danger"
                    onClicked: {
                        if (drawerRoot.targetSessionIndex >= 0) {
                            chatCtrl.deleteChat(drawerRoot.targetSessionIndex);
                            deleteConfirmDialog.close();
                        }
                    }
                }
            }
        }
    }

    // ==========================================
    // 2. MAIN DRAWER LAYOUT
    // ==========================================
    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Header
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 56
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 10
                spacing: 8

                RisuIcon {
                    name: "message-square"
                    size: 18
                    color: Theme.primaryLight
                }

                Text {
                    text: "Sessions (" + chatCtrl.chatSessionCount + ")"
                    color: Theme.textcolor
                    font.pixelSize: Theme.fontMedium
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                }

                Item { Layout.fillWidth: true }

                // "+ New Chat" Button
                RisuButton {
                    text: "+ New"
                    variant: "primary"
                    Layout.preferredHeight: 30
                    onClicked: {
                        newSessionNameInput.text = "Chat " + (chatCtrl.chatSessionCount + 1);
                        newSessionDialog.open();
                    }
                }

                // Close Drawer Button
                RisuIconButton {
                    iconName: "close"
                    buttonSize: 28
                    iconSize: 14
                    tooltipText: "Close Panel / 닫기"
                    onClicked: drawerRoot.isOpen = false
                }
            }
        }

        // Search Bar
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 44
            color: Theme.bgcolor
            border.color: Theme.darkborderc
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                spacing: 8

                RisuIcon {
                    name: "search"
                    size: 14
                    color: Theme.textcolor2
                }

                TextField {
                    id: sessionSearchField
                    Layout.fillWidth: true
                    placeholderText: "Search sessions... / 세션 검색"
                    placeholderTextColor: Theme.textcolor2
                    color: Theme.textcolor
                    font.pixelSize: Theme.fontSmall
                    font.family: Theme.fontFamily
                    background: null
                    onTextChanged: drawerRoot.searchQuery = text.trim().toLowerCase()
                }

                RisuIconButton {
                    iconName: "close"
                    buttonSize: 22
                    iconSize: 10
                    visible: sessionSearchField.text !== ""
                    onClicked: sessionSearchField.text = ""
                }
            }
        }

        // Sessions List
        ListView {
            id: sessionListView
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 6
            topMargin: 8
            bottomMargin: 8
            leftMargin: 8
            rightMargin: 8

            model: {
                var all = chatCtrl.chatSessions;
                if (drawerRoot.searchQuery === "") return all;
                var filtered = [];
                for (var i = 0; i < all.length; ++i) {
                    var s = all[i];
                    if (s.name.toLowerCase().indexOf(drawerRoot.searchQuery) !== -1 ||
                        (s.preview && s.preview.toLowerCase().indexOf(drawerRoot.searchQuery) !== -1)) {
                        filtered.push(s);
                    }
                }
                return filtered;
            }

            ScrollBar.vertical: ScrollBar {
                policy: ScrollBar.AsNeeded
            }

            delegate: Rectangle {
                id: sessionCard
                width: sessionListView.width - 16
                height: 72
                radius: Theme.radiusMedium
                color: modelData.isActive ? Theme.selected : (sessionMouse.containsMouse ? Theme.darkbutton : Theme.darkbg)
                border.color: modelData.isActive ? Theme.primary : (sessionMouse.containsMouse ? Theme.borderc : Theme.darkborderc)
                border.width: modelData.isActive ? 1.5 : 1

                Behavior on color { ColorAnimation { duration: Theme.animFast } }
                Behavior on border.color { ColorAnimation { duration: Theme.animFast } }

                // Active Indicator Pill (Left Edge)
                Rectangle {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: 3.5
                    height: 48
                    radius: 2
                    color: Theme.primary
                    visible: modelData.isActive
                }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 12
                    anchors.rightMargin: 8
                    anchors.topMargin: 6
                    anchors.bottomMargin: 6
                    spacing: 2

                    // Top Row: Name, Message Count, and Last Date
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 6

                        Text {
                            Layout.fillWidth: true
                            text: modelData.name || ("Chat " + (modelData.index + 1))
                            color: modelData.isActive ? Theme.primaryLight : Theme.textcolor
                            font.pixelSize: Theme.fontNormal
                            font.weight: modelData.isActive ? Font.Bold : Font.Medium
                            font.family: Theme.fontFamily
                            elide: Text.ElideRight
                        }

                        // Message Count Pill
                        Rectangle {
                            Layout.preferredWidth: msgCountText.implicitWidth + 10
                            Layout.preferredHeight: 18
                            radius: Theme.radiusFull
                            color: modelData.isActive ? Theme.primary : Theme.bgcolor
                            border.color: Theme.darkborderc
                            border.width: 1

                            Text {
                                id: msgCountText
                                anchors.centerIn: parent
                                text: modelData.messageCount + " msgs"
                                font.pixelSize: Theme.fontTiny
                                font.family: Theme.fontFamily
                                color: modelData.isActive ? "#ffffff" : Theme.textcolor2
                            }
                        }

                        // Date Text
                        Text {
                            text: modelData.lastDateFormatted || ""
                            font.pixelSize: Theme.fontTiny
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            visible: !sessionMouse.containsMouse
                        }

                        // Hover Action Buttons
                        Row {
                            spacing: 2
                            visible: sessionMouse.containsMouse

                            // Rename
                            RisuIconButton {
                                iconName: "edit"
                                buttonSize: 22
                                iconSize: 11
                                tooltipText: "Rename / 이름 변경"
                                onClicked: {
                                    drawerRoot.targetSessionIndex = modelData.index;
                                    drawerRoot.targetSessionName = modelData.name;
                                    renameInput.text = modelData.name;
                                    renameSessionDialog.open();
                                }
                            }

                            // Duplicate
                            RisuIconButton {
                                iconName: "copy"
                                buttonSize: 22
                                iconSize: 11
                                tooltipText: "Duplicate / 복제"
                                onClicked: {
                                    chatCtrl.duplicateChat(modelData.index);
                                }
                            }

                            // Delete
                            RisuIconButton {
                                iconName: "trash"
                                buttonSize: 22
                                iconSize: 11
                                tooltipText: "Delete / 삭제"
                                enabled: chatCtrl.chatSessionCount > 1
                                onClicked: {
                                    drawerRoot.targetSessionIndex = modelData.index;
                                    drawerRoot.targetSessionName = modelData.name;
                                    deleteConfirmDialog.open();
                                }
                            }
                        }
                    }

                    // Bottom Row: Preview Snippet
                    Text {
                        Layout.fillWidth: true
                        text: modelData.preview ? modelData.preview : "(No messages yet / 대화 없음)"
                        color: Theme.textcolor2
                        font.pixelSize: Theme.fontTiny
                        font.family: Theme.fontFamily
                        elide: Text.ElideRight
                        maximumLineCount: 1
                    }
                }

                MouseArea {
                    id: sessionMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    z: -1

                    onClicked: function(mouse) {
                        if (mouse.button === Qt.LeftButton) {
                            if (!modelData.isActive) {
                                chatCtrl.switchChat(modelData.index);
                            }
                        }
                    }
                }
            }
        }
    }
}
