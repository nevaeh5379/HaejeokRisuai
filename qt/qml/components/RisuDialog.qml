import QtQuick
import QtQuick.Controls.Basic
import "../theme"

Dialog {
    id: control

    property string dialogTitle: ""
    modal: true
    dim: true
    anchors.centerIn: Overlay.overlay
    padding: 24

    background: Rectangle {
        radius: Theme.radiusLarge
        color: Theme.bgcolor
        border.color: Theme.darkborderc
        border.width: 1
    }

    header: Item {
        height: 48
        width: parent.width

        Text {
            anchors.left: parent.left
            anchors.leftMargin: 24
            anchors.verticalCenter: parent.verticalCenter
            text: control.dialogTitle
            color: Theme.textcolor
            font.pixelSize: Theme.fontLarge
            font.weight: Font.Bold
            font.family: Theme.fontFamily
        }

        RisuIconButton {
            anchors.right: parent.right
            anchors.rightMargin: 16
            anchors.verticalCenter: parent.verticalCenter
            iconName: "close"
            buttonSize: 32
            iconSize: 14
            onClicked: control.close()
        }

        Rectangle {
            anchors.bottom: parent.bottom
            width: parent.width
            height: 1
            color: Theme.darkborderc
        }
    }
}
