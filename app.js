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
  if (on) send('brightness', cmd('brightness', { i: state.bright }));
  $('#power').setAttribute('aria-pressed', String(on));
  paint();
}
function sendColor(rgb) { send('color', cmd('color', { r: rgb[0], g: rgb[1], b: rgb[2] })); }
function applyColor() {
  stopEngines(); clearMoment();
  state.mode = 'color'; store.set('rgb', state.rgb);
  if (!state.on) setPower(true);
  sendColor(state.rgb); paint();
}
function applyBright() {
  store.set('bright', state.bright);
  send('brightness', cmd('brightness', { i: state.bright }));
  paint();
}
function applyTemp(fromAuto = false) {
  stopEngines(fromAuto ? 'auto' : undefined); if (!fromAuto) clearMoment();
  state.mode = 'white'; store.set('temp', state.temp);
  if (!state.on) setPower(true);
  const c = cmd('color_temp', { w: state.temp, c: 100 - state.temp });
  if (c) send('white', c); else sendColor(tempRGB(state.temp));
  paint();
}
function applyFx(fx) {
  stopEngines(); clearMoment();
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
  if (state.mode === 'custom' || state.mode === 'music') { strip.style.opacity = 1; strip.style.animationDuration = ''; return; }
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
// Vista previa de animaciones: mantiene el tono y expresa la intensidad con la opacidad de la tira
function previewLed(rgb) {
  const m = Math.max(...rgb, 1);
  setLed(rgb.map((x) => Math.round(x * 255 / m)));
  strip.style.opacity = 0.3 + 0.7 * m / 255;
}

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
    b.style.background = f.type === 'fx' ? 'conic-gradient(#ff3b30,#ffcc00,#34c759,#007aff,#af52de,#ff3b30)' : f.type === 'custom' ? `linear-gradient(135deg, ${f.colors.map(css).join(',')})` : css(f.type === 'white' ? tempRGB(f.temp) : f.rgb);
    b.title = f.type === 'fx' ? f.fx.name : f.type === 'custom' ? 'Mi efecto' : f.type === 'white' ? 'Blanco' : 'Color';
    b.setAttribute('aria-label', 'Favorito: ' + b.title);
    b.onclick = () => {
      if (f.bright) { state.bright = f.bright; $('#bright').value = f.bright; $('#brightOut').value = f.bright + ' %'; applyBright(); }
      if (f.type === 'color') { state.rgb = f.rgb; placeKnob(f.rgb); applyColor(); }
      if (f.type === 'white') { state.temp = f.temp; $('#temp').value = f.temp; applyTemp(); }
      if (f.type === 'fx') { state.speed = f.speed; $('#speed').value = f.speed; applyFx(f.fx); }
      if (f.type === 'custom') playAnim(f.colors, f.style, f.period);
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
  if (f.type === 'custom') { if (!anim) return; f.colors = anim.colors; f.style = anim.style; f.period = anim.period; }
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
  stopEngines('music'); clearMoment();
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
function stopMusic(quiet = false) {
  audio.stream.getTracks().forEach((t) => t.stop()); audio.ctx.close(); audio = null;
  $('#micBtn').textContent = 'Escuchar con el micrófono'; $('#micBtn').classList.remove('on');
  $('#meter').style.width = '0';
  if (!quiet) { state.mode = 'color'; sendColor(state.rgb); paint(); }
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
  previewLed(rgb);
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
  const fadeMs = Math.min(5, min / 3) * 60000, startBright = state.bright;
  timerId = setTimeout(() => {
    setPower(false); clearInterval(timerTick);
    $('#timerOut').value = 'Apagado'; $$('#timer .chip').forEach((x) => x.classList.remove('on'));
    state.bright = startBright; $('#bright').value = startBright; $('#brightOut').value = startBright + ' %'; store.set('bright', startBright);
  }, min * 60000);
  const upd = () => {
    const left = timerEnd - Date.now();
    $('#timerOut').value = Math.ceil(left / 60000) + ' min';
    if ($('#softOff').checked && left < fadeMs && state.on) {
      const v = Math.max(1, Math.round(startBright * left / fadeMs));
      if (v !== state.bright) { state.bright = v; $('#bright').value = v; $('#brightOut').value = v + ' %'; send('brightness', cmd('brightness', { i: v })); paint(); }
    }
  };
  upd(); timerTick = setInterval(upd, 5000);
});

// ---------- Motor de animación propio ----------
// La app calcula cada fotograma y se lo manda a la tira: permite efectos que el controlador no trae.
let anim = null;
const autoDay = { on: false, t: null };
const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const ease = (t) => t * t * (3 - 2 * t);
function stopEngines(except) {
  if (except !== 'music' && audio) stopMusic(true);
  if (except !== 'anim') { anim = null; syncPlay(); }
  if (except !== 'auto' && autoDay.on) setAutoDay(false);
}
function playAnim(colors, style, period, keepMoment = false) {
  stopEngines('anim'); if (!keepMoment) clearMoment();
  anim = { colors: colors.slice(), style, period, t0: performance.now(), last: 0 };
  state.mode = 'custom';
  if (!state.on) setPower(true);
  paint(); syncPlay();
  requestAnimationFrame(animLoop);
}
function animFrame(a, t) {
  const n = a.colors.length, p = (t - a.t0) / 1000 / a.period;
  const i = Math.floor(p) % n, f = p - Math.floor(p), c = a.colors[i], next = a.colors[(i + 1) % n];
  if (a.style === 'jump') return c;
  if (a.style === 'breathe') { const k = 0.5 - 0.5 * Math.cos(f * 2 * Math.PI); return c.map((x) => Math.round(x * (0.06 + 0.94 * k))); }
  if (a.style === 'wave') { const k = 0.55 + 0.45 * Math.sin(f * 2 * Math.PI); return lerp(c, next, ease(f)).map((x) => Math.round(x * k)); }
  return lerp(c, next, ease(Math.min(1, f * 1.4)));          // fundido con pausa en cada color
}
function animLoop(t) {
  if (!anim) return;
  const rgb = animFrame(anim, t);
  previewLed(rgb);
  if (t - anim.last > 80) { anim.last = t; sendColor(rgb); }
  requestAnimationFrame(animLoop);
}
const tempoToPeriod = (v) => +(8 - v / 100 * 7.4).toFixed(2);  // 1 → 8 s · 100 → 0,6 s

// ---------- Momentos ----------
const MOMENTS = {
  gaming:  { hint: 'Gaming · colores vivos en movimiento', bright: 100, run: () => playAnim([[255, 0, 180], [140, 0, 255], [0, 120, 255]], 'fade', 2.5, true) },
  cine:    { hint: 'Película · blanco tenue detrás de la pantalla', bright: 15, run: () => { setTempUI(20); applyTemp(true); } },
  estudio: { hint: 'Estudio · blanco frío y brillante', bright: 100, run: () => { setTempUI(10); applyTemp(true); } },
  relax:   { hint: 'Relax · inspira cuando sube la luz, espira cuando baja', bright: 70, run: () => playAnim([[255, 120, 40], [255, 60, 90]], 'breathe', 10, true) },
  noche:   { hint: 'Noche · luz cálida muy baja, sin azules', bright: 8, run: () => { stopEngines(); state.mode = 'color'; state.rgb = [255, 60, 0]; placeKnob(state.rgb); if (!state.on) setPower(true); sendColor(state.rgb); paint(); } },
};
function runMoment(id) {
  const m = MOMENTS[id];
  stopEngines();
  $$('.moment').forEach((b) => b.classList.toggle('on', b.dataset.moment === id));
  $('#momentHint').textContent = m.hint;
  setBright(m.bright);
  m.run();
  store.set('moment', id);
}
function clearMoment() { $$('.moment').forEach((b) => b.classList.remove('on')); $('#momentHint').textContent = ''; store.set('moment', null); }
$$('.moment').forEach((b) => b.onclick = () => runMoment(b.dataset.moment));
function setBright(v) { state.bright = v; $('#bright').value = v; $('#brightOut').value = v + ' %'; applyBright(); }
function setTempUI(v) { state.temp = v; $('#temp').value = v; $('#tempOut').value = v < 34 ? 'Frío' : v > 66 ? 'Cálido' : 'Neutro'; }

// ---------- Color de una foto ----------
const photoCv = $('#photoCv');
let photoPalette = [];
$('#photoIn').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => {
    const w = 600, h = Math.round(w * img.height / img.width);
    photoCv.width = w; photoCv.height = Math.min(h, 600);
    const ctx = photoCv.getContext('2d', { willReadFrequently: true });
    const scale = Math.max(w / img.width, photoCv.height / img.height);
    ctx.drawImage(img, (w - img.width * scale) / 2, (photoCv.height - img.height * scale) / 2, img.width * scale, img.height * scale);
    URL.revokeObjectURL(img.src);
    photoPalette = extractPalette(ctx.getImageData(0, 0, w, photoCv.height).data);
    $('#photoPal').replaceChildren(...photoPalette.map((c) => {
      const b = document.createElement('button'); b.className = 'sw'; b.style.background = css(c); b.setAttribute('aria-label', 'Color de la foto');
      b.onclick = () => { state.rgb = c; placeKnob(c); applyColor(); };
      return b;
    }));
    $('#photoBox').hidden = false;
    if (photoPalette[0]) { state.rgb = photoPalette[0]; placeKnob(state.rgb); applyColor(); }
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});
// Los LEDs se ven mejor con colores saturados: se elige por tono y se lleva al máximo de brillo
const vivid = (c) => { const [h, s] = rgb2hsv(c); return hsv2rgb(h, Math.min(1, s * 1.25 + 0.1), 1); };
function extractPalette(data) {
  const bins = Array.from({ length: 18 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4 * 7) {
    const c = [data[i], data[i + 1], data[i + 2]], [h, s, v] = rgb2hsv(c);
    if (s < 0.22 || v < 0.18) continue;
    const bin = bins[Math.floor(h / 20) % 18], w = s * v;
    bin.w += w; bin.r += c[0] * w; bin.g += c[1] * w; bin.b += c[2] * w;
  }
  // Quedarse con tonos claramente distintos (al menos 35° de separación)
  const top = [];
  for (const b of bins.filter((b) => b.w > 0).sort((a, b) => b.w - a.w)) {
    const c = vivid([b.r / b.w, b.g / b.w, b.b / b.w]), h = rgb2hsv(c)[0];
    if (top.every((t) => { const d = Math.abs(rgb2hsv(t)[0] - h); return Math.min(d, 360 - d) >= 35; })) top.push(c);
    if (top.length === 5) break;
  }
  return top.length ? top : [[255, 255, 255]];
}
photoCv.addEventListener('pointerdown', (e) => {
  const r = photoCv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * photoCv.width), y = Math.floor((e.clientY - r.top) / r.height * photoCv.height);
  const d = photoCv.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  let sum = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
  state.rgb = vivid(sum.map((v) => v / (d.length / 4))); placeKnob(state.rgb); applyColor();
});
$('#photoPlay').onclick = () => { if (photoPalette.length > 1) { palette.splice(0, palette.length, ...photoPalette); store.set('palette', palette); renderPalette(); playAnim(palette, curStyle, tempoToPeriod(+$('#tempo').value)); } };

