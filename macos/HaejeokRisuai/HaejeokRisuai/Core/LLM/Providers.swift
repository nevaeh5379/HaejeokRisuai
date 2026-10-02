import Foundation

/// OpenAI-compatible /chat/completions streaming.
/// Also covers OpenRouter, DeepInfra, Mistral, Ollama and custom proxies.
struct OpenAICompatibleProvider: LLMProvider {
    func stream(messages: [PromptMessage], config: GenerationConfig) -> AsyncThrowingStream<String, Error> {
        guard !config.model.isEmpty else {
            return failing(ProviderError.missingModel)
        }
        guard let url = URL(string: "\(config.baseURL)/chat/completions") else {
            return failing(ProviderError.invalidResponse("invalid base URL '\(config.baseURL)'"))
        }

        var body: [String: Any] = [
            "model": config.model,
            "messages": messages.map { ["role": $0.role, "content": $0.content] },
            "max_tokens": config.maxTokens,
            "stream": true,
        ]
        if config.temperature > 0 { body["temperature"] = config.temperature }
        if let fp = config.frequencyPenalty, fp != 0 { body["frequency_penalty"] = fp / 100.0 }
        if let pp = config.presencePenalty, pp != 0 { body["presence_penalty"] = pp / 100.0 }
        if let tp = config.topP, tp < 1.0 { body["top_p"] = tp }
        if let seed = config.seed, seed >= 0 { body["seed"] = seed }

        // Reasoning models: use max_completion_tokens instead of max_tokens.
        let reasoningModel = config.model.contains("o1") || config.model.contains("o3")
            || config.model.contains("gpt-5") || config.model.contains("reasoning")
        if reasoningModel {
            body["max_completion_tokens"] = config.maxTokens
            body.removeValue(forKey: "max_tokens")
            if config.thinkingType != "off" {
                body["reasoning_effort"] = config.reasoningEffort >= 2 ? "high" : (config.reasoningEffort >= 1 ? "medium" : "low")
            }
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            return failing(ProviderError.invalidResponse("failed to encode request body"))
        }
        var request = SSE.makeRequest(url: url, apiKey: config.apiKey)
        request.httpBody = jsonData

        return SSE.run(request: request) { data in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .skip
            }
            if let error = obj["error"] as? [String: Any],
               let message = error["message"] as? String {
                throw ProviderError.http(status: 500, body: message)
            }
            guard let choices = obj["choices"] as? [[String: Any]] else { return .skip }
            let delta = choices.first?["delta"] as? [String: Any]
            if let content = delta?["content"] as? String, !content.isEmpty {
                return .delta(content)
            }
            return .skip
        }
    }
}

/// Anthropic Messages API streaming (/v1/messages).
struct AnthropicProvider: LLMProvider {
    static let apiVersion = "2023-06-01"

    func stream(messages: [PromptMessage], config: GenerationConfig) -> AsyncThrowingStream<String, Error> {
        guard !config.apiKey.isEmpty else {
            return failing(ProviderError.missingAPIKey("Claude"))
        }
        guard !config.model.isEmpty else {
            return failing(ProviderError.missingModel)
        }

        // Split system messages out of the turn list.
        var systemParts: [String] = []
        var turns: [[String: Any]] = []
        for m in messages {
            if m.role == "system" {
                systemParts.append(m.content)
            } else {
                turns.append(["role": m.role == "assistant" ? "assistant" : "user", "content": m.content])
            }
        }
        // Claude requires alternating roles starting with user; merge adjacent same-role turns.
        var merged: [[String: Any]] = []
        for turn in turns {
            if let lastRole = merged.last?["role"] as? String, lastRole == turn["role"] as? String {
                let lastContent = merged[merged.count - 1]["content"] as? String ?? ""
                merged[merged.count - 1]["content"] = lastContent + "\n\n\(turn["content"] ?? "")"
            } else {
                merged.append(turn)
            }
        }
        if merged.isEmpty {
            merged.append(["role": "user", "content": "(Start)"])
        }

        var body: [String: Any] = [
            "model": config.model,
            "messages": merged,
            "max_tokens": min(config.maxTokens, 64000),
            "stream": true,
        ]
        if !systemParts.isEmpty {
            body["system"] = systemParts.joined(separator: "\n\n")
        }
        body["temperature"] = min(max(config.temperature, 0), 1)
        if let tp = config.topP, tp < 1.0 { body["top_p"] = tp }
        if let tk = config.topK, tk > 0 { body["top_k"] = tk }

        guard let url = URL(string: "https://api.anthropic.com/v1/messages"),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            return failing(ProviderError.invalidResponse("bad url"))
        }
        var request = SSE.makeRequest(
            url: url,
            apiKey: nil,
            extraHeaders: [
                "x-api-key": config.apiKey,
                "anthropic-version": Self.apiVersion,
                "accept": "text/event-stream",
            ]
        )
        request.httpBody = jsonData

