import QtQuick
import QtQuick.Controls.Basic
import QtQuick.Layouts
import "../theme"
import "../components"

Rectangle {
    id: root

    signal closeRequested()

    color: Theme.bgcolor

    property string presetId: presetCtrl.activePresetId || ""

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Header Bar
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
                    text: "AI Provider & Generation Presets"
                    font.pixelSize: Theme.fontLarge
                    font.weight: Font.Bold
                    font.family: Theme.fontFamily
                    color: Theme.textcolor
                }

                Item { Layout.fillWidth: true }

                // Preset selector dropdown
                RisuComboBox {
                    id: presetSelector
                    Layout.preferredWidth: 200
                    model: presetCtrl.presetModel
                    textRole: "name"
                    currentIndex: presetCtrl.presetModel.indexOfId(presetCtrl.activePresetId)
                    onActivated: function(index) {
                        var p = presetCtrl.presetModel.getPresetAt(index);
                        if (p && p.id) presetCtrl.selectPreset(p.id);
                    }
                }

                RisuButton {
                    text: "+ New"
                    variant: "secondary"
                    onClicked: presetCtrl.createPreset("Custom Preset", "openai")
                }

                RisuButton {
                    text: "Delete"
                    iconName: "trash"
                    variant: "danger"
                    onClicked: presetCtrl.deletePreset(presetCtrl.activePresetId)
                }

                RisuButton {
                    text: "Save Preset"
                    iconName: "check"
                    variant: "primary"
                    onClicked: root.saveCurrentData()
                }
            }
        }

        // Main Settings Body Scroll
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            padding: 24

            ColumnLayout {
                width: Math.min(800, parent.width - 48)
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: 20

                // Section 1: Provider & Credentials
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: provLayout.implicitHeight + 32

                    ColumnLayout {
                        id: provLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "1. AI Provider & Connection"
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
                                Text { text: "Preset Name"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: presetNameField
                                    Layout.fillWidth: true
                                    text: presetCtrl.activePreset.name || ""
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "API Provider"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuComboBox {
                                    id: providerCombo
                                    Layout.fillWidth: true
                                    model: ["OpenAI", "Anthropic Claude", "Google Gemini", "OpenRouter", "Local Ollama", "Custom OpenAI-Compatible"]
                                    currentIndex: {
                                        var p = presetCtrl.activePreset.provider || "openai";
                                        if (p === "claude") return 1;
                                        if (p === "gemini") return 2;
                                        if (p === "openrouter") return 3;
                                        if (p === "ollama") return 4;
                                        if (p === "custom") return 5;
                                        return 0;
                                    }
                                }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 16

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "Model ID / Name"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: modelNameField
                                    Layout.fillWidth: true
                                    text: presetCtrl.activePreset.modelName || ""
                                    placeholderText: "e.g. gpt-4o, claude-3-7-sonnet-20250219, gemini-2.5-flash, llama3.3"
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Text { text: "API Key"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                                RisuTextField {
                                    id: apiKeyField
                                    Layout.fillWidth: true
                                    isPassword: true
                                    text: presetCtrl.activePreset.apiKey || ""
                                    placeholderText: "sk-..."
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 4
                            Text { text: "Custom Endpoint / Base URL Override"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor2 }
                            RisuTextField {
                                id: endpointField
                                Layout.fillWidth: true
                                text: presetCtrl.activePreset.customEndpointUrl || ""
                                placeholderText: "Leave blank for official endpoints, or http://localhost:11434 for Ollama / TabbyAPI"
                            }
                        }
                    }
                }

                // Section 2: Generation Parameters & Sampling
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: paramLayout.implicitHeight + 32

                    ColumnLayout {
                        id: paramLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 16

                        Text {
                            text: "2. Generation & Sampling Parameters"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        // Temperature
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Temperature: " + tempSlider.value.toFixed(2); font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 160 }
                            RisuSlider {
                                id: tempSlider
                                Layout.fillWidth: true
                                from: 0.0
                                to: 2.0
                                stepSize: 0.05
                                value: typeof presetCtrl.activePreset.temperature !== "undefined" ? presetCtrl.activePreset.temperature : 0.8
                            }
                        }

                        // Max Response Tokens
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Max Output Tokens: " + String(Math.round(maxTokSlider.value)); font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 160 }
                            RisuSlider {
                                id: maxTokSlider
                                Layout.fillWidth: true
                                from: 100
                                to: 8192
                                stepSize: 50
                                value: presetCtrl.activePreset.maxTokens || 1000
                            }
                        }

                        // Context Limit
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Context Window: " + String(Math.round(contextSlider.value)) + " tokens"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 160 }
                            RisuSlider {
                                id: contextSlider
                                Layout.fillWidth: true
                                from: 2048
                                to: 128000
                                stepSize: 1024
                                value: presetCtrl.activePreset.contextLimit || 16000
                            }
                        }

                        // Top P
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Top-P: " + topPSlider.value.toFixed(2); font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 160 }
                            RisuSlider {
                                id: topPSlider
                                Layout.fillWidth: true
                                from: 0.0
                                to: 1.0
                                stepSize: 0.05
                                value: typeof presetCtrl.activePreset.topP !== "undefined" ? presetCtrl.activePreset.topP : 1.0
                            }
                        }

                        // Frequency Penalty
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Freq Penalty: " + freqSlider.value.toFixed(2); font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 160 }
                            RisuSlider {
                                id: freqSlider
                                Layout.fillWidth: true
                                from: 0.0
                                to: 2.0
                                stepSize: 0.05
                                value: presetCtrl.activePreset.frequencyPenalty || 0.0
                            }
                        }

                        // Reasoning Effort
                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: "Reasoning Effort (Thinking Models):"; font.pixelSize: Theme.fontSmall; font.family: Theme.fontFamily; color: Theme.textcolor; Layout.preferredWidth: 260 }
                            RisuComboBox {
                                id: reasoningCombo
                                Layout.fillWidth: true
                                model: ["Disabled (0)", "Low (1)", "Medium (2)", "High (3)"]
                                currentIndex: presetCtrl.activePreset.reasoningEffort || 0
                            }
                        }

                        // Real-time Streaming
                        RisuSwitch {
                            id: streamSwitch
                            text: "Enable Real-time Token Streaming"
                            checked: typeof presetCtrl.activePreset.enableStreaming !== "undefined" ? presetCtrl.activePreset.enableStreaming : true
                        }
                    }
                }

                // Section 3: Prompts & Formatting
                RisuCard {
                    Layout.fillWidth: true
                    implicitHeight: promptLayout.implicitHeight + 32

                    ColumnLayout {
                        id: promptLayout
                        anchors.fill: parent
                        anchors.margins: 16
                        spacing: 14

                        Text {
                            text: "3. System Prompts & Instruction Templates"
                            font.pixelSize: Theme.fontMedium
                            font.weight: Font.Bold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: presetCtrl.activePreset.usesPromptTemplate || false
                            text: "This preset uses a Risu promptTemplate (" + ((presetCtrl.activePreset.promptTemplate || []).length) + " blocks). Template cards control the final prompt order; the legacy fields below are only used by compatible/empty template cards."
                            wrapMode: Text.Wrap
                            font.pixelSize: Theme.fontSmall
                            font.family: Theme.fontFamily
                            color: Theme.warning
                        }

                        Text {
                            text: "Main System Prompt"
                            font.pixelSize: Theme.fontSmall
                            font.weight: Font.DemiBold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                        }
                        RisuTextArea {
                            id: mainPromptField
                            Layout.fillWidth: true
                            implicitHeight: 140
                            text: presetCtrl.activePreset.mainPrompt || ""
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            Text {
                                text: "Jailbreak / Guidance Note"
                                font.pixelSize: Theme.fontSmall
                                font.weight: Font.DemiBold
                                font.family: Theme.fontFamily
                                color: Theme.textcolor2
                                Layout.fillWidth: true
                            }
                            RisuSwitch {
                                id: jbSwitch
                                text: "Enable Note"
                                checked: presetCtrl.activePreset.enableJailbreak || false
                            }
                        }
                        RisuTextArea {
                            id: jbPromptField
                            Layout.fillWidth: true
                            implicitHeight: 100
                            text: presetCtrl.activePreset.jailbreakPrompt || ""
                        }

                        Text {
                            text: "Global Note (Style & Guidance)"
                            font.pixelSize: Theme.fontSmall
                            font.weight: Font.DemiBold
                            font.family: Theme.fontFamily
                            color: Theme.textcolor2
                        }
                        RisuTextArea {
                            id: globalNoteField
                            Layout.fillWidth: true
                            implicitHeight: 80
                            text: presetCtrl.activePreset.globalNote || ""
                        }
                    }
                }
            }
        }
    }

    function saveCurrentData() {
        var provMap = ["openai", "claude", "gemini", "openrouter", "ollama", "custom"];
        var data = {
            id: presetCtrl.activePresetId,
            name: presetNameField.text,
            provider: provMap[providerCombo.currentIndex],
            modelName: modelNameField.text,
            apiKey: apiKeyField.text,
            customEndpointUrl: endpointField.text,
            temperature: tempSlider.value,
            maxTokens: Math.round(maxTokSlider.value),
            contextLimit: Math.round(contextSlider.value),
            topP: topPSlider.value,
            frequencyPenalty: freqSlider.value,
            reasoningEffort: reasoningCombo.currentIndex,
            enableStreaming: streamSwitch.checked,
            mainPrompt: mainPromptField.text,
            jailbreakPrompt: jbPromptField.text,
            globalNote: globalNoteField.text,
            enableJailbreak: jbSwitch.checked
        };
        presetCtrl.savePresetDetails(data);
    }
}
