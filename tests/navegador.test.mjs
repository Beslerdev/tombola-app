// Pruebas en un navegador real (Chromium): se usa la app como lo haría una persona,
// tocando botones y completando formularios, en el entorno aislado de pruebas.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { crearEntorno } from './entorno.mjs';

let e, nav, org, t;
const erroresJs = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  e = await crearEntorno();
  try { nav = await chromium.launch(); } catch { nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
  org = await e.organizadorActivo(1600);
  await e.api('POST', '/api/panel/perfil', { token: org.token, body: { acepta_efectivo: true } });
  t = await e.crearTombola(org.token, { nombre: 'Tómbola Navegador', precio: 1000 });
});
after(async () => { await nav?.close(); await e?.cerrar(); });

// Página nueva tamaño celular; registra errores de JavaScript
async function pagina({ ancho = 390, sesion } = {}) {
  const ctx = await nav.newContext({ viewport: { width: ancho, height: 860 } });
  // Las fuentes de Google no hacen falta para probar; se bloquean para no depender de internet
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/mp\.test/, (r) => r.fulfill({ status: 200, body: 'checkout de Mercado Pago (simulado)' }));
  const p = await ctx.newPage();
  p.on('pageerror', (err) => erroresJs.push(`${p.url()}: ${err.message}`));
  if (sesion) { await p.goto(e.url + '/terminos'); await p.evaluate((tk) => localStorage.setItem('tt_sesion', tk), sesion); }
  return p;
}
const confirmar = (p) => p.click('.velo.dialogo:not(.oculto) [data-si]');
const estadoNum = async (slug, n) => (await e.api('GET', `/api/t/${slug}`)).data.numeros[n].e;
const reservaGuardada = (p, slug) => p.evaluate((s) => JSON.parse(localStorage.getItem('tt_res_' + s)), slug);

async function elegirYReservar(p, slug, numeros, { nombre = 'Comprador Navegador', celular = '1155550000' } = {}) {
  await p.goto(`${e.url}/t/${slug}`);
  await p.waitForSelector('#grilla .celda:not([disabled])');
  for (const n of numeros) await p.click(`#grilla .celda[data-n="${n}"]`);
  await p.click('#b-reservar');
  await p.fill('#d-nombre', nombre);
  await p.fill('#d-cel', celular);
  await p.click('#d-enviar');
  await p.waitForSelector('#m-pago:not(.oculto)');
}

