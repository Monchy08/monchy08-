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
  const [orderId, doll, size, included, extra, qty] = parts;
  return {
    orderId: orderId || '',
    doll: doll || '',
    size: size || '',
    includedLooks: included || '',
    extraLooks: extra === 'none' ? '' : extra || '',
    qty: qty || '1',
  };
}

async function logToSheet(row) {
  if (!process.env.SHEETS_WEBHOOK_URL) return;
  await fetch(process.env.SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: process.env.SHEETS_SECRET, ...row }),
  });
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
    const extraCount = config.extraLooks ? config.extraLooks.split('-').length : 0;

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

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
