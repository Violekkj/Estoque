// Motor local-first do Estoque no Bolso.
// O IndexedDB guarda o snapshot e a fila na mesma transação; o Supabase é a
// cópia central. Movimentações usam RPC transacional e operation_id idempotente.
import { getSupabaseClient } from './supabase-client.js';
import {
  getMeta, setMeta, listSyncQueue, updateSyncOperation, removeSyncOperation
} from '../data/indexed-db.js';

const PAGE_SIZE = 500;
const ACTIVE_STORE_META = 'sync.active_store_id';
const BOOTSTRAP_PREFIX = 'sync.bootstrap.v1.';
let activeStoreId = null;
let authenticated = false;
let draining = false;
let drainPromise = null;
let callbacks = { onStatus: null, applyRemoteState: null, canApplyRemoteState: null };
let lastStatus = { state: 'local', pending: 0, message: 'Somente neste aparelho' };
let listenersInstalled = false;
let pollTimer = null;
let connectPromise = null;

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')); }
function dateToTimestamp(date) {
  if (!date) return null;
  // Meio-dia local evita que uma data civil recue um dia ao serializar em UTC.
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function isoFromTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function publishStatus(state, pending, message) {
  lastStatus = { state, pending: Number(pending) || 0, message: message || '' };
  if (typeof callbacks.onStatus === 'function') callbacks.onStatus(clone(lastStatus));
}

export function getActiveStoreId() { return activeStoreId; }
export function getSyncStatus() { return clone(lastStatus); }

export function ensureStateOperationIds(state) {
  if (!state || !Array.isArray(state.log)) return state;
  state.log.forEach((entry) => {
    if (entry && !isUuid(entry.operationId)) entry.operationId = uuid();
  });
  return state;
}

function comparableProduct(product) {
  return {
    name: product.name || '', unit: product.unit || 'un', min: Number(product.min) || 0,
    cost: Number(product.cost) || 0, supplier: product.supplier || '', phone: product.phone || '',
    lowSinceDate: product.lowSinceDate || null, lastPurchaseDate: product.lastPurchaseDate || null
  };
}
function sameProductMetadata(a, b) {
  return JSON.stringify(comparableProduct(a)) === JSON.stringify(comparableProduct(b));
}
function makeQueueItem(storeId, type, entityClientId, payload, operationId, order) {
  const stableId = operationId || uuid();
  return {
    id: stableId, operationId: stableId, storeId,
    type, entityClientId: String(entityClientId || ''), payload: clone(payload),
    createdAt: Date.now() + (order || 0), status: 'pending', attempts: 0, lastError: null
  };
}

// Gera a fila a partir da diferença entre snapshots já persistidos. A chamada
// ocorre na mesma transação IndexedDB que grava o novo snapshot.
export function buildSyncOperations(previousState, nextState, storeId) {
  if (!storeId || !nextState || nextState.demo) return [];
  const previous = previousState && !previousState.demo ? previousState : { products: [], log: [] };
  const prevProducts = new Map((previous.products || []).map((p) => [String(p.id), p]));
  const nextProducts = new Map((nextState.products || []).map((p) => [String(p.id), p]));
  const prevEvents = new Map((previous.log || []).map((item) => [String(item.eventId), item]));
  const nextEvents = new Map((nextState.log || []).map((item) => [String(item.eventId), item]));
  const operations = [];
  let order = 0;

  // Produtos são enfileirados antes dos movimentos que dependem deles.
  for (const product of nextProducts.values()) {
    const oldProduct = prevProducts.get(String(product.id));
    if (!oldProduct) {
      operations.push(makeQueueItem(storeId, 'CREATE_PRODUCT', product.id, { product }, uuid(), order++));
    } else if (!sameProductMetadata(oldProduct, product)) {
      operations.push(makeQueueItem(storeId, 'UPDATE_PRODUCT', product.id, { product }, uuid(), order++));
    }
  }

  // Novas movimentações e eventos de alerta.
  for (const event of nextEvents.values()) {
    if (prevEvents.has(String(event.eventId))) continue;
    const productStillExists = nextProducts.has(String(event.id));
    if (!productStillExists) continue;
    const operationId = isUuid(event.operationId) ? event.operationId : uuid();
    event.operationId = operationId;
    if (event.event === 'movement') {
      operations.push(makeQueueItem(storeId, 'STOCK_MOVEMENT', event.eventId, { event }, operationId, order++));
    } else if (event.event === 'low' || event.event === 'normal') {
      operations.push(makeQueueItem(storeId, 'STATUS_EVENT', event.eventId, { event }, operationId, order++));
    }
  }

  // Movimentação removida no cliente vira estorno no servidor. Evento de alerta
  // removido recebe soft-delete. Não são gerados estornos dos filhos de produto
  // excluído, pois a exclusão do produto é uma operação única de lixeira.
  const deletedProductIds = new Set([...prevProducts.keys()].filter((id) => !nextProducts.has(id)));
  for (const oldEvent of prevEvents.values()) {
    if (nextEvents.has(String(oldEvent.eventId))) continue;
    if (deletedProductIds.has(String(oldEvent.id))) continue;
    if (oldEvent.event === 'movement') {
      operations.push(makeQueueItem(storeId, 'DELETE', oldEvent.eventId, {
        entityType: 'stock_movement', event: oldEvent
      }, uuid(), order++));
    } else if (oldEvent.event === 'low' || oldEvent.event === 'normal') {
      operations.push(makeQueueItem(storeId, 'DELETE', oldEvent.eventId, {
        entityType: 'status_event', event: oldEvent
      }, uuid(), order++));
    }
  }

  for (const [clientId, oldProduct] of prevProducts.entries()) {
    if (nextProducts.has(clientId)) continue;
    operations.push(makeQueueItem(storeId, 'DELETE', clientId, {
      entityType: 'product', product: oldProduct,
      relatedLog: (previous.log || []).filter((entry) => String(entry.id) === clientId)
    }, uuid(), order++));
  }
  return operations;
}

async function fetchAll(queryFactory) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await queryFactory().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function cloudRows(storeId) {
  const client = await getSupabaseClient();
  const [products, movements, events] = await Promise.all([
    fetchAll(() => client.from('products').select('*').eq('store_id', storeId).is('deleted_at', null).order('created_at', { ascending: true })),
    fetchAll(() => client.from('stock_movements').select('*').eq('store_id', storeId).is('deleted_at', null).order('occurred_at', { ascending: true })),
    fetchAll(() => client.from('audit_logs').select('*').eq('store_id', storeId).is('deleted_at', null).in('action', ['stock_low', 'stock_normal']).order('created_at', { ascending: true }))
  ]);
  return { products, movements, events };
}

function buildLocalStateFromCloud(store, rows) {
  const productByCloudId = new Map(rows.products.map((product) => [product.id, product]));
  const productByClientId = new Map();
  const products = rows.products.map((row) => {
    productByClientId.set(String(row.client_id), row);
    return {
      id: String(row.client_id), name: row.name, unit: row.unit || 'un',
      qty: Number(row.quantity) || 0, min: Number(row.minimum_quantity) || 0,
      cost: Number(row.cost_price) || 0, supplier: row.supplier_name || '', phone: row.supplier_phone || '',
      lowSinceDate: row.low_since_date || isoFromTimestamp(row.low_since_at),
      lastPurchaseDate: row.last_purchase_date || isoFromTimestamp(row.last_purchase_at)
    };
  });
  const productNameByUuid = new Map(rows.products.map((row) => [row.id, { id: String(row.client_id), name: row.name, unit: row.unit || 'un' }]));
  const log = [];

  rows.movements.forEach((row) => {
    const product = productNameByUuid.get(row.product_id);
    if (!product) return;
    const occurredAt = row.occurred_at ? new Date(row.occurred_at).getTime() : Date.now();
    const delta = Number(row.quantity_delta) || 0;
    log.push({
      eventId: String(row.client_id), operationId: row.idempotency_key || null,
      sourceMovementId: null,
      event: 'movement', t: occurredAt, date: row.occurred_on || isoFromTimestamp(row.occurred_at),
      id: product.id, name: product.name, unit: product.unit,
      kind: delta > 0 ? 'in' : 'out', d: delta, after: Number(row.quantity_after) || 0,
      minAtTime: Number(row.minimum_quantity_at_time ?? 0),
      enteredLow: !!row.entered_low, leftLow: !!row.left_low,
      note: row.note || null, movementType: row.movement_type || null
    });
  });

  rows.events.forEach((row) => {
    const details = row.details || {};
    const productClientId = details.product_client_id || (row.entity_id && productByCloudId.get(row.entity_id)?.client_id);
    const product = productByClientId.get(String(productClientId || ''));
    if (!product) return;
    const eventDate = details.date || isoFromTimestamp(row.created_at);
    log.push({
      eventId: String(row.client_id), operationId: null,
      event: row.action === 'stock_low' ? 'low' : 'normal',
      t: Number(details.t) || new Date(row.created_at).getTime(), date: eventDate,
      id: String(product.client_id), name: product.name, unit: product.unit || 'un',
      qty: Number(details.qty) || 0, min: Number(details.min) || 0
    });
  });
  log.sort((a, b) => b.t - a.t);
  return { shop: store.name || '', demo: false, products, log };
}

async function callRpc(name, params) {
  const client = await getSupabaseClient();
  const { data, error } = await client.rpc(name, params);
  if (error) throw error;
  return data;
}

async function upsertCloudProduct(storeId, product) {
  return callRpc('sync_upsert_product', {
    p_store_id: storeId,
    p_client_id: String(product.id),
    p_name: product.name,
    p_unit: product.unit || 'un',
    p_quantity: Number(product.qty) || 0,
    p_minimum_quantity: Number(product.min) || 0,
    p_cost_price: Number(product.cost) || 0,
    p_sale_price: Number(product.salePrice) || 0,
    p_supplier_name: product.supplier || null,
    p_supplier_phone: product.phone || null,
    p_low_since_date: product.lowSinceDate || null,
    p_last_purchase_date: product.lastPurchaseDate || null
  });
}

async function importMovement(storeId, event) {
  if (!isUuid(event.operationId)) event.operationId = uuid();
  const before = Number(event.after) - Number(event.d);
  return callRpc('sync_import_movement', {
    p_store_id: storeId,
    p_product_client_id: String(event.id),
    p_movement_client_id: String(event.eventId),
    p_operation_id: event.operationId,
    p_movement_type: event.movementType || (event.d > 0 ? 'manual_in' : 'manual_out'),
    p_quantity_delta: Number(event.d),
    p_quantity_before: before,
    p_quantity_after: Number(event.after),
    p_occurred_at: new Date(Number(event.t) || Date.now()).toISOString(),
    p_occurred_on: event.date || null,
    p_minimum_quantity_at_time: Number(event.minAtTime ?? 0),
    p_entered_low: !!event.enteredLow,
    p_left_low: !!event.leftLow,
    p_note: event.note || null
  });
}

async function importStatusEvent(storeId, event) {
  if (!isUuid(event.operationId)) event.operationId = uuid();
  return callRpc('sync_import_status_event', {
    p_store_id: storeId,
    p_product_client_id: String(event.id),
    p_event_client_id: String(event.eventId),
    p_action: event.event === 'low' ? 'stock_low' : 'stock_normal',
    p_details: {
      product_client_id: String(event.id), eventId: String(event.eventId),
      date: event.date || null, t: Number(event.t) || Date.now(),
      qty: Number(event.qty) || 0, min: Number(event.min) || 0,
      name: event.name || '', unit: event.unit || 'un'
    },
    p_occurred_at: new Date(Number(event.t) || Date.now()).toISOString()
  });
}

async function migrateLocalSnapshot(storeId, localState, productClientIdsToImport) {
  const selectedIds = productClientIdsToImport ? new Set(productClientIdsToImport) : null;
  const localProducts = (localState.products || []).filter((product) => !selectedIds || selectedIds.has(String(product.id)));
  for (const product of localProducts) await upsertCloudProduct(storeId, product);
  // Importa o histórico de todos os produtos locais, inclusive produtos que já
  // existiam na nuvem. Isso permite retomar uma primeira migração interrompida
  // depois do upsert dos produtos, sem deixar movimentos históricos faltando.
  const localProductIds = new Set((localState.products || []).map((product) => String(product.id)));
  const localLog = (localState.log || []).filter((event) => localProductIds.has(String(event.id))).slice().sort((a, b) => a.t - b.t);
  for (const event of localLog) {
    if (event.event === 'movement') await importMovement(storeId, event);
    else if (event.event === 'low' || event.event === 'normal') await importStatusEvent(storeId, event);
  }
}

async function processOperation(operation) {
  const storeId = operation.storeId;
  const payload = operation.payload || {};
  if (operation.type === 'CREATE_PRODUCT' || operation.type === 'UPDATE_PRODUCT') {
    await upsertCloudProduct(storeId, payload.product);
    return;
  }
  if (operation.type === 'STOCK_MOVEMENT') {
    const event = payload.event;
    const movementType = event.movementType || (event.d > 0 ? 'manual_in' : 'manual_out');
    await callRpc('apply_stock_movement', {
      p_store_id: storeId,
      p_product_client_id: String(event.id),
      p_movement_client_id: String(event.eventId),
      p_operation_id: operation.operationId || operation.id,
      p_movement_type: movementType,
      p_quantity_delta: Number(event.d),
      p_occurred_at: new Date(Number(event.t) || Date.now()).toISOString(),
      p_occurred_on: event.date || null,
      p_minimum_quantity_at_time: Number(event.minAtTime ?? 0),
      p_note: event.note || null
    });
    return;
  }
  if (operation.type === 'STATUS_EVENT') {
    await importStatusEvent(storeId, payload.event);
    return;
  }
  if (operation.type === 'DELETE') {
    if (payload.entityType === 'product') {
      await callRpc('soft_delete_product', {
        p_store_id: storeId,
        p_product_client_id: String(operation.entityClientId),
        p_operation_id: operation.operationId || operation.id,
        p_snapshot: { product: payload.product, relatedLog: payload.relatedLog || [] }
      });
    } else if (payload.entityType === 'stock_movement') {
      await callRpc('reverse_stock_movement', {
        p_store_id: storeId,
        p_movement_client_id: String(operation.entityClientId),
        p_operation_id: operation.operationId || operation.id
      });
    } else if (payload.entityType === 'status_event') {
      await callRpc('soft_delete_status_event', {
        p_store_id: storeId,
        p_event_client_id: String(operation.entityClientId)
      });
    }
    return;
  }
  throw new Error(`Tipo de operação não reconhecido: ${operation.type}`);
}

async function flushQueueInternal() {
  if (!activeStoreId || !authenticated || !navigator.onLine) {
    const queue = await listSyncQueue().catch(() => []);
    const pending = queue.filter((item) => item.storeId === activeStoreId).length;
    publishStatus(navigator.onLine ? 'local' : 'offline', pending,
      navigator.onLine ? 'Entre na conta para sincronizar' : 'Offline — alterações salvas neste dispositivo');
    return { pending, synced: false };
  }
  const client = await getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) {
    authenticated = false;
    const queue = await listSyncQueue();
    const pending = queue.filter((item) => item.storeId === activeStoreId).length;
    publishStatus('local', pending, 'Entre na conta para sincronizar');
    return { pending, synced: false };
  }

  const all = await listSyncQueue();
  const queue = all.filter((item) => item.storeId === activeStoreId).sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  if (!queue.length) return { pending: 0, synced: true };
  publishStatus('syncing', queue.length, `Sincronizando ${queue.length} alteração(ões)...`);

  for (const item of queue) {
    const working = { ...item, status: 'processing', lastAttemptAt: Date.now() };
    await updateSyncOperation(working);
    try {
      await processOperation(working);
      await removeSyncOperation(working.id);
    } catch (error) {
      const failed = {
        ...working, status: 'pending', attempts: (Number(item.attempts) || 0) + 1,
        lastError: String(error && error.message ? error.message : error).slice(0, 500),
        lastFailedAt: Date.now()
      };
      await updateSyncOperation(failed);
      const remaining = (await listSyncQueue()).filter((entry) => entry.storeId === activeStoreId).length;
      publishStatus('error', remaining, `Falha na sincronização: ${failed.lastError || 'erro desconhecido'}. ${remaining} alteração(ões) continuam salvas neste aparelho.`);
      return { pending: remaining, synced: false, error };
    }
  }
  return { pending: 0, synced: true };
}

