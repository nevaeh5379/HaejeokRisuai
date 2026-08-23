import type { MessageRangeOptions } from "./types";

/**
 * Global open/close state for the Log Exporter modal.
 * Entry points (chat toolbar, per-message buttons) flip this store.
 */
class LogExporterStore {
  isOpen = $state(false);
  options = $state<MessageRangeOptions>({});

  open(options: MessageRangeOptions = {}): void {
    this.options = options;
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
    this.options = {};
  }
}

export const logExporterStore = new LogExporterStore();
