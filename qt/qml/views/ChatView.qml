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
                source: (chatCtrl.largePortrait && chatCtrl.activeCharacterAvatar) ? (chatCtrl.activeCharacterAvatar.startsWith("file://") ? chatCtrl.activeCharacterAvatar : (appConfig.resolveAssetUrl(chatCtrl.activeCharacterAvatar) || "")) : ""
                visible: chatCtrl.largePortrait && source !== ""
                smooth: true
                asynchronous: true
                sourceSize.height: 1200
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

        // Hidden measuring pipeline. While the user reads, it walks the whole
        // history through one off-screen MarkdownView and records every real
        // Chromium height into Theme.mdHeightCache. Delegates created later —
        // by scrollbar drags in particular — then start at exact heights, so
        // contentHeight stops drifting and dragging the thumb no longer
        // remaps its position mid-drag (the "teleporting" scroll).
        MarkdownView {
            id: heightWarmer
            visible: false
            width: Math.max(200, messageListView.width - 36)
        }

        property var _warmQueue: []
        property bool _warmingBusy: false
        property int _warmTries: 0

        function _looksLikeHtml(text) {
            return text && /<[^>]+>/.test(String(text).replace(/<think>[\s\S]*?<\/think>/gi, ""));
        }

        function startHeightWarmup() {
            if (typeof appConfig === "undefined" || !appConfig || !appConfig.renderMessageHtml) return;
            var q = [];
            var total = chatCtrl.messageModel.rowCount;
            for (var i = total - 1; i >= 0; --i) {
                var m = chatCtrl.messageModel.get(i);
                if (!m || !m.content || !root._looksLikeHtml(m.content)) continue;
                if (!m.msgId) continue;
                var key = m.msgId + ":" + (m.currentSwipeIndex || 0);
                if (Theme.mdHeightCache[key]) continue;
                q.push({ key: key, text: m.content });
                if (q.length >= 120) break;
            }
            root._warmQueue = q;
            root._warmTries = 0;
            root._advanceWarmup();
        }

        function _advanceWarmup() {
            if (root._warmingBusy) return;
            if (root._warmQueue.length === 0) {
                root._warmTries = 0;
                return;
            }
            var item = root._warmQueue[0];
            root._warmingBusy = true;
            heightWarmer.measureOnce(item.text, item.key);
        }

        Timer {
            id: warmWatchdog
            interval: 1200
            repeat: true
            running: root._warmQueue.length > 0
            onTriggered: {
                if (!root._warmingBusy) {
                    root._advanceWarmup();
                    return;
                }
                root._warmTries += 1;
                if (root._warmTries >= 4) {
                    root._warmQueue.shift();
                    root._warmTries = 0;
                    root._warmingBusy = false;
                    root._advanceWarmup();
                } else {
                    heightWarmer.measureOnce(root._warmQueue[0].text, root._warmQueue[0].key);
                }
            }
        }

        Connections {
            target: heightWarmer
            function onHeightMeasured() {
                if (root._warmQueue.length > 0 && root._warmingBusy) {
                    root._warmQueue.shift();
                }
                root._warmingBusy = false;
                root._warmTries = 0;
                Qt.callLater(root._advanceWarmup);
            }
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

            // Message Stream.
            //
            // Deliberately a plain Flickable holding a static Column of every
            // message rather than a ListView: ListView recycles delegate
            // lifecycles against asynchronously-measured heights (embedded web
            // views), which forces estimation games whose corrections show up
            // as disappearing chats, snap-backs and scrollbar teleports. Here
            // every bubble simply exists for the session's lifetime, so
            // contentHeight is ground truth and scroll math never shifts under
            // the user. Far-from-viewport web views detach (their reserved
            // height stays) so memory stays bounded without touching layout.
            Flickable {
                id: messageListView
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.preferredHeight: 0
                Layout.leftMargin: 16
                Layout.rightMargin: 16
                Layout.topMargin: 10
                Layout.bottomMargin: 8
                clip: true
                interactive: true
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.VerticalFlick
                pixelAligned: true
                contentWidth: width
                contentHeight: messageColumn.height

                // Sticky-tail scrolling: streaming content may grow after atYEnd becomes false,
                // so remember whether the user intentionally left the bottom instead.
                property bool followTail: true
                property real lastContentY: 0
                property bool tailJumping: false
                property real _pendingCompensation: 0

                function isNearEnd() {
                    return contentHeight <= height || contentY >= Math.max(0, contentHeight - height - 150);
                }

                function scrollToTail() {
                    if (!root.hasCharacter) return;
                    messageListView.tailJumping = true;
                    Qt.callLater(function() {
                        var maxY = Math.max(0, messageListView.contentHeight - messageListView.height);
                        if (messageListView.contentY < maxY - 150) {
                            messageListView.contentY = maxY;
                        }
                        messageListView.lastContentY = messageListView.contentY;
                        messageListView.tailJumping = false;
                    });
                }

                function flushPendingCompensation() {
                    var pending = messageListView._pendingCompensation;
                    messageListView._pendingCompensation = 0;
                    if (pending === 0) return;

                    var minY = 0;
                    var maxY = Math.max(minY, messageListView.contentHeight - messageListView.height);
                    var target = Math.min(maxY, Math.max(minY, messageListView.contentY + pending));
                    messageListView.tailJumping = true;
                    messageListView.contentY = target;
                    messageListView.lastContentY = target;
                    messageListView.tailJumping = false;
                }

                Component.onCompleted: messageListView.lastContentY = messageListView.contentY

                onMovementEnded: messageListView.flushPendingCompensation()

                // Release the sticky tail on ANY upward motion, no matter how
                // small and no matter who caused it: a drag, a flick, a mouse
                // wheel over native text, or the wheel forwarder inside
                // MarkdownView writing contentY directly (which never raises
                // movement events). Programmatic jumps to the tail are exempt
                // via tailJumping, and content growing underneath while pinned
                // only increases contentY, so it can never clear this either.
                onContentYChanged: {
                    if (!messageListView.tailJumping && contentY < messageListView.lastContentY - 0.5) {
                        messageListView.followTail = false;
                    }
                    messageListView.lastContentY = contentY;
                }

                ScrollBar.vertical: ScrollBar {
                    id: vScrollBar
                    policy: ScrollBar.AsNeeded
                    width: 8
                    active: true
                }

                // Scroll on append only while the user is following the tail.
                Connections {
                    target: chatCtrl.messageModel
                    function onCountChanged() {
                        if (messageListView.followTail && (typeof appConfig === "undefined" || appConfig.autoScroll)) {
                            messageListView.scrollToTail();
                        }
                    }
                    function onMessageUpdated(row) {
                        if (messageListView.followTail && (typeof appConfig === "undefined" || appConfig.autoScroll)) {
                            messageListView.scrollToTail();
                        }
                    }
                }

                // Keep chasing the tail while it grows. Right after a chat loads,
                // bubble heights are still settling, so contentHeight keeps
                // increasing for a few frames; without this the single
                // scroll-to-bottom issued at load time aims at a stale height and
                // leaves the view stranded near the top.
                onContentHeightChanged: {
                    if (messageListView.followTail && (typeof appConfig === "undefined" || appConfig.autoScroll)) {
                        messageListView.scrollToTail();
                    }
                }

                // Keep following a streaming response even though growth temporarily
                // makes atYEnd false. Stop only after the user intentionally scrolls away.
                Connections {
                    target: chatCtrl
                    function onGenerationFinished(response) {
                        if (messageListView.followTail && (typeof appConfig === "undefined" || appConfig.autoScroll)) {
                            messageListView.scrollToTail();
                        }
                    }
                    function onCurrentChatChanged() {
                        Qt.callLater(function() {
                            messageListView.followTail = true;
                            messageListView.scrollToTail();
                        });
                        root.startHeightWarmup();
                    }
                    function onActiveCharacterChanged() {
                        Qt.callLater(function() {
                            messageListView.followTail = true;
                            messageListView.scrollToTail();
                        });
                        root.startHeightWarmup();
                    }
                }

                Column {
                    id: messageColumn
                    width: messageListView.width - 12
                    spacing: 8

                    Repeater {
                        model: chatCtrl.messageModel

                        delegate: RisuChatBubble {
                            id: messageBubble

                            width: messageColumn.width
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

                    liveRequested: Math.abs(messageBubble.y - messageListView.contentY) < messageListView.height * 2.5

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

        // Sending from the input dock is an explicit request to follow the new turn.
        messageListView.followTail = true;

        if (root.currentAttachmentPath !== "") {
            chatCtrl.sendMessage(text, root.currentAttachmentPath);
            root.currentAttachmentPath = "";
        } else {
            chatCtrl.sendMessage(text);
        }

        messageInput.text = "";
    }
}
