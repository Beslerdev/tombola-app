// Entorno de pruebas aislado para Tutombola!
// - Postgres temporal con el esquema real (base-de-datos/*.sql)
// - Simulador de Supabase (PostgREST /rest/v1/rpc/*) que ejecuta como rol "anon"
// - Simulador de la API de Mercado Pago (preferencias, pagos, OAuth)
// - El servidor real (server.js) apuntando a esos simuladores
// Nada de esto toca la app publicada ni la base real.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_KEY = 'clave-de-prueba-' + crypto.randomBytes(8).toString('hex');

function puertoLibre() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function leerCuerpo(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
}

// ---------------------------------------------------------------------
// Simulador de Mercado Pago
// ---------------------------------------------------------------------
export class MercadoPagoFalso {
  constructor() {
    this.cuentas = new Map();      // access_token -> { user_id }
    this.codigos = new Map();      // code OAuth -> user_id
    this.pagos = [];               // { id, token, status, external_reference, transaction_amount, ... }
    this.preferencias = [];
    this.siguienteId = 1000;
  }
  crearCuenta(userId) {
    const token = `APP_USR-test-${userId}-${crypto.randomBytes(4).toString('hex')}`;
    this.cuentas.set(token, { user_id: String(userId) });
    const code = 'code-' + crypto.randomBytes(6).toString('hex');
    this.codigos.set(code, String(userId));
    return { token, code };
  }
  codigoPara(userId) {
    const code = 'code-' + crypto.randomBytes(6).toString('hex');
    this.codigos.set(code, String(userId));
    return code;
  }
  tokenDe(userId) { for (const [t, c] of this.cuentas) if (c.user_id === String(userId)) return t; return null; }
  agregarPago({ userId, status = 'approved', external_reference, monto, metodo = 'visa' }) {
    const id = this.siguienteId++;
    this.pagos.push({ id, token: this.tokenDe(userId), status, external_reference, transaction_amount: monto, payment_method_id: metodo, date_created: new Date().toISOString() });
    return id;
  }
  async iniciar() {
    this.puerto = await puertoLibre();
    this.server = http.createServer(async (req, res) => {
      const cuerpo = await leerCuerpo(req);
      const url = new URL(req.url, 'http://x');
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
      const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      // OAuth: pantalla de autorización (devuelve el code al callback)
      if (url.pathname === '/authorization') return json(200, { ok: true, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === '/oauth/token') {
        const b = JSON.parse(cuerpo || '{}');
        if (b.grant_type === 'authorization_code') {
          const uid = this.codigos.get(b.code);
          if (!uid) return json(400, { error: 'invalid_grant' });
          this.codigos.delete(b.code);
          let t = this.tokenDe(uid);
          if (!t) { t = this.crearCuenta(uid).token; }
          return json(200, { access_token: t, refresh_token: 'r-' + uid, user_id: Number(uid), expires_in: 15552000 });
        }
        return json(400, { error: 'unsupported' });
      }
      if (!this.cuentas.has(token)) return json(401, { message: 'invalid token' });
      if (url.pathname === '/checkout/preferences' && req.method === 'POST') {
        const p = JSON.parse(cuerpo);
        const id = 'pref-' + crypto.randomBytes(4).toString('hex');
        this.preferencias.push({ id, token, ...p });
        return json(201, { id, init_point: `https://mp.test/checkout?pref_id=${id}` });
      }
      if (url.pathname === '/v1/payments/search') {
        const ref = url.searchParams.get('external_reference');
        const results = this.pagos.filter((p) => p.token === token && p.external_reference === ref).reverse();
        return json(200, { results });
      }
      const m = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
      if (m) {
        const p = this.pagos.find((x) => x.id === Number(m[1]) && x.token === token);
        return p ? json(200, p) : json(404, { message: 'Payment not found' });
      }
      json(404, { message: 'not found' });
    });
    await new Promise((r) => this.server.listen(this.puerto, r));
  }
  cerrar() { return new Promise((r) => this.server.close(r)); }
}

// ---------------------------------------------------------------------
// Entorno completo
// ---------------------------------------------------------------------
export async function crearEntorno() {
  const e = {};
  // 1) Postgres temporal
  const base = '/var/tmp/tt';
  fs.mkdirSync(base, { recursive: true }); fs.chmodSync(base, 0o777);
  e.dirDatos = path.join(base, 'pg-' + crypto.randomBytes(5).toString('hex'));
  e.pgPuerto = await puertoLibre();
  e.pg = new EmbeddedPostgres({ databaseDir: e.dirDatos, user: 'postgres', password: 'postgres', port: e.pgPuerto, persistent: false, onLog: () => {}, onError: () => {} });
  await e.pg.initialise();
  await e.pg.start();
  e.admin = new pg.Client({ host: '127.0.0.1', port: e.pgPuerto, user: 'postgres', password: 'postgres', database: 'postgres' });
  await e.admin.connect();
  // Roles como en Supabase: anon puede tocar tablas (lo frena RLS) y solo ejecutar lo que se le otorga
  await e.admin.query(`create role anon login password 'anon'; create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;`);
  await e.admin.query(fs.readFileSync(path.join(RAIZ, 'base-de-datos/01-tablas.sql'), 'utf8'));
  await e.admin.query(fs.readFileSync(path.join(RAIZ, 'base-de-datos/02-funciones.sql'), 'utf8'));
  await e.admin.query('insert into app_secret (hash) values ($1)', [crypto.createHash('sha256').update(DB_KEY).digest('hex')]);
  e.anon = new pg.Pool({ host: '127.0.0.1', port: e.pgPuerto, user: 'anon', password: 'anon', database: 'postgres', max: 20 });

  // 2) Simulador de Supabase (PostgREST rpc)
  e.supaPuerto = await puertoLibre();
  e.supa = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (!m || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    const args = JSON.parse((await leerCuerpo(req)) || '{}');
    const nombres = Object.keys(args);
    const valores = nombres.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
    const sql = `select public.${m[1]}(${nombres.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    try {
      const r = await e.anon.query(sql, valores);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.rows[0].r === undefined ? null : r.rows[0].r));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: err.message, code: err.code }));
    }
  });
  await new Promise((r) => e.supa.listen(e.supaPuerto, r));

  // 3) Simulador de Mercado Pago (cuenta de la plataforma = usuario 1)
  e.mp = new MercadoPagoFalso();
  await e.mp.iniciar();
  e.mpPlataforma = e.mp.crearCuenta(1).token;

  // 4) Servidor real
  e.puerto = await puertoLibre();
  e.url = `http://127.0.0.1:${e.puerto}`;
  e.proc = spawn(process.execPath, [path.join(RAIZ, 'server.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(e.puerto), PUBLIC_URL: e.url,
      SUPABASE_URL: `http://127.0.0.1:${e.supaPuerto}`, SUPABASE_ANON_KEY: 'anon-test', DB_API_KEY: DB_KEY,
      TOKEN_SECRET: crypto.randomBytes(16).toString('hex'), ENC_KEY: crypto.randomBytes(32).toString('hex'),
      MP_ACCESS_TOKEN: e.mpPlataforma, MP_CLIENT_ID: '123', MP_CLIENT_SECRET: 'secreto-test',
      MP_API_BASE: `http://127.0.0.1:${e.mp.puerto}`, MP_AUTH_BASE: `http://127.0.0.1:${e.mp.puerto}`,
      PRECIO_SUSCRIPCION: '12000', DIAS_SUSCRIPCION: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  e.logs = '';
  e.proc.stdout.on('data', (d) => (e.logs += d));
  e.proc.stderr.on('data', (d) => (e.logs += d));
  for (let i = 0; i < 50; i++) {
    try { await fetch(e.url + '/terminos'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // ---------- Ayudantes ----------
  let ipN = 0;
  e.api = async (metodo, ruta, { body, token, ip, redirect = 'follow' } = {}) => {
    const res = await fetch(e.url + ruta, {
      method: metodo, redirect,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `10.0.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null; const txt = await res.text();
    try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: res.status, data, headers: res.headers };
  };
  e.sql = (q, p) => e.admin.query(q, p).then((r) => r.rows);
  let n = 0;
  e.registrar = async (extra = {}) => {
    n++;
    const r = await e.api('POST', '/api/registro', { body: { nombre: `Org ${n}`, email: `org${n}-${crypto.randomBytes(3).toString('hex')}@test.com`, password: 'clave-segura-1', ...extra } });
    if (r.status !== 200) throw new Error('registro falló: ' + JSON.stringify(r.data));
    return { token: r.data.token, org: r.data.org };
  };
  // Conecta Mercado Pago por el flujo OAuth real (con el simulador)
  e.conectarMp = async (token, mpUserId) => {
    const r = await e.api('POST', '/api/panel/mp/conectar', { token });
    const state = new URL(r.data.url).searchParams.get('state');
    const code = e.mp.codigoPara(mpUserId);
    const cb = await e.api('GET', `/api/mp/oauth/callback?state=${encodeURIComponent(state)}&code=${code}`, { redirect: 'manual' });
    return new URL(cb.headers.get('location'), e.url).searchParams.get('prueba');
  };
  // Organizador listo para vender (prueba activa con Mercado Pago y alias)
  e.organizadorActivo = async (mpUserId) => {
    const o = await e.registrar();
    if (mpUserId) await e.conectarMp(o.token, mpUserId);
    await e.api('POST', '/api/panel/perfil', { token: o.token, body: { acepta_transferencia: true, alias: 'mi.alias.test', titular: 'Titular Test' } });
    if (!mpUserId) await e.sql(`update organizadores set pagado_hasta = now() + interval '30 days' where id = $1`, [o.org.id]);
    return o;
  };
  e.crearTombola = async (token, datos = {}) => {
    const r = await e.api('POST', '/api/panel/tombolas', { token, body: { nombre: 'Tómbola de prueba', premio: 'Un premio', precio: 1000, ...datos } });
    if (r.status !== 200) throw new Error('crear tómbola falló: ' + JSON.stringify(r.data));
    return r.data.tombola;
  };
  e.reservar = (slug, numeros, celular = '1155550000', nombre = 'Comprador Test') =>
    e.api('POST', `/api/t/${slug}/reservar`, { body: { numeros, nombre, celular } });

  e.cerrar = async () => {
    e.proc.kill();
    await new Promise((r) => e.supa.close(r));
    await e.mp.cerrar();
    await e.anon.end();
    await e.admin.end();
    await e.pg.stop();
    fs.rmSync(e.dirDatos, { recursive: true, force: true });
  };
  return e;
}
