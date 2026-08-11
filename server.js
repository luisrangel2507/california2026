const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');
const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Eduardo';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) {
  console.warn(
    '⚠️  ANTHROPIC_API_KEY no está configurada — el traductor usa Google Translate ' +
    '(literal) en vez de Claude (natural, capta el tono). Para activarlo:\n' +
    '   1. Consigue una API key en https://console.anthropic.com\n' +
    '   2. Railway → este servicio → pestaña "Variables" → agrega ANTHROPIC_API_KEY\n' +
    '   3. Redeploy'
  );
}

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
}));

// ── VAPID keys ─────────────────────────────────────────────────────────────
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const generated = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = generated.publicKey;
  VAPID_PRIVATE_KEY = generated.privateKey;
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no configuradas — usando llaves generadas al vuelo. ' +
    'Las suscripciones se pierden en cada reinicio. Configura ambas como variables de entorno para persistir.');
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:altavibra@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ── Almacenamiento simple de archivos JSON ─────────────────────────────────
// DATA_DIR puede venir de una variable de entorno para poder apuntarlo a un
// disco de verdad (un Volume de Railway montado en, por ejemplo, /data).
// Sin eso, __dirname/data vive dentro del contenedor: cada redeploy empieza
// con un disco en blanco y se pierde todo — itinerario, gastos, fotos,
// reservaciones. Ya pasó una vez. El aviso es tan ruidoso a propósito porque
// es fácil no notarlo hasta que ya se perdió algo.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!process.env.DATA_DIR) {
  console.warn(
    '\n⚠️  DATA_DIR no está configurada — usando ' + DATA_DIR + ', dentro del propio contenedor.\n' +
    '   Sin un Volume de Railway montado ahí, CADA redeploy borra todo lo guardado\n' +
    '   (itinerario, gastos, fotos, reservaciones). Para arreglarlo de raíz:\n' +
    '   1. Railway → este servicio → pestaña "Volumes" → "+ New Volume"\n' +
    '   2. Mount path: /data\n' +
    '   3. Pestaña "Variables" → agregar DATA_DIR=/data\n' +
    '   4. Redeploy una última vez para que quede montado\n'
  );
}
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const subs = loadSubs();
  if (!subs.find((s) => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    saveSubs(subs);
  }
  res.json({ ok: true });
});

// Antes esta función solo devolvía cuántas suscripciones había, sin decir si
// el envío en sí falló — "sent" salía en true aunque ninguna notificación
// llegara. El caso más común: las llaves VAPID se regeneran solas en cada
// arranque si no están fijadas por variable de entorno (ver aviso abajo), así
// que las suscripciones viejas quedan firmadas contra una llave que ya no
// existe y el push service las rechaza — no con 404/410 (eso sí se limpia
// solo) sino con otro código, que antes solo se veía en el log del server,
// invisible para quien le da a "Probar".
async function sendPushToAll(payload) {
  const subs = loadSubs();
  const remaining = [];
  const errors = [];
  let ok = 0;
  for (const sub of subs) {
    try {
      // Sin timeout, una suscripción vieja apuntando a un push service que ya
      // no responde deja este await colgado indefinidamente — y con él, la
      // respuesta al botón "Probar" en el celular (se queda en "Enviando...").
      await webpush.sendNotification(sub, JSON.stringify(payload), { timeout: 8000 });
      remaining.push(sub);
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // suscripción vencida/eliminada por el navegador, se descarta
        continue;
      }
      remaining.push(sub);
      const msg = (err && err.body) || (err && err.message) || String(err);
      errors.push({ statusCode: (err && err.statusCode) || 0, message: msg });
      console.error('Push error:', (err && err.statusCode), msg);
    }
  }
  saveSubs(remaining);
  return { total: subs.length, ok, errors };
}

app.post('/api/send-test', async (req, res) => {
  const result = await sendPushToAll({
    title: 'Alta Vibra · California 2026',
    body: 'Esta es una notificación de prueba 🎉'
  });
  res.json({ ok: true, sent: result.ok, total: result.total, errors: result.errors });
});

// ── Frases de la cuenta regresiva pre-viaje (editables por el admin,
// una lista distinta por persona — { "Erick": [...], "Rafa": [...], ... }) ──
const PHRASES_FILE = path.join(DATA_DIR, 'countdown-phrases.json');
function loadCountdownPhrases() {
  try {
    const data = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf8'));
    // Versión vieja guardaba un arreglo plano compartido entre todos — se
    // descarta en vez de migrarlo mal, son solo frases de relleno.
    return (data && !Array.isArray(data) && typeof data === 'object') ? data : {};
  } catch (e) { return {}; }
}
function saveCountdownPhrasesStore(store) {
  fs.writeFileSync(PHRASES_FILE, JSON.stringify(store, null, 2));
}

app.get('/api/countdown-phrases', (req, res) => {
  res.json({ phrases: loadCountdownPhrases() });
});

app.post('/api/countdown-phrases', (req, res) => {
  const { person, phrases, who } = req.body || {};
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  if (typeof person !== 'string' || !person) return res.status(400).json({ error: 'missing fields' });
  if (!Array.isArray(phrases)) return res.status(400).json({ error: 'missing fields' });
  const clean = phrases
    .map((p) => (typeof p === 'string' ? p.trim().slice(0, 200) : ''))
    .filter(Boolean)
    .slice(0, 40);
  const store = loadCountdownPhrases();
  store[person] = clean;
  saveCountdownPhrasesStore(store);
  res.json({ ok: true, phrases: store });
});

// ── Fotos compartidas por actividad ────────────────────────────────────────
const MEM_FILE = path.join(DATA_DIR, 'memory.json');
let memStore = {};
try { memStore = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch(e) {}
function persistMem() {
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(memStore)); } catch(e) {}
}

app.get('/api/memory', (req, res) => res.json(memStore));

app.post('/api/memory', (req, res) => {
  const { actKey, photo, who } = req.body;
  if (!actKey || !photo) return res.status(400).json({ error: 'missing fields' });
  if (!memStore[actKey]) memStore[actKey] = [];
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  memStore[actKey].push({ id, photo, who: who || '?', ts: Date.now() });
  persistMem();
  res.json({ ok: true, id });
});

app.delete('/api/memory/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const { id } = req.params;
  let found = false;
  Object.keys(memStore).forEach(key => {
    const idx = memStore[key].findIndex(p => p.id === id);
    if (idx !== -1) { memStore[key].splice(idx, 1); found = true; }
  });
  if (found) { persistMem(); res.json({ ok: true }); }
  else res.status(404).json({ error: 'not found' });
});

