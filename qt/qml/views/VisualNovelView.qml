import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "../theme"
import "../components"

Rectangle {
    id: root

    signal exitRequested()
    signal closeRequested()

    color: "#0a0a0f"

    property string charName: charCtrl.selectedCharacter.name || "Companion"
    property string avatarPath: charCtrl.selectedCharacter.avatarPath || ""
    property string currentContent: {
        if (chatCtrl.messageModel.count > 0) {
            var lastMsg = chatCtrl.messageModel.get(chatCtrl.messageModel.count - 1);
            return (lastMsg && lastMsg.content) ? lastMsg.content : "";
        }
        return charCtrl.selectedCharacter.firstMessage || "...";
    }
    property string currentEmotion: {
        if (chatCtrl.messageModel.count > 0) {
            var lastMsg = chatCtrl.messageModel.get(chatCtrl.messageModel.count - 1);
            return (lastMsg && lastMsg.emotion) ? lastMsg.emotion : "";
        }
        return "";
    }

    // Dynamic Emotion Sprite Source
    readonly property string spriteSource: {
        if (currentEmotion !== "" && typeof chatCtrl !== "undefined") {
            var s = chatCtrl.getEmotionSprite(currentEmotion);
            if (s !== "") return s;
        }
        return avatarPath;
    }

    // Scenic Background Layer
    Image {
        id: bgImage
        anchors.fill: parent
        source: ""
        fillMode: Image.PreserveAspectCrop
        opacity: 0.35

        Rectangle {
            anchors.fill: parent
            gradient: Gradient {
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.7; color: Qt.rgba(0, 0, 0, 0.4) }
                GradientStop { position: 1.0; color: "#0a0a0f" }
            }
        }
    }

    // Top Action Bar
    RowLayout {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: 16
        z: 10
        spacing: 12

        RisuButton {
            text: "Exit VN Mode"
            iconName: "arrow-left"
            variant: "secondary"
            onClicked: root.exitRequested()
        }

        Item { Layout.fillWidth: true }

        RisuBadge {
            text: "Visual Novel Immersion Mode"
            badgeColor: Theme.darkbg
            textColor: Theme.textcolor2
        }

        RisuIconButton {
            iconName: (typeof ttsCtrl !== "undefined" && ttsCtrl.isSpeaking) ? "stop" : "volume"
            tooltipText: "Play Voice"
            visible: typeof ttsCtrl !== "undefined" && ttsCtrl.ttsEnabled
            onClicked: {
                if (ttsCtrl.isSpeaking) ttsCtrl.stop();
                else ttsCtrl.speak(root.currentContent);
            }
        }

        RisuIconButton {
            iconName: "refresh"
            tooltipText: "Reroll / 다시 생성"
            onClicked: chatCtrl.regenerate()
        }
    }

    // Character Sprite Center Stage
    Item {
        anchors.fill: parent
        anchors.bottomMargin: 180

        Image {
            id: charSprite
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            height: Math.min(parent.height * 0.9, 700)
            width: height * 0.75
            source: root.spriteSource ? (root.spriteSource.startsWith("file://") ? root.spriteSource : "file://" + root.spriteSource) : ""
            fillMode: Image.PreserveAspectFit
            smooth: true
            asynchronous: true

            Behavior on opacity {
                NumberAnimation { duration: 300 }
            }

            // Idle breathing animation
            SequentialAnimation on y {
                loops: Animation.Infinite
                NumberAnimation { from: charSprite.y; to: charSprite.y - 6; duration: 2500; easing.type: Easing.InOutQuad }
                NumberAnimation { from: charSprite.y - 6; to: charSprite.y; duration: 2500; easing.type: Easing.InOutQuad }
            }
        }
    }

    // Bottom Visual Novel Dialogue Box
    Rectangle {
        id: dialogueBox
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 24
        height: 180
        radius: Theme.radiusLarge
        color: Qt.rgba(Theme.darkbg.r, Theme.darkbg.g, Theme.darkbg.b, 0.92)
        border.color: Theme.darkborderc
        border.width: 1

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 18
            spacing: 8

            // Name Tag Pill
            Rectangle {
                height: 28
                radius: Theme.radiusSmall
                color: Theme.primary
                implicitWidth: nameText.implicitWidth + 24

                Text {
                    id: nameText
                    anchors.centerIn: parent
                    text: root.charName
                    font.pixelSize: Theme.fontMedium
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: "#ffffff"
                }
            }

            // Dialogue Scroll Area
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true

                MarkdownView {
                    width: dialogueBox.width - 48
                    rawText: root.currentContent
                    textColor: Theme.textcolor
                }
            }

            // Fast Input Field for VN Mode
            RowLayout {
                Layout.fillWidth: true
                spacing: 10

                RisuTextField {
                    id: vnInputField
                    Layout.fillWidth: true
                    placeholderText: "Type response... (Enter to reply)"
                    Keys.onReturnPressed: {
                        var t = vnInputField.text.trim();
                        if (t.length > 0 && !chatCtrl.isGenerating) {
                            vnInputField.text = "";
                            chatCtrl.sendMessage(t);
                        }
                    }
                }

                RisuButton {
                    text: "Send"
                    iconName: "send"
                    variant: "primary"
                    onClicked: {
                        var t = vnInputField.text.trim();
                        if (t.length > 0 && !chatCtrl.isGenerating) {
                            vnInputField.text = "";
                            chatCtrl.sendMessage(t);
                        } else if (!chatCtrl.isGenerating) {
                            chatCtrl.sendMessage("...");
                        }
                    }
                }
            }
        }
    }
}
