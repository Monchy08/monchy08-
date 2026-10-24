'use strict';
// Diagnóstico aislado. No crea transacciones, etiquetas, pedidos ni cobros.
const ORIGIN = 'https://pruebas-v2--exquisite-froyo-1dac92.netlify.app';
const PARCEL = Object.freeze({length:'15', width:'11.5', height:'1', distance_unit:'in', weight:'14', mass_unit:'oz'});
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
const reply = (statusCode, body) => ({statusCode, headers, body:JSON.stringify(body)});
function address(input, sender) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Completa ambas direcciones.');
  const out = {country:'US'};
  for (const field of ['name','street1','city','state','zip']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 120 || /[\x00-\x1f]/.test(input[field])) throw Error('Completa nombre, calle, ciudad, estado y ZIP en ambas direcciones.');
    out[field] = input[field].trim();
  }
  out.state = out.state.toUpperCase();
  if (!STATES.has(out.state) || !/^\d{5}(-\d{4})?$/.test(out.zip) || (input.country && input.country !== 'US')) throw Error('Esta prueba admite los 50 estados de USA y Washington DC. Revisa estado y ZIP.');
  if (sender && (out.zip.slice(0,5) !== '07104' || out.state !== 'NJ')) throw Error('El origen de esta prueba debe ser NJ, ZIP 07104.');
  if (input.street2) {
    if (typeof input.street2 !== 'string' || input.street2.length > 120 || /[\x00-\x1f]/.test(input.street2)) throw Error('Revisa apartamento/unidad.');
    out.street2 = input.street2.trim();
  }
  if (sender) {
    if (typeof input.email !== 'string' || input.email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw Error('Introduce el correo del remitente.');
    if (typeof input.phone !== 'string' || !/^[+\d ()-]{10,25}$/.test(input.phone)) throw Error('Introduce el teléfono del remitente.');
    out.email = input.email; out.phone = input.phone;
  }
  return out;
}
exports.handler = async (event) => {
  const env = process.env;
  let requestOrigin;
  try {requestOrigin = new URL(event.rawUrl).origin;} catch (_) {return reply(404,{error:'Prueba desactivada en este entorno.'});}
  if (requestOrigin !== ORIGIN || env.PAYPAL_ENV !== 'sandbox' || env.TRACKING_DISABLED !== 'true') return reply(404,{error:'Prueba desactivada en este entorno.'});
  if (event.httpMethod !== 'POST') return reply(405,{error:'Usa el formulario de prueba.'});
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
  if (h.origin !== ORIGIN || !(h['content-type'] || '').toLowerCase().startsWith('application/json')) return reply(403,{error:'Abre el formulario en la rama de pruebas.'});
  const token = env.SHIPPO_API_TOKEN || '';
  if (!/^shippo_test_[A-Za-z0-9]+$/.test(token)) return reply(503,{error:'Configura una clave Test válida de Shippo en esta rama y vuelve a desplegarla.'});
  if (event.isBase64Encoded || !event.body || Buffer.byteLength(event.body,'utf8') > 8192) return reply(400,{error:'Solicitud inválida o demasiado grande.'});
  let body, from, to;
  try {body=JSON.parse(event.body); from=address(body.from,true); to=address(body.to,false);} catch(e) {return reply(400,{error:e instanceof SyntaxError ? 'Solicitud JSON inválida.' : e.message});}
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),8000);
  try {
    const res = await fetch('https://api.goshippo.com/shipments/',{
      method:'POST', signal:controller.signal,
      headers:{Authorization:'ShippoToken '+token,'Content-Type':'application/json'},
      body:JSON.stringify({address_from:from,address_to:to,parcels:[PARCEL],async:false})
    });
    if (!res.ok) return reply(502,{error:res.status===401||res.status===403 ? 'Shippo no aceptó la clave o los permisos. Revisa la cuenta y la clave Test.' : res.status===400||res.status===422 ? 'Shippo no aceptó los datos. Revisa las direcciones y sus códigos postales.' : 'Shippo no pudo cotizar ahora. Inténtalo de nuevo más tarde.'});
    const data = await res.json();
    if (data.test !== true) return reply(502,{error:'Shippo no confirmó modo Test. No se mostrarán tarifas.'});
    const rates = (Array.isArray(data.rates)?data.rates:[]).filter(r=>/^(USPS|UPS|FedEx)$/i.test(r.provider || '') && r.currency==='USD' && /^\d+(\.\d{1,2})?$/.test(String(r.amount)) && Number(r.amount)>0).map(r=>({
      carrier:r.provider,service:String(r.servicelevel?.name || 'Servicio sin nombre').slice(0,100),amount:Number(r.amount).toFixed(2),currency:'USD',estimatedDays:Number.isInteger(r.estimated_days)&&r.estimated_days>0?r.estimated_days:null
    })).sort((a,b)=>Number(a.amount)-Number(b.amount));
    return reply(200,{mode:'test',parcel:PARCEL,rates,warning:rates.length?'Tarifas Test: no son precios definitivos ni plazos garantizados.':'Shippo no devolvió tarifas utilizables de USPS, UPS o FedEx. Revisa las direcciones y las cuentas habilitadas. No se ha comprado ninguna etiqueta.'});
  } catch(e) {return reply(e.name==='AbortError'?504:502,{error:e.name==='AbortError'?'Shippo tardó demasiado. Vuelve a intentarlo; no se compró ninguna etiqueta.':'No se pudo consultar Shippo. Inténtalo de nuevo.'});}
  finally {clearTimeout(timer);}
};