// Por default toda foto es visible para familia/amigos (fam===false es lo
// único que se guarda) — así ninguna de las que ya se subieron cambia de
// estado con este cambio. Cualquiera del grupo puede ocultar una foto
// puntual, sin necesidad de ser admin, igual que subirlas.
app.post('/api/memory/:id/visibility', (req, res) => {
  const { fam } = req.body;
  if (typeof fam !== 'boolean') return res.status(400).json({ error: 'missing fields' });
  const { id } = req.params;
  let found = null;
  Object.keys(memStore).forEach(key => {
    const p = memStore[key].find((p) => p.id === id);
    if (p) found = p;
  });
  if (!found) return res.status(404).json({ error: 'not found' });
  if (fam) delete found.fam; else found.fam = false;
  persistMem();
  res.json({ ok: true });
});

// ── Gastos compartidos entre todos los del viaje ───────────────────────────
const EXP_FILE = path.join(DATA_DIR, 'expenses.json');
let expStore = [];
try { expStore = JSON.parse(fs.readFileSync(EXP_FILE, 'utf8')); } catch (e) {}
function persistExp() {
  try { fs.writeFileSync(EXP_FILE, JSON.stringify(expStore)); } catch (e) {}
}

app.get('/api/expenses', (req, res) => res.json(expStore));

app.post('/api/expenses', (req, res) => {
  const { desc, amt, who, split, cat } = req.body;
  if (!desc || typeof amt !== 'number' || amt <= 0 || who === undefined) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const expense = { id, desc, amt, who, split: Array.isArray(split) ? split : [], cat: cat || 'other', ts: Date.now() };
  expStore.push(expense);
  persistExp();
  res.json({ ok: true, expense });
});

app.delete('/api/expenses/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const idx = expStore.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  expStore.splice(idx, 1);
  persistExp();
  res.json({ ok: true });
});

// Comprobantes (foto o archivo) adjuntos a un gasto, como evidencia del pago
app.post('/api/expenses/:id/receipts', (req, res) => {
  const { photo, name, type } = req.body;
  if (!photo) return res.status(400).json({ error: 'missing fields' });
  const exp = expStore.find((e) => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: 'not found' });
  if (!exp.receipts) exp.receipts = [];
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const receipt = { id, photo, name: name || '', type: type || '', ts: Date.now() };
  exp.receipts.push(receipt);
  persistExp();
  res.json({ ok: true, receipt });
});

app.delete('/api/expenses/:id/receipts/:rid', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const exp = expStore.find((e) => e.id === req.params.id);
  if (!exp || !exp.receipts) return res.status(404).json({ error: 'not found' });
  const idx = exp.receipts.findIndex((r) => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  exp.receipts.splice(idx, 1);
  persistExp();
  res.json({ ok: true });
});

// ── Pagos entre personas para liquidar deudas del viaje ────────────────────
// No son gastos del viaje (no cuentan para el total gastado) — solo ajustan
// los saldos cuando alguien ya le pagó a quien adelantó el dinero.
const SETTLE_FILE = path.join(DATA_DIR, 'settlements.json');
let settleStore = [];
try { settleStore = JSON.parse(fs.readFileSync(SETTLE_FILE, 'utf8')); } catch (e) {}
function persistSettle() {
  try { fs.writeFileSync(SETTLE_FILE, JSON.stringify(settleStore)); } catch (e) {}
}

app.get('/api/settlements', (req, res) => res.json(settleStore));

app.post('/api/settlements', (req, res) => {
  const { from, to, amt } = req.body;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof amt !== 'number' || amt <= 0) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const settlement = { id, from, to, amt, ts: Date.now() };
  settleStore.push(settlement);
  persistSettle();
  res.json({ ok: true, settlement });
});

app.delete('/api/settlements/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const idx = settleStore.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  settleStore.splice(idx, 1);
  persistSettle();
  res.json({ ok: true });
});

// ── Perfiles (fecha de nacimiento, dirección, contacto de emergencia) ─────
// Compartido entre todos para que el admin pueda ver los contactos de
// emergencia de cada quien en caso de necesitarlos durante el viaje.
const PROF_FILE = path.join(DATA_DIR, 'profiles.json');
let profStore = {};
try { profStore = JSON.parse(fs.readFileSync(PROF_FILE, 'utf8')); } catch (e) {}
function persistProf() {
  try { fs.writeFileSync(PROF_FILE, JSON.stringify(profStore)); } catch (e) {}
}

app.get('/api/profiles', (req, res) => res.json(profStore));

app.post('/api/profiles', (req, res) => {
  const { idx, data } = req.body;
  if (idx === undefined || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'missing fields' });
  }
  // Se hace merge campo por campo (no un reemplazo completo) — así una
  // subida de foto por sí sola no borra el resto del perfil, y viceversa.
  const prev = profStore[idx] || {};
  const pick = (key) => (data[key] !== undefined ? data[key] : (prev[key] || ''));
  profStore[idx] = {
    birth: pick('birth'),
    blood: pick('blood'),
    address: pick('address'),
    ecName: pick('ecName'),
    ecPhoneCode: pick('ecPhoneCode'),
    ecPhone: pick('ecPhone'),
    photo: pick('photo'),
  };
  persistProf();
  res.json({ ok: true });
});

// ── Traductor ──────────────────────────────────────────────────────────────
// Se proxea por aquí en vez de llamar desde el navegador: evita problemas de
// CORS y permite tener un segundo proveedor de respaldo si el primero falla o
// cambia de dominio (como ya nos pasó con la API de tipo de cambio).
const TRANSLATE_EMAIL = process.env.TRANSLATE_EMAIL || '';

const LANG_NAMES = { es: 'español', en: 'inglés', fr: 'francés', pt: 'portugués', it: 'italiano', de: 'alemán' };

// Claude traduce mejor el tono y el sentido que Google/MyMemory (que son
// literales) — se intenta primero si hay una llave de Anthropic configurada.
async function tryClaude(text, from, to) {
  if (!anthropic) return null;
  const fromName = LANG_NAMES[from] || from;
  const toName = LANG_NAMES[to] || to;
  const msg = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 300,
    system: 'Eres un traductor experto en conversaciones cotidianas entre personas. ' +
      `Traduces de ${fromName} a ${toName} de forma natural y fluida, como lo diría ` +
      'alguien nativo — nunca de forma literal ni palabra por palabra. Conserva el ' +
      'tono exacto de quien habla (informal, entusiasta, sarcástico, molesto, etc.) — ' +
      'la traducción debe sonar igual de natural en ese mismo tono. Responde ' +
      'ÚNICAMENTE con la traducción, sin explicaciones, notas ni comillas.',
    messages: [{ role: 'user', content: text }],
  });
  const block = msg.content.find((b) => b.type === 'text');
  const out = block && block.text.trim();
  return out || null;
}

