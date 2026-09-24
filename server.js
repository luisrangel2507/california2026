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
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Viajes ─────────────────────────────────────────────────────────────────
// Antes había un solo viaje (California 2026) con todo en DATA_DIR/*.json.
// Ahora cualquier grupo puede crear el suyo: cada viaje vive en
// DATA_DIR/trips/<id>/ con los mismos archivos de siempre, más trip.json con
// su configuración (nombre, fechas, viajeros, ruta, presupuesto) y su código
// de invitación. Todo lo que es "del viaje" (gastos, itinerario, fotos...)
// exige el código en cada petición (headers X-Trip / X-Trip-Code).
//
// California 2026 queda como viaje de ejemplo: cualquiera puede ver su
// itinerario, ruta y presupuesto (no gastos, perfiles ni ubicaciones) y
// usarlo como plantilla para armar el suyo.
const TRIPS_DIR = path.join(DATA_DIR, 'trips');
if (!fs.existsSync(TRIPS_DIR)) fs.mkdirSync(TRIPS_DIR, { recursive: true });

const SAMPLE_TRIP_ID = 'california2026';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I, que se confunden
function newCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
function newId() {
  return crypto.randomBytes(6).toString('hex');
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function genId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

class Trip {
  constructor(id, meta) {
    this.id = id;
    this.dir = path.join(TRIPS_DIR, id);
    this.meta = meta;       // { code, viewerToken, sample, created, cfg }
    this.stores = {};       // caché en memoria de cada archivo del viaje
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  get(name, def) {
    if (!(name in this.stores)) {
      try { this.stores[name] = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
      catch (e) { this.stores[name] = def; }
      if (this.stores[name] === undefined) this.stores[name] = def;
    }
    return this.stores[name];
  }
  set(name, value) {
    this.stores[name] = value;
    this.save(name);
  }
  save(name) {
    try { fs.writeFileSync(this.file(name), JSON.stringify(this.stores[name])); }
    catch (e) { console.error('No se pudo guardar', this.id, name, e.message); }
  }
  saveMeta() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'trip.json'), JSON.stringify(this.meta, null, 2));
  }
  get cfg() { return this.meta.cfg; }
  isAdmin(who) { return typeof who === 'string' && who === this.meta.cfg.admin; }
  // Lo que ve alguien que ya es parte del viaje (incluye el código para
  // poder invitar a más gente).
  memberView() {
    return Object.assign({ id: this.id, code: this.meta.code, sample: !!this.meta.sample }, this.meta.cfg);
  }
}

const trips = new Map();        // id -> Trip
const viewerIndex = new Map();  // viewerToken -> id
const codeIndex = new Map();    // code -> id

function indexTrip(t) {
  trips.set(t.id, t);
  if (t.meta.viewerToken) viewerIndex.set(t.meta.viewerToken, t.id);
  if (t.meta.code) codeIndex.set(t.meta.code, t.id);
}
function unindexTrip(t) {
  if (t.meta.viewerToken) viewerIndex.delete(t.meta.viewerToken);
  if (t.meta.code) codeIndex.delete(t.meta.code);
}
function uniqueCode() {
  let c;
  do { c = newCode(); } while (codeIndex.has(c));
  return c;
}

// ── Validación de la configuración de un viaje ─────────────────────────────
const MAX_PERSONS = 12;
const MAX_DAYS = 60;
function cleanStr(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function cleanNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function cleanPersons(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach((p) => {
    const n = cleanStr(p, 30);
    if (n && !out.includes(n)) out.push(n);
  });
  return out.slice(0, MAX_PERSONS);
}
function cleanCheckpoints(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).map((c) => {
    const out = {
      label: cleanStr(c && c.label, 60) || 'Parada',
      emoji: cleanStr(c && c.emoji, 8) || '📍',
      km: cleanNum(c && c.km),
      carH: cleanNum(c && c.carH),
      day: Math.max(1, parseInt(c && c.day, 10) || 1),
    };
    if (c && Array.isArray(c.c) && c.c.length === 2 &&
        Number.isFinite(c.c[0]) && Number.isFinite(c.c[1])) out.c = [c.c[0], c.c[1]];
    return out;
  }).filter((c) => c.c);
}
function cleanBudget(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).map((b) => ({
    e: cleanStr(b && b.e, 8) || '💵',
    n: cleanStr(b && b.n, 80),
    t: cleanNum(b && b.t),
    p: cleanNum(b && b.p),
  })).filter((b) => b.n);
}

