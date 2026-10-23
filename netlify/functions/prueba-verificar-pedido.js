const { paypalBase, getAccessToken, sheetsCall, formatShipping } = require('../lib/shop');

// Herramienta de PRUEBAS: compara una orden de PayPal sandbox con lo registrado en el Sheet de pruebas.
// Solo responde si PAYPAL_ENV no es "live" y TRACKING_DISABLED=true. En producción devuelve 404.
// Uso: /.netlify/functions/prueba-verificar-pedido?paypalOrderId=XXXX
const enabled = () => (process.env.PAYPAL_ENV || 'sandbox') !== 'live' && String(process.env.TRACKING_DISABLED || '').toLowerCase() === 'true';
const cents = (v) => Math.round(Number(v) * 100);
const text = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' }, body });

exports.handler = async (event) => {
  if (!enabled()) return { statusCode: 404, body: 'Not found' };
  const id = (event.queryStringParameters || {}).paypalOrderId;
  if (!id || !/^[A-Za-z0-9-]{5,40}$/.test(id)) return text(400, 'Falta ?paypalOrderId= (está en la columna B de "Pedidos v2" o en el enlace de la confirmación de pago).');

  try {
    const token = await getAccessToken();
    const res = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    const pp = await res.json();
    if (!res.ok) return text(502, 'PayPal sandbox no encontró la orden ' + id);
    const sh = await sheetsCall('get_order', { paypalOrderId: id });
    if (sh.notFound) return text(404, 'La orden ' + id + ' no está en el Sheet de pruebas ("Pedidos v2").');

    const o = sh.order;
    const pu = pp.purchase_units[0];
    const ppItems = pu.items || [];
    const cap = pu.payments && pu.payments.captures && pu.payments.captures[0];
    const checks = [];
    const add = (name, ok, detail) => checks.push({ ok: !!ok, name, detail: detail === undefined ? '' : String(detail) });

    add('Total PayPal = total Sheet', cents(pu.amount.value) === cents(o.total), `PayPal ${pu.amount.value} / Sheet ${o.total}`);
    add('Mismo número de líneas (PayPal / Pedidos v2 / Artículos v2)', ppItems.length === o.items.length && o.items.length === o.itemRows.length, `${ppItems.length} / ${o.items.length} / ${o.itemRows.length}`);
    o.items.forEach((it, i) => {
      const L = `Línea ${it.line}`;
      const p = ppItems.find((x) => x.sku === it.sku && x.description === it.description.slice(0, 127)) || ppItems[i];
      const row = o.itemRows.find((r) => Number(r.line) === Number(it.line));
      const expected = [it.colorLabel, `Talla ${it.size}`, `Looks ${it.includedLabels.join(' ')}`]
        .concat(it.extraLabels.length ? [`Extra ${it.extraLabels.join(' ')}`] : [])
        .concat(it.customName ? [`Nombre: ${it.customName}`] : []);
      add(`${L}: cantidad`, p && Number(p.quantity) === it.qty && row && row.qty === it.qty, `PayPal ${p && p.quantity} / Sheet ${row && row.qty} / pedido ${it.qty}`);
      add(`${L}: precio unitario`, p && cents(p.unit_amount.value) === cents(it.unitPrice) && row && cents(row.unitPrice) === cents(it.unitPrice), `PayPal ${p && p.unit_amount.value} / Sheet ${row && row.unitPrice}`);
      add(`${L}: muñeca, color, talla, looks y nombre en PayPal`, p && p.description.startsWith(it.dollLabel) && expected.every((s) => p.description.includes(s)), p && p.description);
      add(`${L}: muñeca, color, talla, looks y nombre en Artículos v2`, row && row.dollLabel === it.dollLabel && row.colorLabel === it.colorLabel && row.size === it.size
        && String(row.customName || '') === String(it.customName || '') && row.includedLabels === it.includedLabels.join(', ') && String(row.extraLabels || '') === it.extraLabels.join(', '),
        row && `${row.dollLabel} | ${row.colorLabel} | ${row.size} | ${row.includedLabels} | ${row.extraLabels || '—'} | ${row.customName || '—'}`);
    });
    add('PayPal: orden y captura COMPLETED', pp.status === 'COMPLETED' && cap && cap.status === 'COMPLETED', `${pp.status} / ${cap && cap.status}`);
    add('Sheet: estado PAGADO (y artículos PAGADO)', o.status === 'PAGADO' && o.itemRows.every((r) => r.status === 'PAGADO'), o.status);
    add('Webhook con firma verificada registró la captura', cap && o.history.includes('COMPLETADO:' + cap.id), o.history.join(', ') || 'sin avisos');
    add('Capture ID y monto del Sheet = PayPal', cap && o.captureId === cap.id && cents(o.captured) === cents(cap.amount.value), `${o.captureId} ${o.captured}`);
    const ship = formatShipping(pu.shipping);
    add('Destinatario y dirección de envío del Sheet = PayPal', ship.name && ship.address && o.shipName === ship.name && o.shipAddress === ship.address, `${o.shipName || '—'} | ${o.shipAddress || '—'}`);
    add('Una sola fila del pedido', o.rowCount === 1, o.rowCount);
    add('Un solo correo de aviso', o.mailsSent === 1, o.mailsSent);

    const failed = checks.filter((c) => !c.ok).length;
    const lines = [
      `VERIFICACIÓN DE PEDIDO (sandbox) — ${failed === 0 ? 'TODO CORRECTO' : failed + ' FALLA(S)'}`,
      `PayPal Order ID: ${id}   Pedido: ${o.orderId}   Entorno: ${o.env}`,
      '',
      ...checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`),
      '',
      `Avisos de webhook duplicados recibidos e ignorados: ${o.duplicateNotices}`,
      `Eventos de compra marcados: ${o.eventsSent ? 'sí (con TRACKING_DISABLED no se envían a GA4/Meta)' : 'no'}`,
    ];
    return text(200, lines.join('\n'));
  } catch (err) {
    return text(500, 'Error al verificar: ' + err.message);
  }
};
