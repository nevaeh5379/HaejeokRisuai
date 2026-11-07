/// <reference types="svelte" />
/// <reference types="vite/client" />

declare let Buffer: BufferConstructor;
declare let safeStructuredClone: <T>(data: T) => T;
declare let userScriptFetch: (
  url: string,
  arg: RequestInit,
) => Promise<Response>;
