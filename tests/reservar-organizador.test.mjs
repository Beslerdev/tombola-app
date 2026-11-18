// El organizador reserva números a nombre de otra persona ("guardame este número")
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { crearEntorno } from './entorno.mjs';

let e, org, t;
before(async () => { e = await crearEntorno(); org = await e.organizadorActivo(2100); t = await e.crearTombola(org.token, { nombre: 'Guardame Este' }); });
after(async () => { await e?.cerrar(); });

const reservar = (body, token = org.token, id = t.id) => e.api('POST', `/api/panel/tombolas/${id}/reservar`, { token, body });
const estado = async (n) => (await e.api('GET', `/api/t/${t.slug}`)).data.numeros[n].e;

test('"Ya me pagó": el número queda vendido al instante', async () => {
  const r = await reservar({ numeros: [10], nombre: 'Ana Gómez', celular: '1155556010', pagado: true });
  assert.equal(r.status, 200);
  assert.equal(await estado(10), 'pagado');
  const c = (await e.sql('select estado, metodo_pago, pagado_at from compras where id = $1', [r.data.id]))[0];
  assert.equal(c.estado, 'aprobada'); assert.equal(c.metodo_pago, 'en_mano'); assert.ok(c.pagado_at);
});

test('"Guardar sin pagar": queda tomado y no se libera solo con el tiempo', async () => {
  const r = await reservar({ numeros: [11], nombre: 'Beto Ruiz', celular: '1155556011', pagado: false });
  assert.equal(r.status, 200);
  assert.equal(await estado(11), 'pendiente');
  // Aunque pasen días, no se libera (no tiene vencimiento)
  await e.sql(`update compras set created_at = now() - interval '30 days' where id = $1`, [r.data.id]);
  assert.equal(await estado(11), 'pendiente');
  const mios = await e.api('GET', `/api/t/${t.slug}/mis-compras?celular=1155556011`);
  assert.equal(mios.data[0].metodo_pago, 'guardado');
  // Otra persona no lo puede comprar
  assert.equal((await e.reservar(t.slug, [11], '1199990011')).status, 409);
});

test('un número guardado se aprueba cuando paga, o se libera', async () => {
  const a = await reservar({ numeros: [12], nombre: 'Caro Paz', celular: '1155556012', pagado: false });
  await e.api('POST', `/api/panel/compras/${a.data.id}/aprobar`, { token: org.token });
  assert.equal(await estado(12), 'pagado');
  const b = await reservar({ numeros: [13], nombre: 'Dani Sol', celular: '1155556013', pagado: false });
  await e.api('POST', `/api/panel/compras/${b.data.id}/rechazar`, { token: org.token, body: { nota: '' } });
  assert.equal(await estado(13), 'libre');
});

test('no se puede reservar un número ocupado, ni sin nombre o celular', async () => {
  assert.equal((await reservar({ numeros: [10], nombre: 'Otro', celular: '1155556099', pagado: true })).status, 409);
  assert.equal((await reservar({ numeros: [20], nombre: '', celular: '1155556099' })).status, 400);
  assert.equal((await reservar({ numeros: [20], nombre: 'Sin Cel', celular: '12' })).status, 400);
  assert.equal(await estado(20), 'libre');
});

test('nadie puede reservar en la tómbola de otro organizador', async () => {
  const otro = await e.organizadorActivo(2101);
  assert.equal((await reservar({ numeros: [30], nombre: 'Intruso', celular: '1155556030', pagado: true }, otro.token)).status, 404);
  assert.equal((await e.api('POST', `/api/panel/tombolas/${t.id}/reservar`, { body: { numeros: [30], nombre: 'X', celular: '1155556030' } })).status, 401);
  assert.equal(await estado(30), 'libre');
});

test('en pantalla: toca un número libre en la Grilla, lo guarda sin pagar y después marca "Ya me pagó"', async () => {
  const S = process.env.CAPTURAS;
  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  const p = await ctx.newPage();
  const errores = []; p.on('pageerror', (x) => errores.push(x.message));
  await p.goto(e.url + '/terminos'); await p.evaluate((tk) => localStorage.setItem('tt_sesion', tk), org.token);
  await p.goto(`${e.url}/panel/t/${t.id}`);
  await p.waitForSelector('#a-grilla .celda', { state: 'attached' });
  await p.click('[data-tab="grilla"]');
  await p.click('#a-grilla .celda[data-n="40"]');
  await p.waitForSelector('#f-para');
  await p.fill('#pa-nombre', 'Juan Pérez'); await p.fill('#pa-cel', '11 5555 6040');
  if (S) { await p.locator('#detalle-num').scrollIntoViewIfNeeded(); await p.screenshot({ path: S + '/guardar-1-formulario.png' }); }
  await p.click('#f-para [data-pagado="0"]');
  await p.waitForFunction(() => /Guardado sin pagar/.test(document.querySelector('#detalle-num').textContent));
  assert.equal(await estado(40), 'pendiente');
  if (S) { await p.waitForTimeout(300); await p.screenshot({ path: S + '/guardar-2-guardado.png' }); }
  await p.click('#detalle-num [data-aprobar]');
  await p.waitForFunction(() => /Vendido/.test(document.querySelector('#detalle-num').textContent));
  assert.equal(await estado(40), 'pagado');
  if (S) { await p.waitForTimeout(300); await p.screenshot({ path: S + '/guardar-3-pagado.png' }); }
  // El comprador lo ve en "Mis números"
  await p.goto(`${e.url}/t/${t.slug}`);
  assert.deepEqual(errores, []);
  await nav.close();
});