async function pullAndApply() {
  if (!activeStoreId || !authenticated || !navigator.onLine) return false;
  if (typeof callbacks.canApplyRemoteState === 'function' && !callbacks.canApplyRemoteState()) return false;
  const client = await getSupabaseClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) { authenticated = false; return false; }
  const { data: store, error: storeError } = await client.from('stores').select('id,name').eq('id', activeStoreId).single();
  if (storeError) throw storeError;
  const rows = await cloudRows(activeStoreId);
  const cloudState = buildLocalStateFromCloud(store, rows);
  if (typeof callbacks.applyRemoteState === 'function') await callbacks.applyRemoteState(cloudState);
  return true;
}

export async function drainSyncQueue(options = {}) {
  if (draining) return drainPromise;
  draining = true;
  drainPromise = (async () => {
    try {
      const result = await flushQueueInternal();
      if (result.synced && options.pull !== false) {
        await pullAndApply();
      }
      const pending = (await listSyncQueue()).filter((item) => item.storeId === activeStoreId).length;
      if (result.synced && pending === 0) {
        await setMeta(`sync.last_success.${activeStoreId}`, Date.now());
        publishStatus('synced', 0, 'Online · Tudo sincronizado');
      }
      return { ...result, pending };
    } catch (error) {
      console.warn('Falha na sincronização:', error);
      const pending = (await listSyncQueue().catch(() => [])).filter((item) => item.storeId === activeStoreId).length;
      publishStatus(navigator.onLine ? 'error' : 'offline', pending,
        navigator.onLine ? 'Falha ao sincronizar — alterações continuam salvas neste aparelho' : 'Offline — alterações salvas neste dispositivo');
      return { pending, synced: false, error };
    } finally {
      draining = false;
    }
  })();
  return drainPromise;
}

