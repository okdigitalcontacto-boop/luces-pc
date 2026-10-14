import { MODELS, EFFECTS } from './models.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Estado guardado ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('luces.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('luces.' + k, JSON.stringify(v)); } catch {} },
};
const state = {
  on: true,
  mode: 'color',                       // color | white | fx | music
  rgb: store.get('rgb', [255, 45, 85]),
  bright: store.get('bright', 100),
  temp: store.get('temp', 50),
  speed: store.get('speed', 50),
  fx: store.get('fx', null),           // {v, name}
  favs: store.get('favs', []),
  modelIdx: null,
};

// ---------- Utilidades de color ----------
function hsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}
function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
const COLD = [207, 227, 255], WARM = [255, 194, 122];
const tempRGB = (t) => COLD.map((c, i) => Math.round(c + (WARM[i] - c) * t / 100));
const css = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

// ---------- Registro ----------
const logEl = $('#log');
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `${t}  ${msg}\n` + logEl.textContent.slice(0, 4000);
}
const hex = (a) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');

// ---------- Modelos ----------
function detectModel(name = '') {
  const n = name.toLowerCase();
  const hits = MODELS.map((m, i) => [m, i]).filter(([m]) => n.startsWith(m.name.toLowerCase()));
  if (!hits.length) return MODELS.findIndex((m) => m.name === 'ELK-BLEDOM' && m.handle == null);
  hits.sort((a, b) => b[0].name.length - a[0].name.length);
  const top = hits.filter(([m]) => m.name === hits[0][0].name);
  return (top.find(([m]) => m.handle == null) || top[0])[1];
}
const model = () => MODELS[state.modelIdx ?? detectModel('')];
function cmd(kind, vals = {}) {
  const t = model().commands[kind];
  if (!t || !t.length) return null;
  return t.map((x) => (typeof x === 'string' ? Math.max(0, Math.min(255, Math.round(vals[x] ?? 0))) : x));
}
function effectList() {
  return EFFECTS[model().effects_list] || EFFECTS.EFFECTS_list;
}

// ---------- Bluetooth ----------
// UUID completos: algunos navegadores (p. ej. Bluefy) no aceptan los alias numéricos
const UUID = (s) => `0000${s}-0000-1000-8000-00805f9b34fb`;
const SERVICES = ['fff0', 'ffe0', 'ffe5', 'ffd0', 'ff00'].map(UUID);
const PREFIXES = ['ELK', 'MELK', 'LED', 'BLEDOM', 'MODELX', 'JACKYLED', 'XROCKER', 'XSL'];
const looksLikeStrip = (n = '') => PREFIXES.some((p) => n.toUpperCase().startsWith(p));
let device = null, chr = null, manualClose = false, busy = false, noWwr = false;

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Un solo requestDevice por toque: los navegadores exigen que venga directamente de un gesto.
async function connect(mode = $('#anyDevice').checked ? 'all' : 'strips', exactName = null) {
  if (busy) return;
  if (!navigator.bluetooth) return showNoBluetooth();
  busy = true; setConnectBusy('Buscando…'); hideHelp();
  let opts;
  if (exactName) opts = { filters: [{ name: exactName }], optionalServices: SERVICES };
  else if (mode === 'all') opts = { acceptAllDevices: true, optionalServices: SERVICES };
  else opts = { filters: PREFIXES.map((p) => ({ namePrefix: p })), optionalServices: SERVICES };
  try {
    let dev;
    try { dev = await navigator.bluetooth.requestDevice(opts); }
    catch (e) {
      // Si el navegador no entiende los filtros, mostrar todos
      if (e.name === 'TypeError' && !opts.acceptAllDevices) {
        log('Filtros no admitidos (' + e.message + '); muestro todos los dispositivos');
        dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
      } else throw e;
    }
    store.set('deviceId', dev.id);
    await attach(dev);
    askIfWorks();
  } catch (e) {
    explainError(e);
  } finally {
    busy = false; if (!chr) resetConnectBtn();
  }
}

