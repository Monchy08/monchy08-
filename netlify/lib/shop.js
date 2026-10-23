// Encantelia — lógica compartida de la tienda (solo servidor).
// Única fuente de verdad para productos, opciones válidas y precios. El navegador nunca define precios.

const CATALOG = {
  'tshirt-intercambiable': {
    name: 'T-Shirt intercambiable',
    skuPrefix: 'TSI',
    baseCents: 4300,          // T-Shirt + muñeca sublimada + 3 looks completos
    extraLookCents: 1000,     // cada look adicional
    includedLooks: 3,
    maxQty: 20,
    maxNameLength: 20,
    dolls: { doll1: 'Piel clara', doll2: 'Piel morena', doll3: 'Piel oscura' },
    colors: {
      rosa: 'Rosa', blanco: 'Blanco', negro: 'Negro', lavanda: 'Lavanda', menta: 'Verde menta',
      celeste: 'Azul cielo', amarillo: 'Amarillo', naranja: 'Naranja', rojo: 'Rojo', marino: 'Azul marino',
    },
    sizes: ['3T', '4T', '5/6', '7/8', '10/12'],
    looks: { look1: 'L01', look2: 'L02', look3: 'L03', look4: 'L04', look5: 'L05', look6: 'L06', look7: 'L07', look8: 'L08' },
  },
};
const MAX_LINES = 20;
const CURRENCY = 'USD';

class ValidationError extends Error {}

const money = (cents) => (cents / 100).toFixed(2);

function cleanName(value, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ValidationError('Nombre personalizado inválido');
  const s = value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new ValidationError(`El nombre personalizado admite máximo ${max} caracteres`);
  return s;
}

function priceLine(raw, index) {
  const n = index + 1;
  if (!raw || typeof raw !== 'object') throw new ValidationError(`Artículo ${n}: formato inválido`);
  const p = CATALOG[raw.productId];
  if (!p) throw new ValidationError(`Artículo ${n}: producto no disponible`);

  const { dollId, colorId, size } = raw;
  if (!Object.prototype.hasOwnProperty.call(p.dolls, dollId)) throw new ValidationError(`Artículo ${n}: muñeca no válida`);
  if (!Object.prototype.hasOwnProperty.call(p.colors, colorId)) throw new ValidationError(`Artículo ${n}: color no válido`);
  if (!p.sizes.includes(size)) throw new ValidationError(`Artículo ${n}: talla no válida`);

  const inc = raw.includedLookIds;
  const ext = raw.extraLookIds === undefined || raw.extraLookIds === null ? [] : raw.extraLookIds;
  if (!Array.isArray(inc) || inc.length !== p.includedLooks) throw new ValidationError(`Artículo ${n}: debe incluir exactamente ${p.includedLooks} looks`);
  if (!Array.isArray(ext)) throw new ValidationError(`Artículo ${n}: looks adicionales inválidos`);
  const all = inc.concat(ext);
  if (all.some((id) => !Object.prototype.hasOwnProperty.call(p.looks, id))) throw new ValidationError(`Artículo ${n}: look no válido`);
  if (new Set(all).size !== all.length) throw new ValidationError(`Artículo ${n}: hay looks repetidos`);

  const qty = raw.qty;
  if (!Number.isInteger(qty) || qty < 1 || qty > p.maxQty) throw new ValidationError(`Artículo ${n}: cantidad inválida (1 a ${p.maxQty})`);

  const customName = cleanName(raw.customName, p.maxNameLength);
  const unitCents = p.baseCents + ext.length * p.extraLookCents;
  const lineCents = unitCents * qty;
  const includedLabels = inc.map((id) => p.looks[id]);
  const extraLabels = ext.map((id) => p.looks[id]);
  const dollLabel = p.dolls[dollId];
  const colorLabel = p.colors[colorId];
  const sku = [p.skuPrefix, dollId, colorId, size.replace('/', '-')].join('-').toUpperCase();
  const description = [
    dollLabel, colorLabel, `Talla ${size}`, `Looks ${includedLabels.join(' ')}`,
    extraLabels.length ? `Extra ${extraLabels.join(' ')}` : '',
    customName ? `Nombre: ${customName}` : '',
  ].filter(Boolean).join(' | ');

  return {
    line: n, productId: raw.productId, sku, name: p.name,
    dollId, dollLabel, colorId, colorLabel, size,
    includedLookIds: inc.slice(), includedLabels, extraLookIds: ext.slice(), extraLabels,
    customName, qty, unitCents, lineCents, unitPrice: money(unitCents), lineTotal: money(lineCents), description,
  };
}

function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ValidationError('El carrito no tiene artículos con precio');
  if (items.length > MAX_LINES) throw new ValidationError(`Máximo ${MAX_LINES} artículos por pedido`);
  const lines = items.map(priceLine);
  const totalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  return { lines, totalCents, total: money(totalCents), currency: CURRENCY };
}

const paypalBase = () => ((process.env.PAYPAL_ENV || 'sandbox') === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('No se pudo obtener el token de PayPal (revisa PAYPAL_CLIENT_ID/SECRET)');
  return (await res.json()).access_token;
}

// Llama al Apps Script del Sheet. Lanza error si no responde {ok:true}: quien llama decide si eso bloquea.
async function sheetsCall(action, payload, timeoutMs = 9000) {
  if (!process.env.SHEETS_WEBHOOK_URL) throw new Error('SHEETS_WEBHOOK_URL no configurado');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(process.env.SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.SHEETS_SECRET, action, ...payload }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`Sheet (${action}): respuesta no válida`); }
    if (!data.ok) throw new Error(`Sheet (${action}): ${data.error || 'error desconocido'}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Destinatario y dirección tal como los devuelve PayPal en purchase_units[0].shipping.
function formatShipping(shipping) {
  const s = shipping || {};
  const a = s.address || {};
  return {
    name: (s.name && s.name.full_name) || '',
    address: [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean).join(', '),
    raw: s,
  };
}

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

module.exports = { CATALOG, CURRENCY, ValidationError, priceCart, priceLine, money, paypalBase, getAccessToken, sheetsCall, formatShipping, json };
