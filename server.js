const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Eduardo';

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

// ── Almacenamiento simple de suscripciones (archivo JSON) ──────────────────
const DATA_DIR = path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

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

async function sendPushToAll(payload) {
  const subs = loadSubs();
  const remaining = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      remaining.push(sub);
    } catch (err) {
      if (err.statusCode !== 404 && err.statusCode !== 410) {
        remaining.push(sub);
        console.error('Push error:', err.message);
      }
      // 404/410 = suscripción vencida/eliminada por el navegador, se descarta
    }
  }
  saveSubs(remaining);
  return subs.length;
}

app.post('/api/send-test', async (req, res) => {
  const count = await sendPushToAll({
    title: 'Alta Vibra · California 2026',
    body: 'Esta es una notificación de prueba 🎉'
  });
  res.json({ ok: true, sent: count });
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
  const idx = expStore.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  expStore.splice(idx, 1);
  persistExp();
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
  profStore[idx] = {
    birth: data.birth || '',
    address: data.address || '',
    ecName: data.ecName || '',
    ecPhone: data.ecPhone || '',
  };
  persistProf();
  res.json({ ok: true });
});

// ── Traductor ──────────────────────────────────────────────────────────────
// Se proxea por aquí en vez de llamar desde el navegador: evita problemas de
// CORS y permite tener un segundo proveedor de respaldo si el primero falla o
// cambia de dominio (como ya nos pasó con la API de tipo de cambio).
const TRANSLATE_EMAIL = process.env.TRANSLATE_EMAIL || '';

async function tryMyMemory(text, from, to) {
  let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent(from + '|' + to);
  if (TRANSLATE_EMAIL) url += '&de=' + encodeURIComponent(TRANSLATE_EMAIL);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

  const providers = [['mymemory', tryMyMemory], ['google', tryGoogleGtx]];
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
let geoQueue = Promise.resolve();
let geoLastCall = 0;
// Encola para respetar el límite de 1 req/seg de Nominatim
function geoThrottle(fn) {
  const run = async () => {
    const wait = Math.max(0, 1100 - (Date.now() - geoLastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    geoLastCall = Date.now();
    return fn();
  };
  geoQueue = geoQueue.then(run, run);
  return geoQueue;
}

function coordsFromMapsUrl(url) {
  if (!url) return null;
  const pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,          // formato interno de place
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,              // /maps/place/.../@lat,lon,17z
    /[?&](?:q|query|daddr|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
  ];
  for (const p of pats) {
    const m = url.match(p);
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
    }
  }
  return null;
}

async function resolveMapsUrl(url) {
  const direct = coordsFromMapsUrl(url);
  if (direct) return direct;
  // Los links cortos (maps.app.goo.gl) no traen coordenadas: hay que seguir
  // la redirección para llegar a la URL larga que sí las tiene.
  if (!/goo\.gl|maps\.app/.test(url)) return null;
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': GEO_UA },
      signal: AbortSignal.timeout(9000),
    });
    return coordsFromMapsUrl(r.url) || coordsFromMapsUrl(await r.text());
  } catch (e) { return null; }
}

async function geocodeName(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': GEO_UA, 'Accept-Language': 'es,en' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  const lat = parseFloat(j[0].lat), lon = parseFloat(j[0].lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return [lat, lon];
}

app.post('/api/geocode', async (req, res) => {
  const { name, city, mapsUrl } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 160) : '';
  const cleanCity = typeof city === 'string' ? city.trim().slice(0, 120) : '';
  if (!cleanName && !mapsUrl) return res.status(400).json({ error: 'missing name' });

  // El link de Maps es más preciso que buscar por nombre
  if (typeof mapsUrl === 'string' && /^https?:\/\//.test(mapsUrl)) {
    const key = 'url:' + mapsUrl;
    if (geoCache[key]) return res.json({ c: geoCache[key], source: 'maps', cached: true });
    const c = await geoThrottle(() => resolveMapsUrl(mapsUrl));
    if (c) { geoCache[key] = c; persistGeo(); return res.json({ c, source: 'maps' }); }
  }

  if (!cleanName) return res.status(404).json({ error: 'not found' });

  // Se le pega la ciudad del día como contexto: "Beverly Hills" solo es
  // ambiguo, "Beverly Hills, Los Ángeles" no.
  const cityCtx = cleanCity && cleanCity !== 'Por definir'
    ? cleanCity.split('→')[0].split('—')[0].trim() : '';
  const queries = [];
  if (cityCtx) queries.push(cleanName + ', ' + cityCtx + ', California, USA');
  queries.push(cleanName + ', California, USA');

  for (const q of queries) {
    const key = 'q:' + q.toLowerCase();
    if (geoCache[key]) return res.json({ c: geoCache[key], source: 'nominatim', cached: true });
    try {
      const c = await geoThrottle(() => geocodeName(q));
      if (c) { geoCache[key] = c; persistGeo(); return res.json({ c, source: 'nominatim', q }); }
    } catch (e) { /* se intenta la siguiente variante */ }
  }
  res.status(404).json({ error: 'not found' });
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
      }
      return out;
    });
  }
  itinStore[i] = entry;
  persistItin();
  res.json({ ok: true, entry });
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