async function attach(dev, quiet = false) {
  device = dev;
  manualClose = false;
  if (dev.addEventListener) { dev.removeEventListener?.('gattserverdisconnected', onDrop); dev.addEventListener('gattserverdisconnected', onDrop); }
  else dev.ongattserverdisconnected = onDrop;
  setStatus('Conectando con ' + (dev.name || 'el dispositivo') + '…');
  setConnectBusy('Conectando…');
  log(`Elegido: ${dev.name || '(sin nombre)'} · id ${String(dev.id).slice(0, 8)}…`);
  const saved = store.get('model.' + dev.name, null);
  state.modelIdx = saved != null && MODELS[saved] ? saved : detectModel(dev.name || '');
  let server = null;
  for (let i = 1; i <= 3 && !server; i++) {
    try { server = await withTimeout(dev.gatt.connect(), 15000, 'La tira no contesta (tiempo agotado)'); }
    catch (e) { log(`Intento ${i}/3 de conexión fallido: ${e.message}`); if (i === 3) throw e; await sleep(700); }
  }
  chr = await withTimeout(findWritable(server), 15000, 'No se pudieron leer los servicios de la tira');
  if (!chr) throw Object.assign(new Error('Este dispositivo no tiene un canal para recibir órdenes. ¿Es la tira LED?'), { name: 'NoChannel' });
  // Si el nombre no dice nada, el canal sí: ffe1 = familia LEDBLE
  if (saved == null && !looksLikeStrip(dev.name) && /ffe1/.test(chr.uuid)) state.modelIdx = MODELS.findIndex((m) => m.name === 'LEDBLE');
  fillModelSelect();
  log(`Conectado · modelo ${model().name} · canal ${chr.uuid.slice(4, 8)}`);
  if (/^(melk|modelx)/i.test(dev.name || '')) {
    await rawWrite([0x7e, 0x07, 0x83]); await sleep(1000); await rawWrite([0x7e, 0x04, 0x04]);
    log('Inicio de sesión MELK enviado');
  }
  $('#devName').textContent = dev.name || 'Luces PC';
  setStatus('Conectado', true);
  $('#power').disabled = false;
  resetConnectBtn();
  $('#notice').hidden = true;
  if ($('#autoOn').checked && !quiet) { setPower(true); if (state.mode === 'white') applyTemp(); else sendColor(state.rgb); }
  renderFx();
}

const canWrite = (c) => !c.properties || c.properties.write || c.properties.writeWithoutResponse;
async function findWritable(server) {
  const want = model().write_uuid;
  const order = [UUID(want.slice(4, 7) + '0'), ...SERVICES].filter((v, i, a) => a.indexOf(v) === i);
  let fallback = null;
  // 1) Servicios conocidos, uno a uno (más compatible)
  for (const su of order) {
    let s;
    try { s = await server.getPrimaryService(su); } catch { continue; }
    try { return await s.getCharacteristic(want); } catch {}
    try {
      for (const c of await s.getCharacteristics()) {
        if (c.uuid === want) return c;
        if (!fallback && canWrite(c)) fallback = c;
      }
    } catch {}
  }
  if (fallback) return fallback;
  // 2) Todos los servicios
  try {
    for (const s of await server.getPrimaryServices()) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch { continue; }
      for (const c of chars) {
        if (c.uuid === want) return c;
        if (!fallback && canWrite(c)) fallback = c;
      }
    }
  } catch (e) { log('No se pudieron listar los servicios: ' + e.message); }
  return fallback;
}

async function onDrop() {
  chr = null;
  $('#power').disabled = true;
  if (manualClose) { setStatus('Desconectado'); resetConnectBtn(); return; }
  for (let i = 1; i <= 5; i++) {
    setStatus(`Reconectando (${i}/5)…`);
    await sleep(800 * i);
    try { await attach(device, true); return; } catch (e) { log('Reintento fallido: ' + e.message); }
  }
  setStatus('Se perdió la conexión');
  resetConnectBtn();
}

async function tryAutoReconnect() {
  if (!navigator.bluetooth?.getDevices) return;
  try {
    const id = store.get('deviceId', null);
    const dev = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
    if (dev) { log('Reconectando con ' + dev.name); busy = true; await attach(dev, true); }
  } catch (e) { log('Reconexión automática no disponible: ' + e.message); resetConnectBtn(); }
  finally { busy = false; }
}

