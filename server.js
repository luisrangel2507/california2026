const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
  const { id } = req.params;
  let found = false;
  Object.keys(memStore).forEach(key => {
    const idx = memStore[key].findIndex(p => p.id === id);
    if (idx !== -1) { memStore[key].splice(idx, 1); found = true; }
  });
  if (found) { persistMem(); res.json({ ok: true }); }
  else res.status(404).json({ error: 'not found' });
});

// ── Push diario 10am — cuenta regresiva al viaje ───────────────────────────
cron.schedule('0 10 * * *', async () => {
  const tripStart = new Date('2026-09-02T00:00:00-06:00');
  const now = new Date();
  if (now >= tripStart) return;
  const dLeft = Math.ceil((tripStart - now) / (1000 * 60 * 60 * 24));
  await sendPushToAll({
    title: 'Alta Vibra · California 2026',
    body: `Faltan ${dLeft} día${dLeft === 1 ? '' : 's'} para tu viaje`
  });
}, { timezone: 'America/Mexico_City' });

app.listen(PORT, () => console.log(`Alta Vibra · puerto ${PORT}`));