export function scheduleSync(options = {}) {
  if (!activeStoreId || !authenticated || !navigator.onLine) return;
  window.setTimeout(() => {
    drainSyncQueue(options).then((result) => {
      // Se novas operações foram adicionadas durante uma drenagem, execute outra
      // passagem. Erros não entram em loop: serão tentados novamente ao reconectar,
      // voltar ao app ou no próximo ciclo periódico.
      if (result && result.synced && result.pending > 0 && navigator.onLine && authenticated) {
        scheduleSync(options);
      }
    });
  }, 150);
}

export async function initSyncEngine(options = {}) {
  callbacks = { ...callbacks, ...options };
  const savedStore = await getMeta(ACTIVE_STORE_META).catch(() => null);
  activeStoreId = savedStore && savedStore.value ? String(savedStore.value) : null;
  authenticated = false;
  if (!listenersInstalled) {
    listenersInstalled = true;
    window.addEventListener('online', () => { if (activeStoreId) drainSyncQueue(); });
    window.addEventListener('offline', async () => {
      const queue = await listSyncQueue().catch(() => []);
      publishStatus('offline', queue.filter((item) => item.storeId === activeStoreId).length,
        'Offline — alterações salvas neste dispositivo');
    });
    window.addEventListener('focus', () => { if (activeStoreId && navigator.onLine && authenticated) drainSyncQueue(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && activeStoreId && navigator.onLine && authenticated) drainSyncQueue();
    });
    pollTimer = window.setInterval(() => {
      if (!document.hidden && activeStoreId && navigator.onLine && authenticated) drainSyncQueue();
    }, 60000);
  }
  const queue = await listSyncQueue().catch(() => []);
  const pending = queue.filter((item) => !activeStoreId || item.storeId === activeStoreId).length;
  if (!navigator.onLine) publishStatus('offline', pending, 'Offline — alterações salvas neste dispositivo');
  else if (!activeStoreId) publishStatus('local', 0, 'Somente neste aparelho');
  else publishStatus('local', pending, pending ? `${pending} alteração(ões) aguardando login` : 'Conta vinculada');
  return { activeStoreId, pending };
}

