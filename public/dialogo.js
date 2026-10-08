// Ventana de confirmación propia (reemplaza confirm/prompt, que algunos navegadores bloquean)
(() => {
  const velo = document.createElement('div');
  velo.className = 'velo dialogo oculto';
  velo.setAttribute('role', 'alertdialog');
  velo.setAttribute('aria-modal', 'true');
  velo.innerHTML = `
    <form class="modal">
      <h2 data-t style="font-size:21px"></h2>
      <p class="sub" data-x style="margin-bottom:6px;white-space:pre-line"></p>
      <div class="campo oculto" data-campo style="margin:12px 0 0"><label data-l></label><input type="text" data-i maxlength="300"></div>
      <div class="botones"><button type="button" class="btn secundario" data-no></button><button type="submit" class="btn" data-si></button></div>
    </form>`;
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(velo));
  if (document.body) document.body.appendChild(velo);
  const q = (s) => velo.querySelector(s);
  let resolver = null;
  function cerrar(valor) { velo.classList.add('oculto'); const r = resolver; resolver = null; if (r) r(valor); }
  q('[data-no]').addEventListener('click', () => cerrar(null));
  velo.addEventListener('click', (e) => { if (e.target === velo) cerrar(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && resolver) cerrar(null); });
  q('form').addEventListener('submit', (e) => {
    e.preventDefault();
    cerrar(q('[data-campo]').classList.contains('oculto') ? true : q('[data-i]').value.trim());
  });
  // preguntar({titulo, texto, si, no, peligro, campo, valor}) -> Promise<true | string | null>
  window.preguntar = (o = {}) => new Promise((res) => {
    if (resolver) cerrar(null);
    resolver = res;
    q('[data-t]').textContent = o.titulo || '¿Confirmás?';
    q('[data-x]').textContent = o.texto || '';
    q('[data-si]').textContent = o.si || 'Confirmar';
    q('[data-no]').textContent = o.no || 'Volver';
    q('[data-si]').className = 'btn' + (o.peligro ? '' : ' oscuro');
    const conCampo = typeof o.campo === 'string';
    q('[data-campo]').classList.toggle('oculto', !conCampo);
    if (conCampo) { q('[data-l]').textContent = o.campo; q('[data-i]').value = o.valor || ''; }
    velo.classList.remove('oculto');
    setTimeout(() => (conCampo ? q('[data-i]') : q('[data-si]')).focus(), 30);
  });
})();