// ---------- Mis efectos ----------
const palette = store.get('palette', [[255, 0, 120], [0, 140, 255], [120, 0, 255]]);
let curStyle = store.get('style', 'fade');
let myFx = store.get('myFx', []);
function renderPalette() {
  const box = $('#palette');
  box.replaceChildren(...palette.map((c, i) => {
    const b = document.createElement('button'); b.className = 'sw'; b.style.background = css(c);
    b.setAttribute('aria-label', 'Quitar este color'); b.title = 'Toca para quitar';
    b.onclick = () => { if (palette.length > 2) { palette.splice(i, 1); store.set('palette', palette); renderPalette(); } };
    return b;
  }));
  if (palette.length < 6) {
    const add = document.createElement('label'); add.className = 'add'; add.textContent = '+'; add.title = 'Añadir color';
    add.style.display = 'grid'; add.style.placeItems = 'center';
    const inp = document.createElement('input'); inp.type = 'color'; inp.setAttribute('aria-label', 'Añadir color');
    inp.value = '#' + state.rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
    inp.onchange = () => { const v = inp.value; palette.push([1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16))); store.set('palette', palette); renderPalette(); };
    add.append(inp); box.append(add);
  }
}
$$('#styles .chip').forEach((c) => {
  c.classList.toggle('on', c.dataset.style === curStyle);
  c.onclick = () => { curStyle = c.dataset.style; store.set('style', curStyle); $$('#styles .chip').forEach((x) => x.classList.toggle('on', x === c)); if (anim && state.mode === 'custom') playAnim(palette, curStyle, tempoToPeriod(+$('#tempo').value)); };
});
$('#tempo').value = store.get('tempo', 50);
slider('#tempo', '#tempoOut', (v) => (v < 34 ? 'Lento' : v > 66 ? 'Rápido' : 'Medio'), (v) => { store.set('tempo', v); if (anim && state.mode === 'custom') anim.period = tempoToPeriod(v); });
function syncPlay() { $('#myFxPlay').textContent = anim ? 'Parar' : 'Reproducir'; $('#myFxPlay').classList.toggle('on', !!anim); }
$('#myFxPlay').onclick = () => {
  if (anim) { stopEngines(); clearMoment(); state.mode = 'color'; sendColor(state.rgb); paint(); return; }
  playAnim(palette, curStyle, tempoToPeriod(+$('#tempo').value));
};
const STYLE_NAMES = { fade: 'Fundido', jump: 'Salto', breathe: 'Respiración', wave: 'Ola' };
function renderMyFx() {
  $('#myFxList').replaceChildren(...myFx.map((f, i) => {
    const wrap = document.createElement('span'); wrap.className = 'fav';
    const b = document.createElement('button'); b.className = 'myfx';
    const dot = document.createElement('i'); dot.style.background = `linear-gradient(135deg, ${f.colors.map(css).join(',')})`;
    b.append(dot, document.createTextNode(STYLE_NAMES[f.style] + ' ' + (i + 1)));
    b.onclick = () => { palette.splice(0, palette.length, ...f.colors); renderPalette(); curStyle = f.style; $$('#styles .chip').forEach((x) => x.classList.toggle('on', x.dataset.style === f.style)); playAnim(f.colors, f.style, f.period); };
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Borrar efecto');
    x.onclick = () => { myFx.splice(i, 1); store.set('myFx', myFx); renderMyFx(); };
    wrap.append(b, x); return wrap;
  }));
}
$('#myFxSave').onclick = () => {
  myFx.push({ colors: palette.map((c) => c.slice()), style: curStyle, period: tempoToPeriod(+$('#tempo').value) });
  myFx = myFx.slice(-8); store.set('myFx', myFx); renderMyFx();
  $('#myFxSave').textContent = 'Guardado'; setTimeout(() => { $('#myFxSave').textContent = 'Guardar'; }, 1500);
};
$('#myFxEdit').onclick = (e) => { const on = $('#myFxList').classList.toggle('editing'); e.target.textContent = on ? 'Listo' : 'Editar'; };