async function connectStoreAndSyncInternal(store, localState) {
  if (!store || !store.id) throw new Error('O estabelecimento não possui um identificador válido.');
  const storeId = String(store.id);
  if (activeStoreId && activeStoreId !== storeId) {
    const queued = (await listSyncQueue()).filter((item) => item.storeId === activeStoreId);
    throw new Error(queued.length
      ? 'Há alterações pendentes vinculadas a outro estabelecimento neste aparelho. Sincronize a conta anterior antes de trocar.'
      : 'Este aparelho já está vinculado a outro estabelecimento. Faça backup antes de trocar de conta.');
  }
  activeStoreId = storeId;
  authenticated = true;
  await setMeta(ACTIVE_STORE_META, storeId);
  publishStatus('syncing', 0, 'Conectando ao estoque na nuvem...');

  const bootstrapKey = BOOTSTRAP_PREFIX + storeId;
  const bootstrapRecord = await getMeta(bootstrapKey);
  const hasBootstrapped = !!(bootstrapRecord && bootstrapRecord.value === true);
  let rows = await cloudRows(storeId);

  if (!hasBootstrapped) {
    const localIsReal = localState && !localState.demo && Array.isArray(localState.products);
    if (rows.products.length === 0 && localIsReal && localState.products.length > 0) {
      publishStatus('syncing', localState.products.length, `Enviando ${localState.products.length} produto(s) para a nuvem...`);
      await migrateLocalSnapshot(storeId, localState, null);
    } else if (rows.products.length > 0 && localIsReal) {
      // A nuvem é a fonte canônica para client_id já conhecido. Produtos locais
      // que nunca chegaram à nuvem são migrados sem sobrescrever saldo remoto.
      const known = new Set(rows.products.map((product) => String(product.client_id)));
      const missing = localState.products.map((product) => String(product.id)).filter((id) => !known.has(id));
      // Também chamamos quando missing está vazio: os upserts e imports do
      // histórico são idempotentes e completam uma migração interrompida.
      await migrateLocalSnapshot(storeId, localState, missing);
    }
    await setMeta(bootstrapKey, true);
    const firstQueueResult = await flushQueueInternal();
    if (!firstQueueResult.synced && firstQueueResult.pending > 0) {
      publishStatus('error', firstQueueResult.pending, 'Existem alterações pendentes que não puderam ser enviadas. Seus dados locais foram preservados.');
      return { synced: false, pending: firstQueueResult.pending };
    }
    rows = await cloudRows(storeId);
  } else {
    const result = await flushQueueInternal();
    if (!result.synced && result.pending > 0) {
      publishStatus('error', result.pending, 'Existem alterações pendentes que não puderam ser enviadas. Seus dados locais foram preservados.');
      return { synced: false, pending: result.pending };
    }
    rows = await cloudRows(storeId);
  }

  // Se a nuvem ainda está vazia e o app está mostrando apenas demonstração,
  // não substituímos a demonstração por um estoque vazio.
  if (rows.products.length > 0 || !(localState && localState.demo)) {
    const { data: cloudStore, error } = await (await getSupabaseClient())
      .from('stores').select('id,name').eq('id', storeId).single();
    if (error) throw error;
    if (typeof callbacks.applyRemoteState === 'function') {
      await callbacks.applyRemoteState(buildLocalStateFromCloud(cloudStore, rows));
    }
  }

  const pending = (await listSyncQueue()).filter((item) => item.storeId === storeId).length;
  publishStatus(pending ? 'pending' : 'synced', pending,
    pending ? `${pending} alteração(ões) aguardando sincronização` : 'Online · Tudo sincronizado');
  return { synced: pending === 0, pending, storeId };
}

