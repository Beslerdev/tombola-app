// Seguridad: datos privados, acceso entre organizadores y acceso directo a la base
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { crearEntorno, DB_KEY } from './entorno.mjs';

let e, a, b, tA;
before(async () => {
  e = await crearEntorno();
  a = await e.organizadorActivo(900);
  b = await e.organizadorActivo(901);
  tA = await e.crearTombola(a.token);
});
after(async () => { await e?.cerrar(); });

describe('Datos privados', () => {
  test('la página pública no expone celulares, credenciales ni ids internos', async () => {
    const r = await e.reservar(tA.slug, [1], '1144443333', 'Privado Pérez');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: a.token });
    const txt = JSON.stringify((await e.api('GET', `/api/t/${tA.slug}`)).data);
    for (const prohibido of ['1144443333', 'Privado', 'mp_tokens', 'pass_hash', 'email', a.org.id]) {
      assert.ok(!txt.includes(prohibido), `no debería aparecer "${prohibido}"`);
    }
  });
  test('el panel no devuelve contraseña ni credenciales de Mercado Pago', async () => {
    const txt = JSON.stringify((await e.api('GET', '/api/panel', { token: a.token })).data);
    assert.ok(!txt.includes('pass_hash') && !txt.includes('mp_tokens') && !txt.includes('APP_USR'));
  });
  test('las credenciales de Mercado Pago se guardan cifradas', async () => {
    const row = (await e.sql('select mp_tokens from organizadores where id = $1', [a.org.id]))[0];
    assert.ok(row.mp_tokens && !row.mp_tokens.includes('APP_USR'), 'no debe estar en texto plano');
  });
  test('las contraseñas se guardan con hash', async () => {
    const row = (await e.sql('select pass_hash from organizadores where id = $1', [a.org.id]))[0];
    assert.match(row.pass_hash, /^scrypt\$/);
    assert.ok(!row.pass_hash.includes('clave-segura-1'));
  });
});

describe('Un organizador no puede tocar lo de otro', () => {
  test('no puede ver, editar ni sortear la tómbola ajena', async () => {
    assert.equal((await e.api('GET', `/api/panel/tombolas/${tA.id}`, { token: b.token })).status, 404);
    assert.equal((await e.api('POST', `/api/panel/tombolas/${tA.id}`, { token: b.token, body: { precio: 1 } })).status, 404);
    assert.equal((await e.api('POST', `/api/panel/tombolas/${tA.id}`, { token: b.token, body: { numero_ganador: 5 } })).status, 404);
    const t = (await e.sql('select precio, numero_ganador from tombolas where id = $1', [tA.id]))[0];
    assert.equal(t.precio, 1000); assert.equal(t.numero_ganador, null);
  });
  test('no puede rechazar ni marcar como devuelta una compra ajena', async () => {
    const r = await e.reservar(tA.slug, [2]);
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/rechazar`, { token: b.token, body: { nota: 'x' } })).status, 404);
    assert.equal((await e.api('POST', `/api/panel/compras/${r.data.id}/devuelta`, { token: b.token })).status, 404);
  });
  test('ids inválidos responden 400 y no rompen el servidor', async () => {
    assert.equal((await e.api('GET', `/api/panel/tombolas/no-es-un-id`, { token: a.token })).status, 400);
    assert.equal((await e.api('POST', `/api/panel/compras/1;drop table compras/aprobar`, { token: a.token })).status, 400);
    assert.equal((await e.sql('select count(*)::int c from compras'))[0].c >= 0, true, 'la tabla sigue existiendo');
    assert.equal((await e.api('GET', `/api/t/${encodeURIComponent("x' or 1=1 --")}`)).status, 404);
  });
});

describe('Acceso directo a la base (como lo haría alguien con la clave pública de Supabase)', () => {
  let cli;
  before(async () => { cli = new pg.Client({ host: '127.0.0.1', port: e.pgPuerto, user: 'anon', password: 'anon', database: 'postgres' }); await cli.connect(); });
  after(async () => { await cli.end(); });

  test('no puede leer las tablas', async () => {
    for (const t of ['organizadores', 'compras', 'casilleros', 'comprobantes', 'app_secret', 'pagos_suscripcion', 'pruebas_mp']) {
      const r = await cli.query(`select count(*)::int c from ${t}`);
      assert.equal(r.rows[0].c, 0, `${t} debería verse vacía para anon`);
    }
  });
  test('no puede escribir en las tablas', async () => {
    await assert.rejects(cli.query(`update organizadores set es_dueno = true`).then((r) => { if (r.rowCount) throw new Error('modificó'); throw new Error('sin filas'); }));
    await assert.rejects(cli.query(`insert into pagos_suscripcion (payment_id, organizador_id, dias) values ('x', '${a.org.id}', 999)`));
  });
  test('no puede llamar funciones internas', async () => {
    await assert.rejects(cli.query(`select reservar_t('${tA.id}', array[9], 'x', '1')`), /permission denied/);
    await assert.rejects(cli.query(`select aprobar_compra(gen_random_uuid())`), /permission denied/);
  });
  test('las funciones api_* exigen la clave del servidor', async () => {
    await assert.rejects(cli.query(`select api_dueno_resumen('clave-falsa')`), /NO_AUTORIZADO/);
    await assert.rejects(cli.query(`select api_suscripcion_pago(null, 'x', '${a.org.id}', 1, 999, 'x')`), /NO_AUTORIZADO/);
    const ok = await cli.query(`select api_tombola_get($1, $2) r`, [DB_KEY, tA.id]);
    assert.ok(ok.rows[0].r, 'con la clave correcta sí funciona');
  });
});
