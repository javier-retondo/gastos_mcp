'use strict';

const path = require('path');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { spawn } = require('child_process');

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// ===== Config =====
const PORT = Number(process.env.PORT || 3000);
const PENDIENTES_DIR = process.env.PENDIENTES_DIR || path.join(__dirname, 'pendientes');

// Auth
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in env');
}
if (!ADMIN_PASSWORD_HASH) {
  // No lo tiramos abajo para permitir levantar y luego setear, pero te aviso.
  console.warn('WARNING: ADMIN_PASSWORD_HASH is empty. Login will not work until you set it.');
}

// Codex
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 10 * 60 * 1000); // 10 min
const CODEX_PROMPT = (process.env.CODEX_PROMPT || '').trim();

// Un solo proceso a la vez (simple)
let isProcessing = false;

// ===== Helpers =====
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function sanitizeBaseName(input) {
  let s = String(input || '').trim().toLowerCase();

  // normaliza acentos
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // espacios -> guiones
  s = s.replace(/\s+/g, '-');

  // solo caracteres seguros
  s = s.replace(/[^a-z0-9._-]/g, '');

  // evita cosas raras con puntos
  s = s.replace(/\.+/g, '.').replace(/^\.*/, '').replace(/\.{2,}/g, '.');

  if (!s) s = 'sin-descripcion';
  if (s.length > 80) s = s.slice(0, 80);

  return s;
}

async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let i = 1;

  // Evita sobreescritura
  while (true) {
    try {
      await fsp.access(safeJoin(dir, candidate));
      candidate = `${base}-${i}${ext}`;
      i += 1;
    } catch {
      return safeJoin(dir, candidate);
    }
  }
}

function removeDuplicateExt(baseName, ext) {
  if (!ext) return baseName;
  const lower = baseName.toLowerCase();
  if (lower.endsWith(ext)) {
    return baseName.slice(0, -ext.length);
  }
  return baseName;
}

function safeJoin(baseDir, fileName) {
  const resolved = path.resolve(baseDir, fileName);
  const resolvedBase = path.resolve(baseDir);
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid path');
  }
  return resolved;
}

function requireJwt(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing_token' });

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

// ===== Rate limit login =====
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// ===== Multer =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1
  }
});

// ===== Static =====
app.use('/', express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h'
}));

// ===== Auth =====
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    if (!ADMIN_PASSWORD_HASH) return res.status(500).json({ error: 'server_not_configured' });

    const password = String(req.body.password || '');
    if (!password) return res.status(400).json({ error: 'password_required' });

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    const accessToken = jwt.sign(
      { sub: 'admin', role: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({ accessToken });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'login_failed' });
  }
});

// ===== Upload =====
app.post('/api/upload', requireJwt, upload.single('file'), async (req, res) => {
  try {
    await ensureDir(PENDIENTES_DIR);

    const descripcion = String(req.body.descripcion || '').trim();
    if (!descripcion) return res.status(400).json({ error: 'descripcion_required' });

    const base = sanitizeBaseName(descripcion);

    if (req.file) {
      const originalExt = path.extname(req.file.originalname || '').toLowerCase();
      const ext = originalExt && originalExt.length <= 10 ? originalExt : '';
      const safeBase = removeDuplicateExt(base, ext);
      const finalName = safeBase + ext;

      const dest = await uniquePath(PENDIENTES_DIR, finalName);
      await fsp.writeFile(dest, req.file.buffer, { flag: 'w', mode: 0o640 });

      return res.json({ ok: true, savedAs: path.basename(dest) });
    } else {
      const finalName = base + '.txt';
      const dest = await uniquePath(PENDIENTES_DIR, finalName);

      await fsp.writeFile(dest, descripcion + '\n', { flag: 'w', mode: 0o640 });

      return res.json({ ok: true, savedAs: path.basename(dest), createdTxt: true });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'upload_failed' });
  }
});

// ===== Process =====
app.post('/api/process', requireJwt, async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'already_processing' });

  try {
    await ensureDir(PENDIENTES_DIR);

    // Por seguridad: preferí prompt fijo por env.
    // Si querés permitir desde UI, lo soportamos pero con límites.
    const promptFromClient = String(req.body.prompt || '').trim();
    const prompt = (CODEX_PROMPT || promptFromClient).trim();

    if (!prompt) return res.status(400).json({ error: 'prompt_required' });
    if (prompt.length > 4000) return res.status(400).json({ error: 'prompt_too_long' });

    isProcessing = true;

    // Ajustá args a tu comando real de codex si es diferente.
    // Ejemplo genérico:
    // codex --prompt "<...>" --dir "<pendientes>"
    const args = ['--prompt', prompt, '--dir', PENDIENTES_DIR];

    const child = spawn(CODEX_BIN, args, {
      shell: false,
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CODEX_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      isProcessing = false;

      res.json({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr
      });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      isProcessing = false;
      console.error(err);
      res.status(500).json({ error: 'process_failed' });
    });
  } catch (e) {
    isProcessing = false;
    console.error(e);
    res.status(500).json({ error: 'process_failed' });
  }
});

// ===== Health =====
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    codex: {
      bin: CODEX_BIN,
      promptConfigured: Boolean(CODEX_PROMPT)
    },
    pendientesDir: PENDIENTES_DIR,
    processing: isProcessing
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Pendientes dir: ${PENDIENTES_DIR}`);
});
