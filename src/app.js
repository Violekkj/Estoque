import {
  fmtMoney, fmtQty, r3, parseNum, isLow, isDateValue, dateISO, todayISO,
  fmtISODate, totalValue, suggest, supplierKey, groupBuy, validItems,
  groupCost, buildMessage, waLink, clean, newId, esc, fmtDate
} from "./core/utils.js";
import { sanitize, demoState } from "./data/state-schema.js";
import {
  loadAppState, saveAppState, loadDraft, saveDraft, isIndexedDBAvailable, isLocalStorageAvailable, restoreFallbackSyncQueue
} from "./data/storage.js";
import { isSupabaseConfigured } from "./cloud/supabase-client.js";
import {
  getCloudAccount, signInWithPassword, signUpWithPassword, signOutFromCloud
} from "./cloud/auth.js";
import {
  buildSyncOperations, ensureStateOperationIds, initSyncEngine, connectStoreAndSync,
  getActiveStoreId, getSyncStatus, scheduleSync, markSignedOut, refreshSyncStatus,
  listTrashItems, restoreProductFromTrash, permanentlyDeleteProductFromTrash
} from "./cloud/sync-engine.js";

'use strict';

var KEY = 'estoque-no-bolso-v1';
var THEME_KEY = KEY + '-theme';
var FIRST_USE_KEY = KEY + '-welcome-v1';
function readSavedTheme(){
  try { var saved = localStorage.getItem(THEME_KEY); return saved === 'light' || saved === 'dark' ? saved : null; }
  catch(e){ return null; }
}
var themeMode = readSavedTheme();
function effectiveTheme(){
  if (themeMode) return themeMode;
  try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch(e){ return 'light'; }
}
function updateThemeColor(){
  var meta = document.getElementById('themeColorMeta');
  if (meta) meta.setAttribute('content', effectiveTheme() === 'dark' ? '#0E151D' : '#EDF0F4');
}
function applyTheme(mode, persist){
  themeMode = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', themeMode);
  if (persist !== false) {
    try { localStorage.setItem(THEME_KEY, themeMode); } catch(e) {}
  }
  updateThemeColor();
}
function themeButtonContent(){
  var dark = effectiveTheme() === 'dark';
  var icon = dark
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>';
  return '<span class="theme-icon">' + icon + '</span><span class="theme-copy"><strong>Modo ' + (dark ? 'escuro' : 'claro') + '</strong><small>Toque para alternar para o modo ' + (dark ? 'claro' : 'escuro') + '</small></span><span class="theme-chevron" aria-hidden="true">›</span>';
}
// Respeita a preferência salva; sem escolha anterior, acompanha o tema do aparelho.
if (themeMode) applyTheme(themeMode, false);
else updateThemeColor();


// Estado em memória; persistência fica isolada no repositório local.
// A chave antiga é mantida durante a migração para não perder dados dos usuários atuais.
var state, override = {}, tab = 'prod', onlyLow = false, search = '', persisted = true;
var indexedDbReady = true, storageFallback = false;
var saveChain = Promise.resolve();
var lastCommittedSnapshot = null;
var STASH_KEY = KEY + '-meus-dados', stashMem = null;

function save(){
  ensureStateOperationIds(state);
  var normalized = sanitize(state);
  if (normalized) state = normalized;
  var snapshot = JSON.parse(JSON.stringify(state));
  renderBanners();
  saveChain = saveChain.then(async function(){
    var operations = buildSyncOperations(lastCommittedSnapshot, snapshot, getActiveStoreId());
    var result = await saveAppState(KEY, snapshot, operations);
    persisted = !!result.ok;
    indexedDbReady = !!result.indexedDBOk;
    storageFallback = !indexedDbReady && !!result.localStorageOk;
    if (result.indexedDBOk && result.queuePersisted) {
      lastCommittedSnapshot = JSON.parse(JSON.stringify(snapshot));
      if (operations.length) {
        refreshSyncStatus();
        scheduleSync();
      }
    }
    renderBanners();
    renderSyncStatus(getSyncStatus());
  }).catch(function(error){
    console.error('Falha ao salvar o estoque:', error);
    persisted = false;
    storageFallback = false;
    renderBanners();
  });
}

function renderSyncStatus(status){
  var root = $('syncStatus');
  if (!root) return;
  status = status || getSyncStatus();
  root.dataset.state = status.state || 'local';
  var label = root.querySelector('.sync-label');
  var count = Number(status.pending) || 0;
  var text = status.message || 'Somente neste aparelho';
  if (status.state === 'syncing') text = count ? 'Sincronizando ' + count + ' alteração(ões)...' : 'Conectando à nuvem...';
  else if (status.state === 'synced') text = 'Online · Tudo sincronizado';
  else if (status.state === 'offline') text = 'Offline — alterações salvas neste dispositivo';
  else if (status.state === 'pending') text = count + ' alteração(ões) aguardando envio';
  if (label) label.textContent = text;
  root.title = text;
}

async function applyCloudSnapshot(remoteState){
  await saveChain;
  var normalized = sanitize(remoteState);
  if (!normalized) throw new Error('A cópia recebida da nuvem não passou pela validação local.');
  state = normalized;
  ensureStateOperationIds(state);
  lastCommittedSnapshot = JSON.parse(JSON.stringify(state));
  var result = await saveAppState(KEY, state, []);
  persisted = !!result.ok;
  indexedDbReady = !!result.indexedDBOk;
  storageFallback = !indexedDbReady && !!result.localStorageOk;
  render();
}

async function activateCloudStore(store){
  ensureStateOperationIds(state);
  var localSnapshot = JSON.parse(JSON.stringify(state));
  return connectStoreAndSync(store, localSnapshot);
}

/* Guarda os dados reais enquanto a pessoa vê o exemplo. */
function getStash(){ return stashMem ? sanitize(stashMem) : null; }
function setStash(s){
  stashMem = s ? sanitize(s) : null;
  saveDraft(STASH_KEY, stashMem).catch(function(error){ console.warn('Não foi possível salvar os dados guardados:', error); });
}

function $(id){ return document.getElementById(id); }
function find(id){ return state.products.filter(function(p){ return p.id === id; })[0]; }
var toastT;
function toast(msg){ var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function(){ t.hidden = true; }, 2400); }

