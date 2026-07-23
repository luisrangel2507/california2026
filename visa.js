// Gestión de Trámite de Visas — módulo de backend.
// Almacenamiento simple en archivos JSON (mismo patrón que el resto de la app),
// sin base de datos externa. Módulo aparte para no inflar server.js.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { SECTIONS, DOCUMENT_CATEGORIES } = require('./visa-schema');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'visa-uploads');
const USERS_FILE = path.join(DATA_DIR, 'visa-users.json');
const TOKENS_FILE = path.join(DATA_DIR, 'visa-tokens.json');
const FORMS_FILE = path.join(DATA_DIR, 'visa-forms.json');
const DOCS_FILE = path.join(DATA_DIR, 'visa-docs.json');

const ADMIN_EMAIL = (process.env.VISA_ADMIN_EMAIL || 'luisrangel2507@gmail.com').toLowerCase();

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadJSON(USERS_FILE, []);       // [{id,name,email,salt,hash,isAdmin,createdAt}]
let tokens = loadJSON(TOKENS_FILE, {});     // { token: userId }
let forms = loadJSON(FORMS_FILE, {});       // { userId: { data:{}, updatedAt, log:[] } }
let docs = loadJSON(DOCS_FILE, {});         // { userId: [{id,category,storedName,originalName,mimetype,size,uploadedAt}] }

const persistUsers = () => saveJSON(USERS_FILE, users);
const persistTokens = () => saveJSON(TOKENS_FILE, tokens);
const persistForms = () => saveJSON(FORMS_FILE, forms);
const persistDocs = () => saveJSON(DOCS_FILE, docs);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (test.length !== stored.length) return false;
  return crypto.timingSafeEqual(test, stored);
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, isAdmin: !!u.isAdmin, createdAt: u.createdAt };
}
function ensureLog(userId) {
  if (!forms[userId]) forms[userId] = { data: {}, updatedAt: null, log: [] };
  if (!Array.isArray(forms[userId].log)) forms[userId].log = [];
  return forms[userId];
}
function pushLog(userId, action, detail) {
  const f = ensureLog(userId);
  f.log.push({ ts: new Date().toISOString(), action, detail: detail || '' });
  if (f.log.length > 500) f.log = f.log.slice(-500);
}

function completion(userId) {
  const total = SECTIONS.reduce((n, s) => n + s.fields.length, 0);
  const data = (forms[userId] && forms[userId].data) || {};
  let filled = 0;
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      const v = data[`${s.id}.${f.id}`];
      if (v !== undefined && v !== null && String(v).trim() !== '') filled++;
    }
  }
  return { filled, total, pct: total ? Math.round((filled / total) * 100) : 0 };
}

function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const userId = token && tokens[token];
  const user = userId && users.find((u) => u.id === userId);
  if (!user) return res.status(401).json({ error: 'No autorizado' });
  req.user = user;
  req.token = token;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Solo administrador' });
  next();
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.user.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const id = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /^image\/|^application\/pdf$/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo de archivo no permitido (solo imágenes o PDF)'), ok);
  },
});

const router = express.Router();

// ── Esquema (público, para renderizar el formulario) ───────────────────────
router.get('/schema', (req, res) => {
  res.json({ sections: SECTIONS, documentCategories: DOCUMENT_CATEGORIES });
});

// ── Registro / Login ────────────────────────────────────────────────────────
router.post('/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña (mínimo 6 caracteres) son obligatorios' });
  }
  const emailLc = String(email).trim().toLowerCase();
  if (users.find((u) => u.email === emailLc)) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(12).toString('hex'),
    name: String(name).trim(),
    email: emailLc,
    salt,
    hash: hashPassword(password, salt),
    isAdmin: emailLc === ADMIN_EMAIL,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  persistUsers();
  ensureLog(user.id);
  pushLog(user.id, 'account_created', '');
  persistForms();

  const token = crypto.randomBytes(24).toString('hex');
  tokens[token] = user.id;
  persistTokens();
  res.json({ ok: true, token, user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const emailLc = String(email || '').trim().toLowerCase();
  const user = users.find((u) => u.email === emailLc);
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens[token] = user.id;
  persistTokens();
  res.json({ ok: true, token, user: publicUser(user) });
});

