import QtQuick
import QtQuick.Controls.Basic
import QtWebEngine
import "../theme"

Item {
    id: root

    property string rawText: ""
    property string thoughtText: ""
    property color textColor: Theme.fontStandard
    property bool showThought: false

    // Any real HTML is rendered by Chromium. Qt Quick Text.RichText only implements
    // a small HTML subset and silently mangles modern CSS, SVG and custom DOM markup.
    readonly property bool hasComplexHtml: {
        if (!root.rawText) return false;
        var withoutThink = root.rawText.replace(/<think>[\s\S]*?<\/think>/gi, "");
        return /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^>]*)?>/i.test(withoutThink);
    }

    implicitWidth: mainColumn.implicitWidth
    implicitHeight: mainColumn.implicitHeight
    height: implicitHeight

    property int webContentHeight: 1

    Timer {
        id: webReloadThrottle
        interval: 200
        repeat: false
        onTriggered: root.updateWebEngineHtml()
    }

    function scheduleWebEngineUpdate() {
        if (!root.hasComplexHtml) return;
        webReloadThrottle.restart();
    }

    function findFlickable(item) {
        var p = item.parent;
        while (p) {
            if (p instanceof Flickable) return p;
            p = p.parent;
        }
        return null;
    }

    Column {
        id: mainColumn
        width: parent.width
        spacing: 8

        // Collapsible Reasoning / Thought Drawer
        Rectangle {
            id: thoughtBox
            width: parent.width
            visible: root.thoughtText !== ""
            radius: Theme.radiusMedium
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1
            implicitHeight: thoughtColumn.implicitHeight + 16
            clip: true

            Column {
                id: thoughtColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 10
                spacing: 8

                Item {
                    width: parent.width
                    height: 24

                    Row {
                        anchors.fill: parent
                        spacing: 8

                        RisuIcon {
                            name: "brain"
                            size: 16
                            color: Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "Thinking Process (" + String(root.thoughtText.length) + " chars)"
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            font.weight: Font.DemiBold
                            color: Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Item { width: 4; height: 1 }

                        RisuIcon {
                            name: root.showThought ? "chevron-up" : "chevron-down"
                            size: 14
                            color: Theme.textcolor2
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.showThought = !root.showThought
                    }
                }

                Text {
                    id: thoughtBody
                    visible: root.showThought
                    width: parent.width
                    wrapMode: Text.Wrap
                    font.family: Theme.monoFontFamily
                    font.pixelSize: Theme.fontSmall
                    color: Theme.textcolor2
                    text: root.thoughtText
                    textFormat: Text.PlainText
                }
            }
        }

        // 1. High-Performance Native RichText Mode (for normal text/markdown)
        Text {
            id: messageText
            visible: !root.hasComplexHtml
            width: parent.width
            wrapMode: Text.Wrap
            color: root.textColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontNormal
            text: (!root.hasComplexHtml) ? root.renderRisuRichText(root.rawText) : ""
            textFormat: Text.RichText
        }

        // 2. Full Chromium WebEngine Mode for actual HTML/CSS/SVG content.
        // The view itself is created asynchronously so fast scrolling never blocks
        // the GUI thread on Chromium startup, and page (re)loads are throttled.
        Item {
            id: webContainer
            visible: root.hasComplexHtml && webLoader.status === Loader.Ready
            width: parent.width
            height: root.hasComplexHtml ? Math.max(1, root.webContentHeight) : 0

            Loader {
                id: webLoader
                anchors.fill: parent
                active: root.hasComplexHtml
                asynchronous: true
                sourceComponent: webEngineComponent
            }

            // Chromium consumes every wheel event above the view instead of
            // propagating it to the enclosing chat ListView, which makes the
            // whole session impossible to scroll whenever the cursor hovers an
            // HTML-formatted message. The document is always laid out at full
            // height here, so internal scrolling is never needed: catch wheels
            // on top of the view and drive the outer Flickable manually.
            // acceptedButtons: NoButton keeps clicks (links, selection) working.
            MouseArea {
                id: wheelForwarder
                anchors.fill: parent
                acceptedButtons: Qt.NoButton
                enabled: webLoader.status === Loader.Ready

                onWheel: function(wheel) {
                    var fl = root.findFlickable(wheelForwarder);
                    if (!fl) {
                        wheel.accepted = false;
                        return;
                    }

                    var step;
                    if (wheel.pixelDelta.y !== 0) {
                        step = -wheel.pixelDelta.y;
                    } else {
                        var lines = Qt.styleHints ? Qt.styleHints.wheelScrollLines : 3;
                        step = -(wheel.angleDelta.y / 120.0) * lines * 20.0;
                    }

                    var minY = -fl.originY;
                    var maxY = Math.max(minY, fl.originY + fl.contentHeight - fl.height);
                    fl.contentY = Math.min(maxY, Math.max(minY, fl.contentY + step));
                    wheel.accepted = true;
                }
            }
        }
    }

    Component {
        id: webEngineComponent

        WebEngineView {
            id: webView
            anchors.fill: parent
            backgroundColor: "transparent"

            settings.javascriptEnabled: true
            settings.localContentCanAccessRemoteUrls: true
            settings.localContentCanAccessFileUrls: true

            function measureContentHeight() {
                webView.runJavaScript(
                    "Math.ceil(Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0));",
                    function(result) {
                        if (result && result > 0) {
                            root.webContentHeight = Math.max(1, Number(result));
                        }
                    }
                );
            }

            onLoadingChanged: function(loadRequest) {
                if (loadRequest.status === WebEngineView.LoadSucceededStatus) {
                    webView.measureContentHeight();
                }
            }

            // The generated document reports ResizeObserver/MutationObserver changes
            // through a private title prefix, so late images and script DOM updates resize
            // the ListView delegate instead of clipping or leaving a giant blank region.
            onTitleChanged: {
                var prefix = "__RISU_HEIGHT__:";
                if (title.indexOf(prefix) === 0) {
                    var measured = Number(title.substring(prefix.length));
                    if (isFinite(measured) && measured > 0) {
                        root.webContentHeight = Math.max(1, Math.ceil(measured));
                    }
                }
            }

            Component.onCompleted: {
                root.scheduleWebEngineUpdate();
            }
        }
    }

    onRawTextChanged: {
        if (root.hasComplexHtml) {
            root.scheduleWebEngineUpdate();
        }
    }

    function updateWebEngineHtml() {
        if (!root.hasComplexHtml || !root.rawText) return;
        var view = webLoader.item;
        if (!view) return;
        var fullHtml = root.buildFullWebEngineDocument(root.renderRisuRichText(root.rawText));
        view.loadHtml(fullHtml, "file://");
    }

    function buildFullWebEngineDocument(bodyHtml) {
        var resizeBridge =
            "<script>(function(){" +
            "var last=-1;" +
            "function report(){" +
            "var b=document.body,d=document.documentElement;" +
            "var h=Math.ceil(Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0,b?b.offsetHeight:0,d?d.offsetHeight:0));" +
            "if(h>0&&h!==last){last=h;document.title='__RISU_HEIGHT__:'+h;}" +
            "}" +
            "if(window.ResizeObserver){new ResizeObserver(function(){requestAnimationFrame(report);}).observe(document.documentElement);}" +
            "if(window.MutationObserver&&document.body){new MutationObserver(function(){requestAnimationFrame(report);}).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});}" +
            "window.addEventListener('load',report);" +
            "document.addEventListener('DOMContentLoaded',report);" +
            "requestAnimationFrame(report);setTimeout(report,50);setTimeout(report,250);" +
            "})();</script>";

        return "<!DOCTYPE html><html><head><meta charset='utf-8'/>" +
               "<meta name='viewport' content='width=device-width, initial-scale=1'/>" +
               "<style>" +
               "  * { box-sizing: border-box; }" +
               "  html, body { margin: 0; padding: 0; width: 100%; min-height: 1px; }" +
               "  body { font-family: " + Theme.fontFamily + ", sans-serif; font-size: " + Theme.fontNormal + "px; line-height: 1.6; color: " + root.textColor + "; background: transparent; overflow-x: hidden; overflow-y: hidden; overflow-wrap: anywhere; }" +
               "  img, video, svg, canvas { max-width: 100%; height: auto; }" +
               "  pre { background: " + Theme.darkbg + "; border: 1px solid " + Theme.darkborderc + "; padding: 8px 12px; border-radius: 6px; font-family: " + Theme.monoFontFamily + "; font-size: 13px; margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }" +
               "  code { background: " + Theme.darkbutton + "; padding: 2px 6px; border-radius: 4px; font-family: " + Theme.monoFontFamily + "; font-size: 13px; }" +
               "  .unicon-image-container { display: inline-flex; align-items: center; justify-content: center; max-width: 100%; margin: 8px 0; border-radius: 8px; overflow: hidden; }" +
               "  .unicon-image-content { max-width: 100%; height: auto; display: block; border-radius: 8px; }" +
               "</style></head><body>" + bodyHtml + resizeBridge + "</body></html>";
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function renderRisuRichText(input) {
        if (!input) return "";

        // Remove model reasoning blocks before either the native or Chromium renderer sees them.
        var cleaned = input.replace(/<think>[\s\S]*?<\/think>/gi, "");

        // Protect code first so HTML-looking examples remain literal code.
        var codeBlocks = [];
        cleaned = cleaned.replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, function(match, code) {
            var token = "___RISU_CODE_BLOCK_" + codeBlocks.length + "___";
            codeBlocks.push("<pre>" + root.escapeHtml(code) + "</pre>");
            return token;
        });

        var inlineCodes = [];
        cleaned = cleaned.replace(/`([^`\n]+)`/g, function(match, code) {
            var token = "___RISU_INLINE_CODE_" + inlineCodes.length + "___";
            inlineCodes.push("<code>" + root.escapeHtml(code) + "</code>");
            return token;
        });

        // CSS/JS/SVG are opaque raw blocks. The old renderer protected only their tags,
        // then inserted <br> and dialogue <span> elements INTO the source itself.
        var rawBlocks = [];
        function protectRaw(match) {
            var token = "___RISU_RAW_BLOCK_" + rawBlocks.length + "___";
            rawBlocks.push(match);
            return token;
        }
        cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, protectRaw);
        cleaned = cleaned.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, protectRaw);
        cleaned = cleaned.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, protectRaw);

        // Protect tags so attribute quotes/styles are never touched by markdown styling.
        var htmlTags = [];
        cleaned = cleaned.replace(/<(\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^>]*?)?\/?)>/g, function(match) {
            var token = "___RISU_HTML_TAG_" + htmlTags.length + "___";
            htmlTags.push(match);
            return token;
        });

        cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "<b style='color:" + Theme.fontBold + ";'>$1</b>");
        cleaned = cleaned.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<i style='color:" + Theme.fontItalic + ";'>$2</i>$3");
        cleaned = cleaned.replace(/("([^"\n]+)")/g, "<span style='color:" + Theme.fontQuote1 + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/(“[\s\S]*?”)/g, "<span style='color:" + Theme.fontQuote2 + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/(「[\s\S]*?」)/g, "<span style='color:" + Theme.fontQuote2 + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/(『[\s\S]*?』)/g, "<span style='color:" + Theme.fontQuote2 + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/\r\n/g, "<br/>").replace(/\n/g, "<br/>");

        for (var h = 0; h < htmlTags.length; ++h)
            cleaned = cleaned.replace("___RISU_HTML_TAG_" + h + "___", htmlTags[h]);
        for (var r = 0; r < rawBlocks.length; ++r)
            cleaned = cleaned.replace("___RISU_RAW_BLOCK_" + r + "___", rawBlocks[r]);
        for (var i = 0; i < inlineCodes.length; ++i)
            cleaned = cleaned.replace("___RISU_INLINE_CODE_" + i + "___", inlineCodes[i]);
        for (var j = 0; j < codeBlocks.length; ++j)
            cleaned = cleaned.replace("___RISU_CODE_BLOCK_" + j + "___", codeBlocks[j]);

        return "<div style='line-height:1.6;font-family:" + Theme.fontFamily + ";color:" + root.textColor + ";'>" + cleaned + "</div>";
    }
}