/* ---------- renderização ---------- */
function renderStats(){
  var low = state.products.filter(isLow).length;
  $('title').textContent = state.shop.trim() || 'Estoque no Bolso';
  $('totalVal').textContent = fmtMoney(totalValue(state.products));
  var n = state.products.length;
  $('totalSub').textContent = n + (n === 1 ? ' produto cadastrado' : ' produtos cadastrados') + ' · quantidade × custo';
  var b = $('alertBtn');
  b.classList.toggle('on', low > 0);
  $('alertTxt').textContent = low === 0 ? 'Nada abaixo do mínimo' : low + (low === 1 ? ' produto abaixo do mínimo' : ' produtos abaixo do mínimo');
  $('alertGo').textContent = low === 0 ? '' : (onlyLow && tab === 'prod' ? 'Mostrando só estes' : 'Ver');
  b.disabled = low === 0;
  var bb = $('buyBadge'); bb.hidden = low === 0; bb.textContent = low;
}
function renderBanners(){
  var h = '';
  if (!persisted) h += '<div class="banner warn"><span>Não foi possível salvar os dados neste aparelho. Faça o backup antes de fechar.</span></div>';
  else if (storageFallback) h += '<div class="banner warn"><span>O armazenamento avançado não está disponível. Seus dados estão em modo de compatibilidade; mantenha um backup atualizado.</span></div>';
  if (state.demo) {
    var mine = !!getStash();
    h += '<div class="banner"><span>' + (mine ? 'Estes são dados de exemplo. Os seus dados estão guardados.' : 'Estes são dados de exemplo.') + '</span><button data-act="' + (mine ? 'back-mine' : 'clear-demo') + '">' + (mine ? 'Voltar aos meus dados' : 'Começar do zero') + '</button></div>';
  }
  $('banners').innerHTML = h;
}
function renderTabs(){
  document.querySelectorAll('[data-act="tab"]').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
  $('toolbar').hidden = tab !== 'prod';
  $('fab').hidden = tab !== 'prod';
}
function renderProducts(){
  var q = search.trim().toLowerCase();
  var list = state.products.filter(function(p){ return !q || p.name.toLowerCase().indexOf(q) >= 0; });
  if (onlyLow) list = list.filter(isLow);
  list.sort(function(a, b){ return (isLow(b) - isLow(a)) || a.name.localeCompare(b.name, 'pt-BR'); });
  if (!state.products.length) return '<div class="empty"><b>Nenhum produto ainda</b>Toque em “+ Produto” para cadastrar o primeiro.' + (state.demo ? '' : '<br><button class="btn plain" style="flex:none; margin-top:14px" data-act="show-demo">Ver dados de exemplo</button>') + '</div>';
  if (!list.length) return '<div class="empty"><b>Nada encontrado</b>' + (onlyLow ? 'Nenhum produto abaixo do mínimo.' : 'Tente outro nome.') + '</div>';
  return '<div class="list">' + list.map(function(p){
    var low = isLow(p);
    var dateMeta = '';
    if (low) dateMeta += '<div>No vermelho desde: ' + (p.lowSinceDate ? fmtISODate(p.lowSinceDate) : 'data não registrada (já estava abaixo do mínimo)') + '</div>';
    if (p.lastPurchaseDate) dateMeta += '<div>Última compra/entrada: ' + fmtISODate(p.lastPurchaseDate) + '</div>';
    return '<article class="card' + (low ? ' low' : '') + '">' +
      '<div class="c-top"><div class="c-name">' + esc(p.name) + '</div>' + (low ? '<span class="pill">' + (p.qty <= 0 ? 'Zerado' : 'Abaixo do mínimo') + '</span>' : '') + '</div>' +
      '<div class="c-meta"><span>Mínimo ' + fmtQty(p.min) + ' ' + esc(p.unit) + '</span><span>Custo ' + fmtMoney(p.cost) + '</span><span>Parado ' + fmtMoney(p.qty * p.cost) + '</span><button class="link" data-act="edit" data-id="' + p.id + '">Editar</button></div>' +
      (dateMeta ? '<div class="date-meta">' + dateMeta + '</div>' : '') +
      '<div class="c-bot"><div class="qty"><span class="n">' + fmtQty(p.qty) + '</span><span class="u">' + esc(p.unit) + '</span></div>' +
      '<div class="acts"><button class="btn out" data-act="mov" data-kind="out" data-id="' + p.id + '">− Saída</button><button class="btn in" data-act="mov" data-kind="in" data-id="' + p.id + '">+ Entrada</button></div></div>' +
      '</article>';
  }).join('') + '</div>';
}
function renderBuy(){
  var groups = groupBuy(state.products, override);
  if (!groups.length) return '<div class="empty"><b>Nada para repor</b>Todos os produtos estão no mínimo ou acima dele.</div>';
  var h = '<p class="hint">Sugestão: repor até o dobro do mínimo. Ajuste as quantidades antes de enviar.</p><div class="list">';
  groups.forEach(function(g, gi){
    h += '<section class="card" data-g="' + gi + '"><div class="g-head"><h2>' + esc(g.key) + '</h2><span>' + (g.phone ? 'WhatsApp ' + esc(g.phone) : 'Sem número: você escolhe o contato no WhatsApp') + '</span></div><div>';
    g.items.forEach(function(i){
      h += '<div class="row"><div><div class="nm">' + esc(i.name) + '</div><div class="buy-date">Abaixo do mínimo desde: ' + (i.lowSinceDate ? fmtISODate(i.lowSinceDate) : 'data não registrada') + '</div></div><input class="qin" type="text" inputmode="decimal" autocomplete="off" aria-label="Quantidade de ' + esc(i.name) + '" data-id="' + i.id + '" data-g="' + gi + '" value="' + esc(fmtQty(i.q).replace(/\./g, '')) + '"><span class="un">' + esc(i.unit) + '</span></div>';
    });
    h += '</div><div class="tot"><span>Total estimado pelo seu custo</span><b data-sub="' + gi + '">' + fmtMoney(groupCost(g)) + '</b></div>' +
      '<div class="g-acts"><a class="btn in" data-wa="' + gi + '" target="_blank" rel="noopener" href="' + esc(waLink(g.phone, buildMessage(state.shop, g))) + '">Enviar no WhatsApp</a>' +
      '<button class="btn plain" data-act="copy-buy" data-g="' + gi + '">Copiar texto</button></div></section>';
  });
  h += '</div><div class="grand tot"><span>Compra total estimada</span><b id="grand">' + fmtMoney(groups.reduce(function(s, g){ return s + groupCost(g); }, 0)) + '</b></div>';
  return h;
}
function historyDeleteButton(l){
  return '<div class="hist-actions"><button type="button" class="hist-delete" data-act="delete-history" data-event-id="' + esc(l.eventId) + '">Excluir registro</button></div>';
}
function renderHist(){
  if (!state.log.length) return '<div class="empty"><b>Sem movimentos</b>As compras/entradas, saídas e alertas de estoque aparecerão aqui.</div>';
  var h = '<p class="hint">Excluir uma compra/entrada ou saída também desfaz o movimento no estoque. Alertas podem ser excluídos do histórico sem alterar a quantidade.</p><div class="list">';
  h += state.log.map(function(l){
    var dateLabel = fmtISODate(l.date);
    if (l.event === 'low') {
      return '<div class="hrow status-low"><span class="nm">Entrou no vermelho · ' + esc(l.name) + '</span><span class="tag">Alerta de estoque</span><span class="dt">' + dateLabel + '</span><span class="af">Estoque: ' + fmtQty(l.qty) + ' ' + esc(l.unit) + ' · mínimo: ' + fmtQty(l.min) + '</span>' + historyDeleteButton(l) + '</div>';
    }
    if (l.event === 'normal') {
      return '<div class="hrow status-normal"><span class="nm">Estoque normalizado · ' + esc(l.name) + '</span><span class="tag">Alerta resolvido</span><span class="dt">' + dateLabel + '</span><span class="af">Estoque: ' + fmtQty(l.qty) + ' ' + esc(l.unit) + '</span>' + historyDeleteButton(l) + '</div>';
    }
    var inn = l.kind === 'in' || l.d > 0;
    var label = inn ? 'Compra / entrada · ' : 'Saída de estoque · ';
    var extra = l.enteredLow ? '<span class="eventnote">Este movimento fez o produto entrar no vermelho.</span>' : (l.leftLow ? '<span class="eventnote" style="color:var(--good)">Este movimento retirou o produto do vermelho.</span>' : '');
    return '<div class="hrow"><span class="nm">' + label + esc(l.name) + '</span><span class="dl ' + (inn ? 'in' : 'out') + '">' + (inn ? '+' : '−') + fmtQty(Math.abs(l.d)) + ' ' + esc(l.unit) + '</span><span class="dt">' + dateLabel + '</span><span class="af">ficou com ' + fmtQty(l.after) + ' ' + esc(l.unit) + '</span>' + extra + historyDeleteButton(l) + '</div>';
  }).join('');
  return h + '</div>';
}
function render(){
  renderStats(); renderBanners(); renderTabs();
  $('view').innerHTML = tab === 'prod' ? renderProducts() : tab === 'buy' ? renderBuy() : renderHist();
}

