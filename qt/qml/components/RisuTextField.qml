import QtQuick
import QtQuick.Controls.Basic
import "../theme"

TextField {
    id: control

    property string label: ""
    property bool isPassword: false

    echoMode: isPassword ? TextInput.Password : TextInput.Normal
    color: Theme.textcolor
    placeholderTextColor: Qt.rgba(Theme.textcolor2.r, Theme.textcolor2.g, Theme.textcolor2.b, 0.6)
    selectionColor: Theme.primary
    selectedTextColor: "#ffffff"
    font.pixelSize: Theme.fontNormal
    font.family: Theme.fontFamily
    padding: 8
    leftPadding: 12
    rightPadding: 12

    background: Rectangle {
        implicitWidth: 200
        implicitHeight: 36
        radius: Theme.radiusMedium
        color: Theme.darkbg
        border.color: control.activeFocus ? Theme.primary : Theme.darkborderc
        border.width: 1

        Behavior on border.color {
            ColorAnimation { duration: Theme.animFast }
        }
    }
}
