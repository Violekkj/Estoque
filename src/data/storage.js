// Repositório local: IndexedDB é a fonte principal; localStorage permanece como fallback/migração.
import { getRecord, putRecord, isSupported, deleteRecord, commitSnapshotAndQueue, enqueueSyncOperation } from './indexed-db.js';
const SNAPSHOT_KEY='main';
const UPDATED_SUFFIX='-updated-at';
const SYNC_QUEUE_SUFFIX='-sync-queue';
let writeQueue=Promise.resolve();
const IDB_READ_TIMEOUT_MS = 3500;
const IDB_WRITE_TIMEOUT_MS = 4500;

function withTimeout(promise, milliseconds, label){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(label || 'O armazenamento local demorou demais para responder.')),milliseconds);
    Promise.resolve(promise).then(
      value=>{clearTimeout(timer);resolve(value);},
      error=>{clearTimeout(timer);reject(error);}
    );
  });
}

function readLegacy(key){
  try{const raw=localStorage.getItem(key);return raw==null?null:JSON.parse(raw);}catch(error){return null;}
}
function legacyTimestamp(key){
  try{return Number(localStorage.getItem(key+UPDATED_SUFFIX))||0;}catch(error){return 0;}
}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}

export function isLocalStorageAvailable(){
  try {
    const key='__estoque_no_bolso_storage_check__';
    localStorage.setItem(key,'ok');
    localStorage.removeItem(key);
    return true;
  } catch(error) { return false; }
}

export async function isIndexedDBAvailable(){
  if(!isSupported())return false;
  try{await withTimeout(getRecord('meta','__healthcheck__'),IDB_READ_TIMEOUT_MS,'O IndexedDB não respondeu a tempo.');return true;}
  catch(error){console.warn('IndexedDB indisponível; usando compatibilidade local.',error);return false;}
}

export async function loadAppState(legacyKey){
  let record=null;
  try{record=await withTimeout(getRecord('snapshots',SNAPSHOT_KEY),IDB_READ_TIMEOUT_MS,'A leitura do IndexedDB excedeu o tempo limite.');}catch(error){console.warn('Falha ao ler snapshot IndexedDB:',error);}
  const legacy=readLegacy(legacyKey);
  const legacyTime=legacyTimestamp(legacyKey);
  const idbTime=record?Number(record.updatedAt)||0:-1;
  if(record&&record.payload&&idbTime>=legacyTime)return{value:clone(record.payload),source:'indexeddb',updatedAt:idbTime};
  if(legacy&&typeof legacy==='object')return{value:legacy,source:'localStorage',updatedAt:legacyTime};
  if(record&&record.payload)return{value:clone(record.payload),source:'indexeddb',updatedAt:idbTime};
  return null;
}

function mergeQueueItems(existing, incoming){
  const map=new Map();
  (Array.isArray(existing)?existing:[]).forEach(item=>{if(item&&item.id)map.set(String(item.id),item);});
  (Array.isArray(incoming)?incoming:[]).forEach(item=>{if(item&&item.id)map.set(String(item.id),item);});
  return Array.from(map.values());
}

// Recupera operações que ficaram no fallback local caso uma gravação IndexedDB
// tenha falhado. IDs estáveis tornam a reimportação segura para repetição.
export async function restoreFallbackSyncQueue(legacyKey){
  const queueKey=legacyKey+SYNC_QUEUE_SUFFIX;
  const pending=readLegacy(queueKey);
  if(!Array.isArray(pending)||pending.length===0)return{restored:0,ok:true};
  let restored=0;
  try{
    for(const operation of pending){
      if(!operation||!operation.id)continue;
      await enqueueSyncOperation(operation);
      restored+=1;
    }
    localStorage.removeItem(queueKey);
    return{restored,ok:true};
  }catch(error){
    console.warn('Não foi possível recuperar toda a fila local de sincronização:',error);
    return{restored,ok:false,error};
  }
}

export function saveAppState(legacyKey,state,queueOperations=[]){
  const snapshot=clone(state);
  const updatedAt=Date.now();
  let localStorageOk=false;
  const queueKey=legacyKey+SYNC_QUEUE_SUFFIX;
  const fallbackQueue=mergeQueueItems(readLegacy(queueKey),queueOperations);
  try{
    localStorage.setItem(legacyKey,JSON.stringify(snapshot));
    localStorage.setItem(legacyKey+UPDATED_SUFFIX,String(updatedAt));
    // Fallback durável: se o IndexedDB falhar, as operações não se perdem junto
    // com o snapshot e podem ser reimportadas na próxima abertura.
    if(fallbackQueue.length)localStorage.setItem(queueKey,JSON.stringify(fallbackQueue));
    localStorageOk=true;
  }catch(error){console.warn('Falha na cópia local de compatibilidade:',error);}
  const record={key:SNAPSHOT_KEY,payload:snapshot,updatedAt,schemaVersion:2};
  const write=writeQueue.then(()=>withTimeout(
    commitSnapshotAndQueue(record,fallbackQueue),
    IDB_WRITE_TIMEOUT_MS,
    'A gravação do estoque e da fila excedeu o tempo limite.'
  ));
  writeQueue=write.catch(()=>{});
  return write.then(()=>{
    try{localStorage.removeItem(queueKey);}catch(error){}
    return{ok:true,indexedDBOk:true,localStorageOk,queuePersisted:true};
  }).catch(error=>{
    console.warn('Falha ao gravar no IndexedDB:',error);
    return{ok:localStorageOk,indexedDBOk:false,localStorageOk,queuePersisted:false};
  });
}

export async function loadDraft(key){
  let record=null;
  try{record=await withTimeout(getRecord('drafts',key),IDB_READ_TIMEOUT_MS,'A leitura do rascunho excedeu o tempo limite.');}catch(error){}
  const legacy=readLegacy(key);
  const legacyTime=legacyTimestamp(key);
  const idbTime=record?Number(record.updatedAt)||0:-1;
  if(record&&record.payload&&idbTime>=legacyTime)return clone(record.payload);
  if(legacy!=null)return legacy;
  return record&&record.payload?clone(record.payload):null;
}

export function saveDraft(key,value){
  const snapshot=clone(value);
  const updatedAt=Date.now();
  try{
    if(snapshot==null){localStorage.removeItem(key);localStorage.removeItem(key+UPDATED_SUFFIX);}
    else{localStorage.setItem(key,JSON.stringify(snapshot));localStorage.setItem(key+UPDATED_SUFFIX,String(updatedAt));}
  }catch(error){console.warn('Falha ao salvar rascunho no localStorage:',error);}
  const task=snapshot==null?withTimeout(deleteRecord('drafts',key),IDB_WRITE_TIMEOUT_MS,'A exclusão do rascunho excedeu o tempo limite.'):withTimeout(putRecord('drafts',{key,payload:snapshot,updatedAt}),IDB_WRITE_TIMEOUT_MS,'A gravação do rascunho excedeu o tempo limite.');
  return task.catch(error=>{console.warn('Falha ao salvar rascunho no IndexedDB:',error);});
}