// Aplica sobre `prev` solo los campos válidos que vengan en `input`.
// Devuelve { cfg } o { error }.
function mergeCfg(prev, input) {
  const cfg = Object.assign({}, prev);
  if (input.name !== undefined) {
    const n = cleanStr(input.name, 60);
    if (!n) return { error: 'El viaje necesita un nombre' };
    cfg.name = n;
  }
  if (input.subtitle !== undefined) cfg.subtitle = cleanStr(input.subtitle, 80);
  if (input.start !== undefined) {
    if (!isValidDateStr(input.start)) return { error: 'Fecha de inicio inválida' };
    cfg.start = input.start;
  }
  if (input.days !== undefined) {
    const d = parseInt(input.days, 10);
    if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) return { error: 'El viaje debe durar entre 1 y ' + MAX_DAYS + ' días' };
    cfg.days = d;
  }
  if (input.persons !== undefined) {
    const p = cleanPersons(input.persons);
    if (!p || !p.length) return { error: 'Falta al menos un viajero' };
    // Los perfiles, gastos y PINs van por posición: no se puede quitar ni
    // reordenar a nadie, solo renombrar o agregar al final.
    if (prev.persons && p.length < prev.persons.length) return { error: 'No se puede quitar a nadie del viaje' };
    cfg.persons = p;
  }
  if (input.admin !== undefined) cfg.admin = cleanStr(input.admin, 30);
  if (input.checkpoints !== undefined) cfg.checkpoints = cleanCheckpoints(input.checkpoints);
  if (input.budget !== undefined) cfg.budget = cleanBudget(input.budget);
  if (!cfg.persons || !cfg.persons.includes(cfg.admin)) cfg.admin = cfg.persons ? cfg.persons[0] : '';
  return { cfg };
}

function createTrip(cfg, opts = {}) {
  const id = opts.id || newId();
  const t = new Trip(id, {
    code: opts.code || uniqueCode(),
    viewerToken: opts.viewerToken || crypto.randomBytes(24).toString('hex'),
    sample: !!opts.sample,
    created: Date.now(),
    cfg,
  });
  t.saveMeta();
  indexTrip(t);
  return t;
}

// Carga todos los viajes existentes al arrancar
fs.readdirSync(TRIPS_DIR, { withFileTypes: true }).forEach((ent) => {
  if (!ent.isDirectory()) return;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(TRIPS_DIR, ent.name, 'trip.json'), 'utf8'));
    indexTrip(new Trip(ent.name, meta));
  } catch (e) {
    console.error('Viaje ilegible, se ignora:', ent.name, e.message);
  }
});

// ── Migración: el viaje original (California 2026) ─────────────────────────
// Se copian los archivos que estaban sueltos en DATA_DIR a su carpeta de
// viaje. Los originales se dejan donde estaban (no se borra nada), por si
// hay que volver atrás.
const SAMPLE_CFG = {
  name: 'California 2026',
  subtitle: 'PCH Road Trip',
  start: '2026-09-02',
  days: 9,
  persons: ['Erick', 'Rafa', 'Eduardo'],
  admin: ADMIN_NAME,
  checkpoints: [
    { label: 'Tijuana CBX', emoji: '🛃', km: 0, carH: 0, day: 1, c: [32.5430, -117.0320] },
    { label: 'San Diego', emoji: '🏖️', km: 32, carH: 0.5, day: 1, c: [32.7626, -117.1869] },
    { label: 'Coronado', emoji: '⛴️', km: 48, carH: 0.8, day: 1, c: [32.6860, -117.1831] },
    { label: 'La Jolla', emoji: '🦭', km: 80, carH: 1.3, day: 2, c: [32.8501, -117.2726] },
    { label: 'Sunset Cliffs', emoji: '🌅', km: 95, carH: 1.6, day: 2, c: [32.7207, -117.2556] },
    { label: 'Palos Verdes / LA', emoji: '🌄', km: 240, carH: 3.8, day: 3, c: [33.7436, -118.4102] },
    { label: 'Santa Monica', emoji: '🎡', km: 295, carH: 4.7, day: 3, c: [34.0092, -118.4975] },
    { label: 'Hollywood', emoji: '⭐', km: 310, carH: 4.9, day: 4, c: [34.1016, -118.3267] },
    { label: 'Malibu', emoji: '🏖️', km: 340, carH: 5.5, day: 5, c: [34.0286, -118.8734] },
    { label: 'Santa Barbara', emoji: '⚓', km: 460, carH: 7.0, day: 5, c: [34.4208, -119.6982] },
    { label: 'Morro Bay', emoji: '🌊', km: 600, carH: 8.8, day: 5, c: [35.3658, -120.8496] },
    { label: 'Ragged Point', emoji: '🏨', km: 685, carH: 10.2, day: 5, c: [35.7937, -121.3330] },
    { label: 'McWay Falls / Big Sur', emoji: '🏞️', km: 730, carH: 11.0, day: 6, c: [36.1578, -121.6720] },
    { label: 'Bixby Bridge', emoji: '🌉', km: 775, carH: 11.8, day: 6, c: [36.3726, -121.9018] },
    { label: 'Monterey', emoji: '🦭', km: 850, carH: 13.0, day: 6, c: [36.5849, -121.9020] },
    { label: 'San Francisco', emoji: '🌁', km: 1040, carH: 15.0, day: 7, c: [37.7749, -122.4194] },
    { label: 'San Diego ↩', emoji: '🏁', km: 1920, carH: 23.0, day: 9, c: [32.7157, -117.1611] },
  ],
  budget: [
    { e: '✈️', n: 'Vuelos QRO → TIJ + CBX', t: 5700, p: 1900 },
    { e: '🚗', n: 'Renta Toyota Camry (10 días)', t: 8000, p: 2666.67 },
    { e: '🏨', n: 'San Diego — Days Inn (2 noches)', t: 2234.56, p: 744.85 },
    { e: '🏨', n: 'Los Ángeles — Torrance (3 noches)', t: 10043.79, p: 3347.93 },
    { e: '🏖️', n: 'Pismo Beach (1 noche)', t: 3429.75, p: 1143.25 },
    { e: '🏨', n: 'Monterey Bay Lodge (1 noche)', t: 4569, p: 1523 },
    { e: '🌉', n: 'San Francisco — Suite (2 noches)', t: 10870, p: 3623.33 },
    { e: '🏨', n: 'San Diego regreso (1 noche)', t: 2200, p: 733.33 },
    { e: '🍽️', n: 'Comida (estimado)', t: 19950, p: 6650 },
    { e: '⛽', n: 'Gasolina', t: 3342.50, p: 1114.17 },
    { e: '⛴️', n: 'Ferry Coronado (i/v)', t: 945, p: 315 },
    { e: '⛴️', n: 'Ferry atardecer SF', t: 3000, p: 1000 },
    { e: '🐋', n: 'Avistamiento de ballenas', t: 3300, p: 1100 },
  ],
};
if (!SAMPLE_CFG.persons.includes(SAMPLE_CFG.admin)) SAMPLE_CFG.persons.push(SAMPLE_CFG.admin);

