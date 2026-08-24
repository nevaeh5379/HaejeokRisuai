import QtQuick
import QtQuick.Controls.Basic
import "../theme"

TextArea {
    id: control

    property string label: ""

    color: Theme.textcolor
    placeholderTextColor: Qt.rgba(Theme.textcolor2.r, Theme.textcolor2.g, Theme.textcolor2.b, 0.6)
    selectionColor: Theme.primary
    selectedTextColor: "#ffffff"
    font.pixelSize: Theme.fontNormal
    font.family: Theme.fontFamily
    wrapMode: TextArea.Wrap
    padding: 10
    leftPadding: 12
    rightPadding: 12

    background: Rectangle {
        implicitWidth: 240
        implicitHeight: 90
        radius: Theme.radiusMedium
        color: Theme.darkbg
        border.color: control.activeFocus ? Theme.primary : Theme.darkborderc
        border.width: 1

        Behavior on border.color {
            ColorAnimation { duration: Theme.animFast }
        }
    }
}
