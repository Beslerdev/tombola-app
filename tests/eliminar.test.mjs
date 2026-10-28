// Eliminar y archivar tómbolas
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e, org;
before(async () => { e = await crearEntorno(); org = await e.organizadorActivo(1800); });
after(async () => { await e?.cerrar(); });

const eliminar = (id, token = org.token) => e.api('POST', `/api/panel/tombolas/${id}/eliminar`, { token, body: {} });
const vencer = (id) => e.sql(`update compras set reservado_hasta = now() - interval '1 minute' where id = $1`, [id])
  .then(() => e.sql(`update casilleros set reservado_hasta = now() - interval '1 minute' where compra_id = $1`, [id]));
const lista = async () => (await e.api('GET', '/api/panel', { token: org.token })).data.tombolas;

test('una tómbola recién creada (por error) se elimina por completo y su link deja de funcionar', async () => {
  const t = await e.crearTombola(org.token, { nombre: 'Creada Por Error' });
  assert.equal((await e.api('GET', `/api/panel/tombolas/${t.id}`, { token: org.token })).data.eliminable, true);
  const r = await eliminar(t.id);
  assert.equal(r.status, 200);
  assert.equal((await e.api('GET', `/api/t/${t.slug}`)).status, 404);
  assert.ok(!(await lista()).some((x) => x.id === t.id));
  assert.equal((await e.sql('select count(*)::int c from casilleros where tombola_id = $1', [t.id]))[0].c, 0);
});

test('también se elimina si solo tuvo reservas que vencieron o se cancelaron', async () => {
  const t = await e.crearTombola(org.token, { nombre: 'Solo Reservas Vencidas' });
  const r = await e.reservar(t.slug, [1, 2], '1155551001');
  await vencer(r.data.id);
  const c = await e.reservar(t.slug, [3], '1155551002');
  await e.api('POST', '/api/cancelar', { body: { compraId: c.data.id, celular: '1155551002' } });
  assert.equal((await eliminar(t.id)).status, 200);
  assert.equal((await e.sql('select count(*)::int c from compras where tombola_id = $1', [t.id]))[0].c, 0);
});

for (const [caso, preparar] of [
  ['alguien está reservando en este momento', async (t) => e.reservar(t.slug, [5], '1155552001')],
  ['hay un comprobante por verificar', async (t) => {
    const r = await e.reservar(t.slug, [6], '1155552002');
    await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1155552002', mime: 'image/png', b64: 'iVBORw0KGgo=' } });
  }],
  ['hay números vendidos', async (t) => {
    const r = await e.reservar(t.slug, [7], '1155552003');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: org.token });
  }],
]) {
  test(`no se puede eliminar si ${caso}`, async () => {
    const t = await e.crearTombola(org.token, { nombre: 'No Borrable ' + caso });
    await preparar(t);
    assert.equal((await e.api('GET', `/api/panel/tombolas/${t.id}`, { token: org.token })).data.eliminable, false);
    const r = await eliminar(t.id);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /no se puede eliminar/);
    assert.equal((await e.api('GET', `/api/t/${t.slug}`)).status, 200, 'sigue existiendo');
  });
}

test('nadie puede eliminar la tómbola de otro organizador', async () => {
  const otro = await e.organizadorActivo(1801);
  const t = await e.crearTombola(org.token, { nombre: 'Ajena' });
  assert.equal((await eliminar(t.id, otro.token)).status, 404);
  assert.equal((await e.api('GET', `/api/t/${t.slug}`)).status, 200);
});

test('archivar: se oculta de la lista, finaliza la venta y los compradores siguen viendo sus números', async () => {
  const t = await e.crearTombola(org.token, { nombre: 'Para Archivar' });
  const r = await e.reservar(t.slug, [9], '1155553001');
  await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: org.token });
  const a = await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: org.token, body: { archivada: true } });
  assert.equal(a.status, 200);
  assert.equal(a.data.tombola.archivada, true);
  assert.equal(a.data.tombola.estado, 'finalizada');
  const pub = await e.api('GET', `/api/t/${t.slug}`);
  assert.equal(pub.data.activa, false, 'ya no se puede comprar');
  const mios = await e.api('GET', `/api/t/${t.slug}/mis-compras?celular=1155553001`);
  assert.equal(mios.data.length, 1);
  assert.equal(mios.data[0].estado, 'aprobada');
  // Desarchivar la devuelve a la lista (la venta sigue finalizada hasta reactivarla)
  const d = await e.api('POST', `/api/panel/tombolas/${t.id}`, { token: org.token, body: { archivada: false } });
  assert.equal(d.data.tombola.archivada, false);
  assert.equal(d.data.tombola.estado, 'finalizada');
});