if (!trips.has(SAMPLE_TRIP_ID)) {
  let legacyViewer = null;
  try { legacyViewer = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'viewer.json'), 'utf8')).token; } catch (e) {}
  const t = createTrip(SAMPLE_CFG, {
    id: SAMPLE_TRIP_ID,
    sample: true,
    code: process.env.SAMPLE_TRIP_CODE ? String(process.env.SAMPLE_TRIP_CODE).toUpperCase() : undefined,
    viewerToken: legacyViewer || undefined,
  });
  ['memory', 'expenses', 'settlements', 'profiles', 'itinerary', 'live-locations', 'car',
   'reservations', 'countdown-phrases', 'subscriptions'].forEach((name) => {
    const src = path.join(DATA_DIR, name + '.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, t.file(name));
  });
  console.log('Viaje "' + SAMPLE_CFG.name + '" migrado a ' + t.dir);
}
{
  // SAMPLE_TRIP_CODE permite fijar (o cambiar) el código del viaje original
  // desde Railway sin tocar archivos.
  const t = trips.get(SAMPLE_TRIP_ID);
  const envCode = process.env.SAMPLE_TRIP_CODE && String(process.env.SAMPLE_TRIP_CODE).toUpperCase();
  if (envCode && envCode !== t.meta.code) {
    unindexTrip(t);
    t.meta.code = envCode;
    t.saveMeta();
    indexTrip(t);
  }
  console.log('Código de invitación de "' + t.cfg.name + '": ' + t.meta.code);
}

// ── Límite de intentos por IP (crear viajes / adivinar códigos) ────────────
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; rateBuckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => {
  const now = Date.now();
  rateBuckets.forEach((b, k) => { if (now - b.start > 60 * 60 * 1000) rateBuckets.delete(k); });
}, 10 * 60 * 1000).unref();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ── Autenticación por viaje ────────────────────────────────────────────────
// Los miembros mandan X-Trip + X-Trip-Code en cada petición. La página de
// "seguir en vivo" (familia/amigos) manda X-Viewer con su token y solo
// puede LEER lo poquito que esa página muestra.
const VIEWER_READABLE = new Set(['/api/itinerary', '/api/live-locations', '/api/public-contacts', '/api/memory']);
function tripAuth(req, res, next) {
  const id = String(req.get('X-Trip') || '');
  const code = String(req.get('X-Trip-Code') || '').toUpperCase();
  const t = trips.get(id);
  if (t && code && safeEqual(code, t.meta.code)) {
    req.trip = t;
    return next();
  }
  const vt = String(req.get('X-Viewer') || '');
  if (vt && req.method === 'GET') {
    const vid = viewerIndex.get(vt);
    const p = req.originalUrl.split('?')[0];
    if (vid && VIEWER_READABLE.has(p)) {
      req.trip = trips.get(vid);
      req.viewer = true;
      return next();
    }
  }
  // Solo se marca "viaje inválido" si mandaron credenciales de viaje — así
  // el cliente sabe que debe volver a la pantalla de inicio.
  if (id) res.set('X-Trip-Invalid', '1');
  res.status(401).json({ error: 'trip' });
}
app.use([
  '/api/trip', '/api/subscribe', '/api/send-test', '/api/countdown-phrases',
  '/api/memory', '/api/expenses', '/api/settlements', '/api/profiles',
  '/api/public-contacts', '/api/itinerary', '/api/live-locations',
  '/api/viewer-token', '/api/car', '/api/reservations',
], tripAuth);

