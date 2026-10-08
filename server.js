'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  DB_API_KEY,
  ADMIN_PASSWORD,
  TOKEN_SECRET,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, DB_API_KEY, ADMIN_PASSWORD, TOKEN_SECRET })) {
  if (!v) { console.error(`Falta la variable de entorno ${k}`); process.exit(1); }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '14mb' }));

// ---------- Supabase RPC ----------
async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_key: DB_API_KEY, ...args }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.message) || `Error ${res.status}`);
    err.status = 400;
    throw err;
  }
  return data;
}

const MENSAJES = {
  NO_DISPONIBLE: 'Alguno de los números ya no está disponible',
  VENCIDA: 'La reserva venció. Elegí los números nuevamente.',
  NO_EXISTE: 'No encontramos esa reserva',
  ESTADO_INVALIDO: 'La reserva ya no está en un estado que permita esta acción',
  SIN_NUMEROS: 'Elegí al menos un número',
};

function enviarError(res, e) {
  const msg = e.message || 'Error';
  const codigo = msg.split(':')[0];
  if (codigo === 'NO_DISPONIBLE') {
    const ocupados = (msg.split(':')[1] || '').split(',').filter(Boolean).map(Number);
    return res.status(409).json({ error: MENSAJES.NO_DISPONIBLE, ocupados });
  }
  if (MENSAJES[codigo]) return res.status(400).json({ error: MENSAJES[codigo] });
  console.error(e);
  res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo en unos segundos.' });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => enviarError(res, e));

// ---------- Validaciones ----------
function normCelular(c) {
  let d = String(c || '').replace(/\D/g, '');
  if (d.startsWith('549')) d = d.slice(3);
  else if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}
function celularValido(d) { return d.length >= 8 && d.length <= 13; }
function nombreValido(n) { return typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 80; }
const UUID = /^[0-9a-f-]{36}$/i;

// ---------- API pública ----------
app.get('/api/estado', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await rpc('api_estado'));
}));

app.post('/api/reservar', wrap(async (req, res) => {
  const { numeros, nombre } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!Array.isArray(numeros) || !numeros.length || numeros.length > 100 ||
      !numeros.every((n) => Number.isInteger(n) && n >= 0 && n <= 99)) {
    return res.status(400).json({ error: 'Números inválidos' });
  }
  if (!nombreValido(nombre)) return res.status(400).json({ error: 'Ingresá tu nombre y apellido' });
  if (!celularValido(celular)) return res.status(400).json({ error: 'Ingresá un celular válido (con código de área)' });
  const r = await rpc('api_reservar', { p_numeros: [...new Set(numeros)], p_nombre: nombre.trim(), p_celular: celular });
  res.json({ ...r, celular });
}));

const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
app.post('/api/comprobante', wrap(async (req, res) => {
  const { compraId, mime, nombreArchivo, b64 } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!UUID.test(compraId || '')) return res.status(400).json({ error: 'Reserva inválida' });
  if (!MIMES.includes(mime)) return res.status(400).json({ error: 'Subí una foto (JPG/PNG) o un PDF' });
  if (typeof b64 !== 'string' || !b64.length) return res.status(400).json({ error: 'Falta el archivo' });
  if (b64.length > 13_500_000) return res.status(400).json({ error: 'El archivo es demasiado grande (máx. 10 MB)' });
  await rpc('api_comprobante', {
    p_compra: compraId, p_celular: celular, p_mime: mime,
    p_nombre: String(nombreArchivo || 'comprobante').slice(0, 120), p_data_b64: b64,
  });
  res.json({ ok: true });
}));

app.post('/api/cancelar', wrap(async (req, res) => {
  const { compraId } = req.body || {};
  const celular = normCelular(req.body && req.body.celular);
  if (!UUID.test(compraId || '')) return res.status(400).json({ error: 'Reserva inválida' });
  await rpc('api_cancelar', { p_compra: compraId, p_celular: celular });
  res.json({ ok: true });
}));

