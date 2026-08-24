import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"
import "../components"

Rectangle {
    id: root

    signal closeRequested()

    color: Theme.bgcolor

    property string charId: charCtrl.selectedCharacter.id || ""
    property var altGreetings: charCtrl.selectedCharacter.alternateGreetings || []
    property int activeTab: 0

    FileDialog {
        id: avatarPicker
        title: "Select Avatar Image"
        nameFilters: ["Images (*.png *.jpg *.jpeg *.webp)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            charCtrl.setAvatarImage(root.charId, path);
        }
    }

    FileDialog {
        id: exportPngDialog
        title: "Export Character Card (PNG)"
        fileMode: FileDialog.SaveFile
        nameFilters: ["PNG Character Card (*.png)"]
        defaultSuffix: "png"
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            charCtrl.exportCardToPng(root.charId, path);
        }
    }

    FileDialog {
        id: exportJsonDialog
        title: "Export Character Card (JSON)"
        fileMode: FileDialog.SaveFile
        nameFilters: ["JSON Card (*.json)"]
        defaultSuffix: "json"
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            charCtrl.exportCardToJson(root.charId, path);
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // ==========================================
        // 1. TOP HEADER ACTION BAR
        // ==========================================
        Rectangle {
            Layout.fillWidth: true
            height: 56
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                spacing: 12

                RisuIconButton {
                    iconName: "arrow-left"
                    tooltipText: "Back to Chat / 대화로 돌아가기"
                    onClicked: root.closeRequested()
                }

                Text {
                    text: "Character Card Editor: " + (nameField.text ? nameField.text : "Unnamed")
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                    Layout.fillWidth: true
                }

                RisuButton {
                    text: "Export PNG"
                    iconName: "download"
                    variant: "outline"
                    onClicked: exportPngDialog.open()
                }

                RisuButton {
                    text: "Export JSON"
                    iconName: "download"
                    variant: "outline"
                    onClicked: exportJsonDialog.open()
                }

                RisuButton {
                    text: "Delete"
                    iconName: "trash"
                    variant: "danger"
                    onClicked: {
                        charCtrl.deleteCharacter(root.charId);
                        root.closeRequested();
                    }
                }

                RisuButton {
                    text: "Save Character"
                    iconName: "check"
                    variant: "primary"
                    onClicked: root.saveCurrentData()
                }
            }
        }

        // ==========================================
        // 2. MAIN SPLIT EDITOR BODY
        // ==========================================
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Left Profile Column
            Rectangle {
                Layout.preferredWidth: 300
                Layout.fillHeight: true
                color: Theme.darkbg
                border.color: Theme.darkborderc
                border.width: 1

                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 16
                    clip: true

                    ColumnLayout {
                        width: parent.width
                        spacing: 14

                        // Avatar Preview Card
                        Rectangle {
                            Layout.alignment: Qt.AlignHCenter
                            width: 150
                            height: 150
                            radius: Theme.radiusLarge
                            color: Theme.darkbutton
                            border.color: Theme.darkborderc
                            border.width: 1
                            clip: true

                            Image {
                                anchors.fill: parent
                                source: charCtrl.selectedCharacter.avatarPath ? ("file://" + charCtrl.selectedCharacter.avatarPath) : ""
                                fillMode: Image.PreserveAspectCrop
                                visible: status === Image.Ready
                            }

                            Text {
                                anchors.centerIn: parent
                                text: nameField.text ? nameField.text.charAt(0).toUpperCase() : "?"
                                font.pixelSize: 48
                                font.weight: Font.Bold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor2
                                visible: !charCtrl.selectedCharacter.avatarPath || parent.children[0].status !== Image.Ready
                            }

                            // Hover Overlay for changing avatar
                            Rectangle {
                                anchors.fill: parent
                                color: Qt.rgba(0, 0, 0, 0.6)
                                opacity: avatarMouse.containsMouse ? 1.0 : 0.0

                                Behavior on opacity {
                                    NumberAnimation { duration: Theme.animFast }
                                }

                                ColumnLayout {
                                    anchors.centerIn: parent
                                    spacing: 4

                                    RisuIcon {
                                        Layout.alignment: Qt.AlignHCenter
                                        name: "image"
                                        size: 24
                                        color: "#ffffff"
                                    }

                                    Text {
                                        Layout.alignment: Qt.AlignHCenter
                                        text: "Change Avatar"
                                        font.pixelSize: Theme.fontSmall
                                        font.weight: Font.Bold
                                        font.family: Theme.fontFamily
                                        color: "#ffffff"
                                    }
                                }

                                MouseArea {
                                    id: avatarMouse
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: avatarPicker.open()
                                }
                            }
                        }

                        RisuButton {
                            text: "Upload Avatar Image"
                            iconName: "image"
                            variant: "secondary"
                            Layout.fillWidth: true
                            onClicked: avatarPicker.open()
                        }

                        // Basic Fields
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Character Name"; font.pixelSize: Theme.fontSmall; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: nameField
                                Layout.fillWidth: true
                                text: charCtrl.selectedCharacter.name || ""
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Creator"; font.pixelSize: Theme.fontSmall; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: creatorField
                                Layout.fillWidth: true
                                text: charCtrl.selectedCharacter.creator || ""
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Character Version"; font.pixelSize: Theme.fontSmall; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: versionField
                                Layout.fillWidth: true
                                text: charCtrl.selectedCharacter.characterVersion || "1.0.0"
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Tags (comma separated)"; font.pixelSize: Theme.fontSmall; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: tagsField
                                Layout.fillWidth: true
                                text: charCtrl.selectedCharacter.tags || ""
                            }
                        }
                    }
                }
            }

            // Right Tabbed Area
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                // Segmented Tabs Header
                Rectangle {
                    Layout.fillWidth: true
                    height: 48
                    color: Theme.darkbg
                    border.color: Theme.darkborderc
                    border.width: 1

                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: 6
                        spacing: 8

                        EditorTabButton {
                            iconKey: "message-square"
                            tabTitle: "First Message"
                            tabIdx: 0
                        }
                        EditorTabButton {
                            iconKey: "file-text"
                            tabTitle: "Description & Personality"
                            tabIdx: 1
                        }
                        EditorTabButton {
                            iconKey: "sparkles"
                            tabTitle: "Examples & Scenario"
                            tabIdx: 2
                        }
                        EditorTabButton {
                            iconKey: "sliders"
                            tabTitle: "Advanced Prompts"
                            tabIdx: 3
                        }

                        component EditorTabButton: Rectangle {
                            property string iconKey: ""
                            property string tabTitle: ""
                            property int tabIdx: 0

                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            radius: Theme.radiusSmall
                            color: root.activeTab === tabIdx ? Theme.primary : "transparent"

                            Behavior on color { ColorAnimation { duration: Theme.animFast } }

                            Row {
                                anchors.centerIn: parent
                                spacing: 6

                                RisuIcon {
                                    name: iconKey
                                    size: 15
                                    color: root.activeTab === tabIdx ? "#ffffff" : Theme.textcolor2
                                    anchors.verticalCenter: parent.verticalCenter
                                }

                                Text {
                                    text: tabTitle
                                    font.pixelSize: Theme.fontSmall
                                    font.weight: Font.Bold
                                    font.family: Theme.fontFamily
                                    color: root.activeTab === tabIdx ? "#ffffff" : Theme.textcolor2
                                    anchors.verticalCenter: parent.verticalCenter
                                }
                            }

                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.activeTab = tabIdx
                            }
                        }
                    }
                }

                // Tab Contents
                StackLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    currentIndex: root.activeTab

                    // Tab 0: First Message & Alternate Greetings
                    ScrollView {
                        clip: true
                        padding: 24

                        ColumnLayout {
                            width: Math.min(800, parent.width - 48)
                            anchors.horizontalCenter: parent.horizontalCenter
                            spacing: 20

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: fmCol.implicitHeight + 32

                                ColumnLayout {
                                    id: fmCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text {
                                        text: "First Message (Initial Greeting)"
                                        font.pixelSize: Theme.fontMedium
                                        font.weight: Font.Bold
                                        font.family: Theme.fontFamily
                                        color: Theme.textcolor
                                    }

                                    Text {
                                        text: "The opening message sent by the character when a new chat begins. Supports {{user}} and {{char}} macros."
                                        font.pixelSize: Theme.fontSmall
                                        font.family: Theme.fontFamily
                                        color: Theme.textcolor2
                                    }

                                    RisuTextArea {
                                        id: firstMsgField
                                        Layout.fillWidth: true
                                        implicitHeight: 140
                                        text: charCtrl.selectedCharacter.firstMessage || ""
                                        placeholderText: "Hello {{user}}! How can I help you today?"
                                    }
                                }
                            }

                            // Alternate Greetings Card
                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: altMainCol.implicitHeight + 32

                                ColumnLayout {
                                    id: altMainCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 12

                                    RowLayout {
                                        Layout.fillWidth: true
                                        Text {
                                            text: "Alternate Greetings (" + String(root.altGreetings.length) + ")"
                                            font.pixelSize: Theme.fontMedium
                                            font.weight: Font.Bold
                                            font.family: Theme.fontFamily
                                            color: Theme.textcolor
                                            Layout.fillWidth: true
                                        }

                                        RisuButton {
                                            text: "+ Add Greeting"
                                            variant: "secondary"
                                            onClicked: {
                                                var list = root.altGreetings.slice();
                                                list.push("Greetings {{user}}! (New variation)");
                                                root.altGreetings = list;
                                            }
                                        }
                                    }

                                    Repeater {
                                        model: root.altGreetings
                                        delegate: Rectangle {
                                            Layout.fillWidth: true
                                            implicitHeight: altRow.implicitHeight + 16
                                            radius: Theme.radiusMedium
                                            color: Theme.darkbg
                                            border.color: Theme.darkborderc
                                            border.width: 1

                                            ColumnLayout {
                                                id: altRow
                                                anchors.fill: parent
                                                anchors.margins: 12
                                                spacing: 8

                                                RowLayout {
                                                    Layout.fillWidth: true
                                                    Text {
                                                        text: "Greeting Variant #" + (index + 1)
                                                        font.pixelSize: Theme.fontSmall
                                                        font.weight: Font.Bold
                                                        font.family: Theme.fontFamily
                                                        color: Theme.textcolor2
                                                        Layout.fillWidth: true
                                                    }

                                                    RisuIconButton {
                                                        iconName: "close"
                                                        buttonSize: 22
                                                        iconSize: 12
                                                        onClicked: {
                                                            var list = root.altGreetings.slice();
                                                            list.splice(index, 1);
                                                            root.altGreetings = list;
                                                        }
                                                    }
                                                }

                                                RisuTextArea {
                                                    Layout.fillWidth: true
                                                    implicitHeight: 80
                                                    text: modelData
                                                    onTextChanged: {
                                                        root.altGreetings[index] = text;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Tab 1: Description & Personality
                    ScrollView {
                        clip: true
                        padding: 24

                        ColumnLayout {
                            width: Math.min(800, parent.width - 48)
                            anchors.horizontalCenter: parent.horizontalCenter
                            spacing: 20

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: descCol.implicitHeight + 32

                                ColumnLayout {
                                    id: descCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Character Description"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Physical appearance, traits, background lore, origins, attire."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: descField
                                        Layout.fillWidth: true
                                        implicitHeight: 160
                                        text: charCtrl.selectedCharacter.description || ""
                                    }
                                }
                            }

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: persCol.implicitHeight + 32

                                ColumnLayout {
                                    id: persCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Personality"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Core personality traits, emotional tendencies, tone of speech, behavioral quirks."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: personalityField
                                        Layout.fillWidth: true
                                        implicitHeight: 120
                                        text: charCtrl.selectedCharacter.personality || ""
                                    }
                                }
                            }
                        }
                    }

                    // Tab 2: Examples & Scenario
                    ScrollView {
                        clip: true
                        padding: 24

                        ColumnLayout {
                            width: Math.min(800, parent.width - 48)
                            anchors.horizontalCenter: parent.horizontalCenter
                            spacing: 20

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: scenCol.implicitHeight + 32

                                ColumnLayout {
                                    id: scenCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Scenario"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Current setting, environment, situation, or roleplay premise."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: scenarioField
                                        Layout.fillWidth: true
                                        implicitHeight: 120
                                        text: charCtrl.selectedCharacter.scenario || ""
                                    }
                                }
                            }

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: exCol.implicitHeight + 32

                                ColumnLayout {
                                    id: exCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Example Dialogues (<START>)"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Guidelines on how the character speaks in dialogue exchanges. Separate dialogue blocks with <START>."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: exampleMsgField
                                        Layout.fillWidth: true
                                        implicitHeight: 160
                                        text: charCtrl.selectedCharacter.exampleMessage || ""
                                        placeholderText: "<START>\n{{user}}: How are you today?\n{{char}}: *smiles warmly* I am feeling wonderful!"
                                    }
                                }
                            }
                        }
                    }

                    // Tab 3: Advanced System Prompts
                    ScrollView {
                        clip: true
                        padding: 24

                        ColumnLayout {
                            width: Math.min(800, parent.width - 48)
                            anchors.horizontalCenter: parent.horizontalCenter
                            spacing: 20

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: sysCol.implicitHeight + 32

                                ColumnLayout {
                                    id: sysCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "System Prompt Override"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Custom system instructions specifically for this character. If empty, the global preset prompt is used."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: sysPromptField
                                        Layout.fillWidth: true
                                        implicitHeight: 120
                                        text: charCtrl.selectedCharacter.systemPrompt || ""
                                    }
                                }
                            }

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: postCol.implicitHeight + 32

                                ColumnLayout {
                                    id: postCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Post-History Instructions"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Instructions injected at the very end of the chat context window right before generation."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: postHistField
                                        Layout.fillWidth: true
                                        implicitHeight: 100
                                        text: charCtrl.selectedCharacter.postHistoryInstructions || ""
                                    }
                                }
                            }

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: anCharCol.implicitHeight + 32

                                ColumnLayout {
                                    id: anCharCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Character Author's Note"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    Text { text: "Default Author's Note instructions for this character when starting new chats."; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextArea {
                                        id: charAuthorNoteField
                                        Layout.fillWidth: true
                                        implicitHeight: 80
                                        text: charCtrl.selectedCharacter.authorNote || ""
                                    }
                                    RowLayout {
                                        Layout.fillWidth: true
                                        spacing: 8
                                        Text { text: "Depth (" + String(charAnDepthSlider.value) + "):"; font.family: Theme.fontFamily; color: Theme.textcolor }
                                        RisuSlider {
                                            id: charAnDepthSlider
                                            Layout.fillWidth: true
                                            from: 1
                                            to: 10
                                            stepSize: 1
                                            value: charCtrl.selectedCharacter.authorNoteDepth || 3
                                        }
                                    }
                                }
                            }

                            RisuCard {
                                Layout.fillWidth: true
                                implicitHeight: noteCol.implicitHeight + 32

                                ColumnLayout {
                                    id: noteCol
                                    anchors.fill: parent
                                    anchors.margins: 16
                                    spacing: 10

                                    Text { text: "Creator Notes"; font.pixelSize: Theme.fontMedium; font.weight: Font.Bold; font.family: Theme.fontFamily; color: Theme.textcolor }
                                    RisuTextArea {
                                        id: creatorNotesField
                                        Layout.fillWidth: true
                                        implicitHeight: 80
                                        text: charCtrl.selectedCharacter.creatorNotes || ""
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    function saveCurrentData() {
        var data = {
            id: root.charId,
            name: nameField.text,
            creator: creatorField.text,
            characterVersion: versionField.text,
            tags: tagsField.text,
            firstMessage: firstMsgField.text,
            description: descField.text,
            personality: personalityField.text,
            scenario: scenarioField.text,
            exampleMessage: exampleMsgField.text,
            systemPrompt: sysPromptField.text,
            postHistoryInstructions: postHistField.text,
            authorNote: charAuthorNoteField.text,
            authorNoteDepth: Math.round(charAnDepthSlider.value),
            creatorNotes: creatorNotesField.text,
            alternateGreetings: root.altGreetings
        };
        charCtrl.saveCharacterDetails(data);
    }
}
