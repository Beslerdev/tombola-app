// Cuentas, prueba gratis, suscripción, suspensión y panel del dueño
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e;
before(async () => { e = await crearEntorno(); });
after(async () => { await e?.cerrar(); });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const org = async (id) => (await e.sql('select * from organizadores where id = $1', [id]))[0];

describe('Registro e ingreso', () => {
  test('valida email, contraseña y nombre', async () => {
    assert.equal((await e.api('POST', '/api/registro', { body: { nombre: 'X Y', email: 'malo', password: 'clave-segura-1' } })).status, 400);
    assert.equal((await e.api('POST', '/api/registro', { body: { nombre: 'X Y', email: 'a@b.com', password: 'corta' } })).status, 400);
    assert.equal((await e.api('POST', '/api/registro', { body: { nombre: '', email: 'a@b.com', password: 'clave-segura-1' } })).status, 400);
  });
  test('no permite dos cuentas con el mismo email (sin importar mayúsculas)', async () => {
    const a = await e.api('POST', '/api/registro', { body: { nombre: 'Uno', email: 'Repetido@Test.com', password: 'clave-segura-1' } });
    assert.equal(a.status, 200);
    const b = await e.api('POST', '/api/registro', { body: { nombre: 'Dos', email: 'repetido@test.com', password: 'clave-segura-1' } });
    assert.equal(b.status, 400);
  });
  test('ingreso: contraseña correcta funciona, incorrecta no', async () => {
    await e.api('POST', '/api/registro', { body: { nombre: 'Login', email: 'login@test.com', password: 'clave-segura-1' } });
    assert.equal((await e.api('POST', '/api/login', { body: { email: 'LOGIN@test.com', password: 'clave-segura-1' } })).status, 200);
    assert.equal((await e.api('POST', '/api/login', { body: { email: 'login@test.com', password: 'otra-clave-x' } })).status, 401);
    assert.equal((await e.api('POST', '/api/login', { body: { email: 'nadie@test.com', password: 'clave-segura-1' } })).status, 401);
  });
  test('demasiados intentos de ingreso desde la misma IP se bloquean', async () => {
    let ultimo;
    for (let i = 0; i < 17; i++) ultimo = await e.api('POST', '/api/login', { ip: '9.9.9.9', body: { email: 'login@test.com', password: 'mal-mal-mal' } });
    assert.equal(ultimo.status, 429);
  });
  test('el panel exige sesión válida', async () => {
    assert.equal((await e.api('GET', '/api/panel')).status, 401);
    assert.equal((await e.api('GET', '/api/panel', { token: 'ses.x.9999999999999.firma' })).status, 401);
    const o = await e.registrar();
    const partes = o.token.split('.');
    partes[1] = '00000000-0000-0000-0000-000000000000';
    assert.equal((await e.api('GET', '/api/panel', { token: partes.join('.') })).status, 401, 'token alterado');
    assert.equal((await e.api('GET', '/api/panel', { token: o.token })).status, 200);
  });
});

describe('Prueba gratis (7 días, una por cuenta de Mercado Pago)', () => {
  test('una cuenta nueva sin Mercado Pago no vende', async () => {
    const o = await e.registrar();
    assert.equal(o.org.activa, false);
    assert.equal(o.org.prueba_disponible, true);
    // Aunque configure su alias (transferencia), sin prueba ni suscripción no vende
    await e.api('POST', '/api/panel/perfil', { token: o.token, body: { acepta_transferencia: true, alias: 'algun.alias' } });
    const t = await e.crearTombola(o.token);
    const r = await e.reservar(t.slug, [1]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /suspendida/);
  });
  test('al conectar Mercado Pago empiezan los 7 días', async () => {
    const o = await e.registrar();
    assert.equal(await e.conectarMp(o.token, 800), 'otorgada');
    const d = await org(o.org.id);
    const dias = (new Date(d.trial_hasta) - Date.now()) / 86400000;
    assert.ok(dias > 6.9 && dias <= 7, `debería ser ~7 días, fue ${dias}`);
    await e.api('POST', '/api/panel/perfil', { token: o.token, body: { alias: 'x.y.z' } });
    const t = await e.crearTombola(o.token);
    assert.equal((await e.reservar(t.slug, [1])).status, 200);
  });
  test('la misma cuenta de Mercado Pago no da una segunda prueba', async () => {
    const o2 = await e.registrar();
    assert.equal(await e.conectarMp(o2.token, 800), 'usada');
    assert.equal((await org(o2.org.id)).trial_hasta, null);
    const p = await e.api('GET', '/api/panel', { token: o2.token });
    assert.equal(p.data.org.activa, false);
  });
  test('desconectar y reconectar otra cuenta no reinicia la prueba', async () => {
    const o = await e.registrar();
    await e.conectarMp(o.token, 801);
    const antes = (await org(o.org.id)).trial_hasta;
    await e.api('POST', '/api/panel/mp/desconectar', { token: o.token });
    assert.equal(await e.conectarMp(o.token, 802), 'ya_tenia');
    assert.equal((await org(o.org.id)).trial_hasta.getTime(), antes.getTime());
  });
  test('un estado OAuth falsificado no conecta nada', async () => {
    const cb = await e.api('GET', '/api/mp/oauth/callback?state=oauth.x.99999999999999.falso&code=abc', { redirect: 'manual' });
    assert.match(cb.headers.get('location'), /mp=error/);
  });
});

