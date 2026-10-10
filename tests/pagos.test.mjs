// Pagos: Mercado Pago (webhook, vuelta del checkout, casos raros) y transferencia con comprobante
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, orgA, orgB, tA;
const MP_A = 700, MP_B = 701;
before(async () => {
  e = await crearEntorno();
  orgA = await e.organizadorActivo(MP_A);
  orgB = await e.organizadorActivo(MP_B);
  tA = await e.crearTombola(orgA.token, { precio: 1000 });
});
after(async () => { await e?.cerrar(); });

const compra = async (id) => (await e.sql('select * from compras where id = $1', [id]))[0];
const casillero = async (tid, n) => (await e.sql('select * from casilleros where tombola_id = $1 and n = $2', [tid, n]))[0];
const webhook = (org, id) => e.api('POST', `/api/mp/webhook?org=${org}&type=payment&data.id=${id}`, { body: { type: 'payment', data: { id: String(id) } } });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Mercado Pago: crear el pago', () => {
  test('genera el link de pago en la cuenta del organizador con el monto correcto', async () => {
    const r = await e.reservar(tA.slug, [1, 2], '1150000001');
    const p = await e.api('POST', '/api/pago/crear', { body: { compraId: r.data.id, celular: '1150000001' } });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const pref = e.mp.preferencias.at(-1);
    assert.equal(pref.token, e.mp.tokenDe(MP_A), 'la preferencia se crea con el token del organizador');
    assert.equal(pref.items[0].unit_price, 2000);
    assert.equal(pref.external_reference, r.data.id);
  });
  test('no genera el pago con otro celular o si la reserva ya no está activa', async () => {
    const r = await e.reservar(tA.slug, [3], '1150000002');
    assert.equal((await e.api('POST', '/api/pago/crear', { body: { compraId: r.data.id, celular: '1199999999' } })).status, 404);
    await e.api('POST', '/api/cancelar', { body: { compraId: r.data.id, celular: '1150000002' } });
    assert.equal((await e.api('POST', '/api/pago/crear', { body: { compraId: r.data.id, celular: '1150000002' } })).status, 400);
  });
});

describe('Mercado Pago: confirmación', () => {
  test('pago aprobado por webhook confirma los números', async () => {
    const r = await e.reservar(tA.slug, [10, 11], '1150000010');
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 2000 });
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'aprobada');
    assert.equal((await casillero(tA.id, 10)).estado, 'pagado');
    assert.equal((await casillero(tA.id, 11)).estado, 'pagado');
  });

  test('el mismo aviso repetido no genera efectos duplicados', async () => {
    const r = await e.reservar(tA.slug, [12], '1150000012');
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    await Promise.all([webhook(orgA.org.id, pid), webhook(orgA.org.id, pid), webhook(orgA.org.id, pid)]);
    await esperar(400);
    assert.equal((await compra(r.data.id)).estado, 'aprobada');
    const pagos = await e.sql('select count(*)::int c from pagos where payment_id = $1', [String(pid)]);
    assert.equal(pagos[0].c, 1);
  });

  test('al volver del checkout (sin webhook) también se confirma', async () => {
    const r = await e.reservar(tA.slug, [13], '1150000013');
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    const s = await e.api('GET', `/api/pago/estado?c=${r.data.id}&payment_id=${pid}`);
    assert.equal(s.data.estado, 'aprobada');
  });

  test('pago rechazado no confirma nada', async () => {
    const r = await e.reservar(tA.slug, [14], '1150000014');
    const pid = e.mp.agregarPago({ userId: MP_A, status: 'rejected', external_reference: r.data.id, monto: 1000 });
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'reservada');
    assert.equal((await casillero(tA.id, 14)).estado, 'reservado');
  });

  test('pago de menos queda para devolver y libera los números', async () => {
    const r = await e.reservar(tA.slug, [15, 16], '1150000015');
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'excepcion');
    assert.equal((await casillero(tA.id, 15)).estado, 'libre');
  });

  test('pago tarde: si el número sigue libre se acepta', async () => {
    const r = await e.reservar(tA.slug, [17], '1150000017');
    await e.sql(`update compras set reservado_hasta = now() - interval '5 minutes' where id = $1`, [r.data.id]);
    await e.sql(`update casilleros set reservado_hasta = now() - interval '5 minutes' where compra_id = $1`, [r.data.id]);
    await e.api('GET', `/api/t/${tA.slug}`); // dispara la liberación
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'aprobada');
    assert.equal((await casillero(tA.id, 17)).estado, 'pagado');
  });

  test('pago tarde: si el número ya lo tomó otro, queda para devolver y no se pisa al otro', async () => {
    const r = await e.reservar(tA.slug, [18], '1150000018');
    await e.sql(`update compras set reservado_hasta = now() - interval '5 minutes' where id = $1`, [r.data.id]);
    await e.sql(`update casilleros set reservado_hasta = now() - interval '5 minutes' where compra_id = $1`, [r.data.id]);
    const otro = await e.reservar(tA.slug, [18], '1150000099');
    assert.equal(otro.status, 200);
    const pid = e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'excepcion');
    assert.equal((await casillero(tA.id, 18)).compra_id, otro.data.id, 'el número sigue siendo del otro');
  });
});