// Crear un viaje nuevo. Quien lo crea queda como admin (primer viajero).
// Si trae `template`, se copian itinerario, ruta, presupuesto y
// reservaciones de un viaje de ejemplo, recorriendo las fechas.
app.post('/api/trips', (req, res) => {
  if (!rateLimit('create:' + clientIp(req), 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados viajes creados, intenta más tarde' });
  }
  const body = req.body || {};
  const creator = cleanStr(body.me, 30);
  if (!creator) return res.status(400).json({ error: 'Falta tu nombre' });
  const others = Array.isArray(body.persons) ? body.persons : [];
  const tpl = body.template ? trips.get(String(body.template)) : null;
  if (body.template && (!tpl || !tpl.meta.sample)) return res.status(400).json({ error: 'Plantilla no encontrada' });

  const base = {
    name: '', subtitle: '', start: '', days: 1, persons: null, admin: creator,
    checkpoints: tpl ? tpl.cfg.checkpoints : [],
    budget: tpl ? tpl.cfg.budget : [],
  };
  const r = mergeCfg(base, {
    name: body.name || '',
    subtitle: body.subtitle || '',
    start: body.start || '',
    days: body.days !== undefined ? body.days : (tpl ? tpl.cfg.days : 1),
    persons: [creator].concat(others),
    admin: creator,
  });
  if (r.error) return res.status(400).json({ error: r.error });
  const t = createTrip(r.cfg);

  if (tpl) {
    const itin = tpl.get('itinerary', {});
    const copy = {};
    Object.keys(itin).forEach((k) => { if (parseInt(k, 10) < t.cfg.days) copy[k] = itin[k]; });
    t.set('itinerary', JSON.parse(JSON.stringify(copy)));
    const shiftMs = new Date(t.cfg.start + 'T12:00:00Z') - new Date(tpl.cfg.start + 'T12:00:00Z');
    const resv = tpl.get('reservations', []).map((x) => {
      const d = new Date(x.date + 'T12:00:00Z');
      const date = isNaN(d) ? x.date : new Date(d.getTime() + shiftMs).toISOString().slice(0, 10);
      return Object.assign({}, x, { date, done: false, ts: Date.now() });
    });
    t.set('reservations', resv);
  }
  res.json({ ok: true, trip: t.memberView() });
});

// Unirse con el código de invitación. `name` opcional: si esa persona no
// está en la lista del viaje, se agrega al final.
app.post('/api/trips/join', (req, res) => {
  if (!rateLimit('join:' + clientIp(req), 30, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos, espera unos minutos' });
  }
  const code = cleanStr((req.body || {}).code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = codeIndex.get(code);
  const t = id && trips.get(id);
  if (!t) return res.status(404).json({ error: 'No existe un viaje con ese código' });
  const name = cleanStr((req.body || {}).name, 30);
  if (name && !t.cfg.persons.includes(name)) {
    if (t.cfg.persons.length >= MAX_PERSONS) return res.status(400).json({ error: 'El viaje ya está lleno' });
    t.meta.cfg = Object.assign({}, t.cfg, { persons: t.cfg.persons.concat([name]) });
    t.saveMeta();
  }
  res.json({ ok: true, trip: t.memberView() });
});

// Los teléfonos que ya usaban la app antes de que existieran los viajes no
// tienen el código guardado: se les da acceso al viaje original de una vez
// para que no se queden fuera. LEGACY_JOIN=off lo apaga.
app.post('/api/trips/legacy-join', (req, res) => {
  if (String(process.env.LEGACY_JOIN || '').toLowerCase() === 'off') {
    return res.status(403).json({ error: 'off' });
  }
  if (!rateLimit('legacy:' + clientIp(req), 10, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos' });
  }
  res.json({ ok: true, trip: trips.get(SAMPLE_TRIP_ID).memberView() });
});

// Viajes de ejemplo — públicos, para inspirarse o usarlos de plantilla.
// Solo lo que sirve como sugerencia: nada de gastos, perfiles, fotos ni
// ubicaciones, y tampoco los nombres de quienes viajaron.
function exampleView(t, full) {
  const out = {
    id: t.id,
    name: t.cfg.name,
    subtitle: t.cfg.subtitle || '',
    start: t.cfg.start,
    days: t.cfg.days,
    travelers: t.cfg.persons.length,
    stops: t.cfg.checkpoints.length,
  };
  if (full) {
    out.checkpoints = t.cfg.checkpoints;
    out.budget = t.cfg.budget;
    out.itinerary = t.get('itinerary', {});
    out.reservations = t.get('reservations', []).map((r) => ({
      title: r.title, date: r.date, time: r.time || '', location: r.location || '', cost: r.cost || '', notes: r.notes || '',
    }));
  }
  return out;
}
app.get('/api/examples', (req, res) => {
  const list = [];
  trips.forEach((t) => { if (t.meta.sample) list.push(exampleView(t, false)); });
  res.json(list);
});
app.get('/api/examples/:id', (req, res) => {
  const t = trips.get(req.params.id);
  if (!t || !t.meta.sample) return res.status(404).json({ error: 'not found' });
  res.json(exampleView(t, true));
});

// Configuración del viaje actual
app.get('/api/trip', (req, res) => res.json(req.trip.memberView()));

// Editar el viaje. Solo el admin cambia nombre, fechas, ruta y presupuesto;
// cualquiera del grupo puede agregar gente o corregir un nombre (igual que
// antes, que la lista de nombres se podía editar desde Presupuesto).
app.patch('/api/trip', (req, res) => {
  const t = req.trip;
  const body = req.body || {};
  const admin = t.isAdmin(body.who);
  const input = {};
  ['name', 'subtitle', 'start', 'days', 'checkpoints', 'budget', 'admin'].forEach((k) => {
    if (body[k] !== undefined) input[k] = body[k];
  });
  if (Object.keys(input).length && !admin) {
    return res.status(403).json({ error: 'Solo el admin puede cambiar los datos del viaje' });
  }
  if (body.persons !== undefined) input.persons = body.persons;
  // Si el admin se cambia el nombre, sigue siendo admin
  if (input.persons && input.admin === undefined) {
    const ai = t.cfg.persons.indexOf(t.cfg.admin);
    const np = cleanPersons(input.persons);
    if (ai !== -1 && np && np[ai]) input.admin = np[ai];
  }
  const r = mergeCfg(t.cfg, input);
  if (r.error) return res.status(400).json({ error: r.error });
  t.meta.cfg = r.cfg;
  t.saveMeta();
  res.json({ ok: true, trip: t.memberView() });
});

// El admin puede cambiar el código de invitación (el anterior deja de
// servir; quien ya estaba adentro tendrá que volver a entrar con el nuevo).
app.post('/api/trip/code', (req, res) => {
  const t = req.trip;
  if (!t.isAdmin((req.body || {}).who)) return res.status(403).json({ error: 'not authorized' });
  unindexTrip(t);
  t.meta.code = uniqueCode();
  t.saveMeta();
  indexTrip(t);
  res.json({ ok: true, trip: t.memberView() });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const subs = req.trip.get('subscriptions', []);
  if (!subs.find((s) => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    req.trip.save('subscriptions');
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
async function sendPushToAll(trip, payload) {
  const subs = trip.get('subscriptions', []);
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
  trip.set('subscriptions', remaining);
  return { total: subs.length, ok, errors };
}

app.post('/api/send-test', async (req, res) => {
  const result = await sendPushToAll(req.trip, {
    title: 'Alta Vibra Travel · ' + req.trip.cfg.name,
    body: 'Esta es una notificación de prueba 🎉'
  });
  res.json({ ok: true, sent: result.ok, total: result.total, errors: result.errors });
});

// ── Frases de la cuenta regresiva pre-viaje (editables por el admin,
// una lista distinta por persona — { "Erick": [...], "Rafa": [...], ... }) ──
function loadCountdownPhrases(trip) {
  const data = trip.get('countdown-phrases', {});
  // Versión vieja guardaba un arreglo plano compartido entre todos — se
  // descarta en vez de migrarlo mal, son solo frases de relleno.
  return (data && !Array.isArray(data) && typeof data === 'object') ? data : {};
}

app.get('/api/countdown-phrases', (req, res) => {
  res.json({ phrases: loadCountdownPhrases(req.trip) });
});

app.post('/api/countdown-phrases', (req, res) => {
  const { person, phrases, who } = req.body || {};
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  if (typeof person !== 'string' || !person) return res.status(400).json({ error: 'missing fields' });
  if (!Array.isArray(phrases)) return res.status(400).json({ error: 'missing fields' });
  const clean = phrases
    .map((p) => (typeof p === 'string' ? p.trim().slice(0, 200) : ''))
    .filter(Boolean)
    .slice(0, 40);
  const store = loadCountdownPhrases(req.trip);
  store[person] = clean;
  req.trip.set('countdown-phrases', store);
  res.json({ ok: true, phrases: store });
});

// ── Fotos compartidas por actividad ────────────────────────────────────────
app.get('/api/memory', (req, res) => {
  const memStore = req.trip.get('memory', {});
  if (!req.viewer) return res.json(memStore);
  // Familia/amigos solo ven las fotos que nadie ocultó
  const out = {};
  Object.keys(memStore).forEach((k) => {
    const list = (memStore[k] || []).filter((p) => p.fam !== false);
    if (list.length) out[k] = list;
  });
  res.json(out);
});

app.post('/api/memory', (req, res) => {
  const { actKey, photo, who } = req.body;
  if (!actKey || !photo) return res.status(400).json({ error: 'missing fields' });
  const memStore = req.trip.get('memory', {});
  if (!memStore[actKey]) memStore[actKey] = [];
  const id = genId();
  memStore[actKey].push({ id, photo, who: who || '?', ts: Date.now() });
  req.trip.save('memory');
  res.json({ ok: true, id });
});

app.delete('/api/memory/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const memStore = req.trip.get('memory', {});
  const { id } = req.params;
  let found = false;
  Object.keys(memStore).forEach(key => {
    const idx = memStore[key].findIndex(p => p.id === id);
    if (idx !== -1) { memStore[key].splice(idx, 1); found = true; }
  });
  if (found) { req.trip.save('memory'); res.json({ ok: true }); }
  else res.status(404).json({ error: 'not found' });
});

// Por default toda foto es visible para familia/amigos (fam===false es lo
// único que se guarda) — así ninguna de las que ya se subieron cambia de
// estado con este cambio. Cualquiera del grupo puede ocultar una foto
// puntual, sin necesidad de ser admin, igual que subirlas.
app.post('/api/memory/:id/visibility', (req, res) => {
  const { fam } = req.body;
  if (typeof fam !== 'boolean') return res.status(400).json({ error: 'missing fields' });
  const memStore = req.trip.get('memory', {});
  const { id } = req.params;
  let found = null;
  Object.keys(memStore).forEach(key => {
    const p = memStore[key].find((p) => p.id === id);
    if (p) found = p;
  });
  if (!found) return res.status(404).json({ error: 'not found' });
  if (fam) delete found.fam; else found.fam = false;
  req.trip.save('memory');
  res.json({ ok: true });
});

// ── Gastos compartidos entre todos los del viaje ───────────────────────────
app.get('/api/expenses', (req, res) => res.json(req.trip.get('expenses', [])));

app.post('/api/expenses', (req, res) => {
  const { desc, amt, who, split, cat } = req.body;
  if (!desc || typeof amt !== 'number' || amt <= 0 || who === undefined) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const expStore = req.trip.get('expenses', []);
  const id = genId();
  const expense = { id, desc, amt, who, split: Array.isArray(split) ? split : [], cat: cat || 'other', ts: Date.now() };
  expStore.push(expense);
  req.trip.save('expenses');
  res.json({ ok: true, expense });
});

app.delete('/api/expenses/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const expStore = req.trip.get('expenses', []);
  const idx = expStore.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  expStore.splice(idx, 1);
  req.trip.save('expenses');
  res.json({ ok: true });
});

// Editar un gasto ya registrado — cualquiera puede corregir un error (mismo
// criterio que agregar gastos, no solo el admin). Si el monto cambia, se
// guarda el monto anterior en "history" antes de sobreescribirlo, para que
// quede rastro de que hubo un cambio de precio (quién lo pagó/con quién se
// divide se puede corregir sin dejar rastro, eso no es un "cambio de precio").
app.patch('/api/expenses/:id', (req, res) => {
  const expStore = req.trip.get('expenses', []);
  const idx = expStore.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const prev = expStore[idx];
  const { desc, amt, who, split, cat, editedBy } = req.body;
  const next = { ...prev };
  if (typeof desc === 'string' && desc.trim()) next.desc = desc.trim();
  if (typeof who === 'number') next.who = who;
  if (Array.isArray(split)) next.split = split;
  if (typeof cat === 'string' && cat) next.cat = cat;
  if (typeof amt === 'number' && amt > 0 && amt !== prev.amt) {
    next.history = (prev.history || []).concat([{ amt: prev.amt, ts: Date.now(), by: editedBy || null }]);
    next.amt = amt;
  }
  expStore[idx] = next;
  req.trip.save('expenses');
  res.json({ ok: true, expense: next });
});

// Comprobantes (foto o archivo) adjuntos a un gasto, como evidencia del pago
app.post('/api/expenses/:id/receipts', (req, res) => {
  const { photo, name, type } = req.body;
  if (!photo) return res.status(400).json({ error: 'missing fields' });
  const exp = req.trip.get('expenses', []).find((e) => e.id === req.params.id);
  if (!exp) return res.status(404).json({ error: 'not found' });
  if (!exp.receipts) exp.receipts = [];
  const id = genId();
  const receipt = { id, photo, name: name || '', type: type || '', ts: Date.now() };
  exp.receipts.push(receipt);
  req.trip.save('expenses');
  res.json({ ok: true, receipt });
});

app.delete('/api/expenses/:id/receipts/:rid', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const exp = req.trip.get('expenses', []).find((e) => e.id === req.params.id);
  if (!exp || !exp.receipts) return res.status(404).json({ error: 'not found' });
  const idx = exp.receipts.findIndex((r) => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  exp.receipts.splice(idx, 1);
  req.trip.save('expenses');
  res.json({ ok: true });
});

// ── Pagos entre personas para liquidar deudas del viaje ────────────────────
// No son gastos del viaje (no cuentan para el total gastado) — solo ajustan
// los saldos cuando alguien ya le pagó a quien adelantó el dinero.
app.get('/api/settlements', (req, res) => res.json(req.trip.get('settlements', [])));

app.post('/api/settlements', (req, res) => {
  const { from, to, amt } = req.body;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof amt !== 'number' || amt <= 0) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const settleStore = req.trip.get('settlements', []);
  const id = genId();
  const settlement = { id, from, to, amt, ts: Date.now() };
  settleStore.push(settlement);
  req.trip.save('settlements');
  res.json({ ok: true, settlement });
});

app.delete('/api/settlements/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const settleStore = req.trip.get('settlements', []);
  const idx = settleStore.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  settleStore.splice(idx, 1);
  req.trip.save('settlements');
  res.json({ ok: true });
});

// ── Perfiles (fecha de nacimiento, dirección, contacto de emergencia) ─────
// Compartido entre todos para que el admin pueda ver los contactos de
// emergencia de cada quien en caso de necesitarlos durante el viaje.
app.get('/api/profiles', (req, res) => res.json(req.trip.get('profiles', {})));

app.post('/api/profiles', (req, res) => {
  const { idx, data } = req.body;
  if (idx === undefined || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'missing fields' });
  }
  const profStore = req.trip.get('profiles', {});
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
  req.trip.save('profiles');
  res.json({ ok: true });
});

// Versión mínima para la página pública de "seguir en vivo" — nada de
// cumpleaños ni dirección de nadie, solo lo que hace falta para que
// familia/amigos puedan llamar al contacto de emergencia de cada quien.
app.get('/api/public-contacts', (req, res) => {
  const profStore = req.trip.get('profiles', {});
  const out = {};
  Object.keys(profStore).forEach((idx) => {
    const p = profStore[idx] || {};
    if (!p.ecName && !p.ecPhone) return;
    out[idx] = { ecName: p.ecName || '', ecPhoneCode: p.ecPhoneCode || '', ecPhone: p.ecPhone || '', blood: p.blood || '' };
  });
  res.json(out);
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
// Forma: { "0": { city, acts:[...] }, ... }
app.get('/api/itinerary', (req, res) => res.json(req.trip.get('itinerary', {})));

app.post('/api/itinerary', (req, res) => {
  const { idx, city, acts, who } = req.body || {};
  const i = parseInt(idx, 10);
  if (!Number.isInteger(i) || i < 0 || i > MAX_DAYS) {
    return res.status(400).json({ error: 'bad day index' });
  }
  if (!req.trip.isAdmin(who)) {
    return res.status(403).json({ error: 'solo el admin puede editar el itinerario' });
  }
  const itinStore = req.trip.get('itinerary', {});
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
  req.trip.save('itinerary');
  res.json({ ok: true, entry });
});

// Borra el itinerario completo para empezar de cero. Solo el admin.
// (El caché de ubicaciones ya no se limpia aquí: es compartido entre todos
// los viajes y las coordenadas de un lugar no cambian.)
app.delete('/api/itinerary', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const dias = Object.keys(req.trip.get('itinerary', {})).length;
  req.trip.set('itinerary', {});
  res.json({ ok: true, borrados: dias });
});

// ── Ubicación en vivo del grupo (opt-in por persona) ───────────────────────
app.get('/api/live-locations', (req, res) => res.json(req.trip.get('live-locations', {})));

app.post('/api/live-locations', (req, res) => {
  const { who, lat, lon } = req.body;
  if (!who || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'missing fields' });
  }
  const liveLocStore = req.trip.get('live-locations', {});
  liveLocStore[who] = { lat, lon, ts: Date.now() };
  req.trip.save('live-locations');
  res.json({ ok: true });
});

app.delete('/api/live-locations/:who', (req, res) => {
  const liveLocStore = req.trip.get('live-locations', {});
  delete liveLocStore[req.params.who];
  req.trip.save('live-locations');
  res.json({ ok: true });
});

// ── Enlace para que familiares y amigos sigan el viaje en vivo ─────────────
// No tienen perfil ni PIN — el "acceso" es un token largo al azar en la URL
// (/seguir/<token>), que solo deja leer lo que esa página muestra. Cada viaje
// tiene el suyo. El admin puede invalidarlo generando uno nuevo si se
// comparte de más.
app.get('/api/viewer-token', (req, res) => res.json({ token: req.trip.meta.viewerToken }));

app.post('/api/viewer-token/regenerate', (req, res) => {
  const t = req.trip;
  const who = req.body && req.body.who;
  if (!t.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  unindexTrip(t);
  t.meta.viewerToken = crypto.randomBytes(24).toString('hex');
  t.saveMeta();
  indexTrip(t);
  res.json({ ok: true, token: t.meta.viewerToken });
});

// Además de validar el token, le da a la página de "seguir" lo que necesita
// para pintarse: nombre del viaje, fechas y viajeros.
app.get('/api/viewer-check/:token', (req, res) => {
  const id = viewerIndex.get(req.params.token);
  const t = id && trips.get(id);
  if (!t) return res.json({ ok: false });
  res.json({
    ok: true,
    trip: { id: t.id, name: t.cfg.name, subtitle: t.cfg.subtitle || '', start: t.cfg.start, days: t.cfg.days, persons: t.cfg.persons },
  });
});

app.get('/seguir/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'seguir.html'));
});

// ── ¿Dónde dejamos el carro? (una sola ubicación compartida) ───────────────
app.get('/api/car', (req, res) => res.json(req.trip.get('car', null)));

app.post('/api/car', (req, res) => {
  const { lat, lon, who } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'missing coords' });
  }
  const carLoc = { lat, lon, who: who || '?', ts: Date.now() };
  req.trip.set('car', carLoc);
  res.json({ ok: true, carLoc });
});