async function tryMyMemory(text, from, to) {
  let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent(from + '|' + to);
  if (TRANSLATE_EMAIL) url += '&de=' + encodeURIComponent(TRANSLATE_EMAIL);
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) return null;
  const j = await r.json();
  const out = j && j.responseData && j.responseData.translatedText;
  if (!out) return null;
  // MyMemory devuelve los avisos de cuota dentro del propio campo de traducción
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(out)) return null;
  return out;
}

async function tryGoogleGtx(text, from, to) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
    encodeURIComponent(from) + '&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text);
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j) || !Array.isArray(j[0])) return null;
  const out = j[0].map((seg) => (seg && seg[0]) || '').join('');
  return out || null;
}

app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'missing text' });
  if (text.length > 500) return res.status(400).json({ error: 'text too long' });
  const langRe = /^[a-z]{2}$/;
  const src = langRe.test(from) ? from : 'es';
  const dst = langRe.test(to) ? to : 'en';
  if (src === dst) return res.json({ translated: text, provider: 'none' });

  // Claude va primero (natural, capta el tono) si hay llave configurada;
  // si no, o si falla, Google GTX (rápido y confiable) y luego MyMemory
  // como último respaldo (a veces ni conecta).
  const providers = [['claude', tryClaude], ['google', tryGoogleGtx], ['mymemory', tryMyMemory]];
  for (const [name, fn] of providers) {
    try {
      const out = await fn(text, src, dst);
      if (out) return res.json({ translated: out, provider: name });
    } catch (e) {
      // se intenta con el siguiente proveedor
    }
  }
  res.status(502).json({ error: 'translation unavailable' });
});

