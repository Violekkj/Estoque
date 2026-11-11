// Repositório local: IndexedDB é a fonte principal; localStorage permanece como fallback/migração.
import { getRecord, putRecord, isSupported, deleteRecord } from './indexed-db.js';
const SNAPSHOT_KEY='main';
const UPDATED_SUFFIX='-updated-at';
let writeQueue=Promise.resolve();

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
  try{await getRecord('meta','__healthcheck__');return true;}
  catch(error){console.warn('IndexedDB indisponível; usando compatibilidade local.',error);return false;}
}

export async function loadAppState(legacyKey){
  let record=null;
  try{record=await getRecord('snapshots',SNAPSHOT_KEY);}catch(error){console.warn('Falha ao ler snapshot IndexedDB:',error);}
  const legacy=readLegacy(legacyKey);
  const legacyTime=legacyTimestamp(legacyKey);
  const idbTime=record?Number(record.updatedAt)||0:-1;
  if(record&&record.payload&&idbTime>=legacyTime)return{value:clone(record.payload),source:'indexeddb',updatedAt:idbTime};
  if(legacy&&typeof legacy==='object')return{value:legacy,source:'localStorage',updatedAt:legacyTime};
  if(record&&record.payload)return{value:clone(record.payload),source:'indexeddb',updatedAt:idbTime};
  return null;
}

export function saveAppState(legacyKey,state){
  const snapshot=clone(state);
  const updatedAt=Date.now();
  let localStorageOk=false;
  try{
    localStorage.setItem(legacyKey,JSON.stringify(snapshot));
    localStorage.setItem(legacyKey+UPDATED_SUFFIX,String(updatedAt));
    localStorageOk=true;
  }catch(error){console.warn('Falha na cópia local de compatibilidade:',error);}
  const write=writeQueue.then(()=>putRecord('snapshots',{key:SNAPSHOT_KEY,payload:snapshot,updatedAt,schemaVersion:1}));
  writeQueue=write.catch(()=>{});
  return write.then(()=>({ok:true,indexedDBOk:true,localStorageOk})).catch(error=>{
    console.warn('Falha ao gravar em IndexedDB:',error);
    return{ok:localStorageOk,indexedDBOk:false,localStorageOk};
  });
}

export async function loadDraft(key){
  let record=null;
  try{record=await getRecord('drafts',key);}catch(error){}
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
  const task=snapshot==null?deleteRecord('drafts',key):putRecord('drafts',{key,payload:snapshot,updatedAt});
  return task.catch(error=>{console.warn('Falha ao salvar rascunho no IndexedDB:',error);});
}
