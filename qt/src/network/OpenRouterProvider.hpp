#pragma once

#include "OpenAIProvider.hpp"

namespace Risu {

class OpenRouterProvider : public OpenAIProvider {
    Q_OBJECT

public:
    explicit OpenRouterProvider(QObject* parent = nullptr) : OpenAIProvider(parent) {}
};

} // namespace Risu
