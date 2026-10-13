// Anular compras, devolver el dinero con Mercado Pago y liberar números desde el panel
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, a, b, t;
const MP_A = 1200, MP_B = 1201;
before(async () => {
  e = await crearEntorno();
  a = await e.organizadorActivo(MP_A);
  b = await e.organizadorActivo(MP_B);
  t = await e.crearTombola(a.token, { precio: 1000 });
});
after(async () => { await e?.cerrar(); });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const compra = async (id) => (await e.sql('select * from compras where id = $1', [id]))[0];
const libres = async (nums) => (await e.sql(`select count(*)::int c from casilleros where tombola_id = $1 and n = any($2) and estado = 'libre'`, [t.id, nums]))[0].c;
async function compraPagadaConMp(nums, cel, monto) {
  const r = await e.reservar(t.slug, nums, cel);
  const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: monto ?? nums.length * 1000 });
  await e.api('POST', `/api/mp/webhook?org=${a.org.id}&type=payment&data.id=${pid}`, { body: {} });
  await esperar(300);
  return { id: r.data.id, pid };
}

describe('Anular y devolver el dinero (Mercado Pago)', () => {
  test('devuelve el dinero en Mercado Pago, libera los números y lo registra', async () => {
    const { id, pid } = await compraPagadaConMp([1, 2], '1160000001');
    assert.equal((await compra(id)).estado, 'aprobada');
    const r = await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token, body: { nota: 'Se arrepintió' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = await compra(id);
    assert.equal(c.estado, 'devuelta');
    assert.equal(c.nota_admin, 'Se arrepintió');
    assert.ok(c.reembolso_id, 'guarda el id de la devolución');
    assert.equal(e.mp.pagos.find((p) => p.id === pid).status, 'refunded', 'el pago quedó devuelto en Mercado Pago');
    assert.equal(await libres([1, 2]), 2, 'los números quedaron libres');
    assert.equal((await e.reservar(t.slug, [1], '1160000099')).status, 200, 'otro puede comprarlo');
  });

  test('tocar dos veces no devuelve dos veces', async () => {
    const { id } = await compraPagadaConMp([3], '1160000003');
    const antes = e.mp.reembolsos || 0;
    const [r1, r2] = await Promise.all([
      e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token }),
      e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token }),
    ]);
    assert.ok([r1.status, r2.status].includes(200));
    const r3 = await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token });
    assert.equal(r3.status, 400, 'una compra ya devuelta no se puede volver a devolver');
    assert.equal((e.mp.reembolsos || 0) - antes, 1, 'una sola devolución en Mercado Pago');
  });

  test('una compra en "devolver dinero" (pagó de menos) se puede devolver automáticamente', async () => {
    const { id } = await compraPagadaConMp([4, 5], '1160000004', 1000);
    assert.equal((await compra(id)).estado, 'excepcion');
    const r = await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await compra(id)).estado, 'devuelta');
  });

  test('si ya se había devuelto desde la app de Mercado Pago, lo registra igual', async () => {
    const { id, pid } = await compraPagadaConMp([6], '1160000006');
    e.mp.pagos.find((p) => p.id === pid).status = 'refunded';
    const r = await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await compra(id)).estado, 'devuelta');
    assert.equal(await libres([6]), 1);
  });

  test('una compra pagada por transferencia no se devuelve automáticamente', async () => {
    const r = await e.reservar(t.slug, [7], '1160000007');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: a.token });
    const d = await e.api('POST', `/api/panel/compras/${r.data.id}/devolver`, { token: a.token });
    assert.equal(d.status, 400);
    assert.match(d.data.error, /no se pagó con Mercado Pago/);
    assert.equal((await compra(r.data.id)).estado, 'aprobada', 'no cambia nada');
  });

  test('otro organizador no puede devolver una compra ajena', async () => {
    const { id, pid } = await compraPagadaConMp([8], '1160000008');
    const r = await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: b.token });
    assert.equal(r.status, 404);
    assert.equal((await compra(id)).estado, 'aprobada');
    assert.equal(e.mp.pagos.find((p) => p.id === pid).status, 'approved');
  });

  test('una compra sin pagar no se puede "devolver"', async () => {
    const r = await e.reservar(t.slug, [9], '1160000009');
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/devolver`, { token: a.token })).status, 400);
  });
});

describe('Liberar números desde el panel', () => {
  test('anular sin devolver libera los números y no toca Mercado Pago', async () => {
    const { id, pid } = await compraPagadaConMp([20], '1160000020');
    const r = await e.api('POST', `/api/panel/compras/${id}/rechazar`, { token: a.token, body: { nota: 'Anulada' } });
    assert.equal(r.status, 200);
    assert.equal(await libres([20]), 1);
    assert.equal(e.mp.pagos.find((p) => p.id === pid).status, 'approved', 'el dinero no se devolvió');
  });
  test('el organizador puede liberar una reserva que todavía no se pagó', async () => {
    const r = await e.reservar(t.slug, [21], '1160000021');
    const x = await e.api('POST', `/api/panel/compras/${r.data.id}/rechazar`, { token: a.token, body: { nota: 'Reserva liberada' } });
    assert.equal(x.status, 200);
    assert.equal(await libres([21]), 1);
  });
  test('la lista de compras del panel informa la devolución', async () => {
    const { id } = await compraPagadaConMp([22], '1160000022');
    await e.api('POST', `/api/panel/compras/${id}/devolver`, { token: a.token });
    const g = await e.api('GET', `/api/panel/tombolas/${t.id}`, { token: a.token });
    const c = g.data.compras.find((x) => x.id === id);
    assert.equal(c.estado, 'devuelta');
    assert.ok(c.reembolso_id);
  });
});
