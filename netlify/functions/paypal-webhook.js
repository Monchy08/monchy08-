const { paypalBase, getAccessToken, sheetsCall, formatShipping, json } = require('../lib/shop');

const STATUS = {
  'PAYMENT.CAPTURE.COMPLETED': 'COMPLETADO',
  'PAYMENT.CAPTURE.DENIED': 'DENEGADO',
  'PAYMENT.CAPTURE.PENDING': 'PENDIENTE',
};

async function verifySignature(headers, webhookEvent) {
  const token = await getAccessToken();
  const res = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent,
    }),
  });
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

// Lee la orden en PayPal (servidor a servidor) para obtener destinatario, dirección de envío y email del pagador.
// El aviso de captura no incluye la dirección. Si PayPal no responde se lanza error → 500 → PayPal reintenta.
async function getOrderDetails(paypalOrderId) {
  if (!paypalOrderId) return { payerEmail: '', shipping: null };
  const token = await getAccessToken();
  const res = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) { console.error('Orden no encontrada en PayPal:', paypalOrderId); return { payerEmail: '', shipping: null }; }
  if (!res.ok) throw new Error('No se pudo leer la orden de PayPal (' + res.status + ')');
  const o = await res.json();
  const pu = (o.purchase_units && o.purchase_units[0]) || {};
  return { payerEmail: (o.payer && o.payer.email_address) || '', shipping: formatShipping(pu.shipping) };
}

// GA4 Measurement Protocol. transaction_id = Capture ID → GA4 deduplica reintentos.
// TRACKING_DISABLED=true (contexto de pruebas en Netlify) → no se envía nada a GA4 ni a Meta.
const trackingOff = () => String(process.env.TRACKING_DISABLED || '').toLowerCase() === 'true';