async function rawWrite(bytes) {
  if (!chr) return;
  const data = new Uint8Array(bytes);
  const props = chr.properties;
  if (!noWwr && chr.writeValueWithoutResponse && (!props || props.writeWithoutResponse)) {
    try { return await chr.writeValueWithoutResponse(data); }
    catch (e) { if (e.name !== 'NotSupportedError' && e.name !== 'TypeError') throw e; noWwr = true; log('Escritura sin respuesta no admitida; uso escritura normal'); }
  }
  if (chr.writeValueWithResponse && (!props || props.write)) return chr.writeValueWithResponse(data);
  return chr.writeValue(data);
}

// ---------- Buscar la más cercana (si el navegador permite escanear) ----------
async function scanNearest() {
  if (busy) return;
  const list = $('#nearList');
  busy = true; setConnectBusy('Buscando…');
  const seen = new Map();
  let scan = null;
  try {
    scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true });
    const onAd = (ev) => {
      const name = ev.device?.name || ev.name;
      if (!name || ev.rssi == null) return;
      const prev = seen.get(name);
      seen.set(name, prev == null ? ev.rssi : Math.max(prev, ev.rssi));
    };
    navigator.bluetooth.addEventListener('advertisementreceived', onAd);
    await sleep(3500);
    navigator.bluetooth.removeEventListener('advertisementreceived', onAd);
  } catch (e) { log('Escaneo no disponible: ' + e.message); }
  finally { try { scan?.stop(); } catch {} busy = false; resetConnectBtn(); }
  const found = [...seen].sort((a, b) => b[1] - a[1]).sort((a, b) => looksLikeStrip(b[0]) - looksLikeStrip(a[0]));
  if (!found.length) { connect(); return; }
  list.replaceChildren(...found.slice(0, 6).map(([name, rssi], i) => {
    const b = document.createElement('button');
    b.className = 'near-item';
    const bars = rssi > -60 ? 'Muy cerca' : rssi > -75 ? 'Cerca' : 'Lejos';
    b.innerHTML = `<span></span><small>${bars}${i === 0 ? ' · la más cercana' : ''}</small>`;
    b.firstChild.textContent = name;
    b.onclick = () => connect('strips', name);
    return b;
  }));
  $('#near').hidden = false;
}

// ---------- Ayuda de conexión ----------
function explainError(e) {
  log(`Error ${e.name}: ${e.message}`);
  const msg = {
    NotFoundError: /cancel/i.test(e.message) || /User/i.test(e.message)
      ? 'No elegiste ninguna tira. Si no aparecía en la lista, prueba «Ver todos los dispositivos».'
      : 'No apareció ninguna tira. Comprueba que está encendida y que LotusLamp X está cerrada del todo, o prueba «Ver todos los dispositivos».',
    NetworkError: 'La tira no acepta la conexión. Cierra LotusLamp X del todo (u otro móvil conectado), acércate y vuelve a intentarlo.',
    SecurityError: 'El navegador ha bloqueado el Bluetooth. Abre la app desde su dirección https y pulsa el botón otra vez.',
    NotAllowedError: 'Falta el permiso de Bluetooth. En iPhone: Ajustes › Bluefy › Bluetooth activado.',
    NoChannel: e.message,
  }[e.name] || (/tiempo agotado|no contesta/i.test(e.message)
    ? 'La tira no contesta. Apaga y enciende las luces (desenchufa el USB 5 segundos), cierra LotusLamp X y vuelve a intentarlo.'
    : 'No se pudo conectar: ' + e.message);
  setStatus('Sin conectar');
  showHelp(msg);
}
function showHelp(msg) { $('#helpText').textContent = msg; $('#connectHelp').hidden = false; }
function hideHelp() { $('#connectHelp').hidden = true; $('#near').hidden = true; }

// ¿Han respondido las luces?
function askIfWorks() {
  $('#works').hidden = false;
  clearTimeout(askIfWorks.t); askIfWorks.t = setTimeout(() => { $('#works').hidden = true; }, 20000);
}

