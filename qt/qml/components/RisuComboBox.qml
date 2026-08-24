import QtQuick
import QtQuick.Controls.Basic
import "../theme"

ComboBox {
    id: control

    font.pixelSize: Theme.fontNormal
    font.family: Theme.fontFamily

    delegate: ItemDelegate {
        width: control.width
        padding: 8
        leftPadding: 12
        rightPadding: 12

        contentItem: Text {
            text: control.textRole ? (Array.isArray(control.model) ? modelData[control.textRole] : model[control.textRole]) : modelData
            color: highlighted ? "#ffffff" : Theme.textcolor
            font: control.font
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }

        background: Rectangle {
            radius: Theme.radiusSmall
            color: highlighted ? Theme.primary : "transparent"
        }
    }

    contentItem: Text {
        leftPadding: 12
        rightPadding: control.indicator.width + control.spacing
        text: control.displayText
        font: control.font
        color: Theme.textcolor
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }

    indicator: Item {
        x: control.width - width - 10
        y: (control.height - height) / 2
        width: 16
        height: 16

        RisuIcon {
            anchors.centerIn: parent
            name: "chevron-down"
            size: 14
            color: Theme.textcolor2
        }
    }

    background: Rectangle {
        implicitWidth: 160
        implicitHeight: 36
        radius: Theme.radiusMedium
        color: Theme.darkbg
        border.color: control.activeFocus ? Theme.primary : Theme.darkborderc
        border.width: 1
    }

    popup: Popup {
        y: control.height + 4
        width: control.width
        implicitHeight: Math.min(280, contentItem.implicitHeight + 8)
        padding: 4

        contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            ScrollIndicator.vertical: ScrollIndicator { }
        }

        background: Rectangle {
            radius: Theme.radiusMedium
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1
        }
    }
}
