export interface InitializableStore<TInitArgs extends unknown[]> {
  init(...args: TInitArgs): void | Promise<void>;
}

export interface FlushableStore {
  flush(): Promise<void>;
  hasPendingWrites(): boolean;
}
