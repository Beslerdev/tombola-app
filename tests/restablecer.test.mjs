// Restablecer contraseña con link de un solo uso
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, org, dueno;
before(async () => {
  e = await crearEntorno();
  const o = await e.registrar();
  org = { token: o.token, email: o.org.email, password: 'clave-segura-1' };
  dueno = await e.registrar();
  await e.sql('update organizadores set es_dueno = true where id = $1', [dueno.org.id]);
});
after(async () => { await e?.cerrar(); });

const pedirLink = (email, token = dueno.token) => e.api('POST', '/api/dueno/restablecer', { token, body: { email } });
const tokenDe = (link) => link.split('#')[1];
const login = (email, password) => e.api('POST', '/api/login', { body: { email, password } });

test('el dueño genera un link, el organizador elige su contraseña y entra', async () => {
  const r = await pedirLink(org.email.toUpperCase());
  assert.equal(r.status, 200);
  assert.match(r.data.link, /\/restablecer#[\w-]{30,}$/);
  const u = await e.api('POST', '/api/restablecer', { body: { token: tokenDe(r.data.link), password: 'nueva-clave-123' } });
  assert.equal(u.status, 200);
  assert.ok(u.data.token, 'queda con la sesión iniciada');
  assert.equal((await e.api('GET', '/api/panel', { token: u.data.token })).status, 200);
  assert.equal((await login(org.email, 'nueva-clave-123')).status, 200);
  assert.equal((await login(org.email, org.password)).status, 401, 'la contraseña vieja ya no sirve');
});

test('el link sirve una sola vez', async () => {
  const t = tokenDe((await pedirLink(org.email)).data.link);
  assert.equal((await e.api('POST', '/api/restablecer', { body: { token: t, password: 'otra-clave-123' } })).status, 200);
  const r = await e.api('POST', '/api/restablecer', { body: { token: t, password: 'tercera-123' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ya se usó o venció/);
});

test('un link nuevo anula el anterior', async () => {
  const viejo = tokenDe((await pedirLink(org.email)).data.link);
  await pedirLink(org.email);
  assert.equal((await e.api('POST', '/api/restablecer', { body: { token: viejo, password: 'clave-12345' } })).status, 400);
});

test('un link vencido o inventado no sirve, y la contraseña corta se rechaza', async () => {
  const t = tokenDe((await pedirLink(org.email)).data.link);
  assert.equal((await e.api('POST', '/api/restablecer', { body: { token: t, password: 'corta' } })).status, 400);
  await e.sql(`update restablecer_pass set expira = now() - interval '1 minute' where usado_at is null`);
  assert.equal((await e.api('POST', '/api/restablecer', { body: { token: t, password: 'clave-12345' } })).status, 400);
  assert.equal((await e.api('POST', '/api/restablecer', { body: { token: 'x'.repeat(32), password: 'clave-12345' } })).status, 400);
});

test('solo el dueño puede generar links, y la base guarda solo el hash', async () => {
  assert.equal((await pedirLink(org.email, org.token)).status, 403);
  assert.equal((await e.api('POST', '/api/dueno/restablecer', { body: { email: org.email } })).status, 401);
  const t = tokenDe((await pedirLink(org.email)).data.link);
  const filas = await e.sql('select token_hash from restablecer_pass');
  assert.ok(filas.every((f) => f.token_hash !== t && /^[0-9a-f]{64}$/.test(f.token_hash)));
  assert.equal((await pedirLink('noexiste@test.com')).status, 400);
});

test('en pantalla: el dueño genera el link desde su panel y el organizador elige su contraseña', async () => {
  const { chromium } = await import('playwright');
  const S = process.env.CAPTURAS;
  const cliente = await e.registrar({ nombre: 'Club Los Andes', celular: '11 3333 4444' });
  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  const p = await ctx.newPage();
  const errores = []; p.on('pageerror', (x) => errores.push(x.message));
  await p.goto(e.url + '/terminos'); await p.evaluate((tk) => localStorage.setItem('tt_sesion', tk), dueno.token);
  await p.goto(e.url + '/dueno');
  await p.fill('#buscar', 'los andes');
  await p.click('[data-clave]');
  await p.waitForSelector('#m-link:not(.oculto)');
  const link = await p.inputValue('#ml-link');
  assert.match(link, /\/restablecer#[\w-]{30,}$/);
  const wa = await p.getAttribute('#ml-wa', 'href');
  assert.ok(wa.startsWith('https://wa.me/5491133334444?text='), wa);
  assert.ok(decodeURIComponent(wa).includes(link));
  if (S) await p.screenshot({ path: S + '/link-1-dueno.png' });
  await p.click('#ml-cerrar');

  // El organizador abre el link en su celular
  const ctx2 = await nav.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx2.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  const c = await ctx2.newPage();
  c.on('pageerror', (x) => errores.push(x.message));
  await c.goto(link.replace(/^https?:\/\/[^/]+/, e.url));
  await c.fill('#n-pass', 'mi-clave-nueva-1'); await c.fill('#n-pass2', 'mi-clave-nueva-1');
  if (S) await c.screenshot({ path: S + '/link-2-cliente.png' });
  await c.click('#f-nueva button');
  await c.waitForURL(/\/panel$/);
  assert.equal((await login(cliente.org.email, 'mi-clave-nueva-1')).status, 200);
  assert.deepEqual(errores, []);
  await nav.close();
});