// ── Geocodificación (para que las actividades aparezcan en el mapa) ────────
// Las actividades que se agregan desde la app no traen coordenadas, así que
// el mapa no las podía mostrar. Aquí se resuelven: primero del link de Google
// Maps si lo pegaron (es exacto), si no buscando el nombre en Nominatim.
// Nominatim pide User-Agent identificable y máximo 1 petición por segundo, así
// que se serializa y se cachea en disco.
const GEO_FILE = path.join(DATA_DIR, 'geocache.json');
let geoCache = {};
try { geoCache = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')); } catch (e) {}
function persistGeo() {
  try { fs.writeFileSync(GEO_FILE, JSON.stringify(geoCache)); } catch (e) {}
}

const GEO_UA = 'AltaVibra-California2026/1.0 (viaje privado; contacto via app)';
// El límite de 1 req/seg es de Nominatim; Photon no lo impone, así que cada
// proveedor lleva su propio ritmo. Antes todo iba a 1.1s y ubicar seis
// actividades tardaba una eternidad.
const GEO_GAP = { nominatim: 1100, photon: 150, maps: 300 };
let geoQueue = Promise.resolve();
const geoLastCall = {};
function geoThrottle(fn, who) {
  const key = who || 'nominatim';
  const run = async () => {
    const gap = GEO_GAP[key] || 1100;
    const wait = Math.max(0, gap - (Date.now() - (geoLastCall[key] || 0)));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    geoLastCall[key] = Date.now();
    return fn();
  };
  geoQueue = geoQueue.then(run, run);
  return geoQueue;
}

// Si un proveedor nos está bloqueando, no tiene caso volver a pegarle con cada
// actividad: se apaga un rato y se sigue con el otro.
const geoDown = {};
const GEO_DOWN_MS = 10 * 60 * 1000;
function geoIsDown(name) {
  return geoDown[name] && (Date.now() - geoDown[name]) < GEO_DOWN_MS;
}

// Patrones que apuntan al LUGAR, no a la vista. Se usan sobre URLs, que son
// cortas y donde cada número tiene un significado fijo.
const URL_PATS = [
  // !3d/!4d es la coordenada exacta del lugar; va primero porque @... es
  // el centro de la vista, que puede estar desplazado.
  /!8m2!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  /[?&](?:q|query|daddr|destination|saddr)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i,
  /[?&](?:ll|sll|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i,
  /[?&]markers=[^&"'\s]*?(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i,
  /\/maps\/(?:search|dir|place)\/(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
];

function validarCoord(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return [lat, lon];
}

function coordsFromMapsUrl(text) {
  if (!text) return null;
  const txt = String(text).replace(/&amp;/g, '&');
  for (const p of URL_PATS) {
    const m = txt.match(p);
    if (!m) continue;
    const c = validarCoord(parseFloat(m[1]), parseFloat(m[2]));
    if (c) return c;
  }
  return null;
}

// Sacar coordenadas del HTML es lo que puso "Little Tokyo" cerca de Sacramento:
// una página de Maps trae cientos de números y patrones sueltos como
// [null,null,x,y], @lat,lng o APP_INITIALIZATION_STATE (que es el centro por
// omisión de la sesión, no el lugar) enganchan con cualquier cosa. Un pin en el
// lugar equivocado es peor que no tener pin, así que aquí sólo se aceptan dos
// cosas, las dos amarradas al lugar:
//   1. la miniatura del mapa de la vista previa (og:image), que es del lugar
//   2. una URL de Maps incrustada que traiga !3d!4d, la coordenada exacta
function coordsFromMapsHtml(html) {
  if (!html) return null;
  const txt = String(html).replace(/&amp;/g, '&');

  const mini = txt.match(/staticmap[^"'\s]*?[?&](?:center|markers)=[^"'\s]*/i);
  if (mini) {
    const c = coordsFromMapsUrl(mini[0]);
    if (c) return c;
  }

  const exacta = txt.match(/!8m2!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
    || txt.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (exacta) {
    const c = validarCoord(parseFloat(exacta[1]), parseFloat(exacta[2]));
    if (c) return c;
  }

  return null;
}

// A un navegador de celular, maps.app.goo.gl le contesta con una página para
// abrir la app de Maps, no con la ficha web — y ahí no hay coordenadas por
// ningún lado. Con un navegador de escritorio la redirección sí lleva a la
// ficha completa. Se intentan los dos, empezando por el de escritorio.
// La cookie de consentimiento se manda a mano, y eso es un arma de dos filos:
// si Google la considera inválida o vieja, ella misma dispara la pantalla de
// consentimiento que se quería evitar. Por eso el primer intento va limpio.
const CONSENT_COOKIE = 'CONSENT=YES+cb; SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2Vydm' +
  'VyXzIwMjQwNzA5LjA3X3AxGgJlbiADGgYIgLD_tQY';

const UA_PREVIEW = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const UA_ESCRITORIO = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_CELULAR = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const MAPS_UAS = [
  // La vista previa que Google sirve a los rastreadores de los chats — es lo
  // que usan WhatsApp e iMessage para pintar la tarjetita del link. Página
  // chica, hecha para leerse por máquinas, y con la miniatura del mapa que
  // trae center=lat,lng. Es la respuesta más confiable desde un servidor.
  ['vista previa', UA_PREVIEW, false],
  ['vista previa con cookie', UA_PREVIEW, true],
  ['escritorio', UA_ESCRITORIO, false],
  ['escritorio con cookie', UA_ESCRITORIO, true],
  ['celular', UA_CELULAR, true],
];

function mapsHeaders(ua, conCookie) {
  const h = {
    'User-Agent': ua,
    // En inglés: en español Google mete más seguido la pantalla de cookies.
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    'Accept': 'text/html,application/xhtml+xml',
  };
  if (conCookie) h.Cookie = CONSENT_COOKIE;
  return h;
}

// Muchos links cortos acaban en una URL así:
//   https://www.google.com/maps?q=418+Pier+Ave,+Hermosa+Beach,+CA&ftid=0x80c2...
// Sin coordenadas, pero con la dirección completa que Google mismo resolvió
// para ese lugar. Buscar esa dirección es exacto: no es adivinar por el nombre
// de la actividad, es la dirección del sitio que el usuario eligió.
function addressFromMapsUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  for (const k of ['q', 'query', 'destination', 'daddr']) {
    const v = u.searchParams.get(k);
    if (!v) continue;
    let t = v.trim();
    // Si ya son coordenadas, de eso se encarga coordsFromMapsUrl
    if (/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(t)) continue;
    if (t.length < 4) continue;
    return t.slice(0, 200);
  }
  return null;
}

// Un solo recorrido de la cadena de redirecciones con un User-Agent dado. La
// coordenada puede aparecer en cualquier paso: en una redirección intermedia,
// en la URL final o dentro del HTML.
async function seguirCadena(url, ua, note, conCookie) {
  let actual = url;
  for (let salto = 0; salto < 6; salto++) {
    let r;
    try {
      r = await fetch(actual, {
        redirect: 'manual',
        headers: mapsHeaders(ua, conCookie),
        signal: AbortSignal.timeout(12000),
      });
    } catch (e) {
      note('no se pudo abrir el link: ' + (e && e.message ? e.message : e));
      return { url: actual };
    }

    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      actual = new URL(loc, actual).toString();
      const c = coordsFromMapsUrl(actual);
      if (c) return { c };
      continue;
    }
    if (!r.ok) { note('Google respondió ' + r.status); return { url: actual }; }

    const html = await r.text().catch(() => '');
    const c = coordsFromMapsHtml(html);
    if (c) return { c };

    // A veces la redirección viene dentro de la página, no en la cabecera
    const dentro = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*?url=([^"'>\s]+)/i)
      || html.match(/location\.replace\(["']([^"']+)["']\)/i)
      || html.match(/<link[^>]+rel=["']?canonical["']?[^>]+href=["']([^"']+)["']/i);
    if (dentro && salto < 5) {
      const sig = new URL(dentro[1].replace(/&amp;/g, '&'), actual).toString();
      if (sig !== actual && /^https?:/i.test(sig)) { actual = sig; continue; }
    }

    note('acabó en ' + actual.slice(0, 90) + ' y esa página no trae coordenadas (' +
         html.length + ' bytes' +
         (/consent|sorry\/index|captcha/i.test(actual + html.slice(0, 3000))
            ? ', parece pantalla de consentimiento o bloqueo' : '') +
         (/comgooglemaps:|intent:\/\/|itms-apps/i.test(html.slice(0, 5000))
            ? ', es la página para abrir la app' : '') + ')');
    return { url: actual };
  }
  note('demasiadas redirecciones');
  return { url: actual };
}

// Devuelve {c:[lat,lon]} si sacó la coordenada, {addr:'...'} si lo único que
// consiguió fue la dirección del lugar, o null.
async function resolveMapsUrl(url, diag) {
  const direct = coordsFromMapsUrl(url);
  if (direct) return { c: direct };
  const dirEnLink = addressFromMapsUrl(url);
  if (!/^https?:\/\//i.test(url)) {
    if (diag) diag.push('no es un link');
    return null;
  }
  let addr = dirEnLink;
  for (const [nombre, ua, conCookie] of MAPS_UAS) {
    const pasos = [];
    const res = await seguirCadena(url, ua, (m) => pasos.push(m), conCookie);
    if (res && res.c) return { c: res.c };
    if (!addr && res && res.url) addr = addressFromMapsUrl(res.url);
    if (diag) diag.push('como ' + nombre + ': ' + (pasos[0] || 'sin resultado'));
  }
  return addr ? { addr } : null;
}

// Lo que se pega en el campo de ubicación no siempre es un link: puede ser la
// dirección tal cual, unas coordenadas copiadas de Maps, o el texto completo
// que comparte la app ("Beverly Hills\nhttps://maps.app.goo.gl/..."). Sea lo
// que sea, lo puso el usuario a mano y manda sobre el nombre de la actividad.
function parseLocHint(text) {
  const s = String(text || '').trim().slice(0, 300);
  if (!s) return null;
  const url = s.match(/https?:\/\/[^\s<>"']+/);
  if (url) return { kind: 'url', value: url[0] };
  const pair = s.match(/^\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if (pair) {
    const lat = parseFloat(pair[1]), lon = parseFloat(pair[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
      return { kind: 'coords', value: [lat, lon] };
    }
  }
  return { kind: 'address', value: s };
}

// Dos proveedores: Nominatim bloquea IPs de servidores en la nube, así que
// Photon (también sobre datos de OpenStreetMap) sirve de respaldo real.
async function geoNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': GEO_UA, 'Accept-Language': 'es,en' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('nominatim HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  const lat = parseFloat(j[0].lat), lon = parseFloat(j[0].lon);
  return (isFinite(lat) && isFinite(lon)) ? [lat, lon] : null;
}

async function geoPhoton(q) {
  const url = 'https://photon.komoot.io/api/?limit=1&lang=es&q=' + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': GEO_UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('photon HTTP ' + r.status);
  const j = await r.json();
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
  const [lon, lat] = f.geometry.coordinates;   // GeoJSON viene [lon, lat]
  return (isFinite(lat) && isFinite(lon)) ? [lat, lon] : null;
}

const GEO_PROVIDERS = [['nominatim', geoNominatim], ['photon', geoPhoton]];

// Google devuelve la dirección del lugar tal cual la muestra, y así entera los
// buscadores no siempre la encuentran: trae el nombre del negocio adelante
// ("Las Americas Premium Outlets, 4211 Camino De La Plaza…"), el número de
// local ("6255 Sunset Blvd #150") y el país en español. Se prueban versiones
// cada vez más limpias, de la más completa a la más pelona.
function direccionVariantes(addr) {
  const out = [];
  const push = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ')
      .replace(/^[\s,]+|[\s,]+$/g, '').trim();
    if (s.length >= 5 && !out.includes(s)) out.push(s);
  };

  const base = String(addr || '').trim()
    // El país viene en el idioma que se pidió; los buscadores quieren USA
    .replace(/,?\s*(?:Estados\s+Unidos(?:\s+de\s+Am[eé]rica)?|EE\.?\s*UU\.?|United\s+States(?:\s+of\s+America)?)\s*$/i,
             ', USA');
  push(base);

  // La dirección de verdad empieza donde aparece el número de la calle; lo de
  // antes es el nombre del lugar.
  const partes = base.split(',').map((p) => p.trim()).filter(Boolean);
  const iNum = partes.findIndex((p) => /^\d/.test(p));
  if (iNum > 0) push(partes.slice(iNum).join(', '));

  // A veces el nombre no trae número de calle detrás porque no es una calle:
  // es un parque, una carretera, una zona natural ("Kings Canyon National
  // Park, CA-180, Hume, CA 93628" — y de paso Google lo tradujo mal, a "Kins
  // Cañon Parque Natural", que ningún buscador reconoce). Ahí el truco del
  // número no dispara nunca. Se prueba también quitando uno y dos pedazos del
  // frente: la ruta y la ciudad casi siempre sí las conoce el buscador, aunque
  // el nombre del lugar esté mal traducido o no lo tenga.
  if (partes.length > 2) push(partes.slice(1).join(', '));
  if (partes.length > 3) push(partes.slice(2).join(', '));

  // El número de local no lo conocen los buscadores
  const sinLocal = (t) => t.replace(/\s*(?:#|Ste\.?|Suite|Unit|Apt\.?|Local)\s*[\w-]+/ig, '');
  out.slice().forEach((v) => push(sinLocal(v)));

  // Y por último sin código postal
  out.slice().forEach((v) => push(v.replace(/\s+\d{5}(?:-\d{4})?(?=,|$)/g, '')));

  return out.slice(0, 6);
}

// Busca una dirección con los dos proveedores. Se usa tanto para lo que pega
// el usuario a mano como para la dirección que deja el link de Maps.
async function buscarDireccion(addr, tried) {
  const queries = direccionVariantes(addr);
  if (!queries.length) queries.push(addr);
  if (!/(?:^|[\s,])(?:usa|united states|california|ca)(?:[\s,.]|$)/i.test(addr)) {
    queries.push(addr + ', California, USA');
  }
  for (const [pname, pfn] of GEO_PROVIDERS) {
    if (geoIsDown(pname)) { tried.push(pname + ' omitido (falló hace poco)'); continue; }
    for (const q of queries) {
      const key = 'q:' + pname + ':' + q.toLowerCase();
      if (geoCache[key]) return geoCache[key];
      try {
        const c = await geoThrottle(() => pfn(q), pname);
        if (c) { geoCache[key] = c; persistGeo(); return c; }
        tried.push(pname + ' sin resultados: ' + q);
      } catch (e) {
        tried.push(pname + ' ERROR: ' + (e && e.message ? e.message : e));
        geoDown[pname] = Date.now();   // se apaga un rato
        break;
      }
    }
  }
  return null;
}

app.post('/api/geocode', async (req, res) => {
  const { mapsUrl } = req.body || {};

  // Sólo se ubica lo que el usuario pegó: link de Maps, dirección o
  // coordenadas. Adivinar por el nombre de la actividad ponía el pin donde
  // fuera — "Comida en Rockefeller" acabó en Irvine — así que ya no se hace.
  const hint = parseLocHint(mapsUrl);
  if (!hint) return res.status(400).json({ error: 'sin ubicación' });

  if (hint.kind === 'coords') {
    return res.json({ c: hint.value, source: 'coords' });
  }

  if (hint.kind === 'url') {
    const key = 'url:' + hint.value;
    if (geoCache[key]) return res.json({ c: geoCache[key], source: 'maps', cached: true });
    const diag = [];
    const r = await geoThrottle(() => resolveMapsUrl(hint.value, diag), 'maps');
    if (r && r.c) { geoCache[key] = r.c; persistGeo(); return res.json({ c: r.c, source: 'maps' }); }

    // El link no soltó coordenadas pero sí la dirección del lugar: se busca esa.
    if (r && r.addr) {
      const c = await buscarDireccion(r.addr, diag);
      if (c) {
        geoCache[key] = c; persistGeo();
        return res.json({ c, source: 'maps-dir', addr: r.addr });
      }
      return res.status(404).json({
        error: 'not found',
        why: 'el link apunta a «' + r.addr + '» pero no encontré esa dirección',
        tried: diag,
      });
    }

    return res.status(404).json({
      error: 'not found',
      why: diag[0] || 'el link no soltó coordenadas',
      tried: diag,
    });
  }

  // Dirección pegada a mano: mismo camino
  const c = await buscarDireccion(hint.value, []);
  if (c) return res.json({ c, source: 'dir' });
  const tried = [];
  await buscarDireccion(hint.value, tried);
  res.status(404).json({ error: 'not found', why: tried[0], tried });
});

// Diagnóstico: dice si los proveedores responden desde este servidor. Nominatim
// bloquea IPs de nube, y sin esto no hay forma de distinguir eso de "el lugar
// no existe" — que fue justo lo que nos tuvo adivinando.
app.get('/api/geocode-check', async (req, res) => {
  const q = (req.query.q || 'Beverly Hills, California, USA').toString().slice(0, 160);
  const out = { q, providers: {} };
  for (const [pname, pfn] of GEO_PROVIDERS) {
    const t0 = Date.now();
    try {
      const c = await geoThrottle(() => pfn(q), pname);
      out.providers[pname] = { ok: !!c, c: c || null, ms: Date.now() - t0 };
    } catch (e) {
      out.providers[pname] = { ok: false, error: String(e && e.message || e), ms: Date.now() - t0 };
    }
  }
  res.json(out);
});

// ── Itinerario compartido (título del día + actividades) ───────────────────
// Antes esto vivía solo en el localStorage de cada teléfono, así que lo que
// el admin armaba no lo veía nadie más. Ahora es del servidor, como los
// gastos y las reservaciones.
const ITIN_FILE = path.join(DATA_DIR, 'itinerary.json');
let itinStore = {};   // { "0": { city, acts:[...] }, ... }
try { itinStore = JSON.parse(fs.readFileSync(ITIN_FILE, 'utf8')); } catch (e) {}
function persistItin() {
  try { fs.writeFileSync(ITIN_FILE, JSON.stringify(itinStore)); } catch (e) {}
}

app.get('/api/itinerary', (req, res) => res.json(itinStore));

app.post('/api/itinerary', (req, res) => {
  const { idx, city, acts, who } = req.body || {};
  const i = parseInt(idx, 10);
  if (!Number.isInteger(i) || i < 0 || i > 60) {
    return res.status(400).json({ error: 'bad day index' });
  }
  if (who !== ADMIN_NAME) {
    return res.status(403).json({ error: 'solo el admin puede editar el itinerario' });
  }
  const entry = itinStore[i] || {};
  if (typeof city === 'string') entry.city = city.slice(0, 120);
  if (Array.isArray(acts)) {
    entry.acts = acts.slice(0, 60).map((a) => {
      const out = {
        t: typeof a.t === 'string' ? a.t.slice(0, 12) : '',
        n: typeof a.n === 'string' ? a.n.slice(0, 160) : '',
        note: typeof a.note === 'string' ? a.note.slice(0, 240) : '',
      };
      if (typeof a.g === 'string' && a.g) out.g = a.g.slice(0, 500);
      // Coordenadas solo si son números válidos
      if (Array.isArray(a.c) && a.c.length === 2 &&
          typeof a.c[0] === 'number' && typeof a.c[1] === 'number') {
        out.c = [a.c[0], a.c[1]];
        // De dónde salió: 'link' la pegó el usuario, 'nombre' la adivinó el
        // buscador y bien puede haber caído en otro lado.
        if (a.cs === 'link' || a.cs === 'nombre') out.cs = a.cs;
      }
      return out;
    });
  }
  itinStore[i] = entry;
  persistItin();
  res.json({ ok: true, entry });
});

// Borra el itinerario completo para empezar de cero. Solo el admin.
app.delete('/api/itinerary', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const dias = Object.keys(itinStore).length;
  itinStore = {};
  persistItin();
  // También se limpia el caché de ubicaciones: si el viaje cambia por
  // completo, las coordenadas viejas ya no sirven de nada.
  geoCache = {};
  persistGeo();
  res.json({ ok: true, borrados: dias });
});

// ── Ubicación en vivo del grupo (opt-in por persona) ───────────────────────
const LIVELOC_FILE = path.join(DATA_DIR, 'live-locations.json');
let liveLocStore = {};
try { liveLocStore = JSON.parse(fs.readFileSync(LIVELOC_FILE, 'utf8')); } catch (e) {}
function persistLiveLoc() {
  try { fs.writeFileSync(LIVELOC_FILE, JSON.stringify(liveLocStore)); } catch (e) {}
}

app.get('/api/live-locations', (req, res) => res.json(liveLocStore));

app.post('/api/live-locations', (req, res) => {
  const { who, lat, lon } = req.body;
  if (!who || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'missing fields' });
  }
  liveLocStore[who] = { lat, lon, ts: Date.now() };
  persistLiveLoc();
  res.json({ ok: true });
});

app.delete('/api/live-locations/:who', (req, res) => {
  delete liveLocStore[req.params.who];
  persistLiveLoc();
  res.json({ ok: true });
});

// ── Enlace para que familiares y amigos sigan el viaje en vivo ─────────────
// No tienen perfil ni PIN — el "acceso" es un token largo al azar en la URL
// (/seguir/<token>), igual de expuesto que el resto de la API (que ya es
// pública sin autenticación) pero no adivinable ni linkeado desde ningún
// lado salvo el botón "Compartir" en Mi Perfil. El admin puede invalidarlo
// generando uno nuevo si se comparte de más.
const VIEWER_FILE = path.join(DATA_DIR, 'viewer.json');
let viewerToken = null;
try { viewerToken = JSON.parse(fs.readFileSync(VIEWER_FILE, 'utf8')).token; } catch (e) {}
function persistViewerToken() {
  try { fs.writeFileSync(VIEWER_FILE, JSON.stringify({ token: viewerToken })); } catch (e) {}
}
if (!viewerToken) {
  viewerToken = crypto.randomBytes(24).toString('hex');
  persistViewerToken();
}

app.get('/api/viewer-token', (req, res) => res.json({ token: viewerToken }));

app.post('/api/viewer-token/regenerate', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  viewerToken = crypto.randomBytes(24).toString('hex');
  persistViewerToken();
  res.json({ ok: true, token: viewerToken });
});

app.get('/api/viewer-check/:token', (req, res) => {
  res.json({ ok: req.params.token === viewerToken });
});

app.get('/seguir/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seguir.html'));
});

// ── ¿Dónde dejamos el carro? (una sola ubicación compartida) ───────────────
const CAR_FILE = path.join(DATA_DIR, 'car.json');
let carLoc = null;
try { carLoc = JSON.parse(fs.readFileSync(CAR_FILE, 'utf8')); } catch (e) {}
function persistCar() {
  try { fs.writeFileSync(CAR_FILE, JSON.stringify(carLoc)); } catch (e) {}
}

app.get('/api/car', (req, res) => res.json(carLoc));

app.post('/api/car', (req, res) => {
  const { lat, lon, who } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'missing coords' });
  }
  carLoc = { lat, lon, who: who || '?', ts: Date.now() };
  persistCar();
  res.json({ ok: true, carLoc });
});

app.delete('/api/car', (req, res) => {
  carLoc = null;
  persistCar();
  res.json({ ok: true });
});

// ── Alertas de clima/desastre cerca de la ruta (NWS, sin API key) ──────────
// CAL FIRE no tenía un API JSON de verdad (el endpoint que se probó regresaba
// la página HTML del sitio, no datos) — se reemplaza por el National Weather
// Service (api.weather.gov), que es público, oficial, bien documentado, y
// además de incendios (Red Flag Warning) cubre huracanes, inundaciones,
// tormentas eléctricas, calor extremo, etc. — todo en un solo feed, y cada
// alerta trae la geometría (polígono) real de la zona afectada, así que se
// puede pintar el área en el mapa en vez de solo un pin.
const HAZARD_FILE = path.join(DATA_DIR, 'hazard-alerts.json');
let hazardStore = { notifiedIds: [], nearby: [], lastCheck: 0 };
try {
  const loaded = JSON.parse(fs.readFileSync(HAZARD_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') hazardStore = Object.assign(hazardStore, loaded);
} catch (e) {}
function persistHazard() {
  try { fs.writeFileSync(HAZARD_FILE, JSON.stringify(hazardStore)); } catch (e) {}
}

// Categorías amigables — el nombre crudo que manda NWS ("Red Flag Warning",
// "Flash Flood Warning") no le dice nada a nadie que no sea meteorólogo.
const HAZARD_CATEGORIES = [
  { match: /red flag|fire weather/i, key: 'fire', emoji: '🔥', label: 'Riesgo de incendio', color: '#FF3B1F' },
  { match: /hurricane|tropical storm|tropical depression/i, key: 'hurricane', emoji: '🌀', label: 'Huracán', color: '#B23BFF' },
  { match: /flash flood|flood/i, key: 'flood', emoji: '🌊', label: 'Inundación', color: '#2E9BFF' },
  { match: /thunderstorm/i, key: 'storm', emoji: '⛈️', label: 'Tormenta eléctrica', color: '#FFD23B' },
  { match: /excessive heat|heat/i, key: 'heat', emoji: '🌡️', label: 'Calor extremo', color: '#FF7A1F' },
  { match: /high surf|coastal|rip current/i, key: 'surf', emoji: '🌊', label: 'Oleaje/costa peligrosa', color: '#2E9BFF' },
  { match: /rain/i, key: 'rain', emoji: '🌧️', label: 'Lluvia fuerte', color: '#3B7DFF' },
  { match: /high wind|wind advisory/i, key: 'wind', emoji: '💨', label: 'Viento fuerte', color: '#8FA6B8' },
  { match: /winter storm|snow|ice/i, key: 'snow', emoji: '❄️', label: 'Nieve/hielo', color: '#8FD9FF' },
];
function categorizeHazard(eventName) {
  const found = HAZARD_CATEGORIES.find((c) => c.match.test(eventName || ''));
  return found || { key: 'other', emoji: '⚠️', label: eventName || 'Alerta', color: '#FF9A40' };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ray casting clásico: ¿el punto cae dentro del anillo? Un "anillo" GeoJSON
// es una lista de [lon,lat] (ojo: lon primero, no lat — al revés de como se
// suele pensar en "lat,lon").
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return geometry.coordinates.some((ring) => pointInRing(lat, lon, ring));
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => poly.some((ring) => pointInRing(lat, lon, ring)));
  return false;
}
// Geometría GeoJSON (anillos en [lon,lat]) a arreglos [lat,lon] que Leaflet
// puede dibujar directo con L.polygon().
function geometryToLatLngPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map((ring) => ring.map(([lon, lat]) => [lat, lon]))];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [lat, lon])));
  }
  return [];
}