// ---------- Enfoque (pomodoro con luz) ----------
const RING = 339.3;
const focus = { running: false, phase: 'work', end: 0, left: 25 * 60000, work: store.get('workMin', 25), brk: store.get('breakMin', 5), done: store.get('focusDone.' + new Date().toDateString(), 0), tick: null, warned: false, wake: null };
function pickChips(sel, val, cb) {
  $$(sel + ' .chip').forEach((c) => {
    c.classList.toggle('on', +c.dataset.v === val);
    c.onclick = () => { $$(sel + ' .chip').forEach((x) => x.classList.toggle('on', x === c)); cb(+c.dataset.v); };
  });
}
pickChips('#workMin', focus.work, (v) => { focus.work = v; store.set('workMin', v); if (!focus.running && focus.phase === 'work') { focus.left = v * 60000; drawFocus(); } });
pickChips('#breakMin', focus.brk, (v) => { focus.brk = v; store.set('breakMin', v); if (!focus.running && focus.phase === 'break') { focus.left = v * 60000; drawFocus(); } });
focus.left = focus.work * 60000;
const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
function drawFocus() {
  const total = (focus.phase === 'work' ? focus.work : focus.brk) * 60000;
  const left = focus.running ? focus.end - Date.now() : focus.left;
  $('#focusTime').value = fmt(left);
  $('#ring').style.strokeDashoffset = RING * (1 - Math.max(0, left) / total);
  $('#focusPhase').textContent = !focus.running && left === total && focus.phase === 'work' ? 'Listo para concentrarte' : focus.phase === 'work' ? (focus.running ? 'Concentrado' : 'En pausa') : (focus.running ? 'Descanso' : 'Descanso en pausa');
  $('#focusCount').textContent = focus.done ? `Hoy llevas ${focus.done} ${focus.done === 1 ? 'bloque' : 'bloques'}.` : '';
  $('#focusStart').textContent = focus.running ? 'Pausar' : left < total ? 'Seguir' : focus.phase === 'work' ? 'Empezar' : 'Empezar descanso';
}
function focusLights() {
  clearMoment();
  if (focus.phase === 'work') { stopEngines('focus'); anim = null; setTempUI(10); applyTemp(true); setBright(100); }
  else { setBright(70); playAnim([[40, 255, 120], [0, 200, 160]], 'breathe', 8, true); }
}
async function keepAwake(on) {
  try { if (on && navigator.wakeLock) focus.wake = await navigator.wakeLock.request('screen'); else if (!on) { await focus.wake?.release(); focus.wake = null; } } catch {}
}
function focusTick() {
  const left = focus.end - Date.now();
  if (focus.phase === 'work' && left <= 60000 && !focus.warned) { focus.warned = true; playAnim([[255, 170, 0]], 'breathe', 3, true); }
  if (left <= 0) {
    if (focus.phase === 'work') { focus.done++; store.set('focusDone.' + new Date().toDateString(), focus.done); }
    focus.phase = focus.phase === 'work' ? 'break' : 'work';
    focus.end = Date.now() + (focus.phase === 'work' ? focus.work : focus.brk) * 60000;
    focus.warned = false;
    try { navigator.vibrate?.([200, 100, 200]); } catch {}
    focusLights();
  }
  drawFocus();
}
$('#focusStart').onclick = () => {
  if (focus.running) {
    focus.left = focus.end - Date.now(); focus.running = false; clearInterval(focus.tick); keepAwake(false);
  } else {
    focus.end = Date.now() + focus.left; focus.running = true; focus.warned = false;
    focusLights(); focus.tick = setInterval(focusTick, 500); keepAwake(true);
  }
  drawFocus();
};
$('#focusReset').onclick = () => {
  clearInterval(focus.tick); focus.running = false; focus.phase = 'work'; focus.left = focus.work * 60000; keepAwake(false);
  if (state.mode === 'custom') { anim = null; state.mode = 'color'; sendColor(state.rgb); paint(); }
  drawFocus();
};
drawFocus();