describe('Mercado Pago: volver sin pagar', () => {
  test('sin ningún pago, la reserva se libera', async () => {
    const r = await e.reservar(tA.slug, [20], '1150000020');
    const a = await e.api('POST', '/api/pago/abandonar', { body: { compraId: r.data.id } });
    assert.equal(a.data.estado, 'cancelada');
    assert.equal((await casillero(tA.id, 20)).estado, 'libre');
  });
  test('con un pago en proceso, NO se libera', async () => {
    const r = await e.reservar(tA.slug, [21], '1150000021');
    e.mp.agregarPago({ userId: MP_A, status: 'in_process', external_reference: r.data.id, monto: 1000 });
    const a = await e.api('POST', '/api/pago/abandonar', { body: { compraId: r.data.id } });
    assert.equal(a.data.estado, 'reservada');
    assert.equal((await casillero(tA.id, 21)).estado, 'reservado');
  });
  test('si en realidad pagó, se confirma en lugar de liberar', async () => {
    const r = await e.reservar(tA.slug, [22], '1150000022');
    e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    const a = await e.api('POST', '/api/pago/abandonar', { body: { compraId: r.data.id } });
    assert.equal(a.data.estado, 'aprobada');
  });
});

describe('Mercado Pago: seguridad entre organizadores', () => {
  test('un pago de la cuenta de otro organizador no confirma compras ajenas', async () => {
    const r = await e.reservar(tA.slug, [30], '1150000030');
    // El organizador B arma un pago en SU cuenta apuntando a la compra de A
    const pid = e.mp.agregarPago({ userId: MP_B, external_reference: r.data.id, monto: 1000 });
    await webhook(orgB.org.id, pid); await esperar(300);
    await webhook(orgA.org.id, pid); await esperar(300);
    assert.equal((await compra(r.data.id)).estado, 'reservada', 'no debe aprobarse');
    const s = await e.api('GET', `/api/pago/estado?c=${r.data.id}&payment_id=${pid}`);
    assert.equal(s.data.estado, 'reservada');
  });
});

describe('Vuelta del checkout con un número de operación inválido', () => {
  test('muestra el estado real de la reserva en lugar de un error', async () => {
    const r = await e.reservar(tA.slug, [31], '1150000031');
    for (const pid of ['999999999', 'null', 'abc']) {
      const s = await e.api('GET', `/api/pago/estado?c=${r.data.id}&payment_id=${pid}`);
      assert.equal(s.status, 200, `payment_id=${pid}`);
      assert.equal(s.data.estado, 'reservada');
    }
  });
  test('si el link trae un número inválido pero la compra sí se pagó, la confirma igual', async () => {
    const r = await e.reservar(tA.slug, [32], '1150000032');
    e.mp.agregarPago({ userId: MP_A, external_reference: r.data.id, monto: 1000 });
    const s = await e.api('GET', `/api/pago/estado?c=${r.data.id}&payment_id=999999999`);
    assert.equal(s.data.estado, 'aprobada');
  });
});

describe('Transferencia con comprobante', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');

  test('subir comprobante deja la compra "en verificación" (sin confirmar)', async () => {
    const r = await e.reservar(tA.slug, [40], '1150000040');
    const s = await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1150000040', mime: 'image/png', nombreArchivo: 'c.png', b64: png } });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal((await compra(r.data.id)).estado, 'pendiente');
    assert.equal((await casillero(tA.id, 40)).estado, 'pendiente');
  });
  test('no acepta comprobantes con otro celular, otro tipo de archivo o reserva vencida', async () => {
    const r = await e.reservar(tA.slug, [41], '1150000041');
    assert.notEqual((await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1100000000', mime: 'image/png', b64: png } })).status, 200);
    assert.equal((await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1150000041', mime: 'text/html', b64: png } })).status, 400);
    await e.sql(`update compras set reservado_hasta = now() - interval '5 minutes' where id = $1`, [r.data.id]);
    const v = await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1150000041', mime: 'image/png', b64: png } });
    assert.equal(v.status, 400);
  });
  test('el organizador aprueba y el número queda vendido; otro organizador no puede', async () => {
    const r = await e.reservar(tA.slug, [42], '1150000042');
    await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1150000042', mime: 'image/png', b64: png } });
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: orgB.token })).status, 404);
    assert.equal((await e.api('GET', `/api/panel/comprobante/${r.data.id}`, { token: orgB.token })).status, 404, 'B no ve el comprobante de A');
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: orgA.token })).status, 200);
    assert.equal((await casillero(tA.id, 42)).estado, 'pagado');
  });
  test('rechazar libera los números y guarda el motivo', async () => {
    const r = await e.reservar(tA.slug, [43], '1150000043');
    await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1150000043', mime: 'image/png', b64: png } });
    await e.api('POST', `/api/panel/compras/${r.data.id}/rechazar`, { token: orgA.token, body: { nota: 'No llegó la plata' } });
    const c = await compra(r.data.id);
    assert.equal(c.estado, 'rechazada'); assert.equal(c.nota_admin, 'No llegó la plata');
    assert.equal((await casillero(tA.id, 43)).estado, 'libre');
  });
});
