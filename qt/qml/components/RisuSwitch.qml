import QtQuick
import QtQuick.Controls.Basic
import "../theme"

Switch {
    id: control

    implicitWidth: 44
    implicitHeight: 24

    indicator: Rectangle {
        implicitWidth: 44
        implicitHeight: 24
        x: control.leftPadding
        y: parent.height / 2 - height / 2
        radius: 12
        color: control.checked ? Theme.primary : Theme.darkbutton
        border.color: control.checked ? Theme.primary : Theme.darkborderc
        border.width: 1

        Rectangle {
            x: control.checked ? parent.width - width - 2 : 2
            y: 2
            width: 18
            height: 18
            radius: 9
            color: "#ffffff"

            Behavior on x {
                NumberAnimation { duration: Theme.animFast; easing.type: Easing.InOutQuad }
            }
        }

        Behavior on color {
            ColorAnimation { duration: Theme.animFast }
        }
    }

    contentItem: Text {
        text: control.text
        font.pixelSize: Theme.fontNormal
        font.family: Theme.fontFamily
        color: Theme.textcolor
        verticalAlignment: Text.AlignVCenter
        leftPadding: control.indicator.width + 8
    }
}