// ---------- Asistente: encontrar mi controlador ----------
const WIZ_COLORS = [['rojo', [255, 0, 0]], ['verde', [0, 255, 0]], ['azul', [0, 0, 255]]];
let wiz = null;
function wizardCandidates() {
  const seen = new Set();
  return MODELS.map((m, i) => [m, i]).filter(([m]) => {
    if (!m.commands.color || !m.commands.turn_on) return false;
    const short = chr ? chr.uuid.slice(4, 8) : '';
    if (/^(fff3|ffe1)$/.test(short) && m.write_uuid.slice(4, 8) !== short) return false;
    const k = JSON.stringify([m.commands.turn_on, m.commands.color, m.commands.brightness]);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).map(([, i]) => i);
}
function startWizard() {
  $('#works').hidden = true;
  if (!chr) { showHelp('Conecta primero la tira con «Conectar luces».'); return; }
  wiz = { list: wizardCandidates(), i: 0, prev: state.modelIdx };
  log('Asistente: ' + wiz.list.length + ' variantes a probar');
  wizardStep();
}
function wizardStep() {
  const box = $('#wizard');
  if (wiz.i >= wiz.list.length) {
    state.modelIdx = wiz.prev; fillModelSelect(); wiz = null;
    $('#wizText').textContent = 'Ninguna variante ha funcionado. Copia el registro (Ajustes y ayuda) y pásamelo para añadir tu modelo.';
    $('#wizYes').hidden = true; $('#wizNo').textContent = 'Cerrar';
    $('#wizNo').onclick = () => { box.hidden = true; $('#wizYes').hidden = false; $('#wizNo').textContent = 'No, probar otra'; $('#wizNo').onclick = wizardNo; };
    return;
  }
  state.modelIdx = wiz.list[wiz.i];
  const [cname, rgb] = WIZ_COLORS[wiz.i % 3];
  send('power', cmd('turn_on'));
  send('brightness', cmd('brightness', { i: 100 }));
  sendColor(rgb);
  setLed(rgb);
  $('#wizText').textContent = `Prueba ${wiz.i + 1} de ${wiz.list.length}: ¿tus luces se han puesto en ${cname.toUpperCase()}?`;
  box.hidden = false;
}
function wizardNo() { wiz.i++; wizardStep(); }
function wizardYes() {
  const idx = state.modelIdx;
  if (device) store.set('model.' + device.name, idx);
  fillModelSelect(); renderFx();
  log('Asistente: controlador encontrado → ' + MODELS[idx].name);
  wiz = null; $('#wizard').hidden = true;
  setStatus('Conectado · controlador ajustado', true);
}

// Cola: un comando de cada tipo, solo el último cuenta (evita atascos al arrastrar)
const queue = new Map();
let flushing = false;
function send(key, bytes) {
  if (!bytes) { log(`Este controlador no admite «${key}»`); return; }
  queue.delete(key);
  queue.set(key, bytes);
  if (!flushing) flush();
}
async function flush() {
  flushing = true;
  const gap = /BLEDDM/.test(model().name) ? 300 : /BLEDOB/.test(model().name) ? 100 : 25;
  while (queue.size) {
    const [key, bytes] = queue.entries().next().value;
    queue.delete(key);
    if (!chr) { queue.clear(); break; }
    try { await rawWrite(bytes); if (key !== 'color' || state.mode !== 'music') log(`${key}: ${hex(bytes)}`); }
    catch (e) { log(`Error al enviar ${key}: ${e.message}`); }
    await sleep(gap);
  }
  flushing = false;
}

// ---------- Acciones ----------
function setPower(on) {
  state.on = on;
  send('power', cmd(on ? 'turn_on' : 'turn_off'));
  $('#power').setAttribute('aria-pressed', String(on));
  paint();
}
function sendColor(rgb) { send('color', cmd('color', { r: rgb[0], g: rgb[1], b: rgb[2] })); }
function applyColor() {
  state.mode = 'color'; store.set('rgb', state.rgb);
  if (!state.on) setPower(true);
  sendColor(state.rgb); paint();
}
function applyBright() {
  store.set('bright', state.bright);
  send('brightness', cmd('brightness', { i: state.bright }));
  paint();
}
function applyTemp() {
  state.mode = 'white'; store.set('temp', state.temp);
  if (!state.on) setPower(true);
  const c = cmd('color_temp', { w: state.temp, c: 100 - state.temp });
  if (c) send('white', c); else sendColor(tempRGB(state.temp));
  paint();
}
function applyFx(fx) {
  state.mode = 'fx'; state.fx = fx; store.set('fx', fx);
  if (!state.on) setPower(true);
  send('effect', cmd('effect', { v: fx.v }));
  applySpeed();
  paint();
}
function applySpeed() {
  store.set('speed', state.speed);
  const max = model().effect_speed_range?.max ?? 100;
  send('speed', cmd('effect_speed', { v: state.speed * max / 100 }));
}

// ---------- Pintar la tira ----------
const strip = $('#strip');
function paint() {
  strip.className = 'strip';
  if (!state.on) { strip.classList.add('off'); return; }
  let rgb = state.rgb;
  if (state.mode === 'white') rgb = tempRGB(state.temp);
  if (state.mode === 'fx' && state.fx) {
    const n = state.fx.name;
    strip.classList.add(n.startsWith('Salto') ? 'fx-jump' : n.startsWith('Fundido') ? 'fx-fade' : n.startsWith('Parpadeo') ? 'fx-blink' : 'fx-rainbow');
    const dur = 0.4 + (100 - state.speed) / 100 * 3;
    strip.style.animationDuration = dur + 's';
    const solid = n.match(/· (rojo|verde|azul|amarillo|cian|magenta|blanco)$/);
    if (solid) rgb = { rojo: [255, 59, 48], verde: [52, 199, 89], azul: [0, 122, 255], amarillo: [255, 204, 0], cian: [90, 200, 250], magenta: [255, 45, 200], blanco: [255, 255, 255] }[solid[1]];
  } else strip.style.animationDuration = '';
  setLed(rgb);
  strip.style.opacity = state.mode === 'music' ? 1 : 0.35 + 0.65 * state.bright / 100;
}
function setLed(rgb) { document.documentElement.style.setProperty('--led', css(rgb)); }

// ---------- Rueda de color ----------
const wheel = $('#wheel'), knob = $('#knob');
(function drawWheel() {
  const ctx = wheel.getContext('2d'), N = wheel.width, R = N / 2;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - R, dy = y - R, d = Math.hypot(dx, dy), i = (y * N + x) * 4;
    if (d > R) { img.data[i + 3] = 0; continue; }
    const [r, g, b] = hsv2rgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / R, 1);
    img.data.set([r, g, b, d > R - 1 ? (R - d) * 255 : 255], i);
  }
  ctx.putImageData(img, 0, 0);
})();
function placeKnob(rgb) {
  const [h, s] = rgb2hsv(rgb), a = h * Math.PI / 180;
  knob.style.left = 50 + Math.cos(a) * s * 50 + '%';
  knob.style.top = 50 + Math.sin(a) * s * 50 + '%';
}
function pickAt(ev) {
  const r = wheel.getBoundingClientRect();
  let dx = ev.clientX - r.left - r.width / 2, dy = ev.clientY - r.top - r.height / 2;
  const R = r.width / 2, d = Math.min(Math.hypot(dx, dy), R);
  const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  state.rgb = hsv2rgb(h, d / R, 1);
  placeKnob(state.rgb);
  applyColor();
}
wheel.addEventListener('pointerdown', (e) => { wheel.setPointerCapture(e.pointerId); pickAt(e); });
wheel.addEventListener('pointermove', (e) => { if (e.buttons) pickAt(e); });

