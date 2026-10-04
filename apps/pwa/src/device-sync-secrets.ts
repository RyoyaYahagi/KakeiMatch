// This device's sync credential and household key. Kept in their own IndexedDB database so
// `.kmb` backups, sync versions and household wipes of the household stores never include them.
// The key is a non-extractable CryptoKey: it can be used here but not read back out as bytes.

const DATABASE = 'kakeimatch-device-sync';
const STORE = 'secrets';
const RECORD = 'device';

export type DeviceSyncSecrets = {
  householdId: string;
  generation: number;
  deviceId: string;
  credential: string;
  /** Null after joining until the recovery code has been entered. */
  key: CryptoKey | null;
};

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function run<T>(factory: IDBFactory, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally { database.close(); }
}

export class DeviceSyncSecretStore {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async load(): Promise<DeviceSyncSecrets | null> {
    return (await run<DeviceSyncSecrets | undefined>(this.factory, 'readonly', store => store.get(RECORD))) ?? null;
  }

  async save(secrets: DeviceSyncSecrets): Promise<void> {
    if (secrets.key && secrets.key.extractable) throw new Error('Household keys must be non-extractable.');
    await run(this.factory, 'readwrite', store => store.put(secrets, RECORD));
  }

  async clear(): Promise<void> {
    await run(this.factory, 'readwrite', store => store.delete(RECORD));
  }
}
