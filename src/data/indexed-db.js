// Banco local do Estoque no Bolso. A fila e o snapshot são gravados na mesma
// transação para que uma alteração nunca seja salva sem sua operação pendente.
const DB_NAME = 'estoque-no-bolso-db';
const DB_VERSION = 2;
const STORES = Object.freeze({
  snapshots: 'snapshots',
  drafts: 'drafts',
  outbox: 'outbox', // mantida para compatibilidade com a estrutura anterior
  sync_queue: 'sync_queue',
  meta: 'meta'
});
let databasePromise;

export function isSupported() {
  return typeof window !== 'undefined' && 'indexedDB' in window && !!window.indexedDB;
}

export function openDatabase() {
  if (!isSupported()) return Promise.reject(new Error('IndexedDB não está disponível neste navegador.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      Object.values(STORES).forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === 'outbox' || name === 'sync_queue' ? 'id' : 'key' });
        }
      });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = null; };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('Não foi possível abrir o banco local.'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Feche outras abas do aplicativo para atualizar o banco local.'));
    };
  });
  return databasePromise;
}

export async function getRecord(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    let value = null;
    request.onsuccess = () => { value = request.result || null; };
    request.onerror = () => reject(request.error || new Error('Falha ao ler o banco local.'));
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('Falha na leitura do banco local.'));
    tx.onabort = () => reject(tx.error || new Error('Leitura do banco local cancelada.'));
  });
}

export async function putRecord(storeName, record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Falha ao gravar no banco local.'));
    tx.onabort = () => reject(tx.error || new Error('Gravação no banco local cancelada.'));
  });
}

export async function deleteRecord(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Falha ao excluir registro local.'));
    tx.onabort = () => reject(tx.error || new Error('Exclusão local cancelada.'));
  });
}

export async function listRecords(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    let values = [];
    request.onsuccess = () => { values = request.result || []; };
    request.onerror = () => reject(request.error || new Error('Falha ao listar registros locais.'));
    tx.oncomplete = () => resolve(values);
    tx.onerror = () => reject(tx.error || new Error('Falha na leitura do banco local.'));
    tx.onabort = () => reject(tx.error || new Error('Leitura do banco local cancelada.'));
  });
}

export async function commitSnapshotAndQueue(snapshotRecord, operations = []) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['snapshots', 'sync_queue'], 'readwrite');
    tx.objectStore('snapshots').put(snapshotRecord);
    const queue = tx.objectStore('sync_queue');
    operations.forEach((operation) => queue.put(operation));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Falha ao salvar o estoque e a fila de sincronização.'));
    tx.onabort = () => reject(tx.error || new Error('A gravação do estoque e da fila foi cancelada.'));
  });
}

export async function enqueueSyncOperation(operation) {
  if (!operation || !operation.id) throw new Error('A operação precisa de um UUID.');
  return putRecord(STORES.sync_queue, operation);
}
export function listSyncQueue() { return listRecords(STORES.sync_queue); }
export function updateSyncOperation(operation) { return putRecord(STORES.sync_queue, operation); }
export function removeSyncOperation(id) { return deleteRecord(STORES.sync_queue, id); }
export async function clearSyncQueueForStore(storeId) {
  const items = await listSyncQueue();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sync_queue, 'readwrite');
    const store = tx.objectStore(STORES.sync_queue);
    items.filter((item) => item.storeId === storeId).forEach((item) => store.delete(item.id));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Falha ao limpar a fila.'));
    tx.onabort = () => reject(tx.error || new Error('Limpeza da fila cancelada.'));
  });
}

// Contrato legado da outbox preservado para que snapshots antigos continuem legíveis.
export function enqueueOutbox(operation) {
  const id = operation && operation.id ? String(operation.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return putRecord(STORES.outbox, { ...operation, id, queuedAt: Date.now(), status: 'pending' });
}
export function listOutbox() { return listRecords(STORES.outbox); }
export function removeOutbox(id) { return deleteRecord(STORES.outbox, id); }
export function getMeta(key) { return getRecord(STORES.meta, key); }
export function setMeta(key, value) { return putRecord(STORES.meta, { key, value, updatedAt: Date.now() }); }
export const STORE_NAMES = STORES;
