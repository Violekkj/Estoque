// Contrato dos dados, validação e migração de registros antigos.
import { clean, newId, r3, isDateValue, dateISO } from "../core/utils.js";

export function sanitize(obj){
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.products)) return null;
  var units = ['un','kg','g','L','ml','cx','pct','fardo'];
  var out = {shop: clean(obj.shop, 60), demo: false, products: [], log: []};
  var productIds = Object.create(null);
  var usedEventIds = Object.create(null);

  obj.products.slice(0, 2000).forEach(function(p){
    if (!p || typeof p !== 'object') return;
    var name = clean(p.name, 80).trim();
    if (!name) return;
    var num = function(v){ var n = Number(v); return isFinite(n) && n >= 0 ? r3(n) : 0; };
    var id = clean(p.id, 30).trim();
    if (!id || productIds[id]) id = newId();
    productIds[id] = true;
    out.products.push({
      id: id, name: name,
      unit: units.indexOf(p.unit) >= 0 ? p.unit : 'un',
      qty: num(p.qty), min: num(p.min), cost: Math.round(num(p.cost) * 100) / 100,
      supplier: clean(p.supplier, 60).trim(), phone: clean(p.phone, 20).trim(),
      lowSinceDate: isDateValue(p.lowSinceDate) ? p.lowSinceDate : null,
      lastPurchaseDate: isDateValue(p.lastPurchaseDate) ? p.lastPurchaseDate : null
    });
  });

  (Array.isArray(obj.log) ? obj.log : []).slice(0, 10000).forEach(function(l){
    if (!l || typeof l !== 'object') return;
    var t = Number(l.t);
    if (!isFinite(t)) return;
    var id = clean(l.id, 30).trim();
    // A history record is only valid while its product exists.
    // This removes old/orphan movements left behind by previous app versions.
    if (!id || !productIds[id]) return;

    var eventType = ['movement','low','normal'].indexOf(l.event) >= 0 ? l.event : 'movement';
    var eventId = clean(l.eventId, 50).trim() || newId();
    if (usedEventIds[eventId]) eventId = newId();
    usedEventIds[eventId] = true;
    var item = {
      eventId: eventId,
      operationId: clean(l.operationId, 60) || null,
      sourceMovementId: clean(l.sourceMovementId, 80) || null,
      event: eventType, t: t, date: isDateValue(l.date) ? l.date : dateISO(t),
      id: id, name: clean(l.name, 80), unit: clean(l.unit, 8)
    };
    if (eventType === 'movement') {
      var d = Number(l.d), a = Number(l.after);
      if (!isFinite(d) || !isFinite(a) || d === 0) return;
      item.d = d; item.after = a;
      var minAtTime = Number(l.minAtTime);
      if (isFinite(minAtTime) && minAtTime >= 0) item.minAtTime = minAtTime;
      item.kind = l.kind === 'in' || l.kind === 'out' ? l.kind : (d > 0 ? 'in' : 'out');
      item.movementType = clean(l.movementType, 40) || null;
      item.note = clean(l.note, 500) || null;
      item.enteredLow = !!l.enteredLow;
      item.leftLow = !!l.leftLow;
    } else {
      var qty = Number(l.qty), min = Number(l.min);
      item.qty = isFinite(qty) && qty >= 0 ? qty : 0;
      item.min = isFinite(min) && min >= 0 ? min : 0;
    }
    out.log.push(item);
  });

  // Linked status events must point to a movement that still exists.
  var movementIds = Object.create(null);
  out.log.forEach(function(item){ if (item.event === 'movement') movementIds[item.eventId] = true; });
  out.log = out.log.filter(function(item){
    return !item.sourceMovementId || !!movementIds[item.sourceMovementId];
  });

  // Migrate the latest purchase date from valid history when older data has no product date.
  out.products.forEach(function(p){
    if (p.lastPurchaseDate) return;
    var latest = null;
    out.log.forEach(function(item){
      if (item.event === 'movement' && item.kind === 'in' && item.id === p.id && (!latest || item.t > latest.t)) latest = item;
    });
    if (latest) p.lastPurchaseDate = latest.date;
  });
  out.demo = !!obj.demo;
  return out;
}

export function demoState(){
  var P = function(name, unit, qty, min, cost, supplier){ return {id:newId(), name:name, unit:unit, qty:qty, min:min, cost:cost, supplier:supplier, phone:''}; };
  return {shop:'', demo:true, log:[], products:[
    P('Arroz branco 5 kg','un',18,10,24.9,'Distribuidora Santa Rita'),
    P('Feijão carioca 1 kg','un',6,20,7.8,'Distribuidora Santa Rita'),
    P('Óleo de soja 900 ml','un',40,24,6.5,'Distribuidora Santa Rita'),
    P('Açúcar refinado 1 kg','un',9,12,4.2,'Distribuidora Santa Rita'),
    P('Café torrado 500 g','un',3,8,16.9,'Café Serra Alta'),
    P('Refrigerante 2 L','un',30,18,6.9,'Bebidas Vila Nova'),
    P('Água mineral 500 ml','un',12,48,1.2,'Bebidas Vila Nova'),
    P('Detergente 500 ml','un',22,10,1.8,'')
  ]};
}