// api.weather.gov es un API federal documentado y estable — a diferencia del
// endpoint de CAL FIRE que resultó no ser JSON de verdad, este sí se puede
// codificar con confianza. Aun así se junta diagnóstico (status, cuántas
// alertas trajo crudo, cuántas tenían geometría usable) porque este sandbox
// tampoco tiene salida a api.weather.gov para probarlo antes de que corra en
// producción.
async function fetchActiveHazards() {
  const debug = { ok: false, status: null, rawCount: null, parsedCount: null, error: null };
  try {
    const r = await fetch('https://api.weather.gov/alerts/active?area=CA', {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': '(Alta Vibra trip app, contacto en el perfil de Railway)',
        Accept: 'application/geo+json',
      },
    });
    debug.status = r.status;
    if (!r.ok) { debug.error = 'HTTP ' + r.status; return { hazards: [], debug }; }
    const j = await r.json();
    const features = Array.isArray(j.features) ? j.features : [];
    debug.rawCount = features.length;
    const hazards = features
      .map((f) => {
        const p = f.properties || {};
        const cat = categorizeHazard(p.event);
        return {
          id: String(p.id || f.id || ''),
          event: p.event || 'Alerta',
          headline: p.headline || p.event || '',
          severity: p.severity || 'Unknown',
          areaDesc: p.areaDesc || '',
          expires: p.expires || null,
          category: cat.key,
          emoji: cat.emoji,
          label: cat.label,
          color: cat.color,
          geometry: f.geometry || null,
        };
      })
      // Sin geometría no hay forma confiable de saber si nos toca ni qué
      // pintar en el mapa — se descarta esa alerta (NWS no siempre la manda,
      // es una limitación conocida de esta primera versión).
      .filter((h) => h.id && h.geometry);
    debug.parsedCount = hazards.length;
    debug.ok = true;
    if (features.length && !hazards.length) {
      debug.error = 'Trajo ' + features.length + ' alertas pero ninguna con geometría/id usable — primera cruda: ' + JSON.stringify(features[0]).slice(0, 400);
    }
    return { hazards, debug };
  } catch (e) {
    debug.error = e.message;
    console.error('fetchActiveHazards:', e.message);
    return { hazards: [], debug };
  }
}

