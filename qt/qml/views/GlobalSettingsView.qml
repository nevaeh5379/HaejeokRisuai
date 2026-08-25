import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import QtQuick.Dialogs
import "../theme"
import "../components"

Rectangle {
    id: root

    signal closeRequested()

    color: Theme.bgcolor

    FileDialog {
        id: backupSaveDialog
        title: "Backup Entire Database (JSON)"
        fileMode: FileDialog.SaveFile
        nameFilters: ["JSON Backup (*.json)"]
        defaultSuffix: "json"
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            appCtrl.backupData(path);
        }
    }

    FileDialog {
        id: restoreOpenDialog
        title: "Restore Backup (Binary .bin / .risubackup / JSON)"
        nameFilters: ["All Risu Backups (*.bin *.risubackup *.json)", "Binary Backups (*.bin *.risubackup)", "JSON Backups (*.json)", "All files (*)"]
        onAccepted: {
            var path = selectedFile.toString().replace("file://", "");
            appCtrl.restoreData(path);
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Header
        Rectangle {
            Layout.fillWidth: true
            height: 56
            color: Theme.darkbg
            border.color: Theme.darkborderc
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                spacing: 12

                RisuIconButton {
                    iconName: "arrow-left"
                    tooltipText: "Back to Chat"
                    onClicked: root.closeRequested()
                }

                Text {
                    text: "Application Settings"
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                }
            }
        }

        // Settings Body Scroll
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            padding: 24

            ColumnLayout {
                width: Math.min(750, parent.width - 48)
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: 20

                // Theme & Appearance
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: themeLayout.implicitHeight + 32

                    ColumnLayout {
                        id: themeLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "Appearance & Theme"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 12

                            Text {
                                text: "Color Theme:"
                                font.pixelSize: Theme.fontNormal
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                Layout.preferredWidth: 140
                            }

                            RisuComboBox {
                                Layout.fillWidth: true
                                model: ["Dracula (Default)", "Dark", "Cherry", "Galaxy", "Nature", "Ocean", "Aurora", "Twilight", "Real Black", "Light"]
                                currentIndex: {
                                    switch (appConfig.theme) {
                                        case "dark": return 1;
                                        case "cherry": return 2;
                                        case "galaxy": return 3;
                                        case "nature": return 4;
                                        case "ocean": return 5;
                                        case "aurora": return 6;
                                        case "twilight": return 7;
                                        case "realblack": return 8;
                                        case "light": return 9;
                                        case "dracula":
                                        default: return 0;
                                    }
                                }
                                onActivated: function(index) {
                                    var themes = ["dracula", "dark", "cherry", "galaxy", "nature", "ocean", "aurora", "twilight", "realblack", "light"];
                                    appConfig.theme = themes[index];
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 12

                            Text {
                                text: "Font Size (" + String(appConfig.fontSize) + "px):"
                                font.pixelSize: Theme.fontNormal
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                Layout.preferredWidth: 140
                            }

                            RisuSlider {
                                Layout.fillWidth: true
                                from: 11
                                to: 24
                                stepSize: 1
                                value: appConfig.fontSize
                                onMoved: appConfig.fontSize = Math.round(value)
                            }
                        }
                    }
                }

                // Chat & Interface Options
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: chatOptLayout.implicitHeight + 32

                    ColumnLayout {
                        id: chatOptLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "Chat & Behavior"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        RisuSwitch {
                            text: "Auto-scroll message list on new stream tokens"
                            checked: appConfig.autoScroll
                            onToggled: appConfig.autoScroll = checked
                        }

                        RisuSwitch {
                            text: "Real-time streaming token display"
                            checked: appConfig.streamDisplay
                            onToggled: appConfig.streamDisplay = checked
                        }

                        RisuSwitch {
                            text: "Sound effects on message received"
                            checked: appConfig.soundEffects
                            onToggled: appConfig.soundEffects = checked
                        }

                        RisuSwitch {
                            text: "Render rich HTML cards and animations"
                            checked: appConfig.renderMessageHtml
                            onToggled: appConfig.renderMessageHtml = checked
                            ToolTip.visible: chatRenderHover.containsMouse
                            ToolTip.text: "Uses an embedded browser only for messages containing HTML. Turn off for maximum stability; RisuAI-compatible cards render best when enabled."
                            ToolTip.delay: 300

                            MouseArea {
                                id: chatRenderHover
                                anchors.fill: parent
                                hoverEnabled: true
                                acceptedButtons: Qt.NoButton
                            }
                        }
                    }
                }

                // Text-to-Speech (TTS) Voice Synthesis
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: ttsCardLayout.implicitHeight + 32

                    ColumnLayout {
                        id: ttsCardLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "Text-to-Speech (TTS) Audio Synthesis"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 20

                            RisuSwitch {
                                text: "Enable TTS Audio"
                                checked: ttsCtrl.ttsEnabled
                                onToggled: ttsCtrl.ttsEnabled = checked
                            }

                            RisuSwitch {
                                text: "Auto-Speak AI Responses"
                                checked: ttsCtrl.autoSpeak
                                onToggled: ttsCtrl.autoSpeak = checked
                                enabled: ttsCtrl.ttsEnabled
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 12
                            visible: ttsCtrl.ttsEnabled

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 16

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "TTS Provider:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuComboBox {
                                        id: ttsProviderCombo
                                        Layout.fillWidth: true
                                        model: ["OpenAI TTS", "ElevenLabs", "Voicevox / Local", "Custom Endpoint"]
                                        currentIndex: {
                                            if (ttsCtrl.provider === "elevenlabs") return 1;
                                            if (ttsCtrl.provider === "voicevox") return 2;
                                            if (ttsCtrl.provider === "custom") return 3;
                                            return 0;
                                        }
                                        onActivated: function(idx) {
                                            var provs = ["openai", "elevenlabs", "voicevox", "custom"];
                                            ttsCtrl.provider = provs[idx];
                                        }
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "Voice ID / Speaker:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: ttsVoiceField
                                        Layout.fillWidth: true
                                        text: ttsCtrl.voiceId
                                        placeholderText: "e.g. alloy, echo, nova or Voice ID"
                                        onTextChanged: ttsCtrl.voiceId = text
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 16

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "API Key (if required):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: ttsApiKeyField
                                        Layout.fillWidth: true
                                        echoMode: TextInput.Password
                                        text: ttsCtrl.apiKey
                                        placeholderText: "sk-..."
                                        onTextChanged: ttsCtrl.apiKey = text
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "Custom Endpoint / URL:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: ttsEndpointField
                                        Layout.fillWidth: true
                                        text: ttsCtrl.customEndpoint
                                        placeholderText: "http://localhost:50021/audio_query"
                                        onTextChanged: ttsCtrl.customEndpoint = text
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 12

                                RisuButton {
                                    text: ttsCtrl.isSpeaking ? "Stop Speaking" : "Test Voice"
                                    iconName: ttsCtrl.isSpeaking ? "stop" : "volume"
                                    variant: ttsCtrl.isSpeaking ? "danger" : "secondary"
                                    onClicked: {
                                        if (ttsCtrl.isSpeaking) {
                                            ttsCtrl.stop();
                                        } else {
                                            ttsCtrl.speak("Hello! This is a voice test from RisuAI Native.");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // AI Image Generation (Stable Diffusion / DALL-E / NovelAI)
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: imgGenCardLayout.implicitHeight + 32

                    ColumnLayout {
                        id: imgGenCardLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "AI Image & Illustration Generation"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 16

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Image Provider:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuComboBox {
                                    id: imgProviderCombo
                                    Layout.fillWidth: true
                                    model: ["Stable Diffusion (WebUI / A1111)", "OpenAI DALL-E 3", "NovelAI Diffusion", "ComfyUI / Custom"]
                                    currentIndex: {
                                        if (imageGenCtrl.provider === "dalle3") return 1;
                                        if (imageGenCtrl.provider === "novelai") return 2;
                                        if (imageGenCtrl.provider === "comfyui") return 3;
                                        return 0;
                                    }
                                    onActivated: function(idx) {
                                        var provs = ["sd_a1111", "dalle3", "novelai", "comfyui"];
                                        imageGenCtrl.provider = provs[idx];
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "API Key (if required):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: imgApiKeyField
                                    Layout.fillWidth: true
                                    echoMode: TextInput.Password
                                    text: imageGenCtrl.apiKey
                                    placeholderText: "sk-... or NovelAI API Key"
                                    onTextChanged: imageGenCtrl.apiKey = text
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 16

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Endpoint URL:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: imgEndpointField
                                    Layout.fillWidth: true
                                    text: imageGenCtrl.endpointUrl
                                    placeholderText: "http://127.0.0.1:7860/sdapi/v1/txt2img"
                                    onTextChanged: imageGenCtrl.endpointUrl = text
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Negative Prompt:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: imgNegPromptField
                                    Layout.fillWidth: true
                                    text: imageGenCtrl.negativePrompt
                                    placeholderText: "low quality, bad anatomy, blurry"
                                    onTextChanged: imageGenCtrl.negativePrompt = text
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 16

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Resolution (Width x Height):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuComboBox {
                                    Layout.fillWidth: true
                                    model: ["512 x 768 (Portrait)", "512 x 512 (Square)", "768 x 512 (Landscape)", "1024 x 1024 (HD Square)"]
                                    currentIndex: 0
                                    onActivated: function(idx) {
                                        if (idx === 0) { imageGenCtrl.width = 512; imageGenCtrl.height = 768; }
                                        else if (idx === 1) { imageGenCtrl.width = 512; imageGenCtrl.height = 512; }
                                        else if (idx === 2) { imageGenCtrl.width = 768; imageGenCtrl.height = 512; }
                                        else if (idx === 3) { imageGenCtrl.width = 1024; imageGenCtrl.height = 1024; }
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Sampling Steps (" + String(imageGenCtrl.steps) + "):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuSlider {
                                    Layout.fillWidth: true
                                    from: 10
                                    to: 50
                                    stepSize: 1
                                    value: imageGenCtrl.steps
                                    onMoved: imageGenCtrl.steps = Math.round(value)
                                }
                            }
                        }
                    }
                }

                // Local REST API Self-Hosting Server
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: apiServerCardLayout.implicitHeight + 32

                    ColumnLayout {
                        id: apiServerCardLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        RowLayout {
                            Layout.fillWidth: true
                            Text {
                                text: "Local REST API Server (Self-Hosting)"
                                font.pixelSize: Theme.fontMedium
                                font.weight: Font.Bold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                Layout.fillWidth: true
                            }
                            RisuBadge {
                                text: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? "ONLINE" : "OFFLINE"
                                badgeColor: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? Theme.success : Theme.darkbutton
                                textColor: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? "#11111b" : Theme.textcolor2
                            }
                        }

                        Text {
                            text: "Host your character cards, chat endpoints, and database over localhost REST API for browser extensions, mobile apps, or companion tools."
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 16

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Server Port:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: portField
                                    Layout.preferredWidth: 140
                                    text: "6001"
                                    Component.onCompleted: {
                                        if (typeof apiServerCtrl !== "undefined") {
                                            portField.text = String(apiServerCtrl.port);
                                        }
                                    }
                                    onEditingFinished: {
                                        var p = parseInt(text);
                                        if (p > 1000 && p < 65535 && typeof apiServerCtrl !== "undefined") {
                                            apiServerCtrl.port = p;
                                        }
                                    }
                                }
                            }

                            RisuButton {
                                text: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? "Stop Server" : "Start API Server"
                                iconName: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? "stop" : "power"
                                variant: (typeof apiServerCtrl !== "undefined" && apiServerCtrl.isRunning) ? "danger" : "primary"
                                onClicked: {
                                    if (typeof apiServerCtrl !== "undefined") {
                                        apiServerCtrl.toggleServer(!apiServerCtrl.isRunning);
                                    }
                                }
                            }
                        }
                    }
                }

                // Database & Multi-SQL Configuration (relational-schema-v3)
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: dbCardLayout.implicitHeight + 32

                    ColumnLayout {
                        id: dbCardLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        RowLayout {
                            Layout.fillWidth: true
                            Text {
                                text: "Database & Multi-SQL Storage (relational-schema-v3)"
                                font.pixelSize: Theme.fontMedium
                                font.weight: Font.Bold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                Layout.fillWidth: true
                            }

                            Rectangle {
                                implicitWidth: statusRow.implicitWidth + 16
                                implicitHeight: 26
                                radius: 13
                                color: appConfig.isDbConnected ? "#50fa7b22" : "#ff555522"
                                border.color: appConfig.isDbConnected ? "#50fa7b" : "#ff5555"
                                border.width: 1

                                RowLayout {
                                    id: statusRow
                                    anchors.centerIn: parent
                                    spacing: 6
                                    Rectangle {
                                        width: 8
                                        height: 8
                                        radius: 4
                                        color: appConfig.isDbConnected ? "#50fa7b" : "#ff5555"
                                    }
                                    Text {
                                        text: appConfig.schemaLayout + " (v" + String(appConfig.schemaVersion) + ") | " + appConfig.activeDbDriver
                                        font.pixelSize: Theme.fontTiny
                                        font.weight: Font.Bold
                                        font.family: Theme.fontFamily
                                        color: appConfig.isDbConnected ? "#50fa7b" : "#ff5555"
                                    }
                                }
                            }
                        }

                        Text {
                            text: "Connect natively to SQLite, PostgreSQL, Oracle Database, or MySQL/MariaDB with automatic schema migration and normalized relational persistence."
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 12

                            Text {
                                text: "Database Engine:"
                                font.pixelSize: Theme.fontNormal
                                font.family: Theme.fontFamily
                                color: Theme.textcolor
                                Layout.preferredWidth: 140
                            }

                            RisuComboBox {
                                id: driverCombo
                                Layout.fillWidth: true
                                model: ["SQLite (Local File)", "PostgreSQL (QPSQL)", "Oracle Database (QODBC / QOCI)", "MySQL / MariaDB (QMYSQL)"]
                                currentIndex: {
                                    var d = appConfig.dbDriver.toUpperCase();
                                    if (d.indexOf("PSQL") !== -1 || d.indexOf("POSTGRES") !== -1) return 1;
                                    if (d.indexOf("OCI") !== -1 || d.indexOf("ORACLE") !== -1 || d.indexOf("ODBC") !== -1) return 2;
                                    if (d.indexOf("MYSQL") !== -1 || d.indexOf("MARIA") !== -1) return 3;
                                    return 0;
                                }
                                onActivated: function(idx) {
                                    var drivers = ["QSQLITE", "QPSQL", "QODBC", "QMYSQL"];
                                    appConfig.dbDriver = drivers[idx];
                                    if (idx === 1 && portFieldDb.text === "0") portFieldDb.text = "5432";
                                    else if (idx === 2 && portFieldDb.text === "0") portFieldDb.text = "1521";
                                    else if (idx === 3 && portFieldDb.text === "0") portFieldDb.text = "3306";
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 10
                            visible: driverCombo.currentIndex !== 0

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 12

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    Layout.preferredWidth: 3
                                    spacing: 4
                                    Text { text: "Host / Server Address:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: hostFieldDb
                                        Layout.fillWidth: true
                                        text: appConfig.dbHost
                                        placeholderText: "localhost or IP"
                                        onEditingFinished: appConfig.dbHost = text
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    Layout.preferredWidth: 1
                                    spacing: 4
                                    Text { text: "Port:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: portFieldDb
                                        Layout.fillWidth: true
                                        text: String(appConfig.dbPort > 0 ? appConfig.dbPort : (driverCombo.currentIndex === 1 ? 5432 : (driverCombo.currentIndex === 2 ? 1521 : 3306)))
                                        placeholderText: "Port"
                                        onEditingFinished: appConfig.dbPort = parseInt(text) || 0
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 12

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: driverCombo.currentIndex === 2 ? "Database / Service Name (SID):" : "Database Name:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: nameFieldDb
                                        Layout.fillWidth: true
                                        text: appConfig.dbName
                                        placeholderText: driverCombo.currentIndex === 2 ? "ORCLPDB1" : "risuai"
                                        onEditingFinished: appConfig.dbName = text
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "Username:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: userFieldDb
                                        Layout.fillWidth: true
                                        text: appConfig.dbUser
                                        placeholderText: driverCombo.currentIndex === 1 ? "postgres" : (driverCombo.currentIndex === 2 ? "system" : "root")
                                        onEditingFinished: appConfig.dbUser = text
                                    }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text { text: "Password:"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                    RisuTextField {
                                        id: passFieldDb
                                        Layout.fillWidth: true
                                        text: appConfig.dbPassword
                                        echoMode: TextInput.Password
                                        placeholderText: "Password"
                                        onEditingFinished: appConfig.dbPassword = text
                                    }
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 12

                            RisuButton {
                                text: "Test Connection"
                                iconName: "wifi"
                                variant: "secondary"
                                onClicked: {
                                    var drivers = ["QSQLITE", "QPSQL", "QODBC", "QMYSQL"];
                                    var drv = drivers[driverCombo.currentIndex];
                                    var port = parseInt(portFieldDb.text) || 0;
                                    var ok = appConfig.testDbConnection(drv, hostFieldDb.text, port, nameFieldDb.text, userFieldDb.text, passFieldDb.text, "");
                                    if (ok) {
                                        appCtrl.showToast("success", "Connection test succeeded! Database is reachable.");
                                    } else {
                                        appCtrl.showToast("error", "Connection test failed. Check host, port, credentials and drivers.");
                                    }
                                }
                            }

                            RisuButton {
                                text: "Connect & Switch Database"
                                iconName: "database"
                                variant: "primary"
                                onClicked: {
                                    var drivers = ["QSQLITE", "QPSQL", "QODBC", "QMYSQL"];
                                    var drv = drivers[driverCombo.currentIndex];
                                    var port = parseInt(portFieldDb.text) || 0;
                                    var ok = appConfig.applyDbConnection(drv, hostFieldDb.text, port, nameFieldDb.text, userFieldDb.text, passFieldDb.text, "");
                                    if (ok) {
                                        charCtrl.refreshCharacters();
                                        presetCtrl.refreshPresets();
                                        personaCtrl.refreshPersonas();
                                        loreCtrl.refreshLorebooks();
                                        groupCtrl.refreshGroups();
                                        appCtrl.showToast("success", "Connected and migrated database to " + drv + " (relational-schema-v3)!");
                                    } else {
                                        appCtrl.showToast("error", "Failed to connect database. Check logs.");
                                    }
                                }
                            }
                        }
                    }
                }

                // Data Management & Backups
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: dataLayout.implicitHeight + 32

                    ColumnLayout {
                        id: dataLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "Data & Storage Management"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        Text {
                            text: "Data Location: " + appConfig.appDataDir
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 12

                            RisuButton {
                                text: "Backup Database"
                                iconName: "download"
                                variant: "secondary"
                                onClicked: backupSaveDialog.open()
                            }

                            RisuButton {
                                text: "Restore Backup"
                                iconName: "download"
                                variant: "secondary"
                                onClicked: restoreOpenDialog.open()
                            }

                            RisuButton {
                                text: "Open Data Folder"
                                iconName: "external-link"
                                variant: "ghost"
                                onClicked: appCtrl.openDirectory(appConfig.appDataDir)
                            }
                        }
                    }
                }

                // About RisuAI Qt
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: aboutLayout.implicitHeight + 32

                    ColumnLayout {
                        id: aboutLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 8

                        Text {
                            text: "About RisuAI Native"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        Text {
                            text: "Version: " + appCtrl.appVersion
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        Text {
                            text: "High-performance cross-platform AI chat application ported to native C++ and Qt6 QML with SQLite storage, full character card spec support, and multi-provider streaming."
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                    }
                }
            }
        }
    }
}
