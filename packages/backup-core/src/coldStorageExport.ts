export interface ColdStorageBackupCollection<TPayload> {
  payloads: TPayload[];
  missingKeys: string[];
  invalidKeys: string[];
}

export interface PrepareColdStorageBackupOptions<TDatabase, TPayload> {
  database: TDatabase;
  collect(
    onProgress: (current: number, total: number, key?: string) => void,
  ): Promise<ColdStorageBackupCollection<TPayload>>;
  confirm(
    database: TDatabase,
    unavailableKeys: readonly string[],
  ): Promise<boolean>;
  onProgress?(current: number, total: number): void;
  yieldControl?(): Promise<void>;
}

export interface WriteColdStorageBackupOptions<TPayload> {
  payloads: readonly TPayload[];
  name(payload: TPayload): string;
  encode(payload: TPayload): Uint8Array;
  write(name: string, data: Uint8Array): Promise<void>;
  onProgress?(current: number, total: number): Promise<void> | void;
  yieldControl?(): Promise<void>;
}

export async function prepareColdStorageBackup<TDatabase, TPayload>(
  options: PrepareColdStorageBackupOptions<TDatabase, TPayload>,
): Promise<ColdStorageBackupCollection<TPayload> | null> {
  options.onProgress?.(0, 0);
  await options.yieldControl?.();
  const collection: ColdStorageBackupCollection<TPayload> =
    await options.collect((current: number, total: number): void => {
      options.onProgress?.(current, total);
    });
  const unavailableKeys: string[] = [
    ...collection.missingKeys,
    ...collection.invalidKeys,
  ];
  const confirmed: boolean = await options.confirm(
    options.database,
    unavailableKeys,
  );
  return confirmed ? collection : null;
}

export async function writeColdStorageBackup<TPayload>(
  options: WriteColdStorageBackupOptions<TPayload>,
): Promise<void> {
  const total: number = options.payloads.length;
  for (let index: number = 0; index < total; index += 1) {
    const payload: TPayload = options.payloads[index];
    await options.onProgress?.(index + 1, total);
    await options.yieldControl?.();
    await options.write(options.name(payload), options.encode(payload));
  }
}
