// Funções puras compartilhadas pelo aplicativo.
const BRL = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'});
export function fmtMoney(n){ return BRL.format(n || 0); }
export function fmtQty(n){ return (Number(n) || 0).toLocaleString('pt-BR', {maximumFractionDigits:3}); }
export function r3(n){ return Math.round(n * 1000) / 1000; }
export function parseNum(v){
  var s = String(v == null ? '' : v).trim().replace(',', '.');
  if (s === '') return NaN;
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}
export function isLow(p){ return p.qty < p.min; }
export function isDateValue(value){
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var parts = value.split('-').map(Number);
  var d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
}
export function dateISO(timestamp){
  var d = new Date(timestamp);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function todayISO(){ return dateISO(Date.now()); }
export function fmtISODate(value){
  if (!isDateValue(value)) return 'Data não registrada';
  var p = value.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('pt-BR');
}
export function totalValue(list){ return list.reduce(function(s, p){ return s + p.qty * p.cost; }, 0); }
export function suggest(p){ return Math.max(0, Math.ceil(r3(p.min * 2 - p.qty))); }
export function supplierKey(p){ return (p.supplier || '').trim() || 'Sem fornecedor'; }
export function groupBuy(products, override){
  var map = {}, order = [];
  products.filter(isLow).forEach(function(p){
    var k = supplierKey(p);
    if (!map[k]) { map[k] = {key:k, phone:'', items:[]}; order.push(k); }
    var g = map[k];
    if (!g.phone && p.phone) g.phone = p.phone;
    var q = (override && override[p.id] != null) ? override[p.id] : suggest(p);
    g.items.push({id:p.id, name:p.name, unit:p.unit, q:q, cost:p.cost, lowSinceDate:p.lowSinceDate || null});
  });
  var groups = order.map(function(k){ return map[k]; });
  groups.sort(function(a, b){
    if (a.key === 'Sem fornecedor') return 1;
    if (b.key === 'Sem fornecedor') return -1;
    return a.key.localeCompare(b.key, 'pt-BR');
  });
  return groups;
}
export function validItems(g){ return g.items.filter(function(i){ return i.q > 0; }); }
export function groupCost(g){ return validItems(g).reduce(function(s, i){ return s + i.q * i.cost; }, 0); }
export function buildMessage(shop, g){
  var lines = validItems(g).map(function(i){ return '• ' + i.name + ' — ' + fmtQty(i.q) + ' ' + i.unit; });
  var who = (shop || '').trim();
  return 'Olá! ' + (who ? 'Aqui é da *' + who + '*. ' : '') + 'Preciso fazer um pedido:\n\n' +
    lines.join('\n') + '\n\nPode confirmar o valor e o prazo de entrega? Obrigado!';
}
export function waLink(phone, text){
  var d = String(phone || '').replace(/\D/g, '');
  if (d && d.length <= 11) d = '55' + d;
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
}
export function clean(s, max){ return String(s == null ? '' : s).slice(0, max); }
export function newId(){ return Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
export function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
export function fmtDate(t){ return new Date(t).toLocaleString('pt-BR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}); }