const PRESETS = [[255, 0, 0], [255, 80, 0], [255, 200, 0], [0, 255, 0], [0, 255, 200], [0, 120, 255], [0, 0, 255], [140, 0, 255], [255, 0, 180], [255, 255, 255]];
$('#swatches').append(...PRESETS.map((c) => {
  const b = document.createElement('button');
  b.className = 'sw'; b.style.background = css(c); b.setAttribute('aria-label', 'Color ' + css(c));
  b.onclick = () => { state.rgb = c; placeKnob(c); applyColor(); };
  return b;
}));

// ---------- Favoritos ----------
function renderFavs() {
  const box = $('#favs');
  box.replaceChildren();
  if (!state.favs.length) { box.innerHTML = '<p class="hint">Guarda aquí tus colores y efectos para tenerlos a un toque.</p>'; return; }
  state.favs.forEach((f, i) => {
    const wrap = document.createElement('span'); wrap.className = 'fav';
    const b = document.createElement('button'); b.className = 'sw';
    b.style.background = f.type === 'fx' ? 'conic-gradient(#ff3b30,#ffcc00,#34c759,#007aff,#af52de,#ff3b30)' : css(f.type === 'white' ? tempRGB(f.temp) : f.rgb);
    b.title = f.type === 'fx' ? f.fx.name : f.type === 'white' ? 'Blanco' : 'Color';
    b.setAttribute('aria-label', 'Favorito: ' + b.title);
    b.onclick = () => {
      if (f.bright) { state.bright = f.bright; $('#bright').value = f.bright; $('#brightOut').value = f.bright + ' %'; applyBright(); }
      if (f.type === 'color') { state.rgb = f.rgb; placeKnob(f.rgb); applyColor(); }
      if (f.type === 'white') { state.temp = f.temp; $('#temp').value = f.temp; applyTemp(); }
      if (f.type === 'fx') { state.speed = f.speed; $('#speed').value = f.speed; applyFx(f.fx); }
    };
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Quitar favorito');
    x.onclick = () => { state.favs.splice(i, 1); store.set('favs', state.favs); renderFavs(); };
    wrap.append(b, x); box.append(wrap);
  });
}
$('#saveFav').onclick = () => {
  const f = { type: state.mode === 'music' ? 'color' : state.mode, bright: state.bright };
  if (f.type === 'color') f.rgb = state.rgb;
  if (f.type === 'white') f.temp = state.temp;
  if (f.type === 'fx') { if (!state.fx) return; f.fx = state.fx; f.speed = state.speed; }
  state.favs.push(f); state.favs = state.favs.slice(-12);
  store.set('favs', state.favs); renderFavs();
};
$('#editFav').onclick = (e) => {
  const on = $('#favs').classList.toggle('editing');
  e.target.textContent = on ? 'Listo' : 'Editar';
};