describe('Comprador (celular)', () => {
  test('elige dos números, ve el total y al reservar quedan tomados para los demás', async () => {
    const p = await pagina();
    await p.goto(`${e.url}/t/${t.slug}`);
    await p.waitForSelector('#grilla .celda');
    assert.equal(await p.locator('#grilla .celda').count(), 100);
    await p.click('#grilla .celda[data-n="1"]');
    await p.click('#grilla .celda[data-n="2"]');
    assert.equal(await p.textContent('#b-total'), '$2.000');
    await p.click('#b-reservar');
    await p.fill('#d-nombre', 'Ana Pérez'); await p.fill('#d-cel', '11 5555-0001');
    await p.click('#d-enviar');
    await p.waitForSelector('#m-pago:not(.oculto)');
    assert.match(await p.textContent('#p-reloj'), /^1[45]:\d\d$/, 'muestra la cuenta regresiva');
    assert.equal(await p.locator('#p-metodos [data-metodo]').count(), 3, 'Mercado Pago, transferencia y efectivo');
    assert.equal(await estadoNum(t.slug, 1), 'reservado');
    const otro = await pagina();
    await otro.goto(`${e.url}/t/${t.slug}`);
    await otro.waitForSelector('#grilla .celda');
    assert.equal(await otro.locator('#grilla .celda[data-n="1"]').isDisabled(), true, 'otro visitante no lo puede elegir');
    await otro.context().close(); await p.context().close();
  });

  test('cancelar la reserva libera el número', async () => {
    const p = await pagina();
    await elegirYReservar(p, t.slug, [3], { celular: '1155550003' });
    await p.click('#p-cancelar');
    await confirmar(p);
    await p.waitForSelector('#m-pago.oculto', { state: 'attached' });
    assert.equal(await estadoNum(t.slug, 3), 'libre');
    await p.context().close();
  });

  test('transferencia: sube el comprobante y queda "en verificación"', async () => {
    const p = await pagina();
    await elegirYReservar(p, t.slug, [4], { celular: '1155550004' });
    await p.click('#p-metodos [data-metodo="transf"]');
    assert.equal(await p.textContent('#p-alias'), 'mi.alias.test');
    await p.setInputFiles('#p-archivo', { name: 'comprobante.png', mimeType: 'image/png', buffer: PNG });
    await p.click('#p-enviar');
    await p.waitForSelector('#m-listo:not(.oculto)');
    assert.equal(await p.textContent('#m-listo-t'), '¡Comprobante recibido!');
    assert.equal(await estadoNum(t.slug, 4), 'pendiente');
    await p.context().close();
  });

  test('efectivo: confirma y en "Mis números" figura como "A pagar en efectivo"', async () => {
    const p = await pagina();
    await elegirYReservar(p, t.slug, [5], { celular: '1155550005' });
    await p.click('#p-metodos [data-metodo="efectivo"]');
    await p.click('#p-efectivo-ok');
    await p.waitForSelector('#m-listo:not(.oculto)');
    assert.equal(await p.textContent('#m-listo-t'), '¡Reserva confirmada!');
    await p.click('#l-ver');
    await p.waitForSelector('#mios-lista .compra');
    assert.match(await p.textContent('#mios-lista'), /A pagar en efectivo/);
    await p.context().close();
  });

  test('Mercado Pago: al volver con el pago aprobado ve "¡Pago exitoso!" y su número confirmado', async () => {
    const p = await pagina();
    await elegirYReservar(p, t.slug, [6], { celular: '1155550006' });
    await p.click('#p-metodos [data-metodo="mp"]');
    await p.click('#p-mp');
    await p.waitForURL(/mp\.test/);
    const pref = e.mp.preferencias.at(-1);
    const pid = e.mp.agregarPago({ userId: 1600, external_reference: pref.external_reference, monto: 1000 });
    await p.goto(`${pref.back_urls.success}&payment_id=${pid}&collection_status=approved`);
    await p.waitForSelector('#m-resultado:not(.oculto)');
    await p.waitForFunction(() => document.querySelector('#r-titulo').textContent !== 'Verificando tu pago…', null, { timeout: 15000 });
    assert.equal(await p.textContent('#r-titulo'), '¡Pago exitoso!');
    assert.equal(await estadoNum(t.slug, 6), 'pagado');
    await p.click('#r-acciones [data-ver-mios]');
    await p.waitForSelector('#mios-lista .compra');
    assert.match(await p.textContent('#mios-lista'), /Confirmado/);
    await p.context().close();
  });

  test('Mercado Pago: si cancela y vuelve, el número se libera y se le avisa', async () => {
    const p = await pagina();
    await elegirYReservar(p, t.slug, [7], { celular: '1155550007' });
    await p.click('#p-metodos [data-metodo="mp"]');
    await p.click('#p-mp');
    await p.waitForURL(/mp\.test/);
    const pref = e.mp.preferencias.at(-1);
    await p.goto(`${pref.back_urls.failure}&collection_status=null&payment_id=null`);
    await p.waitForFunction(() => /quedaron libres/.test(document.querySelector('#r-texto')?.textContent || ''), null, { timeout: 30000 });
    assert.equal(await estadoNum(t.slug, 7), 'libre');
    await p.context().close();
  });

  test('si otra persona reserva el mismo número mientras elige, se le avisa y no se rompe nada', async () => {
    const p = await pagina();
    await p.goto(`${e.url}/t/${t.slug}`);
    await p.waitForSelector('#grilla .celda');
    await p.click('#grilla .celda[data-n="8"]');
    await p.click('#grilla .celda[data-n="9"]');
    await e.reservar(t.slug, [9], '1199990009'); // otra persona se adelanta
    await p.click('#b-reservar');
    await p.fill('#d-nombre', 'Lento López'); await p.fill('#d-cel', '1155550008');
    await p.click('#d-enviar');
    await p.waitForSelector('#d-error .aviso');
    assert.match(await p.textContent('#d-error'), /09.*otra persona/);
    await p.context().close();
  });
});

