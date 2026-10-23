const { priceCart, ValidationError, paypalBase, getAccessToken, sheetsCall, json } = require('../lib/shop');

// Crea la orden de PayPal con TODOS los artículos con precio del carrito.
// Precios y opciones se revalidan aquí; el pedido completo se guarda en el Sheet antes de devolver
// el ID a PayPal. Si ese guardado falla, el checkout se detiene y no se cobra nada.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const startedAt = Date.now();

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Solicitud inválida' }); }

  let cart;
  try {
    cart = priceCart(body.items);
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { error: err.message });
    return json(500, { error: 'No se pudo calcular el pedido' });
  }

  try {
    const orderId = 'ENC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const token = await getAccessToken();
    const res = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': orderId },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: orderId,
          custom_id: orderId,   // solo el identificador interno; la configuración vive en el Sheet
          invoice_id: orderId,  // PayPal rechaza un invoice_id repetido: evita cobros duplicados del mismo pedido
          description: `Pedido Encantelia ${orderId}`,
          amount: {
            currency_code: cart.currency,
            value: cart.total,
            breakdown: { item_total: { currency_code: cart.currency, value: cart.total } },
          },
          items: cart.lines.map((l) => ({
            name: l.name.slice(0, 127),
            sku: l.sku.slice(0, 127),
            description: l.description.slice(0, 127),
            quantity: String(l.qty),
            unit_amount: { currency_code: cart.currency, value: l.unitPrice },
            category: 'PHYSICAL_GOODS',
          })),
        }],
      }),
    });
    const order = await res.json();
    if (!res.ok || !order.id) {
      console.error('PayPal create order error:', JSON.stringify(order));
      return json(502, { error: 'PayPal no pudo crear la orden. Intenta de nuevo.' });
    }

    const h = event.headers || {};
    const clientIp = h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim();
    const items = cart.lines.map(({ unitCents, lineCents, ...rest }) => rest);
    const savePayload = {
        orderId,
        paypalOrderId: order.id,
        env: process.env.PAYPAL_ENV || 'sandbox',
        currency: cart.currency,
        total: cart.total,
        items,
        attribution: {
          gaClientId: body.gaClientId || null,
          gaSessionId: body.gaSessionId || null,
          fbp: body.fbp || null,
          fbc: body.fbc || null,
          userAgent: body.userAgent ? String(body.userAgent).slice(0, 400) : null,
          clientIp: clientIp || null,
        },
    };
    // save_order es idempotente: si el primer intento falla a mitad (o se agota el tiempo), el segundo completa lo que falte.
    let saved = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && !saved; attempt++) {
      const remaining = 8500 - (Date.now() - startedAt);
      if (attempt > 1 && remaining < 2000) break;
      try {
        await sheetsCall('save_order', savePayload, Math.min(5000, Math.max(2000, remaining)));
        saved = true;
      } catch (err) {
        lastErr = err;
        console.error('save_order intento', attempt, 'falló:', err.message);
      }
    }
    if (!saved) {
      console.error('save_order failed, checkout stopped:', lastErr && lastErr.message, '| PayPal order', order.id, 'quedará sin aprobar');
      return json(503, { error: 'No pudimos registrar tu pedido, así que no se inició ningún cobro. Intenta de nuevo en unos minutos o escríbenos a encantelia.creations@gmail.com.' });
    }

    return json(200, { id: order.id, orderId, total: cart.total, currency: cart.currency });
  } catch (err) {
    console.error('create-order error:', err.message);
    return json(500, { error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
  }
};
