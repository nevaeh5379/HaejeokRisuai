// Cache the in-flight import as well as the resolved module. Failed imports are
// retried by later requests, while concurrent callers receive the same failure.
export function lazyModule<T>(loader: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= loader().catch((error) => {
      pending = undefined;
      throw error;
    }));
}

export const loadPostgres = lazyModule(() =>
  import("pg").then((m) => m.default),
);
export const loadOracle = lazyModule(() =>
  import("oracledb").then((m) => m.default),
);
export const loadMssql = lazyModule(() =>
  import("mssql").then((m) => m.default),
);
export const loadTokenizer = lazyModule(() => import("@dqbd/tiktoken"));
export const loadSharp = lazyModule(() =>
  import("sharp").then((m) => m.default),
);
export const loadOpenid = lazyModule(() => import("openid-client"));
export const loadS3 = lazyModule(async () => {
  const [client, storage, http] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/lib-storage"),
    import("@smithy/node-http-handler"),
  ]);
  return {
    ...client,
    Upload: storage.Upload,
    NodeHttpHandler: http.NodeHttpHandler,
  };
});
