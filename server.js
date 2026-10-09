'use strict';
// Tutombola! — plataforma de tómbolas 00-99 para organizadores
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const env = process.env;
const {
  SUPABASE_URL, SUPABASE_ANON_KEY, DB_API_KEY, TOKEN_SECRET, ENC_KEY,
  MP_ACCESS_TOKEN,          // cuenta de Tutombola! (cobro de suscripciones)
  MP_CLIENT_ID, MP_CLIENT_SECRET, // aplicación de Mercado Pago para "Conectar con Mercado Pago"
  PORT = 3000,
} = env;
const PRECIO_SUSCRIPCION = parseInt(env.PRECIO_SUSCRIPCION || '12000', 10);
const DIAS_SUSCRIPCION = parseInt(env.DIAS_SUSCRIPCION || '30', 10);
const PUBLIC_URL = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MP_API = env.MP_API_BASE || 'https://api.mercadopago.com';
const MP_AUTH = env.MP_AUTH_BASE || 'https://auth.mercadopago.com.ar';

for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DB_API_KEY', 'TOKEN_SECRET', 'ENC_KEY']) {
  if (!env[k]) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}
const oauthDisponible = () => Boolean(MP_CLIENT_ID && MP_CLIENT_SECRET);
const suscripcionDisponible = () => Boolean(MP_ACCESS_TOKEN);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '14mb' }));

// ---------- Base de datos ----------
async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: DB_API_KEY, ...args }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) { const e = new Error((data && data.message) || `Error ${res.status}`); e.status = 400; throw e; }
  return data;
}

const MENSAJES = {
  NO_DISPONIBLE: 'Alguno de los números ya no está disponible',
  VENCIDA: 'La reserva venció. Elegí los números nuevamente.',
  NO_EXISTE: 'No encontramos lo que buscabas',
  ESTADO_INVALIDO: 'La compra ya no está en un estado que permita esta acción',
  SIN_NUMEROS: 'Elegí al menos un número',
  EMAIL_EXISTE: 'Ya hay una cuenta con ese email. Ingresá con tu contraseña.',
  SUSPENDIDA: 'Esta tómbola está suspendida momentáneamente. Probá más tarde.',
  TOMBOLA_CERRADA: 'Esta tómbola ya no acepta compras.',
};
function enviarError(res, e) {
  const msg = e.message || 'Error';
  const codigo = msg.split(':')[0];
  if (codigo === 'NO_DISPONIBLE') {
    const ocupados = (msg.split(':')[1] || '').split(',').filter(Boolean).map(Number);
    return res.status(409).json({ error: MENSAJES.NO_DISPONIBLE, ocupados });
  }
  if (MENSAJES[codigo]) return res.status(400).json({ error: MENSAJES[codigo], codigo });
  if (e.publico) return res.status(e.status || 400).json({ error: msg });
  console.error(e);
  res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo en unos segundos.' });
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => enviarError(res, e));
function errorPublico(status, msg) { const e = new Error(msg); e.status = status; e.publico = true; return e; }

// ---------- Validaciones ----------
function normCelular(c) {
  let d = String(c || '').replace(/\D/g, '');
  if (d.startsWith('549')) d = d.slice(3); else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}
const celularValido = (d) => d.length >= 8 && d.length <= 13;
const textoValido = (n, min = 2, max = 80) => typeof n === 'string' && n.trim().length >= min && n.trim().length <= max;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tombola';
}