// Puntos contra los que se mide si una alerta nos toca: cada parada del
// itinerario (visitada o todavía por venir) más la ubicación en vivo de cada
// quien y la del carro, si son recientes.
function gatherRouteWatchPoints() {
  const points = [];
  Object.values(itinStore).forEach((day) => {
    (day.acts || []).forEach((a) => {
      if (Array.isArray(a.c) && a.c.length === 2) {
        points.push({ lat: a.c[0], lon: a.c[1], label: a.n || day.city || 'itinerario' });
      }
    });
  });
  const freshMs = 2 * 60 * 60 * 1000;
  Object.entries(liveLocStore).forEach(([who, loc]) => {
    if (loc && Date.now() - loc.ts < freshMs) points.push({ lat: loc.lat, lon: loc.lon, label: who + ' ahorita' });
  });
  if (carLoc && Date.now() - carLoc.ts < freshMs) points.push({ lat: carLoc.lat, lon: carLoc.lon, label: 'el carro' });
  return points;
}

// Una alerta puede no tocar ninguna parada puntual y aun así cubrir la
// carretera que conecta dos paradas seguidas — esos tramos (en el orden real
// del itinerario: día, luego actividad dentro del día) también cuentan.
function gatherRouteSegments() {
  const dayKeys = Object.keys(itinStore).map((k) => parseInt(k, 10)).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  const ordered = [];
  dayKeys.forEach((k) => {
    const day = itinStore[String(k)];
    (day.acts || []).forEach((a) => {
      if (Array.isArray(a.c) && a.c.length === 2) ordered.push({ lat: a.c[0], lon: a.c[1], label: a.n || day.city || 'itinerario' });
    });
  });
  const segments = [];
  for (let i = 0; i < ordered.length - 1; i++) segments.push({ a: ordered[i], b: ordered[i + 1] });
  return segments;
}

