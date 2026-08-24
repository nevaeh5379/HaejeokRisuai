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

    property string selectedEntryId: ""
    property var currentEntryData: null

    FileDialog {
        id: importJsonDialog
        title: "Import Lorebook (JSON)"
        nameFilters: ["JSON Lorebook (*.json)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            loreCtrl.importLorebookFromJson(path);
        }
    }

    FileDialog {
        id: exportJsonDialog
        title: "Export Lorebook (JSON)"
        fileMode: FileDialog.SaveFile
        nameFilters: ["JSON Lorebook (*.json)"]
        defaultSuffix: "json"
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            loreCtrl.exportLorebookToJson(path);
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
                    text: "Global Lorebook / World Info"
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                    Layout.fillWidth: true
                }

                RisuButton {
                    text: "Import JSON"
                    iconName: "download"
                    variant: "outline"
                    onClicked: importJsonDialog.open()
                }

                RisuButton {
                    text: "Export JSON"
                    iconName: "download"
                    variant: "outline"
                    onClicked: exportJsonDialog.open()
                }

                RisuButton {
                    text: "+ New Entry"
                    variant: "primary"
                    onClicked: {
                        var newId = loreCtrl.createNewEntry();
                        root.selectEntryById(newId);
                    }
                }
            }
        }

        // Split View: Left List, Right Editor
        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            // Left: Entry List
            Rectangle {
                Layout.preferredWidth: 320
                Layout.fillHeight: true
                color: Theme.darkbg
                border.color: Theme.darkborderc
                border.width: 1

                ListView {
                    id: loreListView
                    anchors.fill: parent
                    anchors.margins: 10
                    clip: true
                    spacing: 6
                    model: loreCtrl.lorebookModel

                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

                    delegate: Rectangle {
                        width: loreListView.width
                        height: 64
                        radius: Theme.radiusMedium
                        color: (root.selectedEntryId === model.loreId) ? Theme.selected : (loreMouseArea.containsMouse ? Theme.darkbutton : "transparent")
                        border.color: (root.selectedEntryId === model.loreId) ? Theme.primary : "transparent"
                        border.width: 1

                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: 10
                            spacing: 10

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2

                                RowLayout {
                                    Layout.fillWidth: true
                                    Text {
                                        text: model.comment ? model.comment : "Untitled Entry"
                                        font.pixelSize: Theme.fontNormal
                                        font.weight: Font.Bold
                                        font.family: Theme.fontFamily
                                        color: Theme.textcolor
                                        elide: Text.ElideRight
                                        Layout.fillWidth: true
                                    }
                                    RisuBadge {
                                        text: model.enabled ? "Active" : "Off"
                                        badgeColor: model.enabled ? Theme.success : Theme.darkbutton
                                        textColor: model.enabled ? "#11111b" : Theme.textcolor2
                                    }
                                }

                                Text {
                                    text: "Keys: " + (model.key ? model.key : "none")
                                    font.pixelSize: Theme.fontSmall
                                    font.family: Theme.fontFamily
                                    color: Theme.textcolor2
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                            }

                            RisuIconButton {
                                iconName: "close"
                                tooltipText: "Delete"
                                buttonSize: 24
                                iconSize: 12
                                onClicked: loreCtrl.deleteEntry(model.loreId)
                            }
                        }

                        MouseArea {
                            id: loreMouseArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.loadEntryFromModel(model)
                        }
                    }
                }
            }

            // Right: Entry Details Editor
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                padding: 24

                ColumnLayout {
                    width: Math.min(700, parent.width - 48)
                    anchors.horizontalCenter: parent.horizontalCenter
                    spacing: 16
                    visible: root.selectedEntryId !== ""

                    Text {
                        text: "Entry Title / Memo"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextField {
                        id: commentField
                        Layout.fillWidth: true
                    }

                    Text {
                        text: "Primary Trigger Keys (comma separated)"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextField {
                        id: keyField
                        Layout.fillWidth: true
                        placeholderText: "e.g. dragon, magic, kingdom, sword"
                    }

                    Text {
                        text: "Secondary Keys (Selective matching)"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextField {
                        id: secondKeyField
                        Layout.fillWidth: true
                        placeholderText: "Required if selective mode is enabled"
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 20

                        RisuSwitch {
                            id: enabledSwitch
                            text: "Enabled"
                        }
                        RisuSwitch {
                            id: alwaysActiveSwitch
                            text: "Always Active (Constant)"
                        }
                        RisuSwitch {
                            id: selectiveSwitch
                            text: "Selective (Both keys)"
                        }
                        RisuSwitch {
                            id: regexSwitch
                            text: "Regex"
                        }
                        RisuSwitch {
                            id: caseSensitiveSwitch
                            text: "Case Sensitive"
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 16

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Scan Depth (" + String(scanDepthSlider.value) + " msgs):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuSlider {
                                id: scanDepthSlider
                                Layout.fillWidth: true
                                from: 1
                                to: 50
                                stepSize: 1
                                value: 5
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Insert Order (Priority):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: insertOrderField
                                Layout.fillWidth: true
                                text: "100"
                            }
                        }
                    }

                    Text {
                        text: "Lore Content to Inject"
                        font.pixelSize: Theme.fontSmall
                        font.weight: Font.Bold
                        font.family: Theme.fontFamily
                        color: Theme.textcolor2
                    }
                    RisuTextArea {
                        id: contentField
                        Layout.fillWidth: true
                        implicitHeight: 180
                        placeholderText: "The lore description or world information..."
                    }

                    RisuButton {
                        text: "Save Entry"
                        iconName: "check"
                        variant: "primary"
                        Layout.preferredWidth: 140
                        onClicked: root.saveCurrentEntry()
                    }
                }
            }
        }
    }

    function loadEntryFromModel(m) {
        root.selectedEntryId = m.loreId;
        commentField.text = m.comment || "";
        keyField.text = m.key || "";
        secondKeyField.text = m.secondKey || "";
        contentField.text = m.content || "";
        enabledSwitch.checked = m.enabled;
        alwaysActiveSwitch.checked = m.alwaysActive;
        selectiveSwitch.checked = m.selective;
        regexSwitch.checked = m.useRegex;
        caseSensitiveSwitch.checked = m.caseSensitive || false;
        scanDepthSlider.value = m.scanDepth > 0 ? m.scanDepth : 5;
        insertOrderField.text = String(m.insertOrder || 100);
    }

    function selectEntryById(id) {
        for (var i = 0; i < loreCtrl.lorebookModel.rowCount(); ++i) {
            var e = loreCtrl.lorebookModel.getEntryAt(i);
            if (e && e.id === id) {
                root.selectedEntryId = id;
                commentField.text = e.comment || "";
                keyField.text = e.key || "";
                secondKeyField.text = e.secondKey || "";
                contentField.text = e.content || "";
                enabledSwitch.checked = e.enabled;
                alwaysActiveSwitch.checked = e.alwaysActive;
                selectiveSwitch.checked = e.selective;
                regexSwitch.checked = e.useRegex;
                caseSensitiveSwitch.checked = e.caseSensitive || false;
                scanDepthSlider.value = e.scanDepth > 0 ? e.scanDepth : 5;
                insertOrderField.text = String(e.insertOrder || 100);
                break;
            }
        }
    }

    function saveCurrentEntry() {
        if (!root.selectedEntryId) return;
        var data = {
            id: root.selectedEntryId,
            comment: commentField.text,
            key: keyField.text,
            secondKey: secondKeyField.text,
            content: contentField.text,
            enabled: enabledSwitch.checked,
            alwaysActive: alwaysActiveSwitch.checked,
            selective: selectiveSwitch.checked,
            useRegex: regexSwitch.checked,
            caseSensitive: caseSensitiveSwitch.checked,
            scanDepth: Math.round(scanDepthSlider.value),
            insertOrder: parseInt(insertOrderField.text) || 100
        };
        loreCtrl.saveEntry(data);
    }
}
