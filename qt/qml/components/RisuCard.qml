import QtQuick
import "../theme"

Rectangle {
    id: root

    property int customRadius: Theme.radiusLarge
    property color customBg: Theme.darkbg
    property color customBorder: Theme.darkborderc

    radius: customRadius
    color: customBg
    border.color: customBorder
    border.width: 1
}
