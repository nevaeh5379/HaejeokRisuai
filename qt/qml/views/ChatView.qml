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
            chatCtrl.clearChat(-1);
        }
    }

    // Export Chat Dialog
    FileDialog {
        id: exportFileDialog
        title: "Export Chat History / 대화 내보내기"
        fileMode: FileDialog.SaveFile
        nameFilters: ["Markdown (*.md)", "HTML Document (*.html)", "JSON (*.json)", "Text (*.txt)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            var ext = "md";
            if (path.endsWith(".html")) ext = "html";
            else if (path.endsWith(".json")) ext = "json";
            else if (path.endsWith(".txt")) ext = "txt";
            chatCtrl.exportChat(ext, path);
        }
    }

    // Author Note Dialog
    RisuDialog {
        id: authorNoteDialog
        dialogTitle: "Author's Note / 저자 노트"
        width: 480

        ColumnLayout {
            width: parent.width
            spacing: 12

            Text {
                text: "Session Specific Author's Note (Injected into context)"
                color: Theme.textcolor2
                font.pixelSize: Theme.fontSmall
                font.family: Theme.fontFamily
            }

            RisuTextArea {
                id: authorNoteArea
                Layout.fillWidth: true
                Layout.preferredHeight: 120
                text: chatCtrl.authorNote
                placeholderText: "[Author's Note: Elena acts shy but observant...]"
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                Text {
                    text: "Insertion Depth:"
                    color: Theme.textcolor2
                    font.pixelSize: Theme.fontSmall
                    font.family: Theme.fontFamily
                }

                RisuSlider {
                    id: depthSlider
                    Layout.fillWidth: true
                    from: 0
                    to: 10
                    stepSize: 1
                    value: chatCtrl.authorNoteDepth
                }

                Text {
                    text: depthSlider.value.toString()
                    color: Theme.textcolor
                    font.pixelSize: Theme.fontNormal
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
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
                    onClicked: authorNoteDialog.close()
                }

                RisuButton {
                    text: "Save / 저장"
                    variant: "primary"
                    onClicked: {
                        chatCtrl.setAuthorNote(authorNoteArea.text);
                        chatCtrl.setAuthorNoteDepth(depthSlider.value);
                        authorNoteDialog.close();
                    }
                }
            }
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

        // Background Embedding (Large Portrait / Custom CSS3 & HTML)
        Item {
            id: backgroundEmbeddingLayer
            anchors.fill: parent
            z: 0

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

        // ==========================================
        // Chat Sessions Drawer (Left slide-out panel)
        // ==========================================
        ChatSessionDrawer {
            id: sessionDrawer
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            isOpen: false
            z: 100
        }

        // Main Chat Layout Container (Centered)
        ColumnLayout {
            anchors.left: sessionDrawer.right
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            spacing: 0

            // ==========================================
            // TOP CHAT HEADER BAR & SESSION SWITCHER
            // ==========================================
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 52
                color: Theme.bgcolor
                border.color: Theme.darkborderc
                border.width: 1
                z: 10

                RowLayout {
                    anchors.fill: parent
                    anchors.leftMargin: 12
                    anchors.rightMargin: 14
                    spacing: 8

                    // Sidebar Toggle Button
                    Rectangle {
                        width: 34
                        height: 34
                        radius: Theme.radiusMedium
                        color: arrowMouse.containsMouse ? Theme.darkbutton : "transparent"
                        border.color: Theme.darkborderc
                        border.width: 1

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

                    // Character Avatar Pill
                    RisuAvatar {
                        avatarSource: charCtrl.selectedCharacter.avatarPath || ""
                        characterName: charCtrl.selectedCharacter.name || ""
                        size: 32
                    }

                    // Character Name & Active Session Chip
                    Column {
                        spacing: 1

                        Text {
                            text: charCtrl.selectedCharacter.name || "Character"
                            font.pixelSize: Theme.fontNormal
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        // Active Session Chip (Clickable to open Sessions Drawer)
                        Rectangle {
                            height: 18
                            width: sessionChipRow.implicitWidth + 12
                            radius: Theme.radiusFull
                            color: sessionChipMouse.containsMouse ? Theme.darkbutton : Theme.selected
                            border.color: sessionChipMouse.containsMouse ? Theme.primary : Theme.darkborderc
                            border.width: 1

                            RowLayout {
                                id: sessionChipRow
                                anchors.centerIn: parent
                                spacing: 4

                                RisuIcon {
                                    name: "message-square"
                                    size: 10
                                    color: Theme.primaryLight
                                }

                                Text {
                                    text: chatCtrl.currentChatName + " (" + chatCtrl.messageModel.rowCount + " msgs)"
                                    font.pixelSize: Theme.fontTiny
                                    font.weight: Font.Medium
                                    font.family: Theme.fontFamily
                                    color: Theme.primaryLight
                                }

                                RisuIcon {
                                    name: "chevron-down"
                                    size: 10
                                    color: Theme.textcolor2
                                }
                            }

                            MouseArea {
                                id: sessionChipMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    sessionDrawer.isOpen = !sessionDrawer.isOpen;
                                }
                            }

                            ToolTip.visible: sessionChipMouse.containsMouse
                            ToolTip.text: "Click to open Chat Sessions / 세션 목록 열기"
                            ToolTip.delay: 300
                        }
                    }

                    // Quick "+ New Session" Button
                    RisuButton {
                        text: "+ New Session"
                        variant: "outline"
                        Layout.preferredHeight: 30
                        onClicked: {
                            chatCtrl.createNewChat();
                        }
                    }

                    Item { Layout.fillWidth: true }

                    // Token Breakdown Badge
                    Rectangle {
                        Layout.preferredHeight: 28
                        Layout.preferredWidth: tokRow.implicitWidth + 14
                        radius: Theme.radiusFull
                        color: Theme.darkbg
                        border.color: Theme.darkborderc
                        border.width: 1

                        RowLayout {
                            id: tokRow
                            anchors.centerIn: parent
                            spacing: 6

                            RisuIcon {
                                name: "cpu"
                                size: 12
                                color: Theme.textcolor2
                            }

                            Text {
                                text: (chatCtrl.activePresetModel ? chatCtrl.activePresetModel : "AI") + " | ~" + chatCtrl.tokenEstimate + " tok"
                                font.pixelSize: Theme.fontTiny
                                font.family: Theme.fontFamily
                                color: Theme.textcolor2
                            }
                        }

                        ToolTip.visible: tokMouse.containsMouse
                        ToolTip.text: "Prompt: ~" + chatCtrl.tokenEstimate + " tokens\n(System: " + chatCtrl.systemTokens + ", Lore: " + chatCtrl.lorebookTokens + ", Hist: " + chatCtrl.historyTokens + ", A.Note: " + chatCtrl.authorNoteTokens + ")"
                        ToolTip.delay: 200

                        MouseArea {
                            id: tokMouse
                            anchors.fill: parent
                            hoverEnabled: true
                        }
                    }

                    // Sessions Drawer Toggle Button
                    RisuIconButton {
                        iconName: "message-square"
                        buttonSize: 32
                        iconSize: 15
                        tooltipText: "Chat Sessions (" + chatCtrl.chatSessionCount + ") / 대화 세션 관리"
                        onClicked: sessionDrawer.isOpen = !sessionDrawer.isOpen
                    }

                    // Author's Note Popover Button
                    RisuIconButton {
                        iconName: "edit-3"
                        buttonSize: 32
                        iconSize: 15
                        tooltipText: "Author's Note / 저자 노트"
                        onClicked: {
                            authorNoteArea.text = chatCtrl.authorNote;
                            depthSlider.value = chatCtrl.authorNoteDepth;
                            authorNoteDialog.open();
                        }
                    }

                    // Visual Novel Mode Button
                    RisuIconButton {
                        iconName: "film"
                        buttonSize: 32
                        iconSize: 15
                        tooltipText: "Visual Novel Mode / 비주얼 노벨 모드"
                        onClicked: root.openVisualNovelRequested()
                    }

                    // Export Chat Button
                    RisuIconButton {
                        iconName: "share"
                        buttonSize: 32
                        iconSize: 15
                        tooltipText: "Export Chat / 대화 내보내기"
                        onClicked: exportFileDialog.open()
                    }

                    // Clear Chat Button
                    RisuIconButton {
                        iconName: "trash-2"
                        buttonSize: 32
                        iconSize: 15
                        tooltipText: "Clear Messages / 대화 비우기"
                        onClicked: clearConfirmDialog.open()
                    }
                }
            }

            // Message Stream ListView
            ListView {
                id: messageListView
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.preferredHeight: 0
                Layout.leftMargin: 16
                Layout.rightMargin: 16
                Layout.topMargin: 10
                Layout.bottomMargin: 8
                clip: true
                spacing: 8
                interactive: true
                model: chatCtrl.messageModel
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.VerticalFlick
                pixelAligned: true

                // Generous cache buffer to eliminate delegate creation jitter & popping
                cacheBuffer: 5000
                displayMarginBeginning: 2000
                displayMarginEnd: 2000

                ScrollBar.vertical: ScrollBar {
                    id: vScrollBar
                    policy: ScrollBar.AsNeeded
                    width: 8
                    active: true
                }

                // Smooth and precise desktop mouse wheel handler
                WheelHandler {
                    id: desktopWheelHandler
                    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                    target: null
                    onWheel: function(event) {
                        var delta = event.angleDelta.y !== 0 ? event.angleDelta.y : event.pixelDelta.y;
                        if (delta === 0) return;

                        var scrollStep = -delta * 0.9;
                        var maxScrollY = Math.max(0, messageListView.contentHeight - messageListView.height);
                        var targetY = Math.max(0, Math.min(maxScrollY, messageListView.contentY + scrollStep));

                        messageListView.contentY = targetY;
                        event.accepted = true;
                    }
                }

                // Scroll to bottom when a new message is appended
                onCountChanged: {
                    Qt.callLater(function() {
                        messageListView.positionViewAtEnd();
                    });
                }

                // Stream follow: only scroll down if already at the bottom
                Connections {
                    target: chatCtrl.messageModel
                    function onMessageUpdated(row) {
                        if (messageListView.atYEnd) {
                            Qt.callLater(function() {
                                messageListView.positionViewAtEnd();
                            });
                        }
                    }
                }

                Connections {
                    target: chatCtrl
                    function onGenerationFinished(response) {
                        if (messageListView.atYEnd) {
                            Qt.callLater(function() {
                                messageListView.positionViewAtEnd();
                            });
                        }
                    }
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