async function checkHazardAlerts() {
  const points = gatherRouteWatchPoints();
  const segments = gatherRouteSegments();
  hazardStore.debug = { pointsCount: points.length, segmentsCount: segments.length };
  if (!points.length && !segments.length) {
    hazardStore.debug.error = 'No hay ni una parada del itinerario con coordenada, ni ubicación en vivo, ni carro — nada contra qué revisar.';
    hazardStore.nearby = []; hazardStore.lastCheck = Date.now(); persistHazard(); return;
  }
  const { hazards, debug } = await fetchActiveHazards();
  hazardStore.debug = Object.assign(hazardStore.debug, debug);
  const nearby = [];
  for (const hz of hazards) {
    // ¿Algún punto vigilado cae DENTRO del polígono de la alerta?
    let matchLabel = (points.find((p) => pointInGeometry(p.lat, p.lon, hz.geometry)) || {}).label || null;
    // Si no, ¿algún tramo de carretera pasa por el polígono? (muestreado)
    if (!matchLabel) {
      for (const seg of segments) {
        let hit = pointInGeometry(seg.a.lat, seg.a.lon, hz.geometry);
        for (let i = 1; i <= 20 && !hit; i++) {
          const t = i / 20;
          hit = pointInGeometry(seg.a.lat + (seg.b.lat - seg.a.lat) * t, seg.a.lon + (seg.b.lon - seg.a.lon) * t, hz.geometry);
        }
        if (hit) { matchLabel = 'la carretera hacia ' + seg.b.label; break; }
      }
    }
    if (matchLabel) {
      nearby.push({ ...hz, nearLabel: matchLabel, polygons: geometryToLatLngPolygons(hz.geometry) });
      if (!hazardStore.notifiedIds.includes(hz.id)) {
        hazardStore.notifiedIds.push(hz.id);
        await sendPushToAll({
          title: hz.emoji + ' ' + hz.label + ' cerca de ' + matchLabel,
          body: hz.headline || hz.event,
        });
      }
    }
  }
  hazardStore.debug.checkedCount = hazards.length;
  hazardStore.debug.matchedCount = nearby.length;
  // Si una alerta ya no toca la ruta (expiró, se movió, o nos alejamos), se
  // olvida — así si vuelve a tocar se avisa de nuevo.
  hazardStore.notifiedIds = hazardStore.notifiedIds.filter((id) => nearby.some((h) => h.id === id));
  hazardStore.nearby = nearby;
  hazardStore.lastCheck = Date.now();
  persistHazard();
}

