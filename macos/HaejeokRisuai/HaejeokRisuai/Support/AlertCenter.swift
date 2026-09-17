import Foundation
import SwiftUI
import Combine

/// Global toast/alert state, mirroring the web version's alertStore.
@MainActor
final class AlertCenter: ObservableObject {
    static let shared = AlertCenter()

    enum AlertKind: Equatable {
        case none
        case info(String)
        case error(String)
        case success(String)
    }

    @Published var current: AlertKind = .none

    private var autoDismissTask: Task<Void, Never>?

    func show(_ kind: AlertKind) {
        current = kind
        guard case .error = kind else {
            autoDismissTask?.cancel()
            autoDismissTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3_500_000_000)
                if !Task.isCancelled {
                    self?.current = .none
                }
            }
            return
        }
    }

    func info(_ msg: String) { show(.info(msg)) }
    func success(_ msg: String) { show(.success(msg)) }
    func error(_ err: Error) {
        show(.error(err.localizedDescription))
    }

    func error(_ msg: String) {
        show(.error(msg))
    }

    func dismiss() {
        current = .none
    }
}