app.get('/api/mis-compras', wrap(async (req, res) => {
  const celular = normCelular(req.query.celular);
  if (!celularValido(celular)) return res.status(400).json({ error: 'Ingresá un celular válido' });
  res.set('Cache-Control', 'no-store');
  res.json(await rpc('api_mis_compras', { p_celular: celular }));
}));

// ---------- Admin ----------
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
function firmar(exp) { return crypto.createHmac('sha256', TOKEN_SECRET).update(`admin.${exp}`).digest('hex'); }
function crearToken() { const exp = Date.now() + TOKEN_TTL_MS; return `${exp}.${firmar(exp)}`; }
function tokenValido(t) {
  const [exp, sig] = String(t || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = firmar(exp);
  return sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
}
function soloAdmin(req, res, next) {
  const t = (req.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (!tokenValido(t)) return res.status(401).json({ error: 'Sesión vencida. Ingresá de nuevo.' });
  next();
}

const intentos = new Map();
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const ahora = Date.now();
  const reg = intentos.get(ip) || { n: 0, desde: ahora };
  if (ahora - reg.desde > 15 * 60 * 1000) { reg.n = 0; reg.desde = ahora; }
  if (reg.n >= 10) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  const pass = String((req.body && req.body.password) || '');
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    reg.n += 1; intentos.set(ip, reg);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  intentos.delete(ip);
  res.json({ token: crearToken() });
});

app.get('/api/admin/resumen', soloAdmin, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [estado, compras, numeros] = await Promise.all([
    rpc('api_estado'), rpc('api_admin_compras'), rpc('api_admin_numeros'),
  ]);
  res.json({ config: estado.config, ahora: estado.ahora, compras, numeros });
}));

app.get('/api/admin/comprobante/:id', soloAdmin, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  const c = await rpc('api_admin_ver_comprobante', { p_compra: req.params.id });
  if (!c) return res.status(404).json({ error: 'Sin comprobante' });
  res.set('Content-Type', c.mime);
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(c.b64, 'base64'));
}));

app.post('/api/admin/aprobar/:id', soloAdmin, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  await rpc('api_admin_aprobar', { p_compra: req.params.id });
  res.json({ ok: true });
}));

app.post('/api/admin/rechazar/:id', soloAdmin, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  const nota = String((req.body && req.body.nota) || '').slice(0, 300);
  await rpc('api_admin_rechazar', { p_compra: req.params.id, p_nota: nota });
  res.json({ ok: true });
}));

app.post('/api/admin/config', soloAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const cfg = {};
  for (const k of ['nombre', 'premio', 'alias', 'titular', 'info_sorteo']) {
    if (typeof b[k] === 'string') cfg[k] = b[k].trim().slice(0, 300);
  }
  if (b.precio !== undefined) {
    const p = parseInt(b.precio, 10);
    if (!(p > 0)) return res.status(400).json({ error: 'Precio inválido' });
    cfg.precio = p;
  }
  if (b.minutos_reserva !== undefined) {
    const m = parseInt(b.minutos_reserva, 10);
    if (!(m >= 2 && m <= 120)) return res.status(400).json({ error: 'Los minutos de reserva deben estar entre 2 y 120' });
    cfg.minutos_reserva = m;
  }
  if ('numero_ganador' in b) {
    if (b.numero_ganador === null || b.numero_ganador === '') cfg.numero_ganador = null;
    else {
      const g = parseInt(b.numero_ganador, 10);
      if (!(g >= 0 && g <= 99)) return res.status(400).json({ error: 'El número ganador debe estar entre 00 y 99' });
      cfg.numero_ganador = g;
    }
  }
  if ('detalle_ganador' in b) cfg.detalle_ganador = b.detalle_ganador ? String(b.detalle_ganador).slice(0, 300) : null;
  await rpc('api_admin_config', { p_cfg: cfg });
  res.json({ ok: true });
}));

// ---------- Estáticos ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => console.log(`Tómbola escuchando en :${PORT}`));
