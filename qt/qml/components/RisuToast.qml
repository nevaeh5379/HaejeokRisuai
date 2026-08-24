import QtQuick
import "../theme"

Rectangle {
    id: root

    property string message: ""
    property string toastType: "info" // "info", "success", "warning", "error"
    property bool active: false

    anchors.horizontalCenter: parent ? parent.horizontalCenter : undefined
    anchors.bottom: parent ? parent.bottom : undefined
    anchors.bottomMargin: 40

    implicitWidth: Math.min(500, Math.max(200, labelText.implicitWidth + 60))
    implicitHeight: Math.max(44, labelText.implicitHeight + 20)
    radius: Theme.radiusMedium

    color: Theme.darkbg
    border.color: {
        switch (toastType) {
            case "success": return Theme.success;
            case "error": return Theme.draculared;
            case "warning": return Theme.warning;
            default: return Theme.primary;
        }
    }
    border.width: 1

    opacity: active ? 1.0 : 0.0
    scale: active ? 1.0 : 0.95
    visible: opacity > 0.0

    Behavior on opacity {
        NumberAnimation { duration: Theme.animFast }
    }
    Behavior on scale {
        NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutCubic }
    }

    Row {
        anchors.centerIn: parent
        anchors.margins: 12
        spacing: 10

        RisuIcon {
            name: {
                switch (root.toastType) {
                    case "success": return "check";
                    case "error": return "close";
                    case "warning": return "alert-triangle";
                    default: return "sparkles";
                }
            }
            size: 16
            color: root.border.color
            anchors.verticalCenter: parent.verticalCenter
        }

        Text {
            id: labelText
            text: root.message
            color: Theme.textcolor
            font.pixelSize: Theme.fontSmall
            font.family: Theme.fontFamily
            font.weight: Font.Medium
            wrapMode: Text.Wrap
            width: Math.min(420, implicitWidth)
            anchors.verticalCenter: parent.verticalCenter
        }
    }

    Timer {
        id: hideTimer
        interval: 3500
        repeat: false
        onTriggered: root.active = false
    }

    function show(type, msg) {
        root.toastType = type;
        root.message = msg;
        root.active = true;
        hideTimer.restart();
    }
}
