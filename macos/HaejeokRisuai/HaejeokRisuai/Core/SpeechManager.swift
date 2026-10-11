import AVFoundation
import Foundation
import Combine

/// Text-to-speech using the system speech synthesizer.
@MainActor
final class SpeechManager: NSObject, ObservableObject {
    static let shared = SpeechManager()

    private let synthesizer = AVSpeechSynthesizer()
    @Published var isSpeaking = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        guard DatabaseStore.shared.settings.ttsEnabled else { return }
        var toSpeak = text
        if DatabaseStore.shared.settings.ttsReadOnlyQuoted {
            // Prefer quoted speech when enabled; fall back to the whole text.
            if let match = text.firstMatch(of: /"([^"]+)"/) {
                toSpeak = String(match.1)
            } else if let match = text.firstMatch(of: /\u{201C}([^\u{201D}]+)\u{201D}/) {
                toSpeak = String(match.1)
            } else if let match = text.firstMatch(of: /「([^」]+)」/) {
                toSpeak = String(match.1)
            }
        }
        guard !toSpeak.isEmpty else { return }

        stop()
        let utterance = AVSpeechUtterance(string: toSpeak)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    func toggle(_ text: String) {
        if isSpeaking {
            stop()
        } else {
            speak(text)
        }
    }
}

extension SpeechManager: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = true
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.isSpeaking = false
        }
    }
}
