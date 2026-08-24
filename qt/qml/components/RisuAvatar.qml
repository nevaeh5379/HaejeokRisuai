import QtQuick
import "../theme"

Item {
    id: root

    property string imageSource: ""
    property alias avatarSource: root.imageSource
    property string characterName: ""
    property string fallbackText: characterName !== "" ? characterName.charAt(0).toUpperCase() : "?"
    property int avatarSize: 52
    property alias size: root.avatarSize
    property int avatarRadius: Theme.radiusMedium
    property bool isUser: false
    property bool showBorder: false
    property color borderColor: isUser ? Theme.primary : Theme.darkborderc
    property bool active: false

    width: avatarSize
    height: avatarSize

    Rectangle {
        id: bgContainer
        anchors.fill: parent
        radius: root.avatarRadius
        color: root.isUser ? Theme.darkbutton : Theme.darkbg
        border.color: root.active ? Theme.primary : (root.showBorder ? root.borderColor : "transparent")
        border.width: root.active ? 2 : (root.showBorder ? 1 : 0)
        clip: true

        Image {
            id: avatarImg
            anchors.fill: parent
            source: root.imageSource ? (root.imageSource.startsWith("file://") ? root.imageSource : "file://" + root.imageSource) : ""
            fillMode: Image.PreserveAspectCrop
            visible: status === Image.Ready
            asynchronous: true
            cache: true
            smooth: true
        }

        Item {
            anchors.fill: parent
            visible: !avatarImg.visible

            Rectangle {
                anchors.fill: parent
                color: Theme.darkbutton
            }

            Text {
                anchors.centerIn: parent
                text: root.fallbackText
                font.pixelSize: Math.max(14, Math.floor(root.avatarSize * 0.42))
                font.weight: Font.Bold
                font.family: Theme.fontFamily
                color: Theme.textcolor
            }
        }
    }
}