// ---------- Pestañas ----------
$$('.seg button').forEach((b) => b.onclick = () => {
  $$('.seg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('.panel').forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab);
  store.set('tab', b.dataset.tab);
});

// ---------- Sliders ----------
function slider(id, out, fmt, onChange) {
  const el = $(id);
  const upd = () => { $(out).value = fmt(+el.value); };
  el.addEventListener('input', () => { upd(); onChange(+el.value); });
  upd();
  return el;
}
$('#bright').value = state.bright;
slider('#bright', '#brightOut', (v) => v + ' %', (v) => { state.bright = v; applyBright(); });
$('#temp').value = state.temp;
slider('#temp', '#tempOut', (v) => (v < 34 ? 'Frío' : v > 66 ? 'Cálido' : 'Neutro'), (v) => { state.temp = v; applyTemp(); });
$('#speed').value = state.speed;
slider('#speed', '#speedOut', (v) => v, (v) => { state.speed = v; applySpeed(); paint(); });

// ---------- Efectos ----------
function renderFx() {
  const q = $('#fxSearch').value.trim().toLowerCase();
  const box = $('#fxList');
  box.replaceChildren(...effectList().filter(([n]) => n.toLowerCase().includes(q)).map(([name, v]) => {
    const b = document.createElement('button');
    b.textContent = name;
    if (state.fx && state.fx.v === v && state.mode === 'fx') b.className = 'on';
    b.onclick = () => { applyFx({ name, v }); renderFx(); };
    return b;
  }));
}
$('#fxSearch').addEventListener('input', renderFx);

// ---------- Música (micrófono del móvil/PC) ----------
let audio = null, musicMode = 'pulse', hue = 0, level = 0, lastSend = 0;
$$('#musicModes .chip').forEach((c) => c.onclick = () => {
  $$('#musicModes .chip').forEach((x) => x.classList.toggle('on', x === c));
  musicMode = c.dataset.mm;
});
slider('#sens', '#sensOut', (v) => v, () => {});
$('#micBtn').onclick = async () => {
  if (audio) return stopMusic();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.6;
    ctx.createMediaStreamSource(stream).connect(an);
    audio = { ctx, an, stream, buf: new Uint8Array(an.frequencyBinCount) };
    state.mode = 'music';
    if (!state.on) setPower(true);
    $('#micBtn').textContent = 'Dejar de escuchar'; $('#micBtn').classList.add('on');
    requestAnimationFrame(musicLoop);
  } catch (e) { fail(new Error('No se pudo usar el micrófono: ' + e.message)); }
};
function stopMusic() {
  audio.stream.getTracks().forEach((t) => t.stop()); audio.ctx.close(); audio = null;
  $('#micBtn').textContent = 'Escuchar con el micrófono'; $('#micBtn').classList.remove('on');
  $('#meter').style.width = '0';
  state.mode = 'color'; paint();
}
function musicLoop(t) {
  if (!audio) return;
  const { an, buf, ctx } = audio;
  an.getByteFrequencyData(buf);
  const hz = ctx.sampleRate / an.fftSize;
  let sum = 0, peak = 0, peakI = 1;
  const top = Math.min(buf.length, Math.round(8000 / hz));
  for (let i = 1; i < top; i++) { sum += buf[i]; if (buf[i] > peak) { peak = buf[i]; peakI = i; } }
  const gain = 0.5 + (+$('#sens').value) / 25;
  const raw = Math.min(1, (sum / top / 255) * gain * 1.6);
  level = raw > level ? raw : level * 0.86;
  let rgb;
  if (musicMode === 'pulse') { hue = (hue + 0.6 + level * 6) % 360; rgb = hsv2rgb(hue, 1, 0.06 + 0.94 * level); }
  else if (musicMode === 'spectrum') {
    const f = Math.max(40, peakI * hz), h = Math.min(1, Math.log2(f / 40) / Math.log2(8000 / 40)) * 280;
    rgb = hsv2rgb(h, 1, 0.06 + 0.94 * level);
  } else rgb = state.rgb.map((c) => Math.round(c * (0.06 + 0.94 * level)));
  $('#meter').style.width = level * 100 + '%';
  setLed(rgb);
  if (t - lastSend > 60) { lastSend = t; sendColor(rgb); }
  requestAnimationFrame(musicLoop);
}
// Micrófono del controlador (comandos de elkbledom)
$('#hwMicOn').onclick = () => send('mic', [0x7e, 0x04, 0x07, 0x01, 0xff, 0xff, 0xff, 0x00, 0xef]);
$('#hwMicOff').onclick = () => send('mic', [0x7e, 0x04, 0x07, 0x00, 0xff, 0xff, 0xff, 0x00, 0xef]);

