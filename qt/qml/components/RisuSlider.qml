import QtQuick
import QtQuick.Controls.Basic
import "../theme"

Slider {
    id: control

    property string label: ""
    property string displayValue: String(control.value.toFixed(2))

    implicitWidth: 200
    implicitHeight: 28

    background: Rectangle {
        x: control.leftPadding
        y: control.topPadding + control.availableHeight / 2 - height / 2
        implicitWidth: 200
        implicitHeight: 5
        width: control.availableWidth
        height: implicitHeight
        radius: 2.5
        color: Theme.darkbutton

        Rectangle {
            width: control.visualPosition * parent.width
            height: parent.height
            color: Theme.primary
            radius: 2.5
        }
    }

    handle: Rectangle {
        x: control.leftPadding + control.visualPosition * (control.availableWidth - width)
        y: control.topPadding + control.availableHeight / 2 - height / 2
        implicitWidth: 16
        implicitHeight: 16
        radius: 8
        color: control.pressed ? Theme.primaryLight : Theme.primary
        border.color: "#ffffff"
        border.width: 2
    }
}