export function connectStoreAndSync(store, localState) {
  if (connectPromise) return connectPromise;
  connectPromise = connectStoreAndSyncInternal(store, localState)
    .catch(async (error) => {
      const queue = await listSyncQueue().catch(() => []);
      const pending = queue.filter((item) => item.storeId === activeStoreId).length;
      publishStatus('error', pending, `Não foi possível conectar/sincronizar: ${error && error.message ? error.message : 'erro desconhecido'}. Os dados locais foram preservados.`);
      throw error;
    })
    .finally(() => { connectPromise = null; });
  return connectPromise;
}

export async function refreshSyncStatus() {
  const queue = await listSyncQueue().catch(() => []);
  const pending = queue.filter((item) => !activeStoreId || item.storeId === activeStoreId).length;
  if (!navigator.onLine) publishStatus('offline', pending, 'Offline — alterações salvas neste dispositivo');
  else if (!authenticated) publishStatus(activeStoreId ? 'pending' : 'local', pending,
    activeStoreId && pending ? `${pending} alteração(ões) aguardando login` : 'Somente neste aparelho');
  else if (pending) publishStatus('pending', pending, `${pending} alteração(ões) aguardando sincronização`);
  else publishStatus('synced', 0, 'Online · Tudo sincronizado');
  return lastStatus;
}

export async function markSignedOut() {
  authenticated = false;
  const queue = await listSyncQueue().catch(() => []);
  const pending = queue.filter((item) => item.storeId === activeStoreId).length;
  publishStatus(navigator.onLine ? 'local' : 'offline', pending,
    navigator.onLine ? 'Conta desconectada — alterações ficam neste aparelho' : 'Offline — alterações salvas neste dispositivo');
}

export function hasCloudSession() { return authenticated; }
