import QtQuick
import "../theme"

Rectangle {
    id: root

    property alias text: label.text
    property color badgeColor: Theme.darkbutton
    property color textColor: Theme.textcolor2

    implicitWidth: label.implicitWidth + 16
    implicitHeight: label.implicitHeight + 8
    radius: Theme.radiusFull
    color: badgeColor
    border.color: Theme.darkborderc
    border.width: 1

    Text {
        id: label
        anchors.centerIn: parent
        color: root.textColor
        font.pixelSize: Theme.fontTiny
        font.weight: Font.DemiBold
        font.family: Theme.fontFamily
    }
}
