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

    readonly property bool hasComplexHtml: {
        if (!root.rawText) return false;
        return /<(?:div|style|svg|canvas|video|audio|details|iframe|table|script)\b|class=["']|style=["'](?=.*(?:flex|grid|position|animation|transform))/i.test(root.rawText);
    }

    implicitWidth: mainColumn.implicitWidth
    implicitHeight: mainColumn.implicitHeight
    height: implicitHeight

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

        // 2. Full Chromium WebEngine Mode (for complex HTML5/CSS3/DOM elements like unicon-image-container)
        Item {
            id: webContainer
            visible: root.hasComplexHtml
            width: parent.width
            height: webView.contentHeight > 0 ? webView.contentHeight : 240

            WebEngineView {
                id: webView
                anchors.fill: parent
                backgroundColor: "transparent"
                property int contentHeight: 240

                settings.javascriptEnabled: true
                settings.localContentCanAccessRemoteUrls: true
                settings.localContentCanAccessFileUrls: true

                onLoadingChanged: function(loadRequest) {
                    if (loadRequest.status === WebEngineView.LoadSucceededStatus) {
                        webView.runJavaScript(
                            "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);",
                            function(result) {
                                if (result && result > 0) {
                                    webView.contentHeight = result + 16;
                                }
                            }
                        );
                    }
                }

                Component.onCompleted: {
                    if (root.hasComplexHtml) {
                        root.updateWebEngineHtml();
                    }
                }
            }
        }
    }

    onRawTextChanged: {
        if (root.hasComplexHtml) {
            root.updateWebEngineHtml();
        }
    }

    function updateWebEngineHtml() {
        if (!root.rawText) return;
        var fullHtml = root.buildFullWebEngineDocument(root.renderRisuRichText(root.rawText));
        webView.loadHtml(fullHtml, "file://");
    }

    function buildFullWebEngineDocument(bodyHtml) {
        return "<!DOCTYPE html><html><head><meta charset='utf-8'/>" +
               "<style>" +
               "  * { box-sizing: border-box; margin: 0; padding: 0; }" +
               "  body { font-family: " + Theme.fontFamily + ", sans-serif; font-size: 15px; line-height: 1.6; color: " + root.textColor + "; background: transparent; overflow: hidden; }" +
               "  img { max-width: 100%; height: auto; }" +
               "  pre { background: " + Theme.darkbg + "; border: 1px solid " + Theme.darkborderc + "; padding: 8px 12px; border-radius: 6px; font-family: " + Theme.monoFontFamily + "; font-size: 13px; margin: 6px 0; white-space: pre-wrap; }" +
               "  code { background: " + Theme.darkbutton + "; padding: 2px 6px; border-radius: 4px; font-family: " + Theme.monoFontFamily + "; font-size: 13px; }" +
               "  .unicon-image-container { display: inline-flex; align-items: center; justify-content: center; max-width: 100%; margin: 8px 0; border-radius: 8px; overflow: hidden; }" +
               "  .unicon-image-content { max-width: 100%; height: auto; display: block; border-radius: 8px; }" +
               "</style></head><body>" + bodyHtml + "</body></html>";
    }

    function renderRisuRichText(input) {
        if (!input) return "";

        // Remove <think>...</think> if present in raw text
        var cleaned = input.replace(/<think>[\s\S]*?<\/think>/gi, "");

        // 1. Protect code blocks first
        var codeBlocks = [];
        cleaned = cleaned.replace(/```([\s\S]*?)```/g, function(match, code) {
            var token = "___RISU_CODE_BLOCK_" + codeBlocks.length + "___";
            codeBlocks.push("<pre style='background-color:" + Theme.darkbg + "; border: 1px solid " + Theme.darkborderc + "; padding: 8px 12px; border-radius: 6px; font-family: " + Theme.monoFontFamily + "; font-size: 13px; margin: 6px 0; white-space: pre-wrap;'>" + code + "</pre>");
            return token;
        });

        // 2. Protect inline code
        var inlineCodes = [];
        cleaned = cleaned.replace(/`([^`\n]+)`/g, function(match, code) {
            var token = "___RISU_INLINE_CODE_" + inlineCodes.length + "___";
            inlineCodes.push("<code style='background-color:" + Theme.darkbutton + "; padding: 2px 6px; border-radius: 4px; font-family: " + Theme.monoFontFamily + "; font-size: 13px;'>" + code + "</code>");
            return token;
        });

        // 3. Protect ALL valid HTML tags (<...>) so their attributes (class="...", src="...", style="...") aren't corrupted by markdown/quote parsers
        var htmlTags = [];
        cleaned = cleaned.replace(/<(\/?[a-zA-Z0-9\-]+(?:\s+[^>]*?)?\/?)>/g, function(match) {
            var token = "___RISU_HTML_TAG_" + htmlTags.length + "___";
            htmlTags.push(match);
            return token;
        });

        // 4. Bold **text**
        cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "<b style='color:" + Theme.fontBold + ";'>$1</b>");

        // 5. Italic *text* (Narration styling)
        var narrationColor = Theme.fontItalic;
        cleaned = cleaned.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<i style='color:" + narrationColor + ";'>$2</i>$3");

        // 6. Dialogue Quotes "..." (Only matches quotes in raw text, not within HTML tags)
        var quote1Color = Theme.fontQuote1;
        cleaned = cleaned.replace(/("([^"\n]+)")/g, "<span style='color:" + quote1Color + "; font-weight: 500;'>$1</span>");

        // 7. Dialogue Quotes 2 “...” or 「...」 or 『...』
        var quote2Color = Theme.fontQuote2;
        cleaned = cleaned.replace(/(“[\s\S]*?”)/g, "<span style='color:" + quote2Color + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/(「[\s\S]*?」)/g, "<span style='color:" + quote2Color + "; font-weight: 500;'>$1</span>");
        cleaned = cleaned.replace(/(『[\s\S]*?』)/g, "<span style='color:" + quote2Color + "; font-weight: 500;'>$1</span>");

        // 8. Convert standard newlines to <br/>
        cleaned = cleaned.replace(/\r\n/g, "<br/>").replace(/\n/g, "<br/>");

        // 9. Restore protected HTML tags
        for (var h = 0; h < htmlTags.length; ++h) {
            cleaned = cleaned.replace("___RISU_HTML_TAG_" + h + "___", htmlTags[h]);
        }

        // 10. Restore inline codes
        for (var i = 0; i < inlineCodes.length; ++i) {
            cleaned = cleaned.replace("___RISU_INLINE_CODE_" + i + "___", inlineCodes[i]);
        }

        // 11. Restore code blocks
        for (var j = 0; j < codeBlocks.length; ++j) {
            cleaned = cleaned.replace("___RISU_CODE_BLOCK_" + j + "___", codeBlocks[j]);
        }

        return "<div style='line-height: 1.6; font-family: " + Theme.fontFamily + "; color: " + root.textColor + ";'>" + cleaned + "</div>";
    }
}
