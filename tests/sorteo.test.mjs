// Tómbolas y sorteo: creación, link único, ganador
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, o;
before(async () => { e = await crearEntorno(); o = await e.organizadorActivo(950); });
after(async () => { await e?.cerrar(); });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Crear y editar tómbolas', () => {
  test('valida nombre, premio y precio', async () => {
    for (const body of [{ nombre: 'ab', premio: 'x premio', precio: 10 }, { nombre: 'Buena', premio: '', precio: 10 }, { nombre: 'Buena', premio: 'Premio', precio: 0 }, { nombre: 'Buena', premio: 'Premio', precio: -5 }]) {
      assert.equal((await e.api('POST', '/api/panel/tombolas', { token: o.token, body })).status, 400, JSON.stringify(body));
    }
  });
  test('crea los 100 números libres y un link único aunque se repita el nombre', async () => {
    const a = await e.crearTombola(o.token, { nombre: 'Rifa del Club' });
    const b = await e.crearTombola(o.token, { nombre: 'Rifa del Club' });
    assert.equal(a.slug, 'rifa-del-club');
    assert.notEqual(a.slug, b.slug);
    const n = await e.sql(`select count(*)::int c from casilleros where tombola_id = $1 and estado = 'libre'`, [a.id]);
    assert.equal(n[0].c, 100);
  });
  test('el link convierte acentos y símbolos', async () => {
    const t = await e.crearTombola(o.token, { nombre: '¡Gran Tómbola Ñandú 2026!' });
    assert.equal(t.slug, 'gran-tombola-nandu-2026');
  });
  test('cambiar el precio no altera lo que ya se reservó', async () => {
    const t = await e.crearTombola(o.token, { precio: 1000 });
    const r = await e.reservar(t.slug, [1]);
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { precio: 5000 } });
    const c = (await e.sql('select monto from compras where id = $1', [r.data.id]))[0];
    assert.equal(Number(c.monto), 1000);
  });
});

describe('Sorteo', () => {
  test('publicar el ganador muestra el nombre en la página pública y cierra la venta', async () => {
    const t = await e.crearTombola(o.token);
    const r = await e.reservar(t.slug, [87], '1155559999', 'Mati');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: o.token });
    const p = await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: 87, detalle_ganador: 'Quiniela' } });
    assert.equal(p.status, 200);
    const pub = (await e.api('GET', `/api/t/${t.slug}`)).data;
    assert.equal(pub.tombola.numero_ganador, 87);
    assert.equal(pub.tombola.ganador_nombre, 'Mati');
    assert.equal((await e.reservar(t.slug, [5])).status, 400, 'no se vende después del sorteo');
  });
  test('si el número ganador no se vendió, no muestra nombre', async () => {
    const t = await e.crearTombola(o.token);
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: 3 } });
    assert.equal((await e.api('GET', `/api/t/${t.slug}`)).data.tombola.ganador_nombre, null);
  });
  test('quitar el resultado vuelve a habilitar la venta', async () => {
    const t = await e.crearTombola(o.token);
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: 10 } });
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: null, detalle_ganador: null } });
    assert.equal((await e.api('GET', `/api/t/${t.slug}`)).data.tombola.numero_ganador, null);
    assert.equal((await e.reservar(t.slug, [5])).status, 200);
  });
  test('rechaza números ganadores fuera de 00–99', async () => {
    const t = await e.crearTombola(o.token);
    for (const g of [100, -1, 'abc']) {
      assert.equal((await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: g } })).status, 400, String(g));
    }
  });
  test('una reserva hecha ANTES del sorteo no puede pagarse DESPUÉS y quedarse con el número', async () => {
    const t = await e.crearTombola(o.token, { precio: 1000 });
    const r = await e.reservar(t.slug, [50], '1155550050');
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: 50 } });
    const pid = e.mp.agregarPago({ userId: 950, external_reference: r.data.id, monto: 1000 });
    await e.api('POST', `/api/mp/webhook?org=${o.org.id}&type=payment&data.id=${pid}`, { body: {} });
    await esperar(300);
    const c = (await e.sql('select estado from compras where id = $1', [r.data.id]))[0];
    assert.notEqual(c.estado, 'aprobada', 'no debería quedar como comprador del número ya sorteado');
  });
  test('tampoco se puede subir un comprobante después del sorteo', async () => {
    const t = await e.crearTombola(o.token, { precio: 1000 });
    const r = await e.reservar(t.slug, [51], '1155550051');
    await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: o.token, body: { numero_ganador: 20 } });
    const png = Buffer.from('x').toString('base64');
    const s = await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1155550051', mime: 'image/png', b64: png } });
    assert.notEqual(s.status, 200, 'la tómbola ya se sorteó');
  });
});