/* ---------- folhas ---------- */
function openSheet(html, focusId){
  $('sheet').innerHTML = html; $('overlay').hidden = false;
  if (focusId && $(focusId)) { $(focusId).focus(); if ($(focusId).select) $(focusId).select(); }
}
function closeSheet(){ $('overlay').hidden = true; $('sheet').innerHTML = ''; }
function movSheet(p, kind){
  var inn = kind === 'in';
  openSheet('<form id="movForm" data-id="' + p.id + '" data-kind="' + kind + '" novalidate>' +
    '<div class="sheet-h"><h2>' + (inn ? 'Compra / entrada' : 'Saída') + '</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<p class="sub">' + esc(p.name) + ' · em estoque: <b>' + fmtQty(p.qty) + ' ' + esc(p.unit) + '</b></p>' +
    '<div class="field" style="margin-top:12px"><label for="movDate">' + (inn ? 'Data da compra / entrada' : 'Data da saída') + '</label><input type="date" id="movDate" value="' + todayISO() + '" required></div>' +
    '<div class="field"><label for="movQty">Quantidade (' + esc(p.unit) + ')</label>' +
    '<div class="stepper"><button type="button" data-act="step" data-d="-1" aria-label="Diminuir">−</button><input type="text" id="movQty" inputmode="decimal" autocomplete="off" value="1"></div></div>' +
    '<p class="err" id="movErr" role="alert"></p><p class="after" id="movAfter"></p>' +
    '<button type="submit" class="btn ' + (inn ? 'in' : 'primary') + '" style="width:100%">Registrar ' + (inn ? 'compra / entrada' : 'saída') + '</button></form>', 'movQty');
  updateMov();
}
function updateMov(){
  var f = $('movForm'); if (!f) return;
  var p = find(f.dataset.id), kind = f.dataset.kind, n = parseNum($('movQty').value);
  var movementDate = $('movDate').value;
  var err = '', after = '';
  if (!isDateValue(movementDate)) err = 'Selecione uma data válida.';
  else if (movementDate > todayISO()) err = 'A data não pode ser no futuro.';
  else if (isNaN(n) || n <= 0) err = 'Digite uma quantidade maior que zero.';
  else if (kind === 'out' && n > p.qty) err = 'A saída é maior que o estoque atual (' + fmtQty(p.qty) + ' ' + p.unit + ').';
  else { var a = r3(p.qty + (kind === 'in' ? n : -n)); after = 'Vai ficar com <b>' + fmtQty(a) + ' ' + esc(p.unit) + '</b>' + (a < p.min ? ' — abaixo do mínimo (' + fmtQty(p.min) + ')' : ''); }
  $('movErr').textContent = err; $('movAfter').innerHTML = after;
  return !err;
}
function productSheet(p){
  var isNew = !p; p = p || {name:'', unit:'un', qty:0, min:0, cost:0, supplier:'', phone:''};
  var units = ['un','kg','g','L','ml','cx','pct','fardo'];
  var sup = {}; state.products.forEach(function(x){ if (x.supplier) sup[x.supplier] = 1; });
  var money = function(n){ return n ? String(n).replace('.', ',') : ''; };
  openSheet('<form id="prodForm" data-id="' + (isNew ? '' : p.id) + '" novalidate>' +
    '<div class="sheet-h"><h2>' + (isNew ? 'Novo produto' : 'Editar produto') + '</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<div class="field"><label for="pName">Nome</label><input type="text" id="pName" maxlength="80" autocomplete="off" value="' + esc(p.name) + '" placeholder="Ex.: Arroz branco 5 kg"></div>' +
    '<div class="two"><div class="field"><label for="pUnit">Unidade</label><select id="pUnit">' + units.map(function(u){ return '<option' + (u === p.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label for="pCost">Custo por unidade (R$)</label><input type="text" id="pCost" inputmode="decimal" autocomplete="off" value="' + money(p.cost) + '" placeholder="0,00"></div></div>' +
    '<div class="two">' + (isNew ? '<div class="field"><label for="pQty">Quantidade agora</label><input type="text" id="pQty" inputmode="decimal" autocomplete="off" value="' + (p.qty || '') + '" placeholder="0"></div>' : '<div class="field"><label>Em estoque</label><input type="text" value="' + fmtQty(p.qty) + ' ' + esc(p.unit) + '" disabled></div>') +
    '<div class="field"><label for="pMin">Estoque mínimo</label><input type="text" id="pMin" inputmode="decimal" autocomplete="off" value="' + (p.min || '') + '" placeholder="0"></div></div>' +
    (isNew ? '' : '<p class="sub">Para mudar a quantidade, use Entrada ou Saída.</p>') +
    '<div class="field"><label for="pSup">Fornecedor</label><input type="text" id="pSup" maxlength="60" list="supList" autocomplete="off" value="' + esc(p.supplier) + '" placeholder="Nome do fornecedor"><datalist id="supList">' + Object.keys(sup).map(function(s){ return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></div>' +
    '<div class="field"><label for="pPhone">WhatsApp do fornecedor (com DDD)</label><input type="text" id="pPhone" inputmode="tel" maxlength="20" autocomplete="off" value="' + esc(p.phone) + '" placeholder="11 91234-5678"></div>' +
    '<p class="err" id="pErr" role="alert"></p>' +
    '<button type="submit" class="btn primary" style="width:100%">Salvar</button>' +
    (isNew ? '' : '<button type="button" class="danger" data-act="del" data-id="' + p.id + '">Excluir produto</button>') + '</form>', isNew ? 'pName' : null);
}
function moreSheet(){
  openSheet('<div class="sheet-h"><h2>Mais</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<div class="field"><label for="shopName">Nome do seu comércio</label><input type="text" id="shopName" maxlength="60" autocomplete="off" value="' + esc(state.shop) + '" placeholder="Aparece no pedido do WhatsApp"></div>' +
    '<div class="sec"><h3>Modo</h3><p>Escolha a aparência do Estoque no Bolso. Sua preferência fica salva neste celular.</p><button type="button" class="btn plain theme-mode-btn" id="themeToggle" data-act="toggle-theme">' + themeButtonContent() + '</button></div>' +
    '<div class="sec"><h3>Conta e nuvem</h3><p>Vincule este comércio a uma conta para preparar o acesso em outros dispositivos.</p><button type="button" class="btn plain" data-act="account">Conta e acesso</button></div>' +
    '<div class="sec"><h3>Lixeira</h3><p>Veja os produtos excluídos e restaure os que ainda estão dentro do prazo de recuperação.</p><button type="button" class="btn plain" data-act="trash">Abrir lixeira</button></div>' +
    (state.demo ? '' : '<div class="sec"><h3>Dados de exemplo</h3><p>Veja o app preenchido com produtos de exemplo. Os seus dados ficam guardados e voltam quando você quiser.</p><button type="button" class="btn plain" data-act="show-demo">Ver dados de exemplo</button></div>') +
    '<div class="sec"><h3>Apagar tudo</h3><p>Remove produtos e histórico deste celular.</p><button type="button" class="danger" data-act="wipe">Apagar tudo</button></div>', null);
}

function trashSheet(){
  openSheet('<div class="sheet-h"><h2>Lixeira</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<p class="sub">Os produtos excluídos ficam disponíveis para restauração por até 30 dias. O histórico de movimentações não é apagado.</p>' +
    '<div id="trashContent"><div class="banner"><span>Carregando itens da lixeira...</span></div></div>', null);
  refreshTrashSheet();
}

function renderTrashItems(items){
  if (!items.length) {
    return '<div class="empty"><b>Lixeira vazia</b>Quando você excluir um produto, ele aparecerá aqui para possível restauração.</div>';
  }

  return '<div class="list">' + items.map(function(item){
    var snapshot = item.snapshot || {};
    var product = snapshot.product || snapshot || {};
    var name = product.name || 'Produto sem nome no registro';
    var unit = product.unit || 'un';
    var quantity = Number(product.qty);
    var deletedAt = item.deleted_at || item.created_at;
    var expiresAt = item.expires_at;
    var expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
    var meta = [];
    if (Number.isFinite(quantity)) meta.push('Quantidade: ' + fmtQty(quantity) + ' ' + unit);
    if (Number.isFinite(Number(product.min))) meta.push('Mínimo: ' + fmtQty(product.min) + ' ' + unit);
    var dates = '<div class="date-meta">' +
      (deletedAt ? '<div>Excluído em: ' + esc(fmtDate(deletedAt)) + '</div>' : '') +
      (expiresAt ? '<div>' + (expired ? 'Prazo encerrado em: ' : 'Disponível para restauração até: ') + esc(fmtDate(expiresAt)) + '</div>' : '') +
      '</div>';
    var action = expired
      ? '<button type="button" class="btn plain" disabled>Prazo de restauração encerrado</button>'
      : '<button type="button" class="btn primary" data-act="restore-trash" data-trash-id="' + esc(item.id) + '">Restaurar produto</button>';
    var purgeAction = '<button type="button" class="danger" data-act="purge-trash" data-trash-id="' + esc(item.id) + '">Excluir definitivamente</button>';
    return '<article class="card' + (expired ? ' low' : '') + '">' +
      '<div class="c-top"><div class="c-name">' + esc(name) + '</div>' +
      (expired ? '<span class="pill">Expirado</span>' : '') + '</div>' +
      (meta.length ? '<div class="c-meta">' + meta.map(esc).join(' · ') + '</div>' : '') +
      dates + action + purgeAction +
      '</article>';
  }).join('') + '</div>';
}

async function refreshTrashSheet(){
  var root = $('trashContent');
  if (!root) return;
  root.innerHTML = '<div class="banner"><span>Carregando itens da lixeira...</span></div>';
  try {
    var items = await listTrashItems();
    root = $('trashContent');
    if (!root) return;
    root.innerHTML = renderTrashItems(items);
  } catch(error) {
    root = $('trashContent');
    if (!root) return;
    root.innerHTML = '<div class="banner warn"><span>' + esc(error.message || 'Não foi possível carregar a lixeira.') + '</span></div>' +
      '<button type="button" class="btn plain" data-act="trash-retry">Tentar novamente</button>';
  }
}

async function restoreTrashProduct(trashId, button){
  if (!trashId) return;
  var confirmed = await appConfirm({
    title: 'Restaurar produto?',
    message: 'O produto voltará à lista com a quantidade e os dados originais. O histórico de movimentações será preservado.',
    confirmText: 'Restaurar produto'
  });
  if (!confirmed) return;

  if (button) button.disabled = true;
  closeSheet();
  try {
    await restoreProductFromTrash(trashId);
    toast('Produto restaurado com sucesso.');
    trashSheet();
  } catch(error) {
    toast('Não foi possível restaurar: ' + (error.message || 'erro desconhecido'));
    trashSheet();
  }
}

async function permanentlyDeleteTrashProduct(trashId, button){
  if (!trashId) return;
  var confirmed = await appConfirm({
    title: 'Excluir produto definitivamente?',
    message: 'Esta ação não pode ser desfeita. O produto e o registro da Lixeira só serão removidos se não houver movimentações, estornos, itens de compras ou contagens de inventário vinculados. O histórico nunca será apagado.',
    confirmText: 'Excluir definitivamente'
  });
  if (!confirmed) return;

  if (button) button.disabled = true;
  try {
    await permanentlyDeleteProductFromTrash(trashId);
    toast('Produto excluído definitivamente.');
    await refreshTrashSheet();
  } catch(error) {
    toast('Não foi possível excluir definitivamente: ' + (error.message || 'erro desconhecido'));
    await refreshTrashSheet();
  }
}

function accountSheet(){
  openSheet('<div class="sheet-h"><h2>Conta e nuvem</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<div id="cloudAccountContent"><div class="banner"><span>Verificando configuração da conta...</span></div></div>', null);
  renderCloudAccount();
}

async function renderCloudAccount(messageText){
  var root = $('cloudAccountContent');
  if (!root) return;
  if (!isSupabaseConfigured()) {
    root.innerHTML = '<div class="banner warn"><span>A conexão com a nuvem ainda não foi configurada neste projeto.</span></div>' +
      '<section class="sec"><h3>Etapa necessária</h3><p>Crie seu projeto Supabase, aplique a migração SQL incluída nesta versão e preencha a URL e a chave publicável em <code>src/config/supabase-config.js</code>.</p>' +
      '<p><b>Importante:</b> use somente a chave publicável (publishable/anon). Nunca coloque uma chave <code>service_role</code> ou secret no aplicativo.</p></section>' +
      '<div class="banner"><span>Enquanto isso, o aplicativo continua funcionando localmente. Os produtos ainda não são enviados à nuvem nesta fase.</span></div>';
    return;
  }
  root.innerHTML = '<div class="banner"><span>Conectando ao serviço de autenticação...</span></div>';
  try {
    var account = await getCloudAccount();
    if (!document.getElementById('cloudAccountContent')) return;
    if (account.session && account.store) {
      var syncResult = null;
      try { syncResult = await activateCloudStore(account.store); }
      catch (syncError) { console.warn('Conta autenticada, mas a sincronização não foi concluída:', syncError); }
      var syncStatus = getSyncStatus();
      root.innerHTML = '<div class="cloud-account-card"><div class="cloud-account-status"><span class="cloud-dot online"></span><b>Conta autenticada</b></div>' +
        '<div class="cloud-account-name">' + esc(account.store.name) + '</div>' +
        '<div class="cloud-account-email">' + esc(account.session.user.email || '') + '</div>' +
        '<div class="banner"><span>' + esc(syncStatus.message || (syncResult && syncResult.synced ? 'Tudo sincronizado.' : 'A sincronização está sendo preparada.')) + '</span></div>' +
        '<button type="button" class="btn plain" data-cloud-action="sync-now">Sincronizar agora</button>' +
        '<button type="button" class="btn plain" data-cloud-action="signout">Sair da conta</button></div>';
    } else {
      root.innerHTML = '<p class="sub">Entre na sua conta ou crie o acesso do proprietário do comércio.</p>' +
        '<form id="cloudAuthForm" class="cloud-auth-form" novalidate>' +
        '<div class="field"><label for="cloudStoreName">Nome do comércio (para cadastro)</label><input id="cloudStoreName" type="text" maxlength="80" autocomplete="organization" value="' + esc(state.shop) + '" placeholder="Ex.: Mercado do Bairro"></div>' +
        '<div class="field"><label for="cloudEmail">E-mail</label><input id="cloudEmail" type="email" autocomplete="email" required placeholder="voce@exemplo.com"></div>' +
        '<div class="field"><label for="cloudPassword">Senha</label><input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" required placeholder="Mínimo de 6 caracteres"></div>' +
        '<p class="err" id="cloudAuthError" role="alert"></p>' +
        '<button type="button" class="btn primary" data-cloud-action="signin">Entrar</button>' +
        '<button type="button" class="btn plain" data-cloud-action="signup">Criar conta e estabelecimento</button>' +
        '</form>' +
        '<p class="cloud-footnote">Depois de entrar, produtos e movimentações deste aparelho são enviados uma única vez; alterações seguintes entram na fila automática.</p>'; 
    }
    if (messageText) {
      var note = document.createElement('div');
      note.className = 'banner';
      note.textContent = messageText;
      root.prepend(note);
    }
  } catch (error) {
    root.innerHTML = '<div class="banner warn"><span>Não foi possível conectar: ' + esc(error.message || 'erro desconhecido') + '</span></div>' +
      '<button type="button" class="btn plain" data-cloud-action="retry">Tentar novamente</button>';
  }
}

async function handleCloudAction(action, button){
  var root = $('cloudAccountContent');
  if (!root) return;
  if (action === 'retry') { renderCloudAccount(); return; }
  if (action === 'sync-now') {
    button.disabled = true;
    try {
      var activeAccount = await getCloudAccount();
      if (!activeAccount.session || !activeAccount.store) throw new Error('Entre novamente para sincronizar.');
      await renderCloudAccount('Verificação de sincronização concluída.');
    } catch (syncError) { await renderCloudAccount('Não foi possível sincronizar: ' + (syncError.message || 'erro desconhecido')); }
    return;
  }
  if (action === 'signout') {
    button.disabled = true;
    try { await signOutFromCloud(); await markSignedOut(); renderSyncStatus(getSyncStatus()); await renderCloudAccount('Você saiu da conta. Os dados locais deste aparelho foram preservados.'); }
    catch (error) { await renderCloudAccount('Não foi possível sair: ' + (error.message || 'erro desconhecido')); }
    return;
  }
  var email = $('cloudEmail') ? $('cloudEmail').value.trim() : '';
  var password = $('cloudPassword') ? $('cloudPassword').value : '';
  var storeName = $('cloudStoreName') ? $('cloudStoreName').value.trim() : '';
  var errorBox = $('cloudAuthError');
  if (!email || !password) {
    if (errorBox) errorBox.textContent = 'Informe seu e-mail e sua senha.';
    return;
  }
  if (action === 'signup' && !storeName) {
    if (errorBox) errorBox.textContent = 'Informe o nome do comércio.';
    return;
  }
  if (password.length < 6) {
    if (errorBox) errorBox.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
    return;
  }
  button.disabled = true;
  var oldText = button.textContent;
  button.textContent = 'Aguarde...';
  if (errorBox) errorBox.textContent = '';
  try {
    if (action === 'signin') {
      var signedIn = await signInWithPassword(email, password);
      await renderCloudAccount('Acesso confirmado para ' + signedIn.store.name + '.');
    } else {
      var created = await signUpWithPassword({ email: email, password: password, storeName: storeName });
      if (created.requiresEmailConfirmation) {
        await renderCloudAccount('Cadastro iniciado! Confira seu e-mail para confirmar a conta e depois volte aqui para entrar.');
      } else {
        await renderCloudAccount('Conta e estabelecimento criados. A sincronização inicial foi executada.');
      }
    }
  } catch (error) {
    if (errorBox) errorBox.textContent = error.message || 'Não foi possível concluir a operação.';
    button.disabled = false;
    button.textContent = oldText;
  }
}

function backupState(){
  var cleanState = sanitize(state) || {shop:'', demo:false, products:[], log:[]};
  state = cleanState;
  save();
  return cleanState;
}
function backupSheet(){
  var snapshot = backupState();
  var backupText = JSON.stringify(snapshot, null, 2);
  var productCount = snapshot.products.length;
  var eventCount = snapshot.log.length;
  var summary = productCount === 0 && eventCount === 0
    ? 'Nenhum produto ou movimentação registrado. O backup está vazio e limpo.'
    : productCount + (productCount === 1 ? ' produto' : ' produtos') + ' · ' + eventCount + (eventCount === 1 ? ' registro no histórico' : ' registros no histórico');
  openSheet('<div class="sheet-h"><h2>Backup</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    '<p class="sub">Copie seus dados para guardar uma cópia ou cole um backup para restaurar neste aparelho.</p>' +
    '<div class="banner"><span>' + esc(summary) + '</span></div>' +
    '<div class="sec"><h3>Copiar backup</h3><p>O arquivo contém seus produtos e os registros de histórico vinculados a eles. Registros sem produto correspondente são removidos automaticamente.</p>' +
    '<textarea id="bkOut" readonly spellcheck="false" aria-label="Conteúdo do backup">' + esc(backupText) + '</textarea><button type="button" class="btn plain" data-act="copy-bk">Copiar backup</button></div>' +
    '<div class="sec"><h3>Restaurar backup</h3><p>Cole abaixo o texto de um backup. Os dados atuais deste aparelho serão substituídos após sua confirmação.</p>' +
    '<textarea id="bkIn" spellcheck="false" aria-label="Colar backup" placeholder="Cole aqui o conteúdo do backup"></textarea><p class="err" id="bkErr" role="alert"></p><button type="button" class="btn primary" data-act="restore">Validar e restaurar backup</button></div>', null);
}
function hasUsedAppBefore(){
  try {
    return localStorage.getItem(KEY) !== null ||
      localStorage.getItem(THEME_KEY) !== null ||
      localStorage.getItem(KEY + '-meus-dados') !== null;
  } catch(e) { return true; }
}
function markFirstUseWelcomeSeen(){
  try { localStorage.setItem(FIRST_USE_KEY, 'seen'); } catch(e) {}
}
function showFirstUseWelcome(){
  var alreadySeen = false;
  try { alreadySeen = localStorage.getItem(FIRST_USE_KEY) === 'seen'; } catch(e) { return; }
  if (alreadySeen) return;

  // Existing users keep their current flow; the welcome appears only on a fresh browser/device.
  if (hasUsedAppBefore()) {
    markFirstUseWelcomeSeen();
    return;
  }

  var root = $('confirmRoot');
  if (!root) return;
  root.innerHTML = '<div class="welcome-overlay" data-welcome-backdrop>' +
    '<section class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle" aria-describedby="welcomeMessage">' +
      '<div class="welcome-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20M8 7h8M8 10h8"/></svg></div>' +
      '<h2 id="welcomeTitle">Bem-vindo ao Estoque no Bolso!</h2>' +
      '<p id="welcomeMessage">É sua primeira vez por aqui. Gostaria de ler o manual rápido antes de começar? Ele explica como cadastrar produtos, registrar entradas e saídas, acompanhar alertas e preparar pedidos para fornecedores pelo WhatsApp.</p>' +
      '<div class="welcome-actions"><button type="button" class="welcome-manual" data-welcome-manual>Ler o manual</button><button type="button" class="welcome-start" data-welcome-start>Começar a usar</button></div>' +
      '<p class="welcome-foot">Você também pode abrir o Manual depois, pelo botão no topo do aplicativo.</p>' +
    '</section>' +
  '</div>';

  var overlay = root.firstElementChild;
  var manualButton = overlay.querySelector('[data-welcome-manual]');
  var startButton = overlay.querySelector('[data-welcome-start]');
  var finished = false;
  function finish(openManual){
    if (finished) return;
    finished = true;
    document.removeEventListener('keydown', onKeydown);
    markFirstUseWelcomeSeen();
    root.innerHTML = '';
    if (openManual) manualSheet();
  }
  function onKeydown(event){
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Tab') {
      if (event.shiftKey && document.activeElement === manualButton) {
        event.preventDefault(); startButton.focus();
      } else if (!event.shiftKey && document.activeElement === startButton) {
        event.preventDefault(); manualButton.focus();
      }
    }
  }
  manualButton.addEventListener('click', function(){ finish(true); });
  startButton.addEventListener('click', function(){ finish(false); });
  overlay.addEventListener('click', function(event){ if (event.target === overlay) finish(false); });
  document.addEventListener('keydown', onKeydown);
  manualButton.focus();
}

function manualSheet(){
  var items = [
    ['Para que serve', 'Controla o estoque do seu comércio: você cadastra os produtos, registra o que entra e o que sai, e o app avisa o que está acabando.'],
    ['1. Cadastre os produtos', 'Toque em “+ Produto”. Informe nome, unidade, custo, quantidade atual e o estoque mínimo, que é a quantidade abaixo da qual você quer ser avisado. Para pedir pelo WhatsApp, informe também o fornecedor e o número dele.'],
    ['2. Registre entradas e saídas', 'Em cada produto, use “+ Entrada” quando chegar mercadoria e informe a data da compra/entrada. Use “− Saída” quando sair (venda, perda ou uso) e informe a data da saída. Cada movimentação fica registrada na aba Histórico.'],
    ['3. Veja o alerta vermelho', 'O produto que fica abaixo do mínimo ganha destaque vermelho e sobe para o topo da lista. O app registra a data em que ele entrou no vermelho e mostra essa informação no produto, na lista de compras e no Histórico. No resumo, o botão vermelho mostra quantos estão assim.'],
    ['4. Faça a lista de compras', 'Na aba Compras, o que está em falta aparece separado por fornecedor, com uma quantidade sugerida (o dobro do mínimo, menos o que você tem) e a data desde que cada produto está abaixo do mínimo. Ajuste os números e toque em “Enviar no WhatsApp”: o pedido já vai escrito.'],
    ['5. Valor parado em estoque', 'É a soma de quantidade × custo de todos os produtos. Aparece no topo e mostra quanto dinheiro está guardado em mercadoria.'],
    ['Seus dados', 'Ficam salvos neste celular, sem login. Na aba “Backup” você copia seus dados e restaura uma cópia quando precisar. Se limpar os dados do navegador ou trocar de celular, só o backup traz tudo de volta.']
  ];
  openSheet('<div class="sheet-h"><h2>Manual</h2><button type="button" class="ghost" data-act="close">Fechar</button></div>' +
    items.map(function(it, i){ return '<section class="man"' + (i === 0 ? ' style="border-top:0; padding-top:0"' : '') + '><h3>' + it[0] + '</h3><p>' + it[1] + '</p></section>'; }).join('') +
    (state.demo ? '' : '<button type="button" class="btn plain" style="flex:none" data-act="show-demo">Ver dados de exemplo</button>'), null);
}
function showDemo(){
  if (state.demo) { closeSheet(); return; }
  if (state.products.length || state.log.length) setStash(JSON.parse(JSON.stringify(state)));
  state = demoState(); override = {}; tab = 'prod'; onlyLow = false; search = ''; $('search').value = '';
  save(); closeSheet(); render(); toast('Mostrando dados de exemplo');
}

/* ---------- ações ---------- */
function nextLogTime(){
  var latest = 0;
  state.log.forEach(function(item){ if (item.t > latest) latest = item.t; });
  return Math.max(Date.now(), latest + 1);
}
function applyMove(id, kind, amount, movementDate){
  var p = find(id), wasLow = isLow(p), d = kind === 'in' ? amount : -amount;
  var timestamp = nextLogTime();
  p.qty = r3(p.qty + d);
  var isLowNow = isLow(p);
  if (kind === 'in') p.lastPurchaseDate = movementDate;
  if (!wasLow && isLowNow) p.lowSinceDate = movementDate;
  else if (wasLow && !isLowNow) p.lowSinceDate = null;
  state.log.unshift({
    eventId:newId(), operationId:(crypto.randomUUID ? crypto.randomUUID() : null), event:'movement', t:timestamp, date:movementDate, id:p.id, name:p.name, unit:p.unit,
    kind:kind, d:d, after:p.qty, minAtTime:p.min, enteredLow:!wasLow && isLowNow, leftLow:wasLow && !isLowNow
  });
  delete override[id];
  save();
}
function addStatusLog(eventType, p, eventDate, sourceMovementId){
  state.log.unshift({eventId:newId(), operationId:(crypto.randomUUID ? crypto.randomUUID() : null), sourceMovementId:sourceMovementId || null, event:eventType, t:nextLogTime(), date:eventDate, id:p.id, name:p.name, unit:p.unit, qty:p.qty, min:p.min});
}

function refreshProductDates(p, removedEntry){
  if (!p) return;
  var related = state.log.filter(function(item){ return item.id === p.id; }).slice().sort(function(a, b){ return a.t - b.t; });
  var sawTransition = false, activeLowDate = null;
  related.forEach(function(item){
    if (item.event === 'low') { sawTransition = true; activeLowDate = item.date; }
    else if (item.event === 'normal') { sawTransition = true; activeLowDate = null; }
    else if (item.event === 'movement' && item.enteredLow) { sawTransition = true; activeLowDate = item.date; }
    else if (item.event === 'movement' && item.leftLow) { sawTransition = true; activeLowDate = null; }
  });
  if (!isLow(p)) p.lowSinceDate = null;
  else if (sawTransition) p.lowSinceDate = activeLowDate;
  else if (removedEntry && (removedEntry.event === 'low' || (removedEntry.event === 'movement' && removedEntry.enteredLow))) p.lowSinceDate = null;

  var latestPurchase = null;
  related.forEach(function(item){
    if (item.event === 'movement' && (item.kind === 'in' || item.d > 0) && (!latestPurchase || item.t > latestPurchase.t)) latestPurchase = item;
  });
  p.lastPurchaseDate = latestPurchase ? latestPurchase.date : null;
}

function recalculateMovementAlerts(p){
  state.log.forEach(function(item){
    if (item.event !== 'movement' || item.id !== p.id) return;
    var minimum = Number(item.minAtTime);
    if (!isFinite(minimum) || minimum < 0) minimum = p.min;
    var after = Number(item.after), delta = Number(item.d);
    var before = r3(after - delta);
    item.enteredLow = before >= minimum && after < minimum;
    item.leftLow = before < minimum && after >= minimum;
  });
}

function appConfirm(options){
  return new Promise(function(resolve){
    var root = $('confirmRoot');
    if (!root) { resolve(false); return; }
    var previousFocus = document.activeElement;
    var title = options.title || 'Confirmar ação';
    var message = options.message || 'Deseja continuar?';
    var confirmText = options.confirmText || 'Confirmar';
    root.innerHTML = '<div class="confirm-overlay" data-confirm-backdrop>' +
      '<section class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">' +
        '<div class="confirm-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></div>' +
        '<h2 id="confirmTitle">' + esc(title) + '</h2>' +
        '<p id="confirmMessage">' + esc(message) + '</p>' +
        '<div class="confirm-actions"><button type="button" class="confirm-cancel" data-confirm-cancel>Cancelar</button><button type="button" class="confirm-accept" data-confirm-accept>' + esc(confirmText) + '</button></div>' +
      '</section>' +
    '</div>';

    var overlay = root.firstElementChild;
    var cancelButton = overlay.querySelector('[data-confirm-cancel]');
    var acceptButton = overlay.querySelector('[data-confirm-accept]');
    var finished = false;
    function finish(result){
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKeydown);
      root.innerHTML = '';
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    }
    function onKeydown(event){
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      else if (event.key === 'Tab') {
        var first = cancelButton, last = acceptButton;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    cancelButton.addEventListener('click', function(){ finish(false); });
    acceptButton.addEventListener('click', function(){ finish(true); });
    overlay.addEventListener('click', function(event){ if (event.target === overlay) finish(false); });
    document.addEventListener('keydown', onKeydown);
    cancelButton.focus();
  });
}

async function deleteHistoryEntry(eventId){
  var entry = state.log.filter(function(item){ return item.eventId === eventId; })[0];
  if (!entry) { toast('Esse registro não foi encontrado.'); return; }
  var p = find(entry.id);

  if (entry.event === 'movement' && p) {
    var entryIndex = state.log.findIndex(function(item){ return item.eventId === eventId; });
    function happenedAfter(item){
      var itemIndex = state.log.indexOf(item);
      return item.t > entry.t || (item.t === entry.t && itemIndex < entryIndex);
    }
    var correctedQty = r3(p.qty - entry.d);
    if (correctedQty < -0.0005) {
      toast('Não é possível excluir: há saídas posteriores que dependem desta entrada. Revise essas saídas primeiro.');
      return;
    }
    var laterWouldGoNegative = state.log.some(function(item){
      return item.event === 'movement' && item.id === p.id && happenedAfter(item) && r3(item.after - entry.d) < -0.0005;
    });
    if (laterWouldGoNegative) {
      toast('Não é possível excluir: uma movimentação posterior ficaria com estoque negativo. Revise o histórico primeiro.');
      return;
    }
    var isPurchase = entry.kind === 'in' || entry.d > 0;
    var movementLabel = isPurchase ? 'compra/entrada' : 'saída';
    var movementConfirmed = await appConfirm({
      title: isPurchase ? 'Excluir compra / entrada?' : 'Excluir saída?',
      message: 'Esta ' + movementLabel + ' de ' + fmtQty(Math.abs(entry.d)) + ' ' + entry.unit + ' será removida do histórico e o estoque será ajustado. Deseja continuar?',
      confirmText: 'Excluir movimentação'
    });
    if (!movementConfirmed) return;

    var wasLow = isLow(p);
    p.qty = Math.max(0, correctedQty);
    state.log.forEach(function(item){
      if (item.event === 'movement' && item.id === p.id && happenedAfter(item)) item.after = r3(item.after - entry.d);
    });
    state.log = state.log.filter(function(item){ return item.eventId !== eventId && item.sourceMovementId !== eventId; });
    recalculateMovementAlerts(p);
    var isLowNow = isLow(p);
    if (wasLow && !isLowNow) {
      p.lowSinceDate = null;
      addStatusLog('normal', p, todayISO());
      refreshProductDates(p, null);
    } else {
      refreshProductDates(p, entry);
      if (!wasLow && isLowNow && !p.lowSinceDate) {
        p.lowSinceDate = todayISO();
        addStatusLog('low', p, todayISO());
        refreshProductDates(p, null);
      }
    }
    delete override[p.id];
    save(); render(); toast('Movimento excluído e estoque ajustado.');
    return;
  }

  var historyConfirmed = await appConfirm({
    title: 'Excluir registro?',
    message: 'Este registro será removido do histórico. A quantidade em estoque não será alterada.',
    confirmText: 'Excluir registro'
  });
  if (!historyConfirmed) return;
  state.log = state.log.filter(function(item){ return item.eventId !== eventId && item.sourceMovementId !== eventId; });
  if (p) refreshProductDates(p, entry);
  save(); render(); toast('Registro removido do histórico.');
}
async function restoreBackup(){
  var raw = $('bkIn').value.trim();
  var restored = null;
  try { restored = sanitize(JSON.parse(raw)); } catch(err) {}
  if (!restored) {
    $('bkErr').textContent = 'Esse texto não é um backup válido. Confira o conteúdo e tente novamente.';
    return;
  }
  var confirmed = await appConfirm({
    title: 'Restaurar backup?',
    message: 'Os produtos e o histórico deste aparelho serão substituídos pelo conteúdo do backup. Registros sem produto correspondente serão descartados.',
    confirmText: 'Restaurar dados'
  });
  if (!confirmed) return;
  state = restored;
  setStash(null);
  override = {};
  save();
  closeSheet();
  render();
  toast('Backup restaurado e registros conferidos.');
}

function copyText(text, okMsg){
  function fallback(){
    try { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); document.body.removeChild(ta); toast(ok ? okMsg : 'Não deu para copiar. Selecione o texto e copie.'); }
    catch(e){ toast('Não deu para copiar. Selecione o texto e copie.'); }
  }
  try { navigator.clipboard.writeText(text).then(function(){ toast(okMsg); }, fallback); } catch(e) { fallback(); }
}
function updateGroup(gi){
  var g = groupBuy(state.products, override)[gi]; if (!g) return;
  var a = document.querySelector('[data-wa="' + gi + '"]');
  a.href = waLink(g.phone, buildMessage(state.shop, g));
  a.classList.toggle('disabled', validItems(g).length === 0);
  document.querySelector('[data-sub="' + gi + '"]').textContent = fmtMoney(groupCost(g));
  var all = groupBuy(state.products, override);
  $('grand').textContent = fmtMoney(all.reduce(function(s, x){ return s + groupCost(x); }, 0));
}
var wipeArmed = false, delArmed = false;

document.addEventListener('click', function(e){
  var wa = e.target.closest('[data-wa]');
  if (wa && wa.classList.contains('disabled')) { e.preventDefault(); return; }
  var el = e.target.closest('[data-act]'); if (!el) return;
  var act = el.dataset.act;
  if (act === 'tab') { tab = el.dataset.tab; render(); }
  else if (act === 'show-low') { var wasProd = tab === 'prod'; tab = 'prod'; onlyLow = wasProd ? !onlyLow : true; render(); }
  else if (act === 'new') productSheet(null);
  else if (act === 'edit') productSheet(find(el.dataset.id));
  else if (act === 'mov') movSheet(find(el.dataset.id), el.dataset.kind);
  else if (act === 'delete-history') deleteHistoryEntry(el.dataset.eventId);
  else if (act === 'more') { wipeArmed = false; moreSheet(); }
  else if (act === 'trash') trashSheet();
  else if (act === 'trash-retry') refreshTrashSheet();
  else if (act === 'restore-trash') restoreTrashProduct(el.dataset.trashId, el);
  else if (act === 'purge-trash') permanentlyDeleteTrashProduct(el.dataset.trashId, el);
  else if (act === 'account') accountSheet();
  else if (act === 'backup') backupSheet();
  else if (act === 'toggle-theme') { applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true); var themeToggle = $('themeToggle'); if (themeToggle) themeToggle.innerHTML = themeButtonContent(); }
  else if (act === 'manual') manualSheet();
  else if (act === 'show-demo') showDemo();
  else if (act === 'back-mine') {
    var mine = getStash(); if (!mine) return;
    state = mine; setStash(null); override = {}; save(); render(); toast('Seus dados voltaram');
  }
  else if (act === 'close') closeSheet();
  else if (act === 'step') { var inp = $('movQty'); var n = parseNum(inp.value); inp.value = String(Math.max(0, (isNaN(n) ? 0 : n) + Number(el.dataset.d))).replace('.', ','); updateMov(); }
  else if (act === 'clear-demo') { state = {shop:state.shop, demo:false, products:[], log:[]}; override = {}; save(); render(); toast('Pronto. Cadastre seus produtos.'); }
  else if (act === 'copy-buy') { var g = groupBuy(state.products, override)[Number(el.dataset.g)]; if (g) copyText(buildMessage(state.shop, g), 'Texto copiado'); }
  else if (act === 'copy-bk') { var t = $('bkOut'); t.select(); copyText(t.value, 'Backup copiado'); }
  else if (act === 'restore') restoreBackup();
  else if (act === 'wipe') {
    if (!wipeArmed) { wipeArmed = true; el.textContent = 'Toque de novo para confirmar'; return; }
    state = {shop:state.shop, demo:false, products:[], log:[]}; setStash(null); override = {}; save(); closeSheet(); render(); toast('Tudo apagado');
  }
  else if (act === 'del') {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Toque de novo para excluir'; return; }
    var deletedProductId = el.dataset.id;
    state.products = state.products.filter(function(p){ return p.id !== deletedProductId; });
    state.log = state.log.filter(function(item){ return item.id !== deletedProductId; });
    delete override[deletedProductId]; save(); closeSheet(); render(); toast('Produto e seu histórico foram excluídos');
  }
});
document.addEventListener('click', function(e){
  var button = e.target.closest('[data-cloud-action]');
  if (!button) return;
  e.preventDefault();
  handleCloudAction(button.dataset.cloudAction, button);
});

$('overlay').addEventListener('click', function(e){ if (e.target === $('overlay')) closeSheet(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && !$('overlay').hidden) closeSheet(); });

document.addEventListener('input', function(e){
  var t = e.target;
  if (t.id === 'search') { search = t.value; $('view').innerHTML = renderProducts(); }
  else if (t.id === 'movQty') updateMov();
  else if (t.id === 'shopName') { state.shop = t.value; save(); renderStats(); }
  else if (t.classList && t.classList.contains('qin')) {
    var n = parseNum(t.value); override[t.dataset.id] = isNaN(n) || n < 0 ? 0 : n; updateGroup(Number(t.dataset.g));
  }
});
document.addEventListener('submit', function(e){
  e.preventDefault();
  var f = e.target;
  if (f.id === 'movForm') {
    if (!updateMov()) return;
    var n = parseNum($('movQty').value), kind = f.dataset.kind, p = find(f.dataset.id), movementDate = $('movDate').value;
    applyMove(p.id, kind, n, movementDate); closeSheet(); render();
    toast((kind === 'in' ? 'Compra / entrada' : 'Saída') + ' registrada: ' + p.name);
  } else if (f.id === 'prodForm') {
    var name = $('pName').value.trim(), min = parseNum($('pMin').value || '0'), cost = parseNum($('pCost').value || '0');
    var qty = $('pQty') ? parseNum($('pQty').value || '0') : null;
    var err = '';
    if (!name) err = 'Digite o nome do produto.';
    else if (isNaN(min) || min < 0) err = 'O estoque mínimo precisa ser um número.';
    else if (isNaN(cost) || cost < 0) err = 'O custo precisa ser um número, como 4,50.';
    else if (qty !== null && (isNaN(qty) || qty < 0)) err = 'A quantidade precisa ser um número.';
    if (err) { $('pErr').textContent = err; return; }
    var data = {name:name, unit:$('pUnit').value, min:r3(min), cost:Math.round(cost * 100) / 100, supplier:$('pSup').value.trim(), phone:$('pPhone').value.trim()};
    if (f.dataset.id) {
      var p2 = find(f.dataset.id), wasLow = isLow(p2);
      Object.keys(data).forEach(function(k){ p2[k] = data[k]; });
      var isLowNow = isLow(p2), statusDate = todayISO();
      if (!wasLow && isLowNow) { p2.lowSinceDate = statusDate; addStatusLog('low', p2, statusDate); }
      else if (wasLow && !isLowNow) { p2.lowSinceDate = null; addStatusLog('normal', p2, statusDate); }
      else if (!isLowNow) p2.lowSinceDate = null;
      delete override[p2.id];
    } else {
      data.id = newId(); data.qty = r3(qty); data.lastPurchaseDate = null;
      if (isLow(data)) { data.lowSinceDate = todayISO(); state.products.push(data); addStatusLog('low', data, data.lowSinceDate); }
      else { data.lowSinceDate = null; state.products.push(data); }
    }
    save(); closeSheet(); render(); toast('Produto salvo');
  }
});

async function boot(){
  var startup = $('appStartup');
  var bootCompleted = false;
  function finishStartup(){
    if (startup) startup.hidden = true;
    window.dispatchEvent(new Event('estoque:ready'));
  }
  try {
    // Leia snapshot, rascunho e disponibilidade do IndexedDB em paralelo.
    // Assim, uma demora do banco não soma três esperas sequenciais na tela inicial.
    var bootData = await Promise.all([
      loadAppState(KEY),
      loadDraft(STASH_KEY),
      isIndexedDBAvailable()
    ]);
    var loaded = bootData[0];
    var normalizedState = loaded && loaded.value ? sanitize(loaded.value) : null;
    state = normalizedState || demoState();
    ensureStateOperationIds(state);
    lastCommittedSnapshot = JSON.parse(JSON.stringify(state));

    var savedDraft = bootData[1];
    stashMem = savedDraft ? sanitize(savedDraft) : null;

    indexedDbReady = !!bootData[2];
    persisted = !!normalizedState || indexedDbReady || isLocalStorageAvailable();
    storageFallback = !indexedDbReady && persisted;

    // Migra o localStorage legado e consolida o formato já normalizado no IndexedDB.
    if (normalizedState) {
      var changed = JSON.stringify(normalizedState) !== JSON.stringify(loaded.value);
      if (loaded.source !== 'indexeddb' || changed) {
        var migrated = await saveAppState(KEY, normalizedState);
        indexedDbReady = !!migrated.indexedDBOk;
        persisted = !!migrated.ok;
        storageFallback = !indexedDbReady && !!migrated.localStorageOk;
      }
    }
    // Também importa o rascunho antigo de demonstração para IndexedDB.
    if (stashMem) saveDraft(STASH_KEY, stashMem).catch(function(){});

    await restoreFallbackSyncQueue(KEY).catch(function(error){ console.warn('A fila local de sincronização será recuperada quando o IndexedDB estiver disponível:', error); });
    await initSyncEngine({
      onStatus: renderSyncStatus,
      canApplyRemoteState: function(){ var overlay = $('overlay'); return indexedDbReady && (!overlay || overlay.hidden); },
      applyRemoteState: applyCloudSnapshot
    });
    render();
    renderSyncStatus(getSyncStatus());
    finishStartup();
    bootCompleted = true;
    window.setTimeout(showFirstUseWelcome, 120);
    if (isSupabaseConfigured()) {
      getCloudAccount().then(function(account){
        if (account.session && account.store) activateCloudStore(account.store).catch(function(error){
          console.warn('Não foi possível retomar a sincronização automática:', error);
        });
      }).catch(function(error){ console.warn('A sessão na nuvem não pôde ser verificada:', error); });
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){});
  } catch(error) {
    console.error('Falha ao inicializar o armazenamento:', error);
    state = state || demoState();
    indexedDbReady = false;
    persisted = false;
    storageFallback = false;
    render();
    finishStartup();
    toast('Não foi possível carregar o armazenamento principal. O modo local de compatibilidade foi ativado; confira seu backup antes de continuar.');
  } finally {
    // Última proteção: nenhuma falha inesperada deve manter a tela de carregamento presa.
    if (!bootCompleted && startup && !startup.hidden) finishStartup();
  }
}

boot().catch(function(error){
  console.error('Erro inesperado na inicialização:', error);
  var startup = $('appStartup');
  if (startup) startup.hidden = true;
  window.dispatchEvent(new Event('estoque:ready'));
});