app.delete('/api/car', (req, res) => {
  req.trip.set('car', null);
  res.json({ ok: true });
});


// ── Reservaciones (con horario, fecha y ubicación) ─────────────────────────
// Combina las que salen del itinerario (auto-sembradas por el cliente, ya
// que el server no interpreta el arreglo DAYS del front) con las que agregue
// cualquiera manualmente. Compartidas entre todos.
app.get('/api/reservations', (req, res) => res.json(req.trip.get('reservations', [])));

app.post('/api/reservations', (req, res) => {
  const { id, title, date, time, location, cost, notes, done, source, who } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'missing fields' });
  const resStore = req.trip.get('reservations', []);
  const idx = resStore.findIndex((r) => r.id === id);
  const isNewCustom = idx === -1 && (source || 'custom') === 'custom';
  if (isNewCustom && !req.trip.isAdmin(who)) {
    return res.status(403).json({ error: 'solo el admin puede agregar reservaciones' });
  }
  const item = {
    id: id || genId(),
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
  req.trip.save('reservations');
  res.json({ ok: true, item });
});

app.delete('/api/reservations/:id', (req, res) => {
  const who = req.body && req.body.who;
  if (!req.trip.isAdmin(who)) return res.status(403).json({ error: 'not authorized' });
  const resStore = req.trip.get('reservations', []);
  const idx = resStore.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  resStore.splice(idx, 1);
  req.trip.save('reservations');
  res.json({ ok: true });
});

