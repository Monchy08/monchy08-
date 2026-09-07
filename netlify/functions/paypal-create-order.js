// Shared PayPal helpers
const PAYPAL_API = (env) => (env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function getAccessToken() {
  const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('No se pudo obtener el token de PayPal (revisa PAYPAL_CLIENT_ID/SECRET)');
  const data = await res.json();
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    const { doll, size, includedLooks, extraLooks, qty } = body;

    if (!doll || !size || !Array.isArray(includedLooks) || includedLooks.length !== 3 || !Array.isArray(extraLooks) || !qty || qty < 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Configuración de pedido inválida' }) };
    }

    // Precio calculado SIEMPRE en servidor — nunca se confía en un total enviado por el navegador.
    const basePrice = 43;
    const extraAmount = extraLooks.length * 10;
    const unitPrice = basePrice + extraAmount;
    const total = unitPrice * qty;

    const orderId = 'ENC-' + Date.now();
    const customId = [orderId, doll, size, includedLooks.join('-'), extraLooks.length ? extraLooks.join('-') : 'none', qty]
      .join('|')
      .slice(0, 127);

    const token = await getAccessToken();
    const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
    const res = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: customId,
            description: `T-Shirt intercambiable — ${doll}, talla ${size}`.slice(0, 127),
            amount: { currency_code: 'USD', value: total.toFixed(2) },
          },
        ],
      }),
    });
    const order = await res.json();
    if (!res.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: 'No se pudo crear la orden de PayPal', details: order }) };
    }
    return { statusCode: 200, body: JSON.stringify({ id: order.id, total: total.toFixed(2) }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