describe('Suscripción y suspensión', () => {
  const pagarSuscripcion = async (orgId, monto = 12000, status = 'approved') => {
    const pid = e.mp.agregarPago({ userId: 1, status, external_reference: `sub:${orgId}`, monto });
    await e.api('POST', `/api/mp/webhook-sub?type=payment&data.id=${pid}`, { body: {} });
    await esperar(300);
    return pid;
  };

  test('pagar la suscripción activa la cuenta por 30 días', async () => {
    const o = await e.registrar();
    await pagarSuscripcion(o.org.id);
    const d = await org(o.org.id);
    const dias = (new Date(d.pagado_hasta) - Date.now()) / 86400000;
    assert.ok(dias > 29.9 && dias <= 30, `fueron ${dias}`);
  });
  test('si paga durante la prueba, los 30 días se suman al final de la prueba', async () => {
    const o = await e.registrar();
    await e.conectarMp(o.token, 810);
    const trial = (await org(o.org.id)).trial_hasta;
    await pagarSuscripcion(o.org.id);
    const d = await org(o.org.id);
    assert.equal(Math.round((d.pagado_hasta - trial) / 86400000), 30);
  });
  test('el mismo pago avisado dos veces no suma días dos veces', async () => {
    const o = await e.registrar();
    const pid = await pagarSuscripcion(o.org.id);
    const una = (await org(o.org.id)).pagado_hasta;
    await e.api('POST', `/api/mp/webhook-sub?type=payment&data.id=${pid}`, { body: {} });
    await esperar(300);
    assert.equal((await org(o.org.id)).pagado_hasta.getTime(), una.getTime());
  });
  test('un pago menor al precio o no aprobado no activa la suscripción', async () => {
    const o = await e.registrar();
    await pagarSuscripcion(o.org.id, 100);
    await pagarSuscripcion(o.org.id, 12000, 'pending');
    assert.equal((await org(o.org.id)).pagado_hasta, null);
  });
  test('un pago de suscripción de otra cuenta no se puede usar para la mía', async () => {
    const a = await e.registrar(); const b = await e.registrar();
    const pid = e.mp.agregarPago({ userId: 1, external_reference: `sub:${a.org.id}`, monto: 12000 });
    const r = await e.api('GET', `/api/panel/suscripcion/verificar?payment_id=${pid}`, { token: b.token });
    assert.equal(r.status, 403);
    assert.equal((await org(b.org.id)).pagado_hasta, null);
  });
  test('al vencer se suspende la venta, se respetan los vendidos y al renovar vuelve', async () => {
    const o = await e.organizadorActivo(820);
    const t = await e.crearTombola(o.token);
    const r = await e.reservar(t.slug, [5]);
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: o.token });
    await e.sql(`update organizadores set trial_hasta = now() - interval '1 minute' where id = $1`, [o.org.id]);
    const pub = (await e.api('GET', `/api/t/${t.slug}`)).data;
    assert.equal(pub.suspendida, true);
    assert.equal(pub.numeros[5].e, 'pagado', 'lo vendido se respeta');
    assert.equal((await e.reservar(t.slug, [6])).status, 400);
    await pagarSuscripcion(o.org.id);
    assert.equal((await e.reservar(t.slug, [6])).status, 200);
  });
});

describe('Panel del dueño', () => {
  test('un organizador común no puede entrar', async () => {
    const o = await e.registrar();
    assert.equal((await e.api('GET', '/api/dueno', { token: o.token })).status, 403);
    assert.equal((await e.api('POST', `/api/dueno/${o.org.id}/extender`, { token: o.token, body: { dias: 30 } })).status, 403);
  });
  test('el dueño ve organizadores, suma días y bloquea', async () => {
    const d = await e.registrar();
    await e.sql('update organizadores set es_dueno = true where id = $1', [d.org.id]);
    const o = await e.registrar();
    const r = await e.api('GET', '/api/dueno', { token: d.token });
    assert.equal(r.status, 200);
    assert.ok(r.data.organizadores.some((x) => x.id === o.org.id));
    assert.ok(!JSON.stringify(r.data).includes('pass_hash'), 'no expone contraseñas');
    await e.api('POST', `/api/dueno/${o.org.id}/extender`, { token: d.token, body: { dias: 10 } });
    assert.equal((await e.api('GET', '/api/panel', { token: o.token })).data.org.activa, true);
    await e.api('POST', `/api/dueno/${o.org.id}/bloquear`, { token: d.token, body: { bloquear: true } });
    assert.equal((await e.api('GET', '/api/panel', { token: o.token })).status, 401, 'bloqueado no entra');
  });
});