// ---------- Luz según la hora ----------
function tempForNow(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const pts = [[0, 100], [6, 90], [8, 40], [10, 10], [16, 10], [19, 55], [21, 85], [24, 100]];
  for (let i = 1; i < pts.length; i++) if (h <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return Math.round(v0 + (v1 - v0) * (h - h0) / (h1 - h0)); }
  return 100;
}
function setAutoDay(on) {
  autoDay.on = on; $('#autoDay').checked = on; store.set('autoDay', on); clearInterval(autoDay.t);
  if (!on) { $('#autoDayHint').textContent = 'Frío y despejado por la mañana, cálido por la noche. Se ajusta solo cada minuto.'; return; }
  const step = () => {
    const v = tempForNow(); setTempUI(v); applyTemp(true);
    const hh = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#autoDayHint').textContent = `Ahora (${hh}): ${v < 34 ? 'blanco frío' : v > 66 ? 'blanco cálido' : 'blanco neutro'}. Se ajusta solo cada minuto.`;
  };
  step(); autoDay.t = setInterval(step, 60000);
}
$('#autoDay').onchange = (e) => { if (e.target.checked) { stopEngines('auto'); clearMoment(); } setAutoDay(e.target.checked); };

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
renderPalette();
renderMyFx();
if (store.get('autoDay', false)) setAutoDay(true);
const tab = store.get('tab', 'color');
$(`.seg button[data-tab="${tab}"]`)?.click();
paint();
const bt = navigator.bluetooth;
log(`Navegador: ${navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 120)}`);
log(`Bluetooth web: ${bt ? 'sí' : 'no'} · escaneo: ${bt?.requestLEScan ? 'sí' : 'no'} · recordar: ${bt?.getDevices ? 'sí' : 'no'} · https: ${window.isSecureContext ? 'sí' : 'no'}`);
checkBluetooth();
tryAutoReconnect();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
