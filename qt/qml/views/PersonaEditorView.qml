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

    property string selectedPersonaId: ""

    FileDialog {
        id: personaAvatarPicker
        title: "Select Persona Avatar"
        nameFilters: ["Images (*.png *.jpg *.jpeg *.webp)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            personaCtrl.setAvatarImage(root.selectedPersonaId, path);
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Header Bar
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
                    tooltipText: "Back to Chat"
                    onClicked: root.closeRequested()
                }

                Text {
                    text: "User Persona Profiles"
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                    Layout.fillWidth: true
                }

                RisuButton {
                    text: "+ New Persona"
                    variant: "primary"
                    onClicked: {
                        var newId = personaCtrl.createPersona("New User", "A user profile");
                        root.selectedPersonaId = newId;
                    }
                }
            }
        }

        // Split Layout
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Left Persona List
            Rectangle {
                Layout.preferredWidth: 280
                Layout.fillHeight: true
                color: Theme.darkbg
                border.color: Theme.darkborderc
                border.width: 1

                ListView {
                    id: personaListView
                    anchors.fill: parent
                    anchors.margins: 10
                    spacing: 6
                    model: personaCtrl.personas

                    delegate: Rectangle {
                        width: personaListView.width
                        height: 60
                        radius: Theme.radiusMedium
                        color: (modelData.id === root.selectedPersonaId) ? Theme.selected : (pMouseArea.containsMouse ? Theme.darkbutton : "transparent")
                        border.color: (modelData.id === root.selectedPersonaId) ? Theme.primary : "transparent"
                        border.width: 1

                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: 8
                            spacing: 10

                            Rectangle {
                                width: 40
                                height: 40
                                radius: 20
                                color: Theme.darkbutton
                                clip: true

                                Image {
                                    anchors.fill: parent
                                    source: modelData.avatarPath ? ("file://" + modelData.avatarPath) : ""
                                    fillMode: Image.PreserveAspectCrop
                                    visible: status === Image.Ready
                                }

                                Text {
                                    anchors.centerIn: parent
                                    text: modelData.name ? modelData.name.charAt(0).toUpperCase() : "U"
                                    font.pixelSize: 16
                                    font.weight: Font.Bold
                                    font.family: Theme.fontFamily
                                    color: Theme.textcolor2
                                    visible: !modelData.avatarPath || parent.children[0].status !== Image.Ready
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2

                                Text {
                                    text: modelData.name
                                    font.pixelSize: Theme.fontNormal
                                    font.weight: Font.Bold
                                    font.family: Theme.fontFamily
                                    color: Theme.textcolor
                                    elide: Text.ElideRight
                                }

                                RisuBadge {
                                    text: "Active"
                                    badgeColor: Theme.primary
                                    textColor: "#ffffff"
                                    visible: modelData.isActive
                                }
                            }

                            RisuIconButton {
                                iconName: "close"
                                tooltipText: "Delete"
                                buttonSize: 24
                                iconSize: 12
                                visible: personaCtrl.personas.length > 1
                                onClicked: personaCtrl.deletePersona(modelData.id)
                            }
                        }

                        MouseArea {
                            id: pMouseArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                root.selectedPersonaId = modelData.id;
                                nameField.text = modelData.name;
                                descField.text = modelData.description;
                                activeSwitch.checked = modelData.isActive;
                            }
                        }
                    }
                }
            }

            // Right Persona Editor
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                padding: 24

                ColumnLayout {
                    width: Math.min(600, parent.width - 48)
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: 16

                    Text {
                        text: "Persona Name (Used for {{user}} macro)"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextField {
                        id: nameField
                        Layout.fillWidth: true
                        text: personaCtrl.activePersona.name || "User"
                    }

                    RisuButton {
                        text: "Upload Persona Avatar"
                        iconName: "image"
                        variant: "secondary"
                        onClicked: personaAvatarPicker.open()
                    }

                    RisuSwitch {
                        id: activeSwitch
                        text: "Set as Active Persona"
                        checked: personaCtrl.activePersona.isActive || false
                    }

                    Text {
                        text: "Persona Description (Traits, Appearance, Personality)"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextArea {
                        id: descField
                        Layout.fillWidth: true
                        implicitHeight: 160
                        text: personaCtrl.activePersona.description || ""
                        placeholderText: "Describe your user persona so the AI understands who you are..."
                    }

                    RisuButton {
                        text: "Save Persona"
                        iconName: "check"
                        variant: "primary"
                        Layout.preferredWidth: 140
                        onClicked: {
                            var idToSave = root.selectedPersonaId ? root.selectedPersonaId : personaCtrl.activePersona.id;
                            var data = {
                                id: idToSave,
                                name: nameField.text,
                                description: descField.text,
                                isActive: activeSwitch.checked
                            };
                            personaCtrl.savePersona(data);
                        }
                    }
                }
            }
        }
    }
}
