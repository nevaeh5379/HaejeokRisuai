import {
  executeProviderRoute,
  type ProviderExecutor,
  type ProviderHandlers,
} from "@risuai/chat-core/providerExecutor.cjs";
import type { ChatModelResponse } from "@risuai/chat-core/types.cjs";

export class BrowserProviderExecutor<TRequest>
  implements ProviderExecutor<TRequest>
{
  constructor(
    private readonly handlers: ProviderHandlers<TRequest>,
    private readonly unknownModelMessage: () => string,
  ) {}

  execute(format: number, request: TRequest): Promise<ChatModelResponse> {
    return executeProviderRoute(format, request, this.handlers, {
      unknownModelMessage: this.unknownModelMessage(),
    });
  }
}