        return SSE.run(request: request) { data in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .skip
            }
            switch obj["type"] as? String {
            case "content_block_delta":
                if let delta = obj["delta"] as? [String: Any],
                   let text = delta["text"] as? String, !text.isEmpty {
                    return .delta(text)
                }
                return .skip
            case "message_stop":
                return .done
            case "error":
                let err = obj["error"] as? [String: Any]
                throw ProviderError.http(status: 500, body: err?["message"] as? String ?? "unknown claude error")
            default:
                return .skip
            }
        }
    }
}

/// Google Gemini streamGenerateContent with SSE.
struct GeminiProvider: LLMProvider {
    func stream(messages: [PromptMessage], config: GenerationConfig) -> AsyncThrowingStream<String, Error> {
        guard !config.apiKey.isEmpty else {
            return failing(ProviderError.missingAPIKey("Google Gemini"))
        }
        guard !config.model.isEmpty else {
            return failing(ProviderError.missingModel)
        }

        var systemParts: [String] = []
        var contents: [[String: Any]] = []
        for m in messages {
            if m.role == "system" {
                systemParts.append(m.content)
            } else {
                contents.append([
                    "role": m.role == "assistant" ? "model" : "user",
                    "parts": [["text": m.content]],
                ])
            }
        }

        var generationConfig: [String: Any] = [
            "temperature": config.temperature,
            "maxOutputTokens": config.maxTokens,
        ]
        if let tp = config.topP, tp < 1.0 { generationConfig["topP"] = tp }
        if let tk = config.topK, tk > 0 { generationConfig["topK"] = tk }

        var body: [String: Any] = [
            "contents": contents,
            "generationConfig": generationConfig,
        ]
        if !systemParts.isEmpty {
            body["systemInstruction"] = ["parts": [["text": systemParts.joined(separator: "\n\n")]]]
        }

        let encoded = config.model.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? config.model
        guard let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(encoded):streamGenerateContent?alt=sse&key=\(config.apiKey)"),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            return failing(ProviderError.invalidResponse("bad url"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = jsonData

        return SSE.run(request: request) { data in
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .skip
            }
            if let error = obj["error"] as? [String: Any],
               let message = error["message"] as? String {
                throw ProviderError.http(status: 500, body: message)
            }
            guard let candidates = obj["candidates"] as? [[String: Any]], let first = candidates.first else {
                return .skip
            }
            if let content = first["content"] as? [String: Any],
               let parts = content["parts"] as? [[String: Any]] {
                let text = parts.compactMap { $0["text"] as? String }.joined()
                if !text.isEmpty { return .delta(text) }
            }
            return .skip
        }
    }
}

// MARK: - Factory & helpers

enum LLMProviderFactory {
    @MainActor
    static func provider(for kind: ProviderKind) -> LLMProvider {
        switch kind {
        case .claude: return AnthropicProvider()
        case .google: return GeminiProvider()
        default: return OpenAICompatibleProvider()
        }
    }

    @MainActor
    static func makeConfig(db: DatabaseStore) throws -> GenerationConfig {
        let settings = db.settings
        let kind = settings.apiType
        let key = settings.apiKey(for: kind)
        let model = settings.model(for: kind)
        var base = settings.baseURL(for: kind)
        if base.isEmpty { base = "https://api.openai.com/v1" }

        if kind != .ollama && kind.usesOpenAIProtocol && kind != .customProxy && key.isEmpty {
            throw ProviderError.missingAPIKey(kind.displayName)
        }
        if model.isEmpty {
            throw ProviderError.missingModel
        }

        var cfg = GenerationConfig(providerKind: kind, model: model, apiKey: key, baseURL: base)
        cfg.temperature = settings.temperature
        cfg.maxTokens = settings.maxResponse
        cfg.maxContext = settings.maxContext
        cfg.frequencyPenalty = settings.frequencyPenalty
        cfg.presencePenalty = settings.presencePenalty
        cfg.topP = settings.topP
        cfg.topK = settings.topK
        cfg.seed = settings.generationSeed
        cfg.reasoningEffort = settings.reasoningEffort
        cfg.thinkingType = settings.thinkingType
        return cfg
    }
}

private func failing(_ error: Error) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
        continuation.finish(throwing: error)
    }
}
