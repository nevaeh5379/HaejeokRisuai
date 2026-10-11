import Foundation

/// Curated model suggestions per provider, plus dynamic list fetching where supported.
enum ModelCatalog {
    struct ModelInfo: Identifiable, Hashable {
        var id: String { modelId }
        var modelId: String
        var displayName: String

        init(_ modelId: String, _ displayName: String? = nil) {
            self.modelId = modelId
            self.displayName = displayName ?? modelId
        }
    }

    static func suggestions(for kind: ProviderKind) -> [ModelInfo] {
        switch kind {
        case .openAI:
            return [
                ModelInfo("gpt-4o", "GPT-4o"),
                ModelInfo("gpt-4o-mini", "GPT-4o mini"),
                ModelInfo("gpt-4.1", "GPT-4.1"),
                ModelInfo("gpt-4.1-mini", "GPT-4.1 mini"),
                ModelInfo("gpt-4.1-nano", "GPT-4.1 nano"),
                ModelInfo("o3-mini", "o3-mini"),
                ModelInfo("o1", "o1"),
                ModelInfo("o1-mini", "o1 mini"),
            ]
        case .claude:
            return [
                ModelInfo("claude-sonnet-4-5", "Claude Sonnet 4.5"),
                ModelInfo("claude-opus-4-1", "Claude Opus 4.1"),
                ModelInfo("claude-opus-4", "Claude Opus 4"),
                ModelInfo("claude-sonnet-4", "Claude Sonnet 4"),
                ModelInfo("claude-3-7-sonnet-latest", "Claude 3.7 Sonnet"),
                ModelInfo("claude-3-5-haiku-latest", "Claude 3.5 Haiku"),
            ]
        case .google:
            return [
                ModelInfo("gemini-2.5-flash", "Gemini 2.5 Flash"),
                ModelInfo("gemini-2.5-pro", "Gemini 2.5 Pro"),
                ModelInfo("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"),
                ModelInfo("gemini-2.0-flash", "Gemini 2.0 Flash"),
            ]
        case .openRouter:
            return [
                ModelInfo("openrouter/auto", "Auto Router"),
                ModelInfo("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"),
                ModelInfo("openai/gpt-4o", "GPT-4o"),
                ModelInfo("google/gemini-2.5-flash-preview", "Gemini 2.5 Flash"),
                ModelInfo("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B"),
                ModelInfo("deepseek/deepseek-chat", "DeepSeek V3"),
                ModelInfo("mistralai/mistral-large", "Mistral Large"),
            ]
        case .mistral:
            return [
                ModelInfo("mistral-large-latest", "Mistral Large"),
                ModelInfo("mistral-small-latest", "Mistral Small"),
                ModelInfo("codestral-latest", "Codestral"),
                ModelInfo("open-mistral-nemo", "Mistral Nemo"),
            ]
        case .deepInfra:
            return [
                ModelInfo("meta-llama/Llama-3.3-70B-Instruct", "Llama 3.3 70B"),
                ModelInfo("meta-llama/Meta-Llama-3.1-405B-Instruct", "Llama 3.1 405B"),
                ModelInfo("deepseek-ai/DeepSeek-V3", "DeepSeek V3"),
                ModelInfo("Qwen/Qwen2.5-72B-Instruct", "Qwen 2.5 72B"),
            ]
        case .ollama:
            return [
                ModelInfo("llama3.2", "Llama 3.2"),
                ModelInfo("qwen2.5", "Qwen 2.5"),
                ModelInfo("mistral", "Mistral"),
                ModelInfo("gemma2", "Gemma 2"),
                ModelInfo("deepseek-r1", "DeepSeek R1"),
            ]
        case .customProxy:
            return []
        }
    }

    /// Fetches the /models list from an OpenAI-compatible endpoint.
    @MainActor
    static func fetchModels(kind: ProviderKind) async throws -> [String] {
        let db = DatabaseStore.shared
        let base = db.settings.baseURL(for: kind)
        let key = db.settings.apiKey(for: kind)
        let urlBase: String
        switch kind {
        case .ollama:
            urlBase = db.settings.ollama.url.hasSuffix("/")
                ? String(db.settings.ollama.url.dropLast()) : db.settings.ollama.url
        default:
            guard !base.isEmpty else { throw ProviderError.invalidResponse("no URL") }
            urlBase = base
        }
        guard let url = URL(string: "\(urlBase)/models") else {
            throw ProviderError.invalidResponse("bad url")
        }
        var request = SSE.makeRequest(url: url, method: "GET", apiKey: key.isEmpty ? nil : key)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ProviderError.http(status: (response as? HTTPURLResponse)?.statusCode ?? -1, body: "")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = obj["data"] as? [[String: Any]] else {
            return []
        }
        return models.compactMap { $0["id"] as? String }.sorted()
    }
}
