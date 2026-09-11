const KEYPAIR_DB_NAME = "DPoPDB";
const KEYPAIR_DB_VERSION = 2;
const KEYPAIR_STORE_NAME = "Keypairs";
const LEGACY_KEYPAIR_STORE_NAME = "DPoPStore";

function keypairNamespace(name: string): string {
  return name || LEGACY_KEYPAIR_STORE_NAME;
}

export function openKeypairStoreDB(_name = ""): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYPAIR_DB_NAME, KEYPAIR_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction;
      const target = db.objectStoreNames.contains(KEYPAIR_STORE_NAME)
        ? transaction?.objectStore(KEYPAIR_STORE_NAME)
        : db.createObjectStore(KEYPAIR_STORE_NAME);
      if (!target || !transaction) return;

      // v1 created one object store per server origin. Copy those records into
      // the stable v2 store so adding another remote server never requires a
      // database schema upgrade.
      for (const storeName of Array.from(db.objectStoreNames)) {
        if (storeName === KEYPAIR_STORE_NAME) continue;
        let source: IDBObjectStore;
        try {
          source = transaction.objectStore(storeName);
        } catch {
          continue;
        }
        const legacyRequest = source.get("dpop");
        legacyRequest.onsuccess = () => {
          if (legacyRequest.result) target.put(legacyRequest.result, storeName);
        };
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveKeypairStore(name: string, keyPair: CryptoKeyPair) {
  const db = await openKeypairStoreDB(name);
  return await new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(KEYPAIR_STORE_NAME, "readwrite");
    const store = tx.objectStore(KEYPAIR_STORE_NAME);
    store.put(
      { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey },
      keypairNamespace(name),
    );
    tx.oncomplete = () => {
      db.close();
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Key-pair storage transaction aborted"));
    };
  });
}

export async function getKeypairStore(
  name: string,
): Promise<CryptoKeyPair | null> {
  const db = await openKeypairStoreDB(name);
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(KEYPAIR_STORE_NAME, "readonly");
    const store = tx.objectStore(KEYPAIR_STORE_NAME);
    const request = store.get(keypairNamespace(name));
    let result: CryptoKeyPair | null = null;

    request.onsuccess = () => {
      const value = request.result;
      result = value
        ? ({
            privateKey: value.privateKey,
            publicKey: value.publicKey,
          } as CryptoKeyPair)
        : null;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Key-pair storage transaction aborted"));
    };
  });
}