// ---------- Cifrado y sesiones ----------
const KEY = Buffer.from(ENC_KEY, 'hex');
function cifrar(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function descifrar(s) {
  const [iv, tag, data] = s.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}
function hashPass(p) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(p, salt, 64).toString('hex')}`;
}
function verificarPass(p, h) {
  if (!h || !h.startsWith('scrypt$')) return false;
  const [, salt, hash] = h.split('$');
  const calc = crypto.scryptSync(p, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}
const firmar = (s) => crypto.createHmac('sha256', TOKEN_SECRET).update(s).digest('base64url');
function crearFirmado(tipo, id, ms) { const exp = Date.now() + ms; const base = `${tipo}.${id}.${exp}`; return `${base}.${firmar(base)}`; }
function leerFirmado(tipo, t) {
  const p = String(t || '').split('.');
  if (p.length !== 4 || p[0] !== tipo || Number(p[2]) < Date.now()) return null;
  const esperado = firmar(p.slice(0, 3).join('.'));
  if (p[3].length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(p[3]), Buffer.from(esperado))) return null;
  return p[1];
}
const crearSesion = (orgId) => crearFirmado('ses', orgId, 30 * 24 * 3600 * 1000);

async function soloOrg(req, res, next) {
  const id = leerFirmado('ses', (req.get('Authorization') || '').replace(/^Bearer\s+/, ''));
  if (!id) return res.status(401).json({ error: 'Tu sesión venció. Ingresá de nuevo.' });
  try {
    const org = await rpc('api_org_get', { p_org: id });
    if (!org || org.bloqueado) return res.status(401).json({ error: 'Cuenta no disponible. Contactá a Tutombola!.' });
    req.org = org; next();
  } catch (e) { enviarError(res, e); }
}
function soloDueno(req, res, next) {
  if (!req.org || !req.org.es_dueno) return res.status(403).json({ error: 'Sin permiso' });
  next();
}

// Límite simple de intentos por IP
const intentos = new Map();
function limitar(clave, max, ventanaMs) {
  const ahora = Date.now();
  const r = intentos.get(clave) || { n: 0, desde: ahora };
  if (ahora - r.desde > ventanaMs) { r.n = 0; r.desde = ahora; }
  r.n += 1; intentos.set(clave, r);
  return r.n > max;
}

// ---------- Mercado Pago ----------
async function mp(token, pathname, opts = {}) {
  const res = await fetch(`${MP_API}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error('Mercado Pago', res.status, pathname, JSON.stringify(data));
    throw errorPublico(502, 'No pudimos conectar con Mercado Pago. Probá de nuevo.');
  }
  return data;
}

