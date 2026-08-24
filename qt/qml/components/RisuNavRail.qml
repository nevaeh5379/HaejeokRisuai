import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "../theme"

Rectangle {
    id: root

    signal viewSelected(int viewIndex)
    signal toggleSidebarRequested()

    property int activeViewIndex: 0

    width: 64
    color: Theme.bgcolor
    border.color: Theme.darkborderc
    border.width: 1

    ColumnLayout {
        anchors.fill: parent
        anchors.topMargin: 12
        anchors.bottomMargin: 12
        spacing: 10

        // 1. Home Button
        Rectangle {
            Layout.alignment: Qt.AlignHCenter
            width: 44
            height: 44
            radius: Theme.radiusMedium
            color: railLogoMouse.containsMouse ? Theme.darkbutton : "transparent"

            RisuIcon {
                anchors.centerIn: parent
                name: "home"
                size: 20
                color: Theme.primaryLight
            }

            MouseArea {
                id: railLogoMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.toggleSidebarRequested()
            }
        }

        // Divider
        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: 12
            Layout.rightMargin: 12
            height: 1
            color: Theme.darkborderc
            opacity: 0.5
        }

        // 2. Chat Button
        NavRailButton {
            iconName: "message-square"
            tooltip: "Chat / 대화"
            isSelected: root.activeViewIndex === 0
            onClicked: root.viewSelected(0)
        }

        // 3. Character Editor
        NavRailButton {
            iconName: "pencil"
            tooltip: "Character Editor / 캐릭터 편집"
            isSelected: root.activeViewIndex === 1
            onClicked: root.viewSelected(1)
        }

        // 4. Presets & Models Button
        NavRailButton {
            iconName: "sliders"
            tooltip: "AI Preset & Generation / AI 프리셋"
            isSelected: root.activeViewIndex === 2
            onClicked: root.viewSelected(2)
        }

        // 5. Lorebook / World Info
        NavRailButton {
            iconName: "book"
            tooltip: "World Info & Lorebook / 로어북"
            isSelected: root.activeViewIndex === 3
            onClicked: root.viewSelected(3)
        }

        // 6. Persona Profiles
        NavRailButton {
            iconName: "user"
            tooltip: "User Personas / 페르소나"
            isSelected: root.activeViewIndex === 4
            onClicked: root.viewSelected(4)
        }

        Item { Layout.fillHeight: true }

        // 7. Global Settings
        NavRailButton {
            iconName: "settings"
            tooltip: "Global Settings / 환경 설정"
            isSelected: root.activeViewIndex === 5
            onClicked: root.viewSelected(5)
        }

        component NavRailButton: Rectangle {
            id: btnRoot
            property string iconName: ""
            property string tooltip: ""
            property bool isSelected: false
            signal clicked()

            Layout.alignment: Qt.AlignHCenter
            width: 44
            height: 44
            radius: Theme.radiusMedium
            color: isSelected ? Theme.selected : (btnMouse.containsMouse ? Theme.darkbutton : "transparent")

            Behavior on color {
                ColorAnimation { duration: Theme.animFast }
            }

            RisuIcon {
                anchors.centerIn: parent
                name: btnRoot.iconName
                size: 20
                color: btnRoot.isSelected ? Theme.textcolor : (btnMouse.containsMouse ? Theme.textcolor : Theme.textcolor2)
            }

            // Left Indicator Pill for active item
            Rectangle {
                anchors.left: parent.left
                anchors.leftMargin: -10
                anchors.verticalCenter: parent.verticalCenter
                width: 3
                height: 20
                radius: 1.5
                color: Theme.primary
                visible: btnRoot.isSelected
            }

            ToolTip.visible: btnMouse.containsMouse && btnRoot.tooltip !== ""
            ToolTip.text: btnRoot.tooltip
            ToolTip.delay: 400

            MouseArea {
                id: btnMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: btnRoot.clicked()
            }
        }
    }
}
