const PAYPAL_API = (env) => (env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function getAccessToken() {
  const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('No se pudo obtener el token de PayPal');
  const data = await res.json();
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const { orderId } = JSON.parse(event.body || '{}');
    if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: 'Falta orderId' }) };

    const token = await getAccessToken();
    const base = PAYPAL_API(process.env.PAYPAL_ENV || 'sandbox');
    const res = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: 'No se pudo capturar el pago', details: data }) };
    }

    // No marcamos nada como "pagado" salvo que PayPal confirme status COMPLETED aquí.
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    const isCompleted = data.status === 'COMPLETED';

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: data.status,
        paid: isCompleted,
        captureId: capture?.id || null,
        amount: capture?.amount?.value || null,
        currency: capture?.amount?.currency_code || 'USD',
        payerEmail: data.payer?.email_address || null,
        payerName: data.payer?.name ? `${data.payer.name.given_name || ''} ${data.payer.name.surname || ''}`.trim() : null,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
