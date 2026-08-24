#pragma once

#include <QObject>
#include <QString>
#include <memory>
#include "../core/Types.hpp"
#include "../engine/PromptEngine.hpp"

namespace Risu {

class AIProvider : public QObject {
    Q_OBJECT

public:
    explicit AIProvider(QObject* parent = nullptr) : QObject(parent) {}
    virtual ~AIProvider() = default;

    virtual void sendRequest(const CompiledPrompt& prompt, const Preset& preset) = 0;
    virtual void cancel() = 0;
    virtual bool isRunning() const = 0;

    static std::unique_ptr<AIProvider> create(ProviderType type, QObject* parent = nullptr);

signals:
    void chunkReceived(const QString& textChunk, const QString& thoughtChunk);
    void finished(const QString& fullResponse, const QString& thought, int inputTokens, int outputTokens);
    void errorOccurred(const QString& errorMessage);
};

} // namespace Risu
