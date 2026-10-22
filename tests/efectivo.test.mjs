// Pago en efectivo: el comprador lo elige, el organizador aprueba; si no, se libera a las 48 horas
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, o, t;
before(async () => {
  e = await crearEntorno();
  o = await e.organizadorActivo(1400);
  t = await e.crearTombola(o.token, { precio: 1000 });
});
after(async () => { await e?.cerrar(); });

const compra = async (id) => (await e.sql('select * from compras where id = $1', [id]))[0];
const casillero = async (n, tid = t.id) => (await e.sql('select * from casilleros where tombola_id = $1 and n = $2', [tid, n]))[0];
const efectivo = (id, celular) => e.api('POST', '/api/efectivo', { body: { compraId: id, celular } });
const vencer = (id) => e.sql(`update compras set reservado_hasta = now() - interval '1 minute' where id = $1;`, [id])
  .then(() => e.sql(`update casilleros set reservado_hasta = now() - interval '1 minute' where compra_id = $1`, [id]));

describe('Configuración', () => {
  test('si el organizador no lo activó, no se puede elegir efectivo', async () => {
    const r = await e.reservar(t.slug, [1], '1170000001');
    const x = await efectivo(r.data.id, '1170000001');
    assert.equal(x.status, 400);
    assert.match(x.data.error, /no acepta pago en efectivo/);
    assert.equal((await compra(r.data.id)).estado, 'reservada');
    assert.equal((await e.api('GET', `/api/t/${t.slug}`)).data.medios.efectivo, false);
  });
  test('al activarlo aparece como medio de pago en la tómbola', async () => {
    const r = await e.api('POST', '/api/panel/perfil', { token: o.token, body: { acepta_efectivo: true } });
    assert.equal(r.data.org.acepta_efectivo, true);
    const pub = (await e.api('GET', `/api/t/${t.slug}`)).data;
    assert.equal(pub.medios.efectivo, true);
    assert.equal(pub.organizador.efectivo_horas, 48);
  });
  test('un organizador que solo acepta efectivo puede vender', async () => {
    const o2 = await e.registrar();
    await e.sql(`update organizadores set pagado_hasta = now() + interval '30 days' where id = $1`, [o2.org.id]);
    await e.api('POST', '/api/panel/perfil', { token: o2.token, body: { acepta_transferencia: false, acepta_efectivo: true } });
    const t2 = await e.crearTombola(o2.token);
    const r = await e.reservar(t2.slug, [5], '1170000005');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await efectivo(r.data.id, '1170000005')).status, 200);
  });
});

describe('Compra en efectivo', () => {
  test('al elegir efectivo los números quedan apartados 48 horas, "por verificar"', async () => {
    const r = await e.reservar(t.slug, [10, 11], '1170000010');
    const x = await efectivo(r.data.id, '11 7000-0010');
    assert.equal(x.status, 200, JSON.stringify(x.data));
    const c = await compra(r.data.id);
    assert.equal(c.estado, 'pendiente');
    assert.equal(c.metodo_pago, 'efectivo');
    const horas = (new Date(c.reservado_hasta) - Date.now()) / 3600000;
    assert.ok(horas > 47.9 && horas <= 48, `fueron ${horas} horas`);
    assert.equal((await casillero(10)).estado, 'pendiente');
    assert.equal((await e.reservar(t.slug, [10], '1170000099')).status, 409, 'nadie más lo puede tomar');
    const mias = (await e.api('GET', `/api/t/${t.slug}/mis-compras?celular=1170000010`)).data;
    assert.equal(mias[0].metodo_pago, 'efectivo');
  });
  test('aparece en "Atención" del organizador', async () => {
    const lista = (await e.api('GET', '/api/panel', { token: o.token })).data.tombolas;
    assert.ok(lista.find((x) => x.id === t.id).atencion >= 1);
  });
  test('con otro celular, o con la reserva vencida, no se puede elegir efectivo', async () => {
    const r = await e.reservar(t.slug, [12], '1170000012');
    assert.notEqual((await efectivo(r.data.id, '1199999999')).status, 200);
    await vencer(r.data.id);
    assert.equal((await efectivo(r.data.id, '1170000012')).status, 400);
  });
  test('no se puede elegir efectivo dos veces ni después de pagar', async () => {
    const r = await e.reservar(t.slug, [13], '1170000013');
    await efectivo(r.data.id, '1170000013');
    assert.equal((await efectivo(r.data.id, '1170000013')).status, 400);
  });
  test('cuando el organizador aprueba, los números quedan vendidos', async () => {
    const r = await e.reservar(t.slug, [20], '1170000020');
    await efectivo(r.data.id, '1170000020');
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: o.token })).status, 200);
    assert.equal((await compra(r.data.id)).estado, 'aprobada');
    const cas = await casillero(20);
    assert.equal(cas.estado, 'pagado');
    assert.equal(cas.reservado_hasta, null, 'ya no vence');
  });
  test('si el organizador no aprueba dentro del plazo, se libera solo', async () => {
    const r = await e.reservar(t.slug, [30], '1170000030');
    await efectivo(r.data.id, '1170000030');
    await vencer(r.data.id);
    const pub = (await e.api('GET', `/api/t/${t.slug}`)).data;
    assert.equal(pub.numeros[30].e, 'libre');
    assert.equal((await compra(r.data.id)).estado, 'vencida');
    assert.equal((await e.reservar(t.slug, [30], '1170000031')).status, 200, 'otro lo puede comprar');
  });
  test('el organizador puede rechazarla y el número se libera', async () => {
    const r = await e.reservar(t.slug, [31], '1170000032');
    await efectivo(r.data.id, '1170000032');
    await e.api('POST', `/api/panel/compras/${r.data.id}/rechazar`, { token: o.token, body: { nota: 'No vino a pagar' } });
    assert.equal((await casillero(31)).estado, 'libre');
  });
  test('un comprobante de transferencia "por verificar" NO se libera por el plazo de efectivo', async () => {
    const r = await e.reservar(t.slug, [40], '1170000040');
    const png = Buffer.from('x').toString('base64');
    await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1170000040', mime: 'image/png', b64: png } });
    await e.sql(`update compras set updated_at = now() - interval '10 days' where id = $1`, [r.data.id]);
    await e.api('GET', `/api/t/${t.slug}`);
    assert.equal((await compra(r.data.id)).estado, 'pendiente');
    assert.equal((await casillero(40)).estado, 'pendiente');
  });
});
