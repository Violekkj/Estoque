// Camada IndexedDB do Estoque no Bolso.
// Estrutura preparada para snapshots, rascunhos, fila offline e metadados.
const DB_NAME = 'estoque-no-bolso-db';
const DB_VERSION = 1;
const STORES = Object.freeze({ snapshots: 'snapshots', drafts: 'drafts', outbox: 'outbox', meta: 'meta' });
let databasePromise;

export function isSupported(){
  return typeof window !== 'undefined' && 'indexedDB' in window && !!window.indexedDB;
}

export function openDatabase(){
  if (!isSupported()) return Promise.reject(new Error('IndexedDB não está disponível neste navegador.'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve,reject)=>{
    const request=window.indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      Object.values(STORES).forEach(name=>{
        if(!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:name==='outbox'?'id':'key'});
      });
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();databasePromise=null;};
      resolve(db);
    };
    request.onerror=()=>{databasePromise=null;reject(request.error||new Error('Não foi possível abrir o banco local.'));};
    request.onblocked=()=>{databasePromise=null;reject(new Error('Feche outras abas do aplicativo para atualizar o banco local.'));};
  });
  return databasePromise;
}

export async function getRecord(storeName,key){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readonly');
    const request=tx.objectStore(storeName).get(key);
    let value=null;
    request.onsuccess=()=>{value=request.result||null;};
    request.onerror=()=>reject(request.error||new Error('Falha ao ler o banco local.'));
    tx.oncomplete=()=>resolve(value);
    tx.onerror=()=>reject(tx.error||new Error('Falha na leitura do banco local.'));
    tx.onabort=()=>reject(tx.error||new Error('Leitura do banco local cancelada.'));
  });
}

export async function putRecord(storeName,record){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Falha ao gravar no banco local.'));
    tx.onabort=()=>reject(tx.error||new Error('Gravação no banco local cancelada.'));
  });
}

export async function deleteRecord(storeName,key){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Falha ao excluir registro local.'));
    tx.onabort=()=>reject(tx.error||new Error('Exclusão local cancelada.'));
  });
}

export async function listRecords(storeName){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readonly');
    const request=tx.objectStore(storeName).getAll();
    let values=[];
    request.onsuccess=()=>{values=request.result||[];};
    request.onerror=()=>reject(request.error||new Error('Falha ao listar registros locais.'));
    tx.oncomplete=()=>resolve(values);
    tx.onerror=()=>reject(tx.error||new Error('Falha na leitura do banco local.'));
    tx.onabort=()=>reject(tx.error||new Error('Leitura do banco local cancelada.'));
  });
}

// Contrato inicial da futura fila de sincronização; ainda não envia operações à nuvem.
export function enqueueOutbox(operation){
  const id=operation&&operation.id?String(operation.id):`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return putRecord(STORES.outbox,{...operation,id,queuedAt:Date.now(),status:'pending'});
}
export function listOutbox(){return listRecords(STORES.outbox);}
export function removeOutbox(id){return deleteRecord(STORES.outbox,id);}
export function getMeta(key){return getRecord(STORES.meta,key);}
export function setMeta(key,value){return putRecord(STORES.meta,{key,value,updatedAt:Date.now()});}
export const STORE_NAMES=STORES;
