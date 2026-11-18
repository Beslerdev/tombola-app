// WhatsApp de contacto en "¿Olvidaste tu contraseña?"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { crearEntorno } from './entorno.mjs';

let e;
before(async () => { e = await crearEntorno(); });
after(async () => { await e?.cerrar(); });

test('sin celular del dueño queda el texto de siempre; con celular aparece el link de WhatsApp', async () => {
  assert.equal((await e.api('GET', '/api/contacto')).data.whatsapp, null);
  const otro = await e.registrar({ celular: '11 4444 0000' }); // un organizador común no es el contacto
  const d = await e.registrar();
  await e.sql('update organizadores set es_dueno = true where id = $1', [d.org.id]);
  await e.api('POST', '/api/panel/perfil', { token: d.token, body: { celular: '11 2345 6789' } });
  assert.equal((await e.api('GET', '/api/contacto')).data.whatsapp, '1123456789');

  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const p = await nav.newPage({ viewport: { width: 390, height: 800 } });
  await p.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await p.goto(e.url + '/ingresar');
  const link = p.locator('#olvido a');
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /^https:\/\/wa\.me\/5491123456789\?text=Hola/);
  if (process.env.CAPTURAS) await p.locator('#f-ingresar').screenshot({ path: process.env.CAPTURAS + '/olvido-whatsapp.png' });
  await nav.close();
  assert.ok(otro);
});
