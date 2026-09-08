const PAYPAL_API = (env) => (env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function getAccessToken() {
  const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

function decodeCustomId(customId) {
  const parts = (customId || '').split('|');
  const [orderId, doll, size, included, extra, qty, clientId, sessionId] = parts;
  const extraRaw = extra === 'none' ? '' : (extra || '');
  return {
    orderId: orderId || '',
    doll: doll || '',
    size: size || '',
    includedLooks: (included || '').split('-').join(', '),
    extraLooks: extraRaw.split('-').filter(Boolean).join(', '),
    extraCount: extraRaw ? extraRaw.split('-').filter(Boolean).length : 0,
    qty: qty || '1',
    clientId: clientId && clientId !== 'none' ? clientId : null,
    sessionId: sessionId && sessionId !== 'none' ? sessionId : null,
  };
}

// El Apps Script del Sheet también envía el correo de notificación (ver instrucción en chat).
async function logToSheet(row) {
  if (!process.env.SHEETS_WEBHOOK_URL) return;
  await fetch(process.env.SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: process.env.SHEETS_SECRET, ...row }),
  });
}

// Envía purchase a GA4 vía Measurement Protocol (server-side) — solo se llama tras verificar la firma
// del webhook y confirmar PAYMENT.CAPTURE.COMPLETED. transaction_id = Capture ID de PayPal (único/idempotente),
// así que reintentos del mismo webhook no duplican la transacción en GA4 (GA4 deduplica por transaction_id).
// clientId/sessionId reales (del navegador que compró) atribuyen la compra a su sesión/tráfico original;
// si no llegaron (bloqueador de anuncios, SDK no cargó a tiempo), cae a un client_id sintético.
async function sendPurchaseToGA4({ captureId, value, currency, doll, size, qty, clientId, sessionId }) {
  if (!process.env.GA4_MEASUREMENT_ID || !process.env.GA4_API_SECRET) return;
  const finalClientId = clientId || ('server.' + captureId);
  const params = {
    transaction_id: captureId,
    currency,
    value: Number(value),
    engagement_time_msec: 1, // Valor técnico de compatibilidad con GA4 (no es una medición real de tiempo de interacción; el servidor no tiene acceso a esa señal del navegador).
    items: [{ item_name: 'T-Shirt intercambiable', item_variant: `${doll} / talla ${size}`, price: Number(value) / (Number(qty) || 1), quantity: Number(qty) || 1 }],
  };
  if (sessionId) params.session_id = sessionId;
  await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: finalClientId,
      events: [{ name: 'purchase', params }],
    }),
  }).catch(() => {});
}

// Recupera fbp/fbc guardados al crear la orden. Nunca debe bloquear el procesamiento del webhook:
// timeout corto + catch silencioso — si falla, Purchase se envía igual sin esos campos.
async function fetchAttribution(paypalOrderId) {
  if (!process.env.SHEETS_WEBHOOK_URL || !paypalOrderId) return { fbp: null, fbc: null, userAgent: null };
  try {
    const url = `${process.env.SHEETS_WEBHOOK_URL}?action=get_attribution&paypalOrderId=${encodeURIComponent(paypalOrderId)}&secret=${encodeURIComponent(process.env.SHEETS_SECRET || '')}`;
    const res = await Promise.race([
      fetch(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200)),
    ]);
    const data = await res.json();
    return { fbp: data.fbp || null, fbc: data.fbc || null, userAgent: data.userAgent || null };
  } catch (e) {
    return { fbp: null, fbc: null, userAgent: null };
  }
}

// Envía Purchase a Meta Conversions API — solo tras verificar la firma del webhook y confirmar
// PAYMENT.CAPTURE.COMPLETED. Nunca se dispara Purchase desde el navegador.
async function sendPurchaseToMeta({ captureId, value, currency, fbp, fbc, userAgent }) {
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN) {
    console.log('Meta CAPI skipped: missing META_PIXEL_ID or META_CAPI_ACCESS_TOKEN env vars');
    return;
  }
  const apiVersion = process.env.META_GRAPH_API_VERSION || 'v25.0';
  const userData = {};
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (userAgent) userData.client_user_agent = userAgent;
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
        custom_data: { value: Number(value), currency },
      }],
      test_event_code: 'TEST93788', // TEMPORAL: quitar después de verificar en Meta Test Events.
    }),
  }).catch((e) => ({ ok: false, _fetchError: e.message }));
  try {
    const text = await res.text();
    console.log('Meta CAPI response:', res.status, text);
  } catch (e) { console.log('Meta CAPI error:', res._fetchError || e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const webhookEvent = JSON.parse(event.body || '{}');
    const headers = event.headers || {};

    // Verificar firma del webhook con PayPal antes de confiar en el evento.
    const token = await getAccessToken();
    const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
    const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
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
    const verifyData = await verifyRes.json();
    if (verifyData.verification_status !== 'SUCCESS') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Firma de webhook inválida' }) };
    }

    const eventType = webhookEvent.event_type;
    const resource = webhookEvent.resource || {};
    const statusMap = {
      'PAYMENT.CAPTURE.COMPLETED': 'COMPLETADO',
      'PAYMENT.CAPTURE.DENIED': 'DENEGADO',
      'PAYMENT.CAPTURE.PENDING': 'PENDIENTE',
    };
    const status = statusMap[eventType];
    if (!status) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: eventType }) };
    }

    const config = decodeCustomId(resource.custom_id);
    const extraCount = config.extraCount;

    // El webhook es el registro oficial/definitivo del pedido — no depende de que el navegador siga abierto.
    await logToSheet({
      orderId: config.orderId,
      customerName: '',
      email: resource.payer?.email_address || '',
      paypalOrderId: resource.supplementary_data?.related_ids?.order_id || '',
      paypalCaptureId: resource.id,
      status,
      doll: config.doll,
      size: config.size,
      includedLooks: config.includedLooks,
      extraLooks: config.extraLooks,
      qty: config.qty,
      basePrice: 43,
      extrasTotal: extraCount * 10,
      totalPaid: resource.amount?.value || '',
      currency: resource.amount?.currency_code || 'USD',
      notes: 'Registrado vía webhook',
    });

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      await sendPurchaseToGA4({
        captureId: resource.id,
        value: resource.amount?.value || 0,
        currency: resource.amount?.currency_code || 'USD',
        doll: config.doll,
        size: config.size,
        qty: config.qty,
        clientId: config.clientId,
        sessionId: config.sessionId,
      });
      const paypalOrderId = resource.supplementary_data?.related_ids?.order_id || '';
      const { fbp, fbc, userAgent } = await fetchAttribution(paypalOrderId);
      await sendPurchaseToMeta({
        captureId: resource.id,
        value: resource.amount?.value || 0,
        currency: resource.amount?.currency_code || 'USD',
        fbp,
        fbc,
        userAgent,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