router.post('/logout', auth, (req, res) => {
  delete tokens[req.token];
  persistTokens();
  res.json({ ok: true });
});

router.get('/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user), completion: completion(req.user.id) });
});

// ── Formulario ───────────────────────────────────────────────────────────────
router.get('/form', auth, (req, res) => {
  const f = ensureLog(req.user.id);
  res.json({ data: f.data, updatedAt: f.updatedAt, log: f.log.slice(-100).reverse(), completion: completion(req.user.id) });
});

router.get('/log', auth, (req, res) => {
  const f = ensureLog(req.user.id);
  res.json({ log: f.log.slice(-100).reverse() });
});

router.post('/form', auth, (req, res) => {
  const { data, sectionTitle } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Datos de formulario inválidos' });
  }
  const f = ensureLog(req.user.id);
  let changed = 0;
  for (const [k, v] of Object.entries(data)) {
    if (typeof k !== 'string' || k.length > 120) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') continue;
    f.data[k] = v;
    changed++;
  }
  f.updatedAt = new Date().toISOString();
  pushLog(req.user.id, 'form_saved', sectionTitle ? `Sección: ${sectionTitle} (${changed} campos)` : `${changed} campos`);
  persistForms();
  res.json({ ok: true, updatedAt: f.updatedAt, completion: completion(req.user.id) });
});

// ── Documentos ───────────────────────────────────────────────────────────────
router.get('/documents', auth, (req, res) => {
  res.json({ documents: docs[req.user.id] || [] });
});

router.post('/documents', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
    const category = String(req.body.category || 'otro');
    if (!docs[req.user.id]) docs[req.user.id] = [];
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      category,
      storedName: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
    };
    docs[req.user.id].push(entry);
    persistDocs();
    pushLog(req.user.id, 'document_uploaded', `${entry.originalName} (${category})`);
    persistForms();
    res.json({ ok: true, document: entry });
  });
});

router.get('/documents/:id/download', auth, (req, res) => {
  const list = docs[req.user.id] || [];
  const entry = list.find((d) => d.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const filePath = path.join(UPLOADS_DIR, req.user.id, entry.storedName);
  res.download(filePath, entry.originalName);
});

router.delete('/documents/:id', auth, (req, res) => {
  const list = docs[req.user.id] || [];
  const idx = list.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const [entry] = list.splice(idx, 1);
  persistDocs();
  const filePath = path.join(UPLOADS_DIR, req.user.id, entry.storedName);
  fs.unlink(filePath, () => {});
  pushLog(req.user.id, 'document_deleted', entry.originalName);
  persistForms();
  res.json({ ok: true });
});

// ── Administración (Ing. Rangel) ─────────────────────────────────────────────
router.get('/admin/users', auth, requireAdmin, (req, res) => {
  const list = users.filter((u) => !u.isAdmin).map((u) => ({
    ...publicUser(u),
    completion: completion(u.id),
    documentCount: (docs[u.id] || []).length,
    formUpdatedAt: (forms[u.id] && forms[u.id].updatedAt) || null,
  }));
  res.json({ users: list });
});

router.get('/admin/users/:id', auth, requireAdmin, (req, res) => {
  const u = users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  const f = ensureLog(u.id);
  res.json({
    user: publicUser(u),
    data: f.data,
    updatedAt: f.updatedAt,
    log: f.log.slice(-200).reverse(),
    documents: docs[u.id] || [],
    completion: completion(u.id),
  });
});

router.get('/admin/users/:id/documents/:docId/download', auth, requireAdmin, (req, res) => {
  const list = docs[req.params.id] || [];
  const entry = list.find((d) => d.id === req.params.docId);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const filePath = path.join(UPLOADS_DIR, req.params.id, entry.storedName);
  res.download(filePath, entry.originalName);
});

module.exports = router;
