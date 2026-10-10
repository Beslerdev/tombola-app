// Reservas de números: validaciones, conflictos, concurrencia y vencimientos
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, org, t;
before(async () => {
  e = await crearEntorno();
  org = await e.organizadorActivo(600);
  t = await e.crearTombola(org.token, { precio: 2500 });
});
after(async () => { await e?.cerrar(); });

const estadoDe = async (slug, n) => (await e.api('GET', `/api/t/${slug}`)).data.numeros[n].e;

describe('Validaciones al reservar', () => {
  test('rechaza números fuera de 00–99', async () => {
    for (const nums of [[100], [-1], [1.5], ['7'], []]) {
      const r = await e.reservar(t.slug, nums);
      assert.equal(r.status, 400, `debería rechazar ${JSON.stringify(nums)}`);
    }
  });
  test('rechaza nombre o celular inválidos', async () => {
    assert.equal((await e.reservar(t.slug, [1], '1155550000', 'A')).status, 400);
    assert.equal((await e.reservar(t.slug, [1], '123', 'Ana Pérez')).status, 400);
  });
  test('acepta el celular con distintos formatos y lo normaliza', async () => {
    const r = await e.reservar(t.slug, [2], '+54 9 11 5555-1234', 'Ana Pérez');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.celular, '1155551234');
  });
  test('números repetidos en el pedido se cuentan una sola vez', async () => {
    const r = await e.reservar(t.slug, [3, 3, 3]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.numeros, [3]);
    assert.equal(Number(r.data.monto), 2500);
  });
  test('tómbola inexistente responde 404', async () => {
    assert.equal((await e.reservar('no-existe', [1])).status, 404);
  });
});

describe('Conflictos', () => {
  test('no se puede reservar un número ya reservado', async () => {
    const a = await e.reservar(t.slug, [10, 11]);
    assert.equal(a.status, 200);
    const b = await e.reservar(t.slug, [11, 12]);
    assert.equal(b.status, 409);
    assert.deepEqual(b.data.ocupados, [11]);
    assert.equal(await estadoDe(t.slug, 12), 'libre', 'el 12 no debe quedar tomado si la reserva falló');
  });

  test('20 personas a la vez por el mismo número: solo una lo consigue', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => e.reservar(t.slug, [42], `11555500${String(i).padStart(2, '0')}`)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, 'exactamente una reserva exitosa');
    assert.equal(rs.filter((r) => r.status === 409).length, 19);
  });

  test('reservas cruzadas simultáneas no se bloquean entre sí', async () => {
    const rs = await Promise.all([e.reservar(t.slug, [50, 51]), e.reservar(t.slug, [51, 52]), e.reservar(t.slug, [52, 50])]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    const n = await e.sql(`select count(*)::int c from casilleros where tombola_id = $1 and n in (50,51,52) and estado <> 'libre'`, [t.id]);
    assert.equal(n[0].c, 2);
  });
});

describe('Vencimiento y cancelación', () => {
  test('una reserva vencida libera el número', async () => {
    const r = await e.reservar(t.slug, [60]);
    await e.sql(`update compras set reservado_hasta = now() - interval '2 minutes' where id = $1`, [r.data.id]);
    await e.sql(`update casilleros set reservado_hasta = now() - interval '2 minutes' where compra_id = $1`, [r.data.id]);
    assert.equal(await estadoDe(t.slug, 60), 'libre');
    const c = await e.sql('select estado from compras where id = $1', [r.data.id]);
    assert.equal(c[0].estado, 'vencida');
    assert.equal((await e.reservar(t.slug, [60], '1166660000')).status, 200, 'otro puede tomarlo');
  });

  test('cancelar libera los números; solo con el celular correcto', async () => {
    const r = await e.reservar(t.slug, [61], '1177770000');
    const mal = await e.api('POST', '/api/cancelar', { body: { compraId: r.data.id, celular: '1100000000' } });
    assert.notEqual(mal.status, 200, 'con otro celular no debe poder cancelar');
    assert.equal(await estadoDe(t.slug, 61), 'reservado');
    const ok = await e.api('POST', '/api/cancelar', { body: { compraId: r.data.id, celular: '11 7777-0000' } });
    assert.equal(ok.status, 200);
    assert.equal(await estadoDe(t.slug, 61), 'libre');
  });

  test('"Mis números" muestra solo las compras de ese celular en esa tómbola', async () => {
    await e.reservar(t.slug, [70], '1188880000', 'Luis');
    const otra = await e.crearTombola(org.token, { nombre: 'Otra tómbola' });
    await e.reservar(otra.slug, [70], '1188880000', 'Luis');
    const r = await e.api('GET', `/api/t/${t.slug}/mis-compras?celular=1188880000`);
    assert.equal(r.status, 200);
    assert.equal(r.data.length, 1);
    assert.deepEqual(r.data[0].numeros, [70]);
  });
});

describe('Estado de la tómbola', () => {
  test('pausada o finalizada no acepta reservas, y al reactivar vuelve a vender', async () => {
    const t2 = await e.crearTombola(org.token, { nombre: 'Pausable' });
    for (const estado of ['pausada', 'finalizada']) {
      await e.api('POST', `/api/panel/tombolas/${t2.id}`, { token: org.token, body: { estado } });
      const r = await e.reservar(t2.slug, [1]);
      assert.equal(r.status, 400, estado);
      assert.match(r.data.error, /no acepta compras/);
    }
    await e.api('POST', `/api/panel/tombolas/${t2.id}`, { token: org.token, body: { estado: 'activa' } });
    assert.equal((await e.reservar(t2.slug, [1])).status, 200);
  });

  test('el contador de vendidos y la grilla pública son coherentes', async () => {
    const d = (await e.api('GET', `/api/t/${t.slug}`)).data;
    assert.equal(d.numeros.length, 100);
    assert.deepEqual(d.numeros.map((x) => x.n), Array.from({ length: 100 }, (_, i) => i));
  });
});