// ---------- Temporizador ----------
let timerId = null, timerEnd = 0, timerTick = null;
$$('#timer .chip').forEach((c) => c.onclick = () => {
  clearTimeout(timerId); clearInterval(timerTick);
  $$('#timer .chip').forEach((x) => x.classList.toggle('on', x === c && c.dataset.min !== '0'));
  const min = +c.dataset.min;
  if (!min) { $('#timerOut').value = '—'; return; }
  timerEnd = Date.now() + min * 60000;
  timerId = setTimeout(() => { setPower(false); $('#timerOut').value = 'Apagado'; clearInterval(timerTick); $$('#timer .chip').forEach((x) => x.classList.remove('on')); }, min * 60000);
  const upd = () => { $('#timerOut').value = Math.ceil((timerEnd - Date.now()) / 60000) + ' min'; };
  upd(); timerTick = setInterval(upd, 15000);
});

// ---------- Ajustes ----------
function fillModelSelect() {
  const sel = $('#model');
  sel.replaceChildren(...MODELS.map((m, i) => {
    const o = document.createElement('option');
    const same = MODELS.filter((x) => x.name === m.name);
    o.value = i; o.textContent = same.length > 1 ? `${m.name} · variante ${same.indexOf(m) + 1}` : m.name;
    return o;
  }));
  sel.value = state.modelIdx ?? detectModel('');
}
$('#model').onchange = (e) => {
  state.modelIdx = +e.target.value;
  if (device) store.set('model.' + device.name, state.modelIdx);
  log('Modelo cambiado a ' + model().name);
  renderFx();
};
$('#forget').onclick = () => { manualClose = true; try { device?.gatt?.disconnect(); } catch {} chr = null; resetConnectBtn(); setStatus('Desconectado'); };
$('#power').onclick = () => setPower(!state.on);
$('#connect').onclick = () => connect();
$('#showAll').onclick = () => connect('all');
$('#nearBtn').onclick = scanNearest;
$('#tryWizard').onclick = startWizard;
$('#worksYes').onclick = () => { $('#works').hidden = true; };
$('#worksNo').onclick = startWizard;
$('#wizYes').onclick = wizardYes;
$('#wizNo').onclick = wizardNo;
$('#copyLog').onclick = async () => {
  try { await navigator.clipboard.writeText(logEl.textContent); $('#copyLog').textContent = 'Copiado'; }
  catch { const r = document.createRange(); r.selectNodeContents(logEl); getSelection().removeAllRanges(); getSelection().addRange(r); $('#copyLog').textContent = 'Seleccionado: cópialo'; }
  setTimeout(() => { $('#copyLog').textContent = 'Copiar registro'; }, 2500);
};
if (navigator.bluetooth?.requestLEScan) $('#nearBtn').hidden = false;

