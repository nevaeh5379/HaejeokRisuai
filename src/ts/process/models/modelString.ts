import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

export function getGenerationModelString(name?: string) {
  const db = settingsStore.state;
  switch (name ?? presetStore.state.aiModel) {
    case "reverse_proxy":
      return (
        "custom-" +
        (db.reverseProxyOobaMode
          ? "ooba"
          : presetStore.state.customProxyRequestModel)
      );
    case "openrouter":
      return "openrouter-" + presetStore.state.openrouterRequestModel;
    case "nanogpt": {
      const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel;
      return (
        "NanoGPT " +
        modelLabel +
        (db.nanogptUseSubscriptionEndpoint ? " [SUB]" : "")
      );
    }
    case "ollama-hosted":
    case "ollama-cloud": {
      const modelLabel =
        name === "ollama-cloud"
          ? db.ollamaCloudModelName || db.ollamaCloudModel
          : db.ollamaModelName || db.ollamaModel;
      return `Ollama ${name === "ollama-cloud" ? "Cloud" : "Local"} ${modelLabel}`;
    }
    default:
      return name ?? presetStore.state.aiModel;
  }
}
