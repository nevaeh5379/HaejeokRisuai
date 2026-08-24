import QtQuick
import QtQuick.Controls.Basic
import "../theme"

Button {
    id: control

    property string iconName: ""
    property string tooltipText: ""
    property int buttonSize: 32
    property color customColor: Theme.textcolor2
    property color hoverColor: Theme.primaryLight
    property bool filled: false
    property int iconSize: Math.max(14, Math.floor(buttonSize * 0.52))

    implicitWidth: buttonSize
    implicitHeight: buttonSize

    contentItem: Item {
        anchors.fill: parent

        RisuIcon {
            visible: control.iconName !== ""
            anchors.centerIn: parent
            name: control.iconName
            size: control.iconSize
            color: !control.enabled ? Theme.textcolor2 : (control.hovered ? control.hoverColor : control.customColor)

            Behavior on color {
                ColorAnimation { duration: Theme.animFast }
            }
        }

        Text {
            visible: control.iconName === "" && control.text !== ""
            anchors.centerIn: parent
            text: control.text
            font.pixelSize: control.iconSize
            font.family: Theme.fontFamily
            color: !control.enabled ? Theme.textcolor2 : (control.hovered ? control.hoverColor : control.customColor)
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Theme.animFast }
            }
        }
    }

    background: Rectangle {
        radius: Theme.radiusMedium
        color: control.filled
               ? (control.hovered ? Theme.selectedHover : Theme.darkbutton)
               : (control.hovered ? Theme.darkbutton : "transparent")
        opacity: control.down ? 0.75 : 1.0

        Behavior on color {
            ColorAnimation { duration: Theme.animFast }
        }
    }

    ToolTip.visible: hovered && tooltipText !== ""
    ToolTip.text: tooltipText
    ToolTip.delay: 350
}