describe('Organizador', () => {
  test('se registra desde la página y ve la prueba gratis esperando a conectar Mercado Pago', async () => {
    const p = await pagina();
    await p.goto(e.url + '/registro');
    await p.fill('#r-nombre', 'Club Navegador');
    await p.fill('#r-email', `club${Date.now()}@test.com`);
    await p.fill('#r-pass', 'clave-segura-1');
    await p.check('#r-acepto');
    await p.click('#f-registro button[type=submit]');
    await p.waitForURL(/\/panel/);
    await p.waitForSelector('#plan .dias');
    assert.match(await p.textContent('#plan'), /prueba gratis esperándote/);
    await p.context().close();
  });

  test('crea una tómbola desde el panel y el link público funciona', async () => {
    const p = await pagina({ sesion: org.token });
    await p.goto(e.url + '/panel');
    await p.click('#nueva');
    await p.fill('#n-nombre', 'Rifa Creada Desde El Panel');
    await p.fill('#n-premio', 'Una bici');
    await p.fill('#n-precio', '500');
    await p.click('#f-nueva button[type=submit]');
    await p.waitForURL(/\/panel\/t\//);
    const r = await e.api('GET', '/api/t/rifa-creada-desde-el-panel');
    assert.equal(r.status, 200);
    assert.equal(r.data.tombola.precio, 500);
    await p.context().close();
  });

  test('aprueba un comprobante desde "Atención" y el número queda vendido', async () => {
    const r = await e.reservar(t.slug, [20], '1155550020', 'Para Aprobar');
    await e.api('POST', '/api/comprobante', { body: { compraId: r.data.id, celular: '1155550020', mime: 'image/png', b64: PNG.toString('base64') } });
    const p = await pagina({ sesion: org.token });
    await p.goto(`${e.url}/panel/t/${t.id}`);
    const tarjeta = p.locator(`#lista-pend .compra[data-id="${r.data.id}"]`);
    await tarjeta.waitFor();
    assert.equal(await tarjeta.locator('[data-aprobar]').count(), 1, 'un solo botón "Aprobar"');
    await tarjeta.locator('[data-aprobar]').click();
    await p.waitForFunction((id) => !document.querySelector(`#lista-pend .compra[data-id="${id}"]`), r.data.id);
    assert.equal(await estadoNum(t.slug, 20), 'pagado');
    await p.context().close();
  });

  test('libera un número vendido desde la grilla', async () => {
    const r = await e.reservar(t.slug, [21], '1155550021', 'Para Liberar');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: org.token });
    const p = await pagina({ sesion: org.token });
    await p.goto(`${e.url}/panel/t/${t.id}`);
    await p.waitForSelector('#a-grilla .celda', { state: 'attached' });
    await p.click('[data-tab="grilla"]');
    await p.click('#a-grilla .celda[data-n="21"]');
    await p.click('#detalle-num [data-rechazar]');
    await confirmar(p);
    for (let i = 0; i < 20 && (await estadoNum(t.slug, 21)) !== 'libre'; i++) await p.waitForTimeout(150);
    assert.equal(await estadoNum(t.slug, 21), 'libre');
    await p.context().close();
  });

  test('con la tómbola completa publica el ganador y la página pública muestra su nombre', async () => {
    const t2 = await e.crearTombola(org.token, { nombre: 'Tómbola Llena', precio: 100 });
    const r = await e.reservar(t2.slug, Array.from({ length: 100 }, (_, i) => i), '1155550099', 'Mati Ganador');
    await e.api('POST', `/api/panel/compras/${r.data.id}/aprobar`, { token: org.token });
    const p = await pagina({ sesion: org.token });
    await p.goto(`${e.url}/panel/t/${t2.id}`);
    await p.waitForSelector('#a-avisos .aviso.completa');
    await p.click('[data-tab="sorteo"]');
    await p.fill('#s-num', '87');
    await p.click('#form-sorteo button[type=submit]');
    for (let i = 0; i < 20 && !(await e.api('GET', `/api/t/${t2.slug}`)).data.tombola.numero_ganador; i++) await p.waitForTimeout(150);
    const pub = await pagina();
    await pub.goto(`${e.url}/t/${t2.slug}`);
    await pub.waitForSelector('.aviso.ganador');
    assert.match(await pub.textContent('.aviso.ganador'), /87.*Mati Ganador/s);
    await p.context().close(); await pub.context().close();
  });
});

describe('Seguridad en pantalla', () => {
  test('un nombre con código malicioso se muestra como texto y no se ejecuta en el panel', async () => {
    const malicioso = '<img src=x onerror="window.__hackeado=1">Juan';
    await e.reservar(t.slug, [30], '1155550030', malicioso);
    const p = await pagina({ sesion: org.token });
    await p.goto(`${e.url}/panel/t/${t.id}`);
    await p.click('[data-tab="compras"]');
    await p.waitForSelector('#lista-compras .compra');
    await p.click('[data-tab="grilla"]');
    await p.click('#a-grilla .celda[data-n="30"]');
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => window.__hackeado), undefined, 'el código no se ejecutó');
    assert.match(await p.textContent('#lista-compras'), /<img src=x/, 'se ve como texto');
    await p.context().close();
  });
});

describe('Calidad general', () => {
  test('en celular ninguna página se sale de la pantalla hacia los costados', async () => {
    const p = await pagina({ ancho: 360, sesion: org.token });
    for (const ruta of ['/', '/registro', '/terminos', `/t/${t.slug}`, '/panel', `/panel/t/${t.id}`]) {
      await p.goto(e.url + ruta);
      await p.waitForTimeout(500);
      const desborde = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(desborde <= 1, `${ruta} se sale ${desborde}px de la pantalla`);
    }
    await p.context().close();
  });

  test('ninguna página tuvo errores de JavaScript durante las pruebas', () => {
    assert.deepEqual(erroresJs, []);
  });
});
