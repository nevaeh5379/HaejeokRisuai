import QtQuick
import QtQuick.Controls.Basic
import "../theme"

Button {
    id: control

    property string variant: "primary" // "primary", "secondary", "outline", "ghost", "danger"
    property string iconName: ""
    property int customRadius: Theme.radiusMedium
    property color customColor: "transparent"
    property alias buttonColor: control.customColor
    property color customTextColor: "transparent"
    property color customBorderColor: "transparent"
    property alias borderColor: control.customBorderColor

    font.pixelSize: Theme.fontNormal
    font.family: Theme.fontFamily
    font.weight: Font.Medium
    padding: 8
    leftPadding: 14
    rightPadding: 14

    contentItem: Row {
        spacing: 6
        anchors.centerIn: parent

        RisuIcon {
            visible: control.iconName !== ""
            name: control.iconName
            size: control.font.pixelSize + 2
            color: control.textColor
            anchors.verticalCenter: parent.verticalCenter
        }

        Text {
            text: control.text
            font: control.font
            color: control.textColor
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignHCenter
        }
    }

    property color textColor: {
        if (control.customTextColor !== "transparent" && control.customTextColor.a > 0) return control.customTextColor;
        if (!control.enabled) return Theme.textcolor2;
        if (variant === "primary" || variant === "danger") return "#ffffff";
        return Theme.textcolor;
    }

    background: Rectangle {
        implicitWidth: 84
        implicitHeight: 34
        radius: control.customRadius
        opacity: control.enabled ? (control.down ? 0.85 : 1.0) : 0.45

        color: {
            if (control.customColor !== "transparent" && control.customColor.a > 0) {
                return control.customColor;
            }
            if (control.variant === "primary") {
                return control.hovered ? Theme.primaryHover : Theme.primary;
            } else if (control.variant === "danger") {
                return control.hovered ? "#dc2626" : Theme.draculared;
            } else if (control.variant === "ghost") {
                return control.hovered ? Theme.darkbutton : "transparent";
            } else if (control.variant === "outline") {
                return control.hovered ? Theme.darkbutton : "transparent";
            } else { // secondary / default
                return control.hovered ? Theme.selected : Theme.darkbutton;
            }
        }

        border.color: {
            if (control.customBorderColor !== "transparent" && control.customBorderColor.a > 0) {
                return control.customBorderColor;
            }
            if (control.variant === "outline") return control.hovered ? Theme.textcolor2 : Theme.darkborderc;
            return "transparent";
        }
        border.width: (control.variant === "outline" || (control.customBorderColor !== "transparent" && control.customBorderColor.a > 0)) ? 1 : 0

        Behavior on color {
            ColorAnimation { duration: Theme.animFast }
        }
    }
}
