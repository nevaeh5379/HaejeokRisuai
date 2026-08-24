#include "AIProvider.hpp"
#include "OpenAIProvider.hpp"
#include "ClaudeProvider.hpp"
#include "GeminiProvider.hpp"
#include "OpenRouterProvider.hpp"
#include "OllamaProvider.hpp"
#include "CustomProvider.hpp"

namespace Risu {

std::unique_ptr<AIProvider> AIProvider::create(ProviderType type, QObject* parent) {
    switch (type) {
        case ProviderType::OpenAI:
            return std::make_unique<OpenAIProvider>(parent);
        case ProviderType::AnthropicClaude:
            return std::make_unique<ClaudeProvider>(parent);
        case ProviderType::GoogleGemini:
            return std::make_unique<GeminiProvider>(parent);
        case ProviderType::OpenRouter:
            return std::make_unique<OpenRouterProvider>(parent);
        case ProviderType::Ollama:
            return std::make_unique<OllamaProvider>(parent);
        case ProviderType::CustomOpenAICompatible:
            return std::make_unique<CustomProvider>(parent);
    }
    return std::make_unique<OpenAIProvider>(parent);
}

} // namespace Risu
