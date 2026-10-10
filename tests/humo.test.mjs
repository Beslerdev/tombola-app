import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './entorno.mjs';

let e;
before(async () => { e = await crearEntorno(); });
after(async () => { await e?.cerrar(); });

test('el entorno levanta y las páginas responden', async () => {
  for (const ruta of ['/', '/ingresar', '/registro', '/panel', '/dueno', '/terminos', '/t/algo']) {
    const r = await e.api('GET', ruta);
    assert.equal(r.status, 200, ruta);
  }
  assert.equal((await e.api('GET', '/no-existe')).status, 404);
});

test('un organizador puede registrarse, crear una tómbola y alguien reservar', async () => {
  const o = await e.organizadorActivo(500);
  const t = await e.crearTombola(o.token);
  const r = await e.reservar(t.slug, [7, 8]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.numeros, [7, 8]);
  assert.equal(Number(r.data.monto), 2000);
});
