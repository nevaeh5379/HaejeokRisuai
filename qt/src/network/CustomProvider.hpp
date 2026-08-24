#pragma once

#include "OpenAIProvider.hpp"

namespace Risu {

class CustomProvider : public OpenAIProvider {
    Q_OBJECT

public:
    explicit CustomProvider(QObject* parent = nullptr) : OpenAIProvider(parent) {}
};

} // namespace Risu