// ── Push diario 10am — cuenta regresiva al viaje + recordatorio de reservas ─
// Se recorre cada viaje con su propia fecha de salida y sus suscripciones.
cron.schedule('0 10 * * *', async () => {
  const now = new Date();
  for (const t of trips.values()) {
    try {
      const subs = t.get('subscriptions', []);
      if (!subs.length) continue;
      const title = 'Alta Vibra Travel · ' + t.cfg.name;
      const tripStart = new Date(t.cfg.start + 'T00:00:00-06:00');
      if (now < tripStart) {
        const dLeft = Math.ceil((tripStart - now) / (1000 * 60 * 60 * 24));
        await sendPushToAll(t, {
          title,
          body: `Faltan ${dLeft} día${dLeft === 1 ? '' : 's'} para tu viaje`
        });
      }

      const soonMs = 5 * 24 * 60 * 60 * 1000;
      const pending = t.get('reservations', []).filter((r) => {
        if (r.done) return false;
        const d = new Date(r.date + 'T12:00:00-06:00');
        const diff = d - now;
        return diff > -12 * 60 * 60 * 1000 && diff <= soonMs;
      });
      if (pending.length) {
        const names = pending.map((r) => r.title).join(', ');
        await sendPushToAll(t, {
          title: 'Alta Vibra Travel · Reservaciones pendientes',
          body: `Faltan pocos días para: ${names}. ¡Resérvalo antes de que se ocupe!`
        });
      }
    } catch (e) {
      console.error('Push diario falló para', t.id, e.message);
    }
  }
}, { timezone: 'America/Mexico_City' });

app.listen(PORT, () => console.log(`Alta Vibra Travel · puerto ${PORT}`));