async function sendPurchaseToGA4({ captureId, value, currency, items, clientId, sessionId }) {
  if (trackingOff()) { console.log('GA4 omitido: TRACKING_DISABLED'); return; }
  if (!process.env.GA4_MEASUREMENT_ID || !process.env.GA4_API_SECRET) return;
  const params = {
    transaction_id: captureId,
    currency,
    value: Number(value),
    engagement_time_msec: 1, // valor técnico requerido por GA4; el servidor no mide tiempo real
    items: items.map((it) => ({
      item_id: it.sku,
      item_name: it.name,
      item_variant: [it.dollLabel, it.colorLabel, it.size ? `Talla ${it.size}` : ''].filter(Boolean).join(' / '),
      price: Number(it.unitPrice),
      quantity: Number(it.qty) || 1,
    })),
  };
  if (sessionId) params.session_id = sessionId;
  const res = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`, {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId || ('server.' + captureId), events: [{ name: 'purchase', params }] }),
  });
  if (!res.ok) throw new Error('GA4 respondió ' + res.status);
}

// Meta Conversions API. event_id = Capture ID → Meta deduplica reintentos.
async function sendPurchaseToMeta({ captureId, value, currency, items, attribution }) {
  if (trackingOff()) { console.log('Meta CAPI omitido: TRACKING_DISABLED'); return; }
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN) {
    console.log('Meta CAPI omitido: faltan META_PIXEL_ID o META_CAPI_ACCESS_TOKEN');
    return;
  }
  const a = attribution || {};
  const userData = {};
  if (a.fbp) userData.fbp = a.fbp;
  if (a.fbc) userData.fbc = a.fbc;
  if (a.userAgent) userData.client_user_agent = a.userAgent;
  if (a.clientIp) userData.client_ip_address = a.clientIp;
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v25.0';
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: captureId,
        action_source: 'website',
        user_data: userData,
        custom_data: {
          value: Number(value),
          currency,
          content_type: 'product',
          contents: items.map((it) => ({ id: it.sku, quantity: Number(it.qty) || 1, item_price: Number(it.unitPrice) })),
          num_items: items.reduce((s, it) => s + (Number(it.qty) || 1), 0),
        },
      }],
    }),
  });
  const text = await res.text();
  console.log('Meta CAPI response:', res.status, text.slice(0, 300));
  if (!res.ok) throw new Error('Meta CAPI respondió ' + res.status);
}

// Pedidos creados con la versión anterior (custom_id con la configuración separada por "|").
// Solo para órdenes que estaban abiertas durante el cambio de versión.
async function handleLegacy(r, status) {
  const [orderId, doll, size, included, extra, qty, clientId, sessionId] = (r.custom_id || '').split('|');
  const extraList = extra && extra !== 'none' ? extra.split('-').filter(Boolean) : [];
  if (process.env.SHEETS_WEBHOOK_URL) {
    await fetch(process.env.SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.SHEETS_SECRET, orderId, customerName: '', email: r.payer?.email_address || '',
        paypalOrderId: r.supplementary_data?.related_ids?.order_id || '', paypalCaptureId: r.id, status,
        doll, size, includedLooks: (included || '').split('-').join(', '), extraLooks: extraList.join(', '), qty,
        basePrice: 43, extrasTotal: extraList.length * 10, totalPaid: r.amount?.value || '', currency: r.amount?.currency_code || 'USD',
        notes: 'Registrado vía webhook (formato anterior)',
      }),
    });
  }
  if (status === 'COMPLETADO') {
    const q = Number(qty) || 1;
    const value = r.amount?.value || '0';
    const items = [{ sku: 'tshirt-intercambiable', name: 'T-Shirt intercambiable', dollLabel: doll, size, unitPrice: (Number(value) / q).toFixed(2), qty: q }];
    await sendPurchaseToGA4({ captureId: r.id, value, currency: r.amount?.currency_code || 'USD', items, clientId: clientId !== 'none' ? clientId : null, sessionId: sessionId !== 'none' ? sessionId : null });
    await sendPurchaseToMeta({ captureId: r.id, value, currency: r.amount?.currency_code || 'USD', items, attribution: {} });
  }
  return json(200, { ok: true, legacy: true });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let webhookEvent;
  try { webhookEvent = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'JSON inválido' }); }

  try {
    if (!(await verifySignature(event.headers || {}, webhookEvent))) {
      return json(400, { error: 'Firma de webhook inválida' });
    }
    const status = STATUS[webhookEvent.event_type];
    console.log('Webhook recibido:', webhookEvent.event_type, webhookEvent.id || '');
    if (!status) return json(200, { ok: true, ignored: webhookEvent.event_type });

    const r = webhookEvent.resource || {};
    const customId = r.custom_id || '';
    if (customId.includes('|')) return await handleLegacy(r, status);

    const amount = (r.amount && r.amount.value) || '0';
    const currency = (r.amount && r.amount.currency_code) || 'USD';
    const paypalOrderId = (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || '';

    const details = status === 'DENEGADO' ? { payerEmail: '', shipping: null } : await getOrderDetails(paypalOrderId);

    // El Sheet reconcilia el estado con bloqueo (idempotente) y responde si este aviso ya se había procesado.
    const rec = await sheetsCall('record_payment', {
      paypalOrderId, orderId: customId, captureId: r.id, status, amount, currency,
      payerEmail: (r.payer && r.payer.email_address) || details.payerEmail || '',
      shipping: details.shipping,
      webhookEventId: webhookEvent.id || '',
    });

    if (rec.notFound) {
      console.error('Pedido no encontrado en el Sheet:', paypalOrderId, customId);
      return json(200, { ok: true, notFound: true });
    }

    // Compra solo para PAGADO. "REVISAR" (monto o moneda distintos) no se envía a GA4 ni a Meta.
    if (rec.eventsPending && rec.status === 'PAGADO') {
      const o = rec.order;
      const a = o.attribution || {};
      await sendPurchaseToGA4({ captureId: r.id, value: amount, currency, items: o.items, clientId: a.gaClientId, sessionId: a.gaSessionId });
      await sendPurchaseToMeta({ captureId: r.id, value: amount, currency, items: o.items, attribution: a });
      await sheetsCall('mark_events_sent', { paypalOrderId: o.paypalOrderId });
    }

    return json(200, { ok: true, status: rec.status, duplicate: !!rec.duplicate, eventsSent: !!(rec.eventsPending && rec.status === 'PAGADO') });
  } catch (err) {
    // 500 → PayPal reintenta el aviso. Es seguro: el Sheet descarta duplicados y los eventos se deduplican por Capture ID.
    console.error('Webhook error:', err.message);
    return json(500, { error: err.message });
  }
};