app.get('/api/hazard-alerts', (req, res) => {
  res.json({ nearby: hazardStore.nearby, lastCheck: hazardStore.lastCheck });
});

// Revisión manual (botón de admin) — regresa el diagnóstico completo para
// poder ver EN PRODUCCIÓN, sin adivinarle, si NWS respondió bien, cuántas
// alertas trajo crudo, y cuántas de verdad tocan la ruta.
app.post('/api/hazard-alerts/check', async (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  await checkHazardAlerts();
  res.json({ ok: true, nearby: hazardStore.nearby, debug: hazardStore.debug });
});

// Primer chequeo a los pocos segundos de arrancar (no hay que esperar el
// intervalo completo tras cada redeploy), y luego cada 20 min — el clima
// cambia más rápido que un incendio ya andando.
setTimeout(() => { checkHazardAlerts().catch((e) => console.error('checkHazardAlerts:', e.message)); }, 15000);
cron.schedule('*/20 * * * *', () => {
  checkHazardAlerts().catch((e) => console.error('checkHazardAlerts:', e.message));
});

// ── Reservaciones (con horario, fecha y ubicación) ─────────────────────────
// Combina las que salen del itinerario (auto-sembradas por el cliente, ya
// que el server no interpreta el arreglo DAYS del front) con las que agregue
// cualquiera manualmente. Compartidas entre todos.
const RES_FILE = path.join(DATA_DIR, 'reservations.json');
let resStore = [];
try { resStore = JSON.parse(fs.readFileSync(RES_FILE, 'utf8')); } catch (e) {}
function persistRes() {
  try { fs.writeFileSync(RES_FILE, JSON.stringify(resStore)); } catch (e) {}
}

app.get('/api/reservations', (req, res) => res.json(resStore));

app.post('/api/reservations', (req, res) => {
  const { id, title, date, time, location, cost, notes, done, source, who } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'missing fields' });
  const idx = resStore.findIndex((r) => r.id === id);
  const isNewCustom = idx === -1 && (source || 'custom') === 'custom';
  if (isNewCustom && who !== ADMIN_NAME) {
    return res.status(403).json({ error: 'solo el admin puede agregar reservaciones' });
  }
  const item = {
    id: id || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title, date,
    time: time || '',
    location: location || '',
    cost: cost || '',
    notes: notes || '',
    done: !!done,
    source: source || 'custom',
    ts: Date.now()
  };
  if (idx === -1) resStore.push(item);
  else resStore[idx] = Object.assign({}, resStore[idx], item, { ts: resStore[idx].ts });
  persistRes();
  res.json({ ok: true, item });
});

app.delete('/api/reservations/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (who !== ADMIN_NAME) return res.status(403).json({ error: 'not authorized' });
  const idx = resStore.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  resStore.splice(idx, 1);
  persistRes();
  res.json({ ok: true });
});

// ── Push diario 10am — cuenta regresiva al viaje + recordatorio de reservas ─
cron.schedule('0 10 * * *', async () => {
  const tripStart = new Date('2026-09-02T00:00:00-06:00');
  const now = new Date();
  if (now < tripStart) {
    const dLeft = Math.ceil((tripStart - now) / (1000 * 60 * 60 * 24));
    await sendPushToAll({
      title: 'Alta Vibra · California 2026',
      body: `Faltan ${dLeft} día${dLeft === 1 ? '' : 's'} para tu viaje`
    });
  }

  const soonMs = 5 * 24 * 60 * 60 * 1000;
  const pending = resStore.filter((r) => {
    if (r.done) return false;
    const d = new Date(r.date + 'T12:00:00-06:00');
    const diff = d - now;
    return diff > -12 * 60 * 60 * 1000 && diff <= soonMs;
  });
  if (pending.length) {
    const names = pending.map((r) => r.title).join(', ');
    await sendPushToAll({
      title: 'Alta Vibra · Reservaciones pendientes',
      body: `Faltan pocos días para: ${names}. ¡Resérvalo antes de que se ocupe!`
    });
  }
}, { timezone: 'America/Mexico_City' });

app.listen(PORT, () => console.log(`Alta Vibra · puerto ${PORT}`));