function resetConnectBtn() {
  const c = $('#connect'); c.disabled = false; c.classList.remove('busy');
  if (chr) { c.textContent = 'Cambiar de dispositivo'; c.classList.add('secondary'); return; }
  c.textContent = 'Conectar luces'; c.classList.remove('secondary');
  $('#power').disabled = true;
}
function setConnectBusy(t) { const c = $('#connect'); c.disabled = true; c.classList.add('busy'); c.textContent = t; }
function setStatus(t, ok = false) { const s = $('#status'); s.textContent = t; s.classList.toggle('ok', ok); if (ok) store.set('everConnected', true); paint(); }
function fail(e) { log('Error: ' + e.message); setStatus(e.message); }

async function showNoBluetooth() {
  const n = $('#notice'); n.hidden = false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  n.innerHTML = ios
    ? '<b>En iPhone, Safari no puede usar Bluetooth desde una web.</b> Abre esta misma dirección con el navegador <b>Bluefy</b> (App Store) y funcionará igual.'
    : '<b>Este navegador no puede usar Bluetooth.</b> Abre la app con <b>Chrome</b> o <b>Edge</b> en Android o en un ordenador con Bluetooth.';
}
async function checkBluetooth() {
  if (!navigator.bluetooth) return showNoBluetooth();
  if (!window.isSecureContext) { const n = $('#notice'); n.hidden = false; n.innerHTML = '<b>Abre la app desde su dirección https.</b> El Bluetooth web solo funciona en páginas seguras.'; return; }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      const n = $('#notice'); n.hidden = false;
      n.innerHTML = '<b>No hay Bluetooth activo en este equipo.</b> Actívalo en los ajustes. Si es un PC sin Bluetooth, hace falta un adaptador USB Bluetooth.';
    }
  } catch {}
}

// ---------- Inicio ----------
state.modelIdx = detectModel('');
fillModelSelect();
placeKnob(state.rgb);
renderFavs();
renderFx();
const tab = store.get('tab', 'color');
$(`.seg button[data-tab="${tab}"]`)?.click();
paint();
const bt = navigator.bluetooth;
log(`Navegador: ${navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 120)}`);
log(`Bluetooth web: ${bt ? 'sí' : 'no'} · escaneo: ${bt?.requestLEScan ? 'sí' : 'no'} · recordar: ${bt?.getDevices ? 'sí' : 'no'} · https: ${window.isSecureContext ? 'sí' : 'no'}`);
checkBluetooth();
tryAutoReconnect();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