// Token de Mercado Pago del organizador (renovándolo si está por vencer)
async function tokenOrg(orgId) {
  const enc = await rpc('api_org_tokens', { p_org: orgId });
  if (!enc) return null;
  let t = descifrar(enc);
  if (t.expires_at && t.expires_at - Date.now() < 7 * 24 * 3600 * 1000 && t.refresh_token && oauthDisponible()) {
    try {
      const r = await fetch(`${MP_API}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: t.refresh_token }),
      });
      const d = await r.json();
      if (r.ok && d.access_token) {
        t = { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, user_id: String(d.user_id || t.user_id), expires_at: Date.now() + (d.expires_in || 15552000) * 1000 };
        await rpc('api_org_update', { p_org: orgId, p: { mp_tokens: cifrar(t), mp_user_id: t.user_id } });
      } else console.error('Refresh MP falló', orgId, JSON.stringify(d));
    } catch (e) { console.error('Refresh MP error', e.message); }
  }
  return t.access_token;
}

// Procesa un pago de una tómbola consultando siempre la API de MP con el token del organizador
async function procesarPago(orgId, paymentId) {
  const token = await tokenOrg(orgId);
  if (!token) return { estado: null };
  const p = await mp(token, `/v1/payments/${encodeURIComponent(paymentId)}`);
  const compra = UUID.test(p.external_reference || '') ? p.external_reference : null;
  if (!compra) return { estado: p.status };
  const c = await rpc('api_compra', { p_compra: compra });
  if (!c || c.organizador_id !== orgId) return { estado: p.status };
  if (p.status === 'approved') {
    const resultado = await rpc('api_registrar_pago', { p_compra: compra, p_payment_id: String(p.id), p_monto: p.transaction_amount, p_metodo: p.payment_method_id || p.payment_type_id || null });
    return { estado: p.status, resultado, compra };
  }
  await rpc('api_registrar_evento_pago', { p_payment_id: String(p.id), p_compra: compra, p_monto: p.transaction_amount, p_estado: p.status, p_metodo: p.payment_method_id || null });
  return { estado: p.status, compra };
}

// Procesa un pago de suscripción (cuenta de Tutombola!)
async function procesarSuscripcion(paymentId) {
  const p = await mp(MP_ACCESS_TOKEN, `/v1/payments/${encodeURIComponent(paymentId)}`);
  const ref = String(p.external_reference || '');
  if (!ref.startsWith('sub:')) return { estado: p.status };
  const orgId = ref.slice(4);
  if (!UUID.test(orgId)) return { estado: p.status };
  if (p.status === 'approved' && p.transaction_amount + 0.01 >= PRECIO_SUSCRIPCION) {
    const r = await rpc('api_suscripcion_pago', { p_payment_id: String(p.id), p_org: orgId, p_monto: p.transaction_amount, p_dias: DIAS_SUSCRIPCION, p_origen: 'mercadopago' });
    return { estado: p.status, orgId, org: r.org };
  }
  return { estado: p.status, orgId };
}

// ======================================================================
// API: cuentas
// ======================================================================
app.post('/api/registro', wrap(async (req, res) => {
  if (limitar('reg:' + req.ip, 10, 3600_000)) throw errorPublico(429, 'Demasiados intentos. Probá más tarde.');
  const { nombre, email, password } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!textoValido(nombre)) throw errorPublico(400, 'Ingresá tu nombre o el de tu organización');
  if (!EMAIL.test(String(email || ''))) throw errorPublico(400, 'Ingresá un email válido');
  if (typeof password !== 'string' || password.length < 8) throw errorPublico(400, 'La contraseña debe tener al menos 8 caracteres');
  if (celular && !celularValido(celular)) throw errorPublico(400, 'El celular no parece válido');
  const org = await rpc('api_org_crear', { p_email: email.trim(), p_hash: hashPass(password), p_nombre: nombre.trim(), p_celular: celular || null });
  res.json({ token: crearSesion(org.id), org });
}));

app.post('/api/login', wrap(async (req, res) => {
  if (limitar('log:' + req.ip, 15, 15 * 60_000)) throw errorPublico(429, 'Demasiados intentos. Esperá 15 minutos.');
  const { email, password } = req.body || {};
  const u = await rpc('api_org_login', { p_email: String(email || '').trim() });
  if (!u || !verificarPass(String(password || ''), u.pass_hash)) throw errorPublico(401, 'Email o contraseña incorrectos');
  if (u.bloqueado) throw errorPublico(403, 'Tu cuenta está bloqueada. Contactá a Tutombola!.');
  res.json({ token: crearSesion(u.id) });
}));

// ======================================================================
// API: panel del organizador
// ======================================================================
app.get('/api/panel', soloOrg, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tombolas = await rpc('api_tombolas_de_org', { p_org: req.org.id });
  res.json({ org: req.org, tombolas, precioSuscripcion: PRECIO_SUSCRIPCION, diasSuscripcion: DIAS_SUSCRIPCION,
    oauthDisponible: oauthDisponible(), suscripcionDisponible: suscripcionDisponible(), ahora: new Date().toISOString() });
}));

app.post('/api/panel/perfil', soloOrg, wrap(async (req, res) => {
  const b = req.body || {};
  const p = {};
  if (b.nombre !== undefined) { if (!textoValido(b.nombre)) throw errorPublico(400, 'Nombre inválido'); p.nombre = b.nombre.trim(); }
  if (b.celular !== undefined) { const c = normCelular(b.celular); if (c && !celularValido(c)) throw errorPublico(400, 'Celular inválido'); p.celular = c || null; }
  if (b.alias !== undefined) p.alias = String(b.alias || '').trim().slice(0, 60);
  if (b.titular !== undefined) p.titular = String(b.titular || '').trim().slice(0, 100);
  if (b.acepta_transferencia !== undefined) p.acepta_transferencia = Boolean(b.acepta_transferencia);
  if (b.password) {
    if (String(b.password).length < 8) throw errorPublico(400, 'La contraseña debe tener al menos 8 caracteres');
    p.pass_hash = hashPass(String(b.password));
  }
  const org = await rpc('api_org_update', { p_org: req.org.id, p });
  res.json({ org });
}));

function datosTombola(b, nueva) {
  const t = {};
  if (b.nombre !== undefined || nueva) { if (!textoValido(b.nombre, 3, 100)) throw errorPublico(400, 'Poné un nombre para la tómbola'); t.nombre = b.nombre.trim(); }
  if (b.premio !== undefined || nueva) { if (!textoValido(b.premio, 2, 200)) throw errorPublico(400, 'Describí el premio'); t.premio = b.premio.trim(); }
  if (b.precio !== undefined || nueva) { const p = parseInt(b.precio, 10); if (!(p > 0 && p < 100_000_000)) throw errorPublico(400, 'Precio por número inválido'); t.precio = p; }
  if (b.minutos_reserva !== undefined) { const m = parseInt(b.minutos_reserva, 10); if (!(m >= 5 && m <= 120)) throw errorPublico(400, 'Los minutos de reserva deben estar entre 5 y 120'); t.minutos_reserva = m; }
  if (typeof b.info_sorteo === 'string') t.info_sorteo = b.info_sorteo.trim().slice(0, 300);
  if (b.estado !== undefined) { if (!['activa', 'pausada', 'finalizada'].includes(b.estado)) throw errorPublico(400, 'Estado inválido'); t.estado = b.estado; }
  if ('numero_ganador' in b) {
    if (b.numero_ganador === null || b.numero_ganador === '') t.numero_ganador = null;
    else { const g = parseInt(b.numero_ganador, 10); if (!(g >= 0 && g <= 99)) throw errorPublico(400, 'El número ganador debe estar entre 00 y 99'); t.numero_ganador = g; }
  }
  if ('detalle_ganador' in b) t.detalle_ganador = b.detalle_ganador ? String(b.detalle_ganador).slice(0, 300) : null;
  return t;
}

app.post('/api/panel/tombolas', soloOrg, wrap(async (req, res) => {
  const t = datosTombola(req.body || {}, true);
  const r = await rpc('api_tombola_crear', { p_org: req.org.id, p_slug: slugify(t.nombre), p: t });
  res.json({ tombola: r });
}));

async function tombolaPropia(req) {
  if (!UUID.test(req.params.id)) throw errorPublico(400, 'Id inválido');
  const t = await rpc('api_tombola_get', { p_tombola: req.params.id });
  if (!t || t.organizador_id !== req.org.id) throw errorPublico(404, 'No encontramos esa tómbola');
  return t;
}
async function compraPropia(req) {
  if (!UUID.test(req.params.id)) throw errorPublico(400, 'Id inválido');
  const c = await rpc('api_compra', { p_compra: req.params.id });
  if (!c || c.organizador_id !== req.org.id) throw errorPublico(404, 'No encontramos esa compra');
  return c;
}

app.post('/api/panel/tombolas/:id', soloOrg, wrap(async (req, res) => {
  await tombolaPropia(req);
  const r = await rpc('api_tombola_update', { p_org: req.org.id, p_tombola: req.params.id, p: datosTombola(req.body || {}, false) });
  res.json({ tombola: r });
}));

app.get('/api/panel/tombolas/:id', soloOrg, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t = await tombolaPropia(req);
  const [compras, numeros] = await Promise.all([
    rpc('api_admin_compras', { p_tombola: t.id }), rpc('api_admin_numeros', { p_tombola: t.id }),
  ]);
  res.json({ tombola: t, compras, numeros, org: req.org, ahora: new Date().toISOString() });
}));

app.get('/api/panel/comprobante/:id', soloOrg, wrap(async (req, res) => {
  await compraPropia(req);
  const c = await rpc('api_admin_ver_comprobante', { p_compra: req.params.id });
  if (!c) throw errorPublico(404, 'Sin comprobante');
  res.set('Content-Type', c.mime); res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(c.b64, 'base64'));
}));
app.post('/api/panel/compras/:id/aprobar', soloOrg, wrap(async (req, res) => {
  await compraPropia(req); await rpc('api_admin_aprobar', { p_compra: req.params.id }); res.json({ ok: true });
}));
app.post('/api/panel/compras/:id/rechazar', soloOrg, wrap(async (req, res) => {
  await compraPropia(req);
  await rpc('api_admin_rechazar', { p_compra: req.params.id, p_nota: String((req.body && req.body.nota) || '').slice(0, 300) });
  res.json({ ok: true });
}));
app.post('/api/panel/compras/:id/devuelta', soloOrg, wrap(async (req, res) => {
  await compraPropia(req); await rpc('api_admin_marcar_devuelta', { p_compra: req.params.id }); res.json({ ok: true });
}));

// ---------- Conectar Mercado Pago (OAuth) ----------
app.post('/api/panel/mp/conectar', soloOrg, wrap(async (req, res) => {
  if (!oauthDisponible()) throw errorPublico(503, 'La conexión con Mercado Pago todavía no está habilitada en Tutombola!.');
  const state = crearFirmado('oauth', req.org.id, 15 * 60_000);
  const u = new URL(`${MP_AUTH}/authorization`);
  u.searchParams.set('client_id', MP_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('platform_id', 'mp');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', `${PUBLIC_URL}/api/mp/oauth/callback`);
  res.json({ url: u.toString() });
}));

app.get('/api/mp/oauth/callback', async (req, res) => {
  const orgId = leerFirmado('oauth', req.query.state);
  if (!orgId || !req.query.code) return res.redirect('/panel?mp=error');
  try {
    const r = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET, grant_type: 'authorization_code',
        code: String(req.query.code), redirect_uri: `${PUBLIC_URL}/api/mp/oauth/callback` }),
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) { console.error('OAuth MP', JSON.stringify(d)); return res.redirect('/panel?mp=error'); }
    const t = { access_token: d.access_token, refresh_token: d.refresh_token, user_id: String(d.user_id), expires_at: Date.now() + (d.expires_in || 15552000) * 1000 };
    const con = await rpc('api_org_conectar_mp', { p_org: orgId, p_tokens: cifrar(t), p_mp_user: t.user_id });
    res.redirect('/panel?mp=ok&prueba=' + encodeURIComponent(con.prueba || ''));
  } catch (e) { console.error('OAuth MP error', e.message); res.redirect('/panel?mp=error'); }
});

app.post('/api/panel/mp/desconectar', soloOrg, wrap(async (req, res) => {
  const org = await rpc('api_org_update', { p_org: req.org.id, p: { mp_tokens: null, mp_user_id: null } });
  res.json({ org });
}));

// ---------- Suscripción ----------
app.post('/api/panel/suscripcion', soloOrg, wrap(async (req, res) => {
  if (!suscripcionDisponible()) throw errorPublico(503, 'El pago de la suscripción todavía no está habilitado. Contactá a Tutombola!.');
  const pref = await mp(MP_ACCESS_TOKEN, '/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ id: 'suscripcion', title: `Tutombola! – Suscripción ${DIAS_SUSCRIPCION} días`, quantity: 1, unit_price: PRECIO_SUSCRIPCION, currency_id: 'ARS' }],
      payer: { email: req.org.email, name: req.org.nombre },
      external_reference: `sub:${req.org.id}`,
      notification_url: `${PUBLIC_URL}/api/mp/webhook-sub`,
      back_urls: { success: `${PUBLIC_URL}/panel?sub=ok`, failure: `${PUBLIC_URL}/panel?sub=fallo`, pending: `${PUBLIC_URL}/panel?sub=pendiente` },
      auto_return: 'approved',
      binary_mode: true,
      statement_descriptor: 'TUTOMBOLA',
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
    }),
  });
  res.json({ url: pref.init_point });
}));

app.get('/api/panel/suscripcion/verificar', soloOrg, wrap(async (req, res) => {
  const pid = String(req.query.payment_id || '').replace(/\D/g, '');
  if (pid && suscripcionDisponible()) {
    const r = await procesarSuscripcion(pid);
    if (r.orgId && r.orgId !== req.org.id) throw errorPublico(403, 'Ese pago no corresponde a tu cuenta');
  }
  res.json({ org: await rpc('api_org_get', { p_org: req.org.id }) });
}));

app.post('/api/mp/webhook-sub', async (req, res) => {
  res.sendStatus(200);
  try {
    const tipo = req.query.type || req.query.topic || (req.body && (req.body.type || req.body.topic));
    const id = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
    if (!suscripcionDisponible() || tipo !== 'payment' || !id) return;
    const r = await procesarSuscripcion(id);
    console.log('Suscripción MP', id, r.estado, r.orgId || '');
  } catch (e) { console.error('Webhook suscripción error', e.message); }
});

// ======================================================================
// API: tómbola pública
// ======================================================================
async function publica(slug) {
  const d = await rpc('api_tombola_publica', { p_slug: String(slug || '').slice(0, 80) });
  if (!d) throw errorPublico(404, 'Esta tómbola no existe');
  return d;
}

app.get('/api/t/:slug', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const d = await publica(req.params.slug);
  delete d.organizador.id;
  res.json(d);
}));

app.post('/api/t/:slug/reservar', wrap(async (req, res) => {
  const d = await publica(req.params.slug);
  if (!d.medios.mp && !d.medios.transferencia) throw errorPublico(400, 'El organizador todavía no configuró cómo cobrar. Probá más tarde.');
  const { numeros, nombre } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!Array.isArray(numeros) || !numeros.length || numeros.length > 100 || !numeros.every((n) => Number.isInteger(n) && n >= 0 && n <= 99)) throw errorPublico(400, 'Números inválidos');
  if (!textoValido(nombre)) throw errorPublico(400, 'Ingresá tu nombre y apellido');
  if (!celularValido(celular)) throw errorPublico(400, 'Ingresá un celular válido (con código de área)');
  const r = await rpc('api_reservar', { p_tombola: d.tombola.id, p_numeros: [...new Set(numeros)], p_nombre: nombre.trim(), p_celular: celular });
  res.json({ ...r, celular });
}));

app.get('/api/t/:slug/mis-compras', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const celular = normCelular(req.query.celular);
  if (!celularValido(celular)) throw errorPublico(400, 'Ingresá un celular válido');
  const d = await publica(req.params.slug);
  res.json(await rpc('api_mis_compras', { p_tombola: d.tombola.id, p_celular: celular }));
}));

const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
app.post('/api/comprobante', wrap(async (req, res) => {
  const { compraId, mime, nombreArchivo, b64 } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!UUID.test(compraId || '')) throw errorPublico(400, 'Reserva inválida');
  if (!MIMES.includes(mime)) throw errorPublico(400, 'Subí una foto (JPG/PNG) o un PDF');
  if (typeof b64 !== 'string' || !b64.length) throw errorPublico(400, 'Falta el archivo');
  if (b64.length > 13_500_000) throw errorPublico(400, 'El archivo es demasiado grande (máx. 10 MB)');
  await rpc('api_comprobante', { p_compra: compraId, p_celular: celular, p_mime: mime, p_nombre: String(nombreArchivo || 'comprobante').slice(0, 120), p_data_b64: b64 });
  res.json({ ok: true });
}));

app.post('/api/cancelar', wrap(async (req, res) => {
  const { compraId } = req.body || {};
  if (!UUID.test(compraId || '')) throw errorPublico(400, 'Reserva inválida');
  await rpc('api_cancelar', { p_compra: compraId, p_celular: normCelular(req.body && req.body.celular) });
  res.json({ ok: true });
}));

// Crear el pago en Mercado Pago, en la cuenta del organizador
app.post('/api/pago/crear', wrap(async (req, res) => {
  const { compraId } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!UUID.test(compraId || '')) throw errorPublico(400, 'Reserva inválida');
  const c = await rpc('api_compra', { p_compra: compraId });
  if (!c || c.celular !== celular) throw errorPublico(404, 'No encontramos esa reserva');
  if (c.estado !== 'reservada') throw errorPublico(400, 'La reserva ya no está activa. Elegí los números de nuevo.');
  const token = await tokenOrg(c.organizador_id);
  if (!token) throw errorPublico(400, 'Esta tómbola no acepta pagos con Mercado Pago.');
  const lista = c.numeros.map((n) => String(n).padStart(2, '0')).join(', ');
  const vence = new Date(Math.max(new Date(c.reservado_hasta).getTime(), Date.now() + 60_000));
  const pref = await mp(token, '/checkout/preferences', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': `${c.id}-${c.reservado_hasta}` },
    body: JSON.stringify({
      items: [{ id: c.codigo, title: `${c.tombola_nombre} – ${c.numeros.length === 1 ? 'número' : 'números'} ${lista}`.slice(0, 250),
        description: `Premio: ${c.premio}`.slice(0, 250), quantity: 1, unit_price: Number(c.monto), currency_id: 'ARS' }],
      payer: { name: c.nombre },
      external_reference: c.id,
      notification_url: `${PUBLIC_URL}/api/mp/webhook?org=${c.organizador_id}`,
      back_urls: {
        success: `${PUBLIC_URL}/t/${c.slug}?pago=ok&c=${c.id}`,
        failure: `${PUBLIC_URL}/t/${c.slug}?pago=fallo&c=${c.id}`,
        pending: `${PUBLIC_URL}/t/${c.slug}?pago=pendiente&c=${c.id}`,
      },
      auto_return: 'approved',
      binary_mode: true,
      statement_descriptor: 'TOMBOLA',
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
      expires: true,
      expiration_date_from: new Date(Date.now() - 60_000).toISOString(),
      expiration_date_to: vence.toISOString(),
    }),
  });
  res.json({ url: pref.init_point });
}));

// Notificaciones de pagos de tómbolas
app.post('/api/mp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const tipo = req.query.type || req.query.topic || (req.body && (req.body.type || req.body.topic));
    const id = req.query['data.id'] || req.query.id || (req.body && req.body.data && req.body.data.id);
    if (tipo !== 'payment' || !id) return;
    let orgId = UUID.test(String(req.query.org || '')) ? String(req.query.org) : null;
    if (!orgId && req.body && req.body.user_id) orgId = await rpc('api_org_por_mp_user', { p_mp_user: String(req.body.user_id) });
    if (!orgId) return;
    const r = await procesarPago(orgId, id);
    console.log('Webhook MP', id, r.estado, r.resultado || '');
  } catch (e) { console.error('Webhook MP error', e.message); }
});

// Verificación al volver del checkout (respaldo del webhook)
app.get('/api/pago/estado', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const compraId = String(req.query.c || '');
  if (!UUID.test(compraId)) throw errorPublico(400, 'Reserva inválida');
  let c = await rpc('api_compra', { p_compra: compraId });
  if (!c) throw errorPublico(404, 'No encontramos esa reserva');
  let estadoMp = null;
  const token = await tokenOrg(c.organizador_id);
  if (token) {
    const paymentId = String(req.query.payment_id || '').replace(/\D/g, '');
    if (paymentId) {
      const r = await procesarPago(c.organizador_id, paymentId);
      if (r.compra === compraId) estadoMp = r.estado;
    } else {
      const s = await mp(token, `/v1/payments/search?external_reference=${compraId}&sort=date_created&criteria=desc&limit=10`);
      for (const p of (s.results || [])) {
        if (p.status === 'approved') { await procesarPago(c.organizador_id, p.id); estadoMp = 'approved'; break; }
        if (!estadoMp) estadoMp = p.status;
      }
    }
    c = await rpc('api_compra', { p_compra: compraId });
  }
  res.json({ estado: c.estado, estadoMp, codigo: c.codigo, numeros: c.numeros, monto: c.monto, reservado_hasta: c.reservado_hasta, celular: c.celular, nota: c.nota_admin });
}));

// El comprador volvió de Mercado Pago sin pagar: liberar la reserva si no hay ningún pago en curso
app.post('/api/pago/abandonar', wrap(async (req, res) => {
  const compraId = String((req.body && req.body.compraId) || '');
  if (!UUID.test(compraId)) throw errorPublico(400, 'Reserva inválida');
  let c = await rpc('api_compra', { p_compra: compraId });
  if (!c) throw errorPublico(404, 'No encontramos esa reserva');
  if (c.estado !== 'reservada') return res.json({ estado: c.estado });
  const token = await tokenOrg(c.organizador_id);
  if (token) {
    const s = await mp(token, `/v1/payments/search?external_reference=${compraId}&sort=date_created&criteria=desc&limit=10`);
    for (const p of (s.results || [])) {
      if (p.status === 'approved') { await procesarPago(c.organizador_id, p.id); c = await rpc('api_compra', { p_compra: compraId }); return res.json({ estado: c.estado }); }
      if (['pending', 'in_process', 'authorized'].includes(p.status)) return res.json({ estado: c.estado, enProceso: true });
    }
  }
  await rpc('api_cancelar', { p_compra: compraId, p_celular: c.celular });
  res.json({ estado: 'cancelada' });
}));

// ======================================================================
// API: dueño de la plataforma
// ======================================================================
app.get('/api/dueno', soloOrg, soloDueno, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...(await rpc('api_dueno_resumen')), precioSuscripcion: PRECIO_SUSCRIPCION, config: {
    suscripcion: suscripcionDisponible(), oauth: oauthDisponible(), redirectUri: `${PUBLIC_URL}/api/mp/oauth/callback` } });
}));
app.post('/api/dueno/:org/extender', soloOrg, soloDueno, wrap(async (req, res) => {
  if (!UUID.test(req.params.org)) throw errorPublico(400, 'Id inválido');
  const dias = parseInt((req.body && req.body.dias) || DIAS_SUSCRIPCION, 10);
  if (!(dias >= 1 && dias <= 366)) throw errorPublico(400, 'Días inválidos');
  const r = await rpc('api_suscripcion_pago', { p_payment_id: `manual-${crypto.randomUUID()}`, p_org: req.params.org,
    p_monto: Number((req.body && req.body.monto) || 0), p_dias: dias, p_origen: 'manual' });
  res.json(r);
}));
app.post('/api/dueno/:org/bloquear', soloOrg, soloDueno, wrap(async (req, res) => {
  if (!UUID.test(req.params.org)) throw errorPublico(400, 'Id inválido');
  await rpc('api_dueno_bloquear', { p_org: req.params.org, p_bloq: Boolean(req.body && req.body.bloquear) });
  res.json({ ok: true });
}));
app.post('/api/dueno/:org/clave', soloOrg, soloDueno, wrap(async (req, res) => {
  if (!UUID.test(req.params.org)) throw errorPublico(400, 'Id inválido');
  const nueva = crypto.randomBytes(6).toString('base64url');
  await rpc('api_org_update', { p_org: req.params.org, p: { pass_hash: hashPass(nueva) } });
  res.json({ clave: nueva });
}));

// ======================================================================
// Páginas
// ======================================================================
const pub = (f) => path.join(__dirname, 'public', f);
app.get('/', (req, res) => res.sendFile(pub('inicio.html')));
app.get(['/ingresar', '/registro'], (req, res) => res.sendFile(pub('cuenta.html')));
app.get('/panel', (req, res) => res.sendFile(pub('panel.html')));
app.get('/panel/t/:id', (req, res) => res.sendFile(pub('gestion.html')));
app.get('/dueno', (req, res) => res.sendFile(pub('dueno.html')));
app.get('/terminos', (req, res) => res.sendFile(pub('terminos.html')));
app.get('/t/:slug', (req, res) => res.sendFile(pub('tombola.html')));
app.get('/admin', (req, res) => res.redirect('/panel'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use((req, res) => res.status(404).sendFile(pub('inicio.html')));

app.listen(PORT, () => console.log(`Tutombola! escuchando en :${PORT}`));
