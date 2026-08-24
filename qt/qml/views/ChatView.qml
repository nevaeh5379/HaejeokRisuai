import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"
import "../components"

Item {
    id: root

    signal toggleSidebarRequested()
    signal editCharacterRequested(string charId)
    signal openPresetSettingsRequested()
    signal openVisualNovelRequested()

    readonly property bool hasCharacter: charCtrl.hasSelectedCharacter
    property string currentAttachmentPath: ""

    // File Attachment Dialog
    FileDialog {
        id: attachFileDialog
        title: "Attach Multimodal Image"
        nameFilters: ["Images (*.png *.jpg *.jpeg *.webp *.gif)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            root.currentAttachmentPath = path;
        }
    }

    // Clear Chat Confirmation Dialog
    Dialog {
        id: clearConfirmDialog
        title: "Clear Chat History / 대화 비우기"
        modal: true
        standardButtons: Dialog.Yes | Dialog.No
        anchors.centerIn: parent

        Text {
            text: "Are you sure you want to clear all messages in this chat session?\n현재 대화 기록을 모두 비우시겠습니까?"
            color: Theme.textcolor
            font.pixelSize: Theme.fontNormal
            font.family: Theme.fontFamily
        }

        onAccepted: {
            chatCtrl.clearChat();
        }
    }

    // ==========================================
    // 1. HOME SCREEN (When no character selected)
    // ==========================================
    HomeScreenView {
        anchors.fill: parent
        visible: !root.hasCharacter
        onNewCharacterRequested: {
            charCtrl.createCharacter("New Character");
            root.editCharacterRequested(charCtrl.selectedCharacter.id);
        }
    }

    // ==========================================
    // 2. CHAT SCREEN (When character selected)
    // ==========================================
    Item {
        anchors.fill: parent
        visible: root.hasCharacter

        // ==========================================
        // Background Embedding (Large Portrait / Custom CSS3 & HTML)
        // ==========================================
        Item {
            id: backgroundEmbeddingLayer
            anchors.fill: parent
            z: 0

            // Large Portrait Background (Waifu-style immersion)
            Image {
                id: bgPortraitImg
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                width: Math.min(parent.width * 0.55, 600)
                height: parent.height
                fillMode: Image.PreserveAspectFit
                opacity: 0.22
                source: (chatCtrl.largePortrait && chatCtrl.activeCharacterAvatar) ? (chatCtrl.activeCharacterAvatar.startsWith("file://") ? chatCtrl.activeCharacterAvatar : ("file://" + chatCtrl.activeCharacterAvatar)) : ""
                visible: chatCtrl.largePortrait && source !== ""
                smooth: true
            }

            // Custom Background HTML / Text Embedding
            Text {
                id: bgHtmlEmbedding
                anchors.fill: parent
                anchors.margins: 20
                text: chatCtrl.backgroundHTML
                textFormat: Text.RichText
                wrapMode: Text.Wrap
                opacity: 0.15
                visible: chatCtrl.backgroundHTML !== ""
            }
        }

        // Top-Left Sidebar Arrow Toggle Button (SideBarArrow in RisuAI)
        Rectangle {
            id: sideBarArrow
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.leftMargin: 12
            anchors.topMargin: 12
            width: 36
            height: 36
            radius: Theme.radiusMedium
            color: arrowMouse.containsMouse ? Theme.darkbutton : "transparent"
            border.color: Theme.darkborderc
            border.width: 1
            z: 20

            RisuIcon {
                anchors.centerIn: parent
                name: "menu"
                size: 16
                color: arrowMouse.containsMouse ? Theme.primaryLight : Theme.textcolor2
            }

            MouseArea {
                id: arrowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.toggleSidebarRequested()
            }

            ToolTip.visible: arrowMouse.containsMouse
            ToolTip.text: "Toggle Sidebar / 사이드바 토글"
            ToolTip.delay: 350
        }

        // Main Chat Column Container (Centered max-w-6xl)
        ColumnLayout {
            width: Math.min(1080, parent.width)
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            spacing: 0

            // Message Stream ListView
            ListView {
                id: messageListView
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.leftMargin: 16
                Layout.rightMargin: 16
                Layout.topMargin: 10
                Layout.bottomMargin: 8
                clip: true
                spacing: 8
                model: chatCtrl.messageModel

                ScrollBar.vertical: ScrollBar {
                    id: vScrollBar
                    policy: ScrollBar.AsNeeded
                }

                delegate: RisuChatBubble {
                    width: messageListView.width - 12
                    messageIndex: index
                    messageId: model.msgId || ""
                    role: model.role || "user"
                    senderName: model.name || (model.isUser ? "User" : (charCtrl.selectedCharacter.name || "Assistant"))
                    avatarSource: model.isUser ? "" : (charCtrl.selectedCharacter.avatarPath || "")
                    contentText: model.content || ""
                    thoughtText: model.thought || ""
                    formattedTime: model.formattedTime || ""
                    swipeIndex: model.currentSwipeIndex || 0
                    swipeCount: model.swipeCount || 1
                    isPinned: model.isPinned || false
                    emotion: model.emotion || ""
                    attachmentPath: model.attachmentPath || ""

                    onSwipeLeftRequested: function(row) {
                        chatCtrl.swipeMessage(row, -1);
                    }
                    onSwipeRightRequested: function(row) {
                        chatCtrl.swipeMessage(row, 1);
                    }
                    onEditRequested: function(row, newContent) {
                        chatCtrl.editMessage(row, newContent);
                    }
                    onDeleteRequested: function(row) {
                        chatCtrl.deleteMessage(row);
                    }
                    onRegenerateRequested: {
                        chatCtrl.regenerate();
                    }
                    onPinToggleRequested: function(row) {
                        chatCtrl.togglePinMessage(row);
                    }
                    onForkRequested: function(row) {
                        chatCtrl.forkChat(row);
                    }
                }

                onCountChanged: {
                    Qt.callLater(function() {
                        messageListView.positionViewAtEnd();
                    });
                }
            }

            // ==========================================
            // 3. AUTHENTIC RISUAI CONNECTED INPUT DOCK
            // (Matching DefaultChatScreen.svelte lines 663-797)
            // ==========================================
            Item {
                Layout.fillWidth: true
                Layout.preferredHeight: inputDockRow.implicitHeight + (root.currentAttachmentPath !== "" ? 38 : 0) + 16

                ColumnLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 16
                    anchors.rightMargin: 16
                    anchors.bottomMargin: 10
                    spacing: 6

                    // Attachment Preview Pill
                    Rectangle {
                        visible: root.currentAttachmentPath !== ""
                        Layout.preferredWidth: attachRow.implicitWidth + 16
                        Layout.preferredHeight: 28
                        radius: Theme.radiusFull
                        color: Theme.darkbg
                        border.color: Theme.darkborderc
                        border.width: 1

                        RowLayout {
                            id: attachRow
                            anchors.centerIn: parent
                            spacing: 6

                            RisuIcon {
                                name: "attachment"
                                size: 13
                                color: Theme.primaryLight
                            }

                            Text {
                                text: root.currentAttachmentPath.split("/").pop()
                                font.pixelSize: Theme.fontSmall
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                elide: Text.ElideMiddle
                                Layout.maximumWidth: 240
                            }

                            RisuIconButton {
                                iconName: "close"
                                buttonSize: 18
                                iconSize: 11
                                onClicked: root.currentAttachmentPath = ""
                            }
                        }
                    }

                    // Connected Input Bar: [ Textarea | Send | Menu ]
                    RowLayout {
                        id: inputDockRow
                        Layout.fillWidth: true
                        spacing: 0

                        // 1. Textarea (rounded-l-md, border-r-0)
                        Rectangle {
                            id: textInputBox
                            Layout.fillWidth: true
                            Layout.preferredHeight: Math.max(46, Math.min(150, messageInput.contentHeight + 18))
                            color: "transparent"
                            border.color: messageInput.activeFocus ? Theme.textcolor : Theme.darkborderc
                            border.width: 1
                            radius: Theme.radiusMedium

                            // Flatten right border radius so it connects seamlessly to Send button
                            Rectangle {
                                anchors.top: parent.top
                                anchors.bottom: parent.bottom
                                anchors.right: parent.right
                                width: Theme.radiusMedium
                                color: "transparent"
                            }

                            Flickable {
                                anchors.fill: parent
                                anchors.margins: 10
                                contentWidth: width
                                contentHeight: messageInput.contentHeight
                                clip: true

                                TextArea.flickable: TextArea {
                                    id: messageInput
                                    width: parent.width
                                    wrapMode: TextArea.Wrap
                                    color: Theme.textcolor
                                    font.pixelSize: Theme.fontNormal + 1
                                    font.family: Theme.fontFamily
                                    selectByMouse: true
                                    placeholderText: "Send a message... (Enter to send, Shift+Enter for newline)"
                                    placeholderTextColor: Qt.rgba(Theme.textcolor2.r, Theme.textcolor2.g, Theme.textcolor2.b, 0.6)
                                    background: null

                                    Keys.onReturnPressed: function(event) {
                                        if (event.modifiers & Qt.ShiftModifier) {
                                            event.accepted = false;
                                        } else {
                                            event.accepted = true;
                                            root.submitMessage();
                                        }
                                    }
                                }
                            }
                        }

                        // 2. Send Button (Attached middle: border-y, border-r-0, no radius)
                        Rectangle {
                            Layout.preferredWidth: 50
                            Layout.preferredHeight: textInputBox.Layout.preferredHeight
                            color: sendMouse.containsMouse ? Theme.primary : "transparent"
                            border.color: messageInput.activeFocus ? Theme.textcolor : Theme.darkborderc
                            border.width: 1

                            Behavior on color { ColorAnimation { duration: Theme.animFast } }

                            RisuIcon {
                                anchors.centerIn: parent
                                name: chatCtrl.isGenerating ? "stop" : "send"
                                size: 18
                                color: sendMouse.containsMouse ? "#ffffff" : Theme.textcolor
                            }

                            MouseArea {
                                id: sendMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    if (chatCtrl.isGenerating) {
                                        chatCtrl.stopGeneration();
                                    } else {
                                        root.submitMessage();
                                    }
                                }
                            }

                            ToolTip.visible: sendMouse.containsMouse
                            ToolTip.text: chatCtrl.isGenerating ? "Stop generation / 중지" : "Send message / 전송"
                            ToolTip.delay: 350
                        }

                        // 3. Menu Button (Attached right: border-y, border-r, rounded-r-md)
                        Rectangle {
                            Layout.preferredWidth: 44
                            Layout.preferredHeight: textInputBox.Layout.preferredHeight
                            color: menuBtnMouse.containsMouse ? Theme.primary : "transparent"
                            border.color: messageInput.activeFocus ? Theme.textcolor : Theme.darkborderc
                            border.width: 1
                            radius: Theme.radiusMedium

                            // Flatten left border radius so it connects seamlessly to Send button
                            Rectangle {
                                anchors.top: parent.top
                                anchors.bottom: parent.bottom
                                anchors.left: parent.left
                                width: Theme.radiusMedium
                                color: menuBtnMouse.containsMouse ? Theme.primary : "transparent"
                            }

                            Behavior on color { ColorAnimation { duration: Theme.animFast } }

                            RisuIcon {
                                anchors.centerIn: parent
                                name: "more-vertical"
                                size: 18
                                color: menuBtnMouse.containsMouse ? "#ffffff" : Theme.textcolor
                            }

                            MouseArea {
                                id: menuBtnMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: inputActionMenu.open()
                            }

                            ToolTip.visible: menuBtnMouse.containsMouse
                            ToolTip.text: "Action Menu / 메뉴"
                            ToolTip.delay: 350
                        }
                    }
                }
            }
        }
    }

    // Input Action Popup Menu (Matching DefaultChatScreen.svelte)
    Menu {
        id: inputActionMenu
        x: root.width - 240
        y: root.height - 280

        MenuItem {
            text: "Continue Response / 이어쓰기"
            onTriggered: chatCtrl.continueMessage()
        }
        MenuItem {
            text: "Attach Image / 이미지 첨부"
            onTriggered: attachFileDialog.open()
        }
        MenuItem {
            text: "Roll Dice / 주사위 굴리기"
            onTriggered: chatCtrl.rollDice(1, 20)
        }
        MenuItem {
            text: "Visual Novel Mode / 비주얼 노벨"
            onTriggered: root.openVisualNovelRequested()
        }
        MenuItem {
            text: "Preset Settings / 프리셋 설정"
            onTriggered: root.openPresetSettingsRequested()
        }
        MenuItem {
            text: "Edit Character / 캐릭터 수정"
            onTriggered: root.editCharacterRequested(charCtrl.selectedCharacter.id)
        }
        MenuItem {
            text: "Clear Chat History / 대화 비우기"
            onTriggered: clearConfirmDialog.open()
        }
    }

    function submitMessage() {
        var text = messageInput.text.trim();
        if (text.length === 0 && root.currentAttachmentPath === "") return;

        if (root.currentAttachmentPath !== "") {
            chatCtrl.sendMessageWithAttachment(text, root.currentAttachmentPath);
            root.currentAttachmentPath = "";
        } else {
            chatCtrl.sendMessage(text);
        }

        messageInput.text = "";
    }
}
