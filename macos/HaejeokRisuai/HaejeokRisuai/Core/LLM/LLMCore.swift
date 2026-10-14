import Foundation

/// A single prompt turn sent to a provider.
/// Roles follow the OpenAI convention: "system", "user", "assistant".
struct PromptMessage: Hashable, Codable {
    var role: String
    var content: String
}

/// Everything needed to perform one completion request.
struct GenerationConfig {
    var providerKind: ProviderKind
    var model: String
    var apiKey: String
    var baseURL: String
    var temperature: Double = 0.75
    var maxTokens: Int = 500
    var maxContext: Int = 4022
    var frequencyPenalty: Double?
    var presencePenalty: Double?
    var topP: Double?
    var topK: Int?
    var seed: Int?
    var reasoningEffort: Int = 0
    var thinkingType: String = "off"

    init(providerKind: ProviderKind, model: String, apiKey: String, baseURL: String) {
        self.providerKind = providerKind
        self.model = model
        self.apiKey = apiKey
        self.baseURL = baseURL
    }
}

enum ProviderError: LocalizedError {
    case missingAPIKey(String)
    case missingModel
    case http(status: Int, body: String)
    case invalidResponse(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .missingAPIKey(let provider):
            return "No API key set for \(provider). Add one in Settings → API."
        case .missingModel:
            return "No model selected."
        case .http(let status, let body):
            return "HTTP \(status): \(body)"
        case .invalidResponse(let why):
            return "Invalid response: \(why)"
        case .cancelled:
            return "Generation cancelled."
        }
    }
}

/// Streaming chat-completion providers.
protocol LLMProvider {
    /// Streams generated text deltas. Completes normally at end of output,
    /// or throws on failure/cancellation.
    func stream(messages: [PromptMessage], config: GenerationConfig) -> AsyncThrowingStream<String, Error>
}

extension LLMProvider {
    /// Convenience: collects the full response.
    func collect(messages: [PromptMessage], config: GenerationConfig) async throws -> String {
        var out = ""
        for try await delta in stream(messages: messages, config: config) {
            out += delta
        }
        return out
    }
}

// MARK: - SSE helpers

enum SSE {
    /// Builds an HTTP request with common headers.
    static func makeRequest(url: URL, method: String = "POST", apiKey: String?, extraHeaders: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        for (k, v) in extraHeaders {
            request.setValue(v, forHTTPHeaderField: k)
        }
        return request
    }

    enum SSEAction {
        case delta(String)
        case done
        case skip
    }

    /// Runs an SSE request, extracting text deltas with the given parser.
    static func run(
        request: URLRequest,
        parser: @escaping (Data) throws -> SSEAction
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw ProviderError.invalidResponse("not an HTTP response")
                    }
                    guard http.statusCode == 200 else {
                        var body = ""
                        for try await byte in bytes {
                            body.append(Character(UnicodeScalar(byte)))
                            if body.count > 4000 { break }
                        }
                        throw ProviderError.http(status: http.statusCode, body: body)
                    }

                    var buffer = ""
                    for try await byte in bytes {
                        guard !Task.isCancelled else { break }
                        let ch = Character(UnicodeScalar(byte))
                        if ch == "\n" {
                            if let action = try handleLine(buffer, parser) {
                                switch action {
                                case .delta(let text):
                                    continuation.yield(text)
                                case .done:
                                    continuation.finish()
                                    return
                                case .skip:
                                    break
                                }
                            }
                            buffer = ""
                        } else if ch != "\r" {
                            buffer.append(ch)
                        }
                    }
                    // Flush any final buffered line.
                    if !buffer.isEmpty, let action = try handleLine(buffer, parser), case .delta(let t) = action {
                        continuation.yield(t)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: ProviderError.cancelled)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private static func handleLine(_ line: String, _ parser: (Data) throws -> SSEAction) throws -> SSEAction? {
        guard line.hasPrefix("data:") else { return .skip }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" || payload.isEmpty && line.hasSuffix("[DONE]") { return .done }
        guard !payload.isEmpty else { return .skip }
        guard let data = payload.data(using: .utf8) else { return .skip }
        return try parser(data)
    }

    static func string(_ dict: Any, _ key: String) -> String? {
        (dict as? [String: Any])?[key] as? String
    }

    static func subdict(_ dict: Any, _ key: String) -> [String: Any]? {
        (dict as? [String: Any])?[key] as? [String: Any]
    }

    static func array(_ dict: Any, _ key: String) -> [Any]? {
        (dict as? [String: Any])?[key] as? [Any]
    }
}
