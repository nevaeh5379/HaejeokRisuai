import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "../theme"

Rectangle {
    id: root

    property int messageIndex: -1
    property string messageId: ""
    property string role: "user"
    property bool isUser: role === "user"
    property string senderName: isUser ? "User" : "Assistant"
    property string avatarSource: ""
    property string contentText: ""
    property string thoughtText: ""
    property string formattedTime: ""
    property int swipeIndex: 0
    property int swipeCount: 1
    property bool isPinned: false
    property string emotion: ""
    property string attachmentPath: ""
    property string modelName: ""

    property bool isEditing: false
    property bool liveRequested: true
    property bool isHovered: bubbleHoverHandler.hovered

    // Coalesce rapid streaming updates so markdown re-rendering runs at most
    // ~8 times per second instead of once per received token chunk.
    property string displayedContent: contentText
    onContentTextChanged: renderThrottle.restart()

    Timer {
        id: renderThrottle
        interval: 120
        onTriggered: root.displayedContent = root.contentText
    }

    Component.onCompleted: root.displayedContent = root.contentText

    signal swipeLeftRequested(int row)
    signal swipeRightRequested(int row)
    signal editRequested(int row, string newContent)
    signal deleteRequested(int row)
    signal regenerateRequested()
    signal pinToggleRequested(int row)
    signal forkRequested(int row)

    width: parent ? parent.width : 600
    implicitHeight: mainLayout.implicitHeight + 20
    height: implicitHeight
    color: isPinned ? Qt.rgba(Theme.primary.r, Theme.primary.g, Theme.primary.b, 0.08) : (isHovered ? Qt.rgba(255, 255, 255, 0.02) : "transparent")
    border.color: isPinned ? Theme.primary : "transparent"
    border.width: isPinned ? 1 : 0
    radius: Theme.radiusMedium

    Behavior on color {
        ColorAnimation { duration: Theme.animFast }
    }

    RowLayout {
        id: mainLayout
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 12
        spacing: 16

        // Left Avatar (52px rounded squircle matching RisuAI)
        RisuAvatar {
            Layout.alignment: Qt.AlignTop
            avatarSize: 52
            avatarRadius: Theme.radiusMedium
            imageSource: (root.emotion !== "" && typeof chatCtrl !== "undefined") ? chatCtrl.getEmotionSprite(root.emotion) : root.avatarSource
            isUser: root.isUser
            fallbackText: root.senderName ? root.senderName.charAt(0).toUpperCase() : (root.isUser ? "U" : "C")
            showBorder: false
        }

        // Right Content Column
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 6

            // Top Header: Name, Model Tag, Timestamp & Action Buttons
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                // Sender Name
                Text {
                    text: root.senderName
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                }

                // AI Model Info Pill
                Rectangle {
                    visible: !root.isUser
                    height: 22
                    radius: Theme.radiusFull
                    color: Theme.darkbg
                    border.color: Theme.darkborderc
                    border.width: 1
                    implicitWidth: modelRow.implicitWidth + 12

                    Row {
                        id: modelRow
                        anchors.centerIn: parent
                        spacing: 4

                        RisuIcon {
                            name: "bot"
                            size: 12
                            color: Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: root.modelName ? root.modelName : (typeof presetCtrl !== "undefined" && presetCtrl.activePreset.model ? presetCtrl.activePreset.model : "AI")
                            font.pixelSize: Theme.fontTiny
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                }

                // Pinned Badge
                Rectangle {
                    visible: root.isPinned
                    height: 20
                    radius: Theme.radiusFull
                    color: Qt.rgba(Theme.warning.r, Theme.warning.g, Theme.warning.b, 0.2)
                    border.color: Theme.warning
                    border.width: 1
                    implicitWidth: pinRow.implicitWidth + 10

                    Row {
                        id: pinRow
                        anchors.centerIn: parent
                        spacing: 3

                        RisuIcon {
                            name: "pin"
                            size: 11
                            color: Theme.warning
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "Pinned"
                            font.pixelSize: Theme.fontTiny
                            font.weight: Font.DemiBold
                            font.family: Theme.fontFamily
                            color: Theme.warning
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                }

                // Timestamp
                Text {
                    text: root.formattedTime
                    font.pixelSize: Theme.fontTiny
                    font.family: Theme.fontFamily
                    color: Theme.textcolor2
                }

                Item { Layout.fillWidth: true }

                // Hover Actions Toolbar (Matches Chat.svelte iconButtons)
                RowLayout {
                    spacing: 2
                    opacity: (root.isHovered || root.swipeCount > 1 || root.isEditing) ? 1.0 : 0.0

                    Behavior on opacity {
                        NumberAnimation { duration: Theme.animFast }
                    }

                    // Multi-Swipe Controls (◀ 1 / 3 ▶)
                    RowLayout {
                        visible: root.swipeCount > 1
                        spacing: 2

                        RisuIconButton {
                            iconName: "chevron-left"
                            tooltipText: "Previous swipe / 이전 응답"
                            buttonSize: 26
                            onClicked: root.swipeLeftRequested(root.messageIndex)
                        }

                        Text {
                            text: String(root.swipeIndex + 1) + "/" + String(root.swipeCount)
                            font.pixelSize: Theme.fontTiny
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                        }

                        RisuIconButton {
                            iconName: "chevron-right"
                            tooltipText: "Next swipe / 다음 응답"
                            buttonSize: 26
                            onClicked: root.swipeRightRequested(root.messageIndex)
                        }
                    }

                    // Regenerate / Reroll (only for AI)
                    RisuIconButton {
                        iconName: "refresh"
                        tooltipText: "Reroll response / 다시 생성"
                        buttonSize: 26
                        visible: !root.isUser
                        onClicked: root.regenerateRequested()
                    }

                    // Copy Button
                    RisuIconButton {
                        iconName: "copy"
                        tooltipText: "Copy message / 복사"
                        buttonSize: 26
                        onClicked: {
                            editArea.text = root.contentText;
                            editArea.selectAll();
                            editArea.copy();
                            editArea.deselect();
                            if (typeof appCtrl !== "undefined") {
                                appCtrl.triggerToast("info", "Copied to clipboard");
                            }
                        }
                    }

                    // Edit Button
                    RisuIconButton {
                        iconName: "pencil"
                        tooltipText: "Edit message / 수정"
                        buttonSize: 26
                        customColor: root.isEditing ? Theme.primaryLight : Theme.textcolor2
                        onClicked: {
                            root.isEditing = !root.isEditing;
                            if (root.isEditing) {
                                editArea.text = root.contentText;
                                editArea.forceActiveFocus();
                            }
                        }
                    }

                    // TTS Speak Button
                    RisuIconButton {
                        iconName: (typeof ttsCtrl !== "undefined" && ttsCtrl.isSpeaking) ? "stop" : "volume"
                        tooltipText: "Read aloud (TTS) / 음성 읽기"
                        buttonSize: 26
                        visible: typeof ttsCtrl !== "undefined" && ttsCtrl.ttsEnabled && root.contentText.length > 0
                        onClicked: {
                            if (ttsCtrl.isSpeaking) {
                                ttsCtrl.stop();
                            } else {
                                ttsCtrl.speak(root.contentText);
                            }
                        }
                    }

                    // Fork / Branch Button
                    RisuIconButton {
                        iconName: "branch"
                        tooltipText: "Branch chat / 분기 생성"
                        buttonSize: 26
                        onClicked: root.forkRequested(root.messageIndex)
                    }

                    // Pin / Bookmark Button
                    RisuIconButton {
                        iconName: "bookmark"
                        tooltipText: root.isPinned ? "Unpin message" : "Pin message"
                        buttonSize: 26
                        customColor: root.isPinned ? Theme.warning : Theme.textcolor2
                        onClicked: root.pinToggleRequested(root.messageIndex)
                    }

                    // Delete Button
                    RisuIconButton {
                        iconName: "trash"
                        tooltipText: "Delete message / 삭제"
                        buttonSize: 26
                        hoverColor: Theme.draculared
                        onClicked: root.deleteRequested(root.messageIndex)
                    }
                }
            }

            // Normal Display Mode (Markdown & Thought Drawer)
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                visible: !root.isEditing

                // Image Attachment Preview
                Rectangle {
                    visible: root.attachmentPath !== ""
                    Layout.preferredWidth: Math.min(360, parent.width)
                    Layout.preferredHeight: 220
                    radius: Theme.radiusMedium
                    color: Theme.darkbg
                    border.color: Theme.darkborderc
                    border.width: 1
                    clip: true

                    Image {
                        anchors.fill: parent
                        source: root.attachmentPath ? (root.attachmentPath.startsWith("file://") ? root.attachmentPath : (appConfig.resolveAssetUrl(root.attachmentPath) || "")) : ""
                        fillMode: Image.PreserveAspectFit
                        smooth: true
                        asynchronous: true
                        sourceSize.width: 720
                        sourceSize.height: 440
                    }
                }

                MarkdownView {
                    Layout.fillWidth: true
                    rawText: (typeof chatCtrl !== "undefined") ? chatCtrl.formatInChat(root.displayedContent) : root.displayedContent
                    thoughtText: root.thoughtText
                    textColor: Theme.fontStandard
                    cacheKey: root.messageId !== "" ? (root.messageId + ":" + root.swipeIndex) : ""
                    liveRequested: root.liveRequested
                }
            }

            // Inline Edit Form Mode
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                visible: root.isEditing

                RisuTextArea {
                    id: editArea
                    Layout.fillWidth: true
                    implicitHeight: Math.max(100, contentHeight + 30)
                    text: root.contentText
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Item { Layout.fillWidth: true }

                    RisuButton {
                        text: "Cancel"
                        variant: "ghost"
                        onClicked: root.isEditing = false
                    }

                    RisuButton {
                        text: "Save"
                        variant: "primary"
                        onClicked: {
                            root.editRequested(root.messageIndex, editArea.text);
                            root.isEditing = false;
                        }
                    }
                }
            }
        }
    }

    HoverHandler {
        id: bubbleHoverHandler
    }
}
