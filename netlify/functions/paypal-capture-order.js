const { paypalBase, getAccessToken, json } = require('../lib/shop');

// Captura el pago tras la aprobación del cliente. Solo informa al navegador; el registro oficial
// como PAGADO lo hace el webhook verificado (PAYMENT.CAPTURE.COMPLETED).
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const { orderId, simular } = JSON.parse(event.body || '{}');
    if (!orderId || typeof orderId !== 'string') return json(400, { error: 'Falta orderId' });

    const headers = { Authorization: '', 'Content-Type': 'application/json' };
    // Solo en pruebas (sandbox + TRACKING_DISABLED=true): simula un rechazo con el mecanismo oficial de PayPal sandbox.
    const testEnv = (process.env.PAYPAL_ENV || 'sandbox') !== 'live' && String(process.env.TRACKING_DISABLED || '').toLowerCase() === 'true';
    if (testEnv && simular === 'INSTRUMENT_DECLINED') headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });

    headers.Authorization = `Bearer ${await getAccessToken()}`;
    const res = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', headers });
    const data = await res.json();

    if (!res.ok) {
      const issue = data && data.details && data.details[0] && data.details[0].issue;
      console.error('Capture error:', res.status, issue, JSON.stringify(data).slice(0, 500));
      if (issue === 'INSTRUMENT_DECLINED') return json(200, { paid: false, retry: true, issue, status: 'DECLINED' });
      if (issue === 'ORDER_ALREADY_CAPTURED') return json(200, { paid: false, alreadyCaptured: true, issue, status: 'ALREADY_CAPTURED', error: 'Este pago ya fue procesado. Revisa tu correo de confirmación de PayPal.' });
      return json(502, { paid: false, issue: issue || null, status: 'FAILED', error: 'No se pudo completar el pago. No se realizó ningún cargo.' });
    }

    const unit = (data.purchase_units && data.purchase_units[0]) || {};
    const capture = unit.payments && unit.payments.captures && unit.payments.captures[0];
    const captureStatus = capture ? capture.status : null;

    return json(200, {
      status: data.status,
      captureStatus,
      paid: data.status === 'COMPLETED' && captureStatus === 'COMPLETED',
      pending: captureStatus === 'PENDING',
      orderId: unit.reference_id || null,
      captureId: capture ? capture.id : null,
      amount: capture && capture.amount ? capture.amount.value : null,
      currency: capture && capture.amount ? capture.amount.currency_code : 'USD',
      payerEmail: (data.payer && data.payer.email_address) || null,
      payerName: data.payer && data.payer.name ? `${data.payer.name.given_name || ''} ${data.payer.name.surname || ''}`.trim() : null,
    });
  } catch (err) {
    console.error('capture-order error:', err.message);
    return json(500, { paid: false, error: 'No pudimos confirmar el pago. Si PayPal te muestra un cargo, escríbenos antes de intentar de nuevo.' });
  }
};
