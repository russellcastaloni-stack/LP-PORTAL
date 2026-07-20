require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express    = require('express');
const puppeteer  = require('puppeteer');
const cors       = require('cors');
const compression = require('compression');
const path       = require('path');
const fs         = require('fs');
const fsp        = fs.promises;
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const dataLayer = require('./db.js'); // SQLite-backed: clients, quotes, serials, profiles
// exceljs used only for admin client import (read-only, admin-gated endpoint)
let _excelLib = null;
function getExcel() {
    if (!_excelLib) _excelLib = require('exceljs');
    return _excelLib;
}
// No external Excel library needed — clients stored as CSV (opens natively in Excel)

// ── Security fixes applied ────────────────────────────────────────────────────
// 1. POST /api/admin/login       — now rate-limited (checkRateLimit)
// 2. PATCH /api/profiles/:id/self      — now rate-limited
// 3. PATCH /api/profiles/:id/self-pin  — now rate-limited
// 4. POST /api/open-file         — path sandboxed to DRIVE_FOLDER / JO_FOLDER
// 5. POST /api/widgets/:username — body size capped at 256 KB
// 6. POST /api/notes/:username   — body size capped at 512 KB
// 7. renderPDF                   — hard 90-second overall timeout added
// ─────────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

// Stamped once per process start — changes every time the server is restarted
// (i.e. every deploy under pm2). Exposed via /api/health so active sessions
// can detect "the server behind me just changed" and prompt the user to
// save their work and reload, instead of silently working against stale
// client code until something breaks.
const SERVER_BOOT_ID = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

// ── Fail-fast: required env vars ─────────────────────────────────────────────
const MISSING_ENV = ['ADMIN_PASSWORD', 'PIN_SALT', 'JWT_SECRET'].filter(k => !process.env[k]);
if (MISSING_ENV.length) {
    console.error(`\n❌  FATAL: Required environment variable(s) not set: ${MISSING_ENV.join(', ')}`);
    console.error('   Set them before starting the server.\n');
    process.exit(1);
}

// ── Rate limiting — protects login endpoints from brute-force ────────────────
// Sliding window: max 10 attempts per IP per 15 minutes. Backed by the
// `login_attempts` SQLite table (not just an in-memory Map) so a deliberate
// or accidental server restart can no longer be used to bypass the lockout
// (see audit 2.3). An in-memory Map is still used as a fast pre-check cache
// to avoid hitting SQLite on every single request when an IP is well under
// the limit, but the persistent count is always the source of truth for the
// actual block decision.
const _rateLimitCache = new Map(); // ip -> last known count (best-effort fast path)
const RL_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const RL_MAX        = 10;              // max attempts per window

function checkRateLimit(req, res, next) {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    try {
        dataLayer.recordLoginAttempt(ip);
        const count = dataLayer.countRecentLoginAttempts(ip, RL_WINDOW_MS);
        _rateLimitCache.set(ip, count);
        if (count > RL_MAX) {
            const oldest = dataLayer.oldestRecentLoginAttempt(ip, RL_WINDOW_MS) || Date.now();
            const retryAfter = Math.max(1, Math.ceil((oldest + RL_WINDOW_MS - Date.now()) / 1000));
            res.setHeader('Retry-After', retryAfter);
            return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(retryAfter/60)} min.` });
        }
    } catch (e) {
        // If the DB is briefly unavailable, fail open rather than locking
        // everyone out — but log it, since this should be rare.
        console.error('[checkRateLimit] persistent store error:', e.message);
    }
    next();
}
// Sweep stale entries every 30 minutes to prevent unbounded table growth
setInterval(() => {
    try { dataLayer.pruneOldLoginAttempts(RL_WINDOW_MS); } catch (e) { console.error('[rateLimit sweep]', e.message); }
    _rateLimitCache.clear();
}, 30 * 60 * 1000);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());

// ── Request logging (PM2 console) ────────────────────────────────────────────
// One compact line per request, written to stdout so `pm2 monit` / `pm2 logs`
// show live traffic instead of sitting empty. Registered first so it wraps
// the full request lifecycle (static files + API) -- req.user (set by the
// /api auth gate below, if the request is authenticated) is already
// populated by the time 'finish' fires, since that happens after every
// downstream handler has run.
// Polled every ~3s per open tab (chat history refresh, see index.html/jo.html/
// proofing.html chatPoll()) — logging every single poll would flood `pm2
// logs` with near-useless noise and bury real request activity. Add other
// high-frequency polling endpoints here if they start doing the same.
const SKIP_LOG_PATHS = ['/api/chat/history'];

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        if (SKIP_LOG_PATHS.includes(req.path)) return;
        const ms  = Date.now() - start;
        const who = (req.user && req.user.name) ? req.user.name : '-';
        console.log(`[REQ] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ${who}`);
    });
    next();
});

// CORS: only allow requests from the portal origin (env override for local dev).
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://portal.launchpadph.com';
app.use(cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Session-Id', 'X-File-Type', 'X-File-Name', 'X-Copies', 'X-Paper-Size'],
    exposedHeaders: ['X-PDF-Path', 'X-PDF-Save-Warning', 'Content-Disposition', 'Retry-After'],
    credentials: false,
}));
// Routes below declare their own express.json({limit:...}) middleware for
// payloads bigger than 1mb (base64 file/image data, PDF generation, etc.).
// Those per-route overrides only matter if THIS global parser doesn't run
// first and already reject the request — body-parser enforces its limit as
// soon as it reads the body, before Express ever reaches route-specific
// middleware registered later in the chain. Bug found 2026-07: Proofing's
// inline-base64 Image Guide upload could push /api/generate-proofing's
// payload over 1mb, and every request died here with "request entity too
// large" despite that route explicitly asking for a 50mb limit. Skipping
// the global parser for these paths lets their own (larger) limit actually
// apply.
const BIG_PAYLOAD_ROUTES = new Set([
    '/api/quotes',
    '/api/joborders',
    '/api/proofing',
    '/api/generate-quotation',
    '/api/generate-joborder',
    '/api/generate-proofing',
    '/api/import/clients-xlsx-preview',
    '/api/parse-quotation-pdf',
    '/api/print-fit-preview', // Fit-to-Page image print composer (2026-07) — base64 photo(s), easily over 1mb
    '/api/print-fit',
    '/api/print-preview-pdf', // full-screen print tool PDF preview (2026-07) — base64 PDF, easily over 1mb
]);
app.use((req, res, next) => {
    if (BIG_PAYLOAD_ROUTES.has(req.path)) return next();
    express.json({ limit: '1mb' })(req, res, next);
});
// HTML/JS/CSS get "no-store" (not just "no-cache") — a plain revalidate-first
// policy still let a Cloudflare-tunnel-cached or browser-heuristic-cached copy
// of a page slip through stale after a deploy (reported again 2026-07, even
// after the original no-cache fix), so app source files now forbid caching
// outright: every request re-fetches the real current file, full stop. Images/
// icons/fonts still get a normal cache since those genuinely don't change and
// benefit from caching.
app.use(express.static('public', {
    setHeaders: (res, filePath) => {
        const noStoreExt = /\.(html?|js|css)$/i;
        res.setHeader('Cache-Control', noStoreExt.test(filePath) ? 'no-store' : 'no-cache');
    }
}));

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// ── Global /api auth gate ─────────────────────────────────────────────────────
const PUBLIC_API_PATHS = new Set([
    '/admin/login',
    '/profiles/login',
    '/health',
    '/view-file',
    '/emergency/reset-pin',  // localhost-only, has its own IP check
    '/spotlight-images',     // just wallpaper filenames — nothing sensitive
]);

app.use('/api', async (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();

    // ── JWT Bearer token (preferred) ─────────────────────────────────────────
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) {
        const tok = auth.slice(7);
        // SECURITY: __dev__ backdoor removed — use real credentials in all environments
        try {
            // Attach the decoded payload as req.user ({sub, role, name}) so
            // downstream routes/logging can identify who's making the request
            // without every route having to re-verify the token itself.
            req.user = jwt.verify(tok, process.env.JWT_SECRET);
            return next();
        } catch {}
    }

    // ── Legacy X-Session-Id — FIXED: validate against DB, not just existence ──
    // TODO: deprecate this header; all clients should migrate to JWT Bearer tokens.
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
        try {
            const profile = dataLayer.getProfileById(sessionId);
            if (profile) {
                req.user = { sub: profile.id, role: profile.role || 'user', name: profile.name };
                return next();
            }
        } catch { /* fall through to 401 */ }
    }

    res.status(401).json({ error: 'Not authenticated' });
});

// ── Activity log (persistent audit trail) ────────────────────────────────────
// Separate from the request logger above (a live PM2 console tail only) —
// this writes to the activity_log SQLite table so "who did what" can be
// looked back through days/weeks later, not just scrolled past in pm2 logs.
function logActivity(req, action, details) {
    try {
        const u = req.user || {};
        dataLayer.recordActivity({
            userId:   u.sub  || null,
            userName: u.name || null,
            role:     u.role || null,
            action,
            details:  details ? String(details) : null,
            ip:       req.ip || (req.connection && req.connection.remoteAddress) || null,
        });
    } catch (e) {
        console.error('[logActivity]', e.message);
    }
}

// ── Storage paths ─────────────────────────────────────────────────────────────
const DRIVE_FOLDER = process.env.DRIVE_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. Launchpad Portal\\1. Quotations';
const JO_FOLDER    = process.env.JO_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. Launchpad Portal\\2. Job Orders';
const PROOFING_FOLDER = process.env.PROOFING_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. Launchpad Portal\\3. Proofing';

// Resolve a folder path to its real (symlink-free) form once at startup.
// Falls back to the normalized path if the folder doesn't exist yet (e.g. Drive offline).
function safeRealpath(p) {
    try { return fs.realpathSync.native(p); } catch { return path.normalize(p); }
}
const DRIVE_FOLDER_REAL    = safeRealpath(DRIVE_FOLDER);
const JO_FOLDER_REAL       = safeRealpath(JO_FOLDER);
const PROOFING_FOLDER_REAL = safeRealpath(PROOFING_FOLDER);

// Returns the resolved real path if `filePath` is a regular file that genuinely
// resolves (after following any symlinks/junctions) inside one of the allowed
// sandbox folders, or null otherwise. Using realpath (not just startsWith on the
// raw string) closes the UNC-path / symlink-chain bypass described in the audit.
function resolveSandboxedFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    let real;
    try { real = fs.realpathSync.native(filePath); } catch { return null; }
    const allowedReal = [DRIVE_FOLDER_REAL, JO_FOLDER_REAL, PROOFING_FOLDER_REAL];
    const isAllowed = allowedReal.some(dir => real === dir || real.startsWith(dir + path.sep));
    if (!isAllowed) return null;
    try {
        if (!fs.statSync(real).isFile()) return null;
    } catch { return null; }
    return real;
}

// ── SQLite — clients, quotes, serials, job orders, profiles ─────────────────
// Replaces lp_quotes.json, lp_serials.json, lp_clients.csv, lp_joborders.json,
// lp_profiles.json. See db.js for the full data access layer and migrate.js
// for the one-time migration script that produced launchpad.db from those
// JSON/CSV files.
//
// launchpad.db lives on LOCAL disk (not inside DRIVE_FOLDER) — see
// DATABASE-MIGRATION.md. It used to live in DRIVE_FOLDER (the Google
// Drive-synced shared drive, same place the generated PDFs live), but
// Drive's sync client doesn't implement real file locking, which WAL-mode
// SQLite depends on. That mismatch caused intermittent SQLITE_PROTOCOL
// ("locking protocol") errors, and carried a real risk of silent
// corruption if Drive ever synced the .db file mid-write. Moving PCs?
// Read DATABASE-MIGRATION.md before touching this.
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH       = process.env.DB_PATH  || path.join(DATA_DIR, 'launchpad.db');
const LEGACY_DB_PATH = path.join(DRIVE_FOLDER, 'launchpad.db'); // pre-2026-07 location
const DB_BACKUP_DIR = path.join(DRIVE_FOLDER, 'db-backups');
const SCHEMA_PATH   = path.join(__dirname, 'schema.sql');

// One-time self-migration: if the new local copy doesn't exist yet but the
// old Drive copy does, move it over (dragging its -wal/-shm sidecars along
// so no recent, not-yet-checkpointed write is lost). The old file is left
// in place afterward, untouched, as an extra safety net — not deleted
// automatically.
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
        const src = LEGACY_DB_PATH + suffix;
        if (fs.existsSync(src)) fs.copyFileSync(src, DB_PATH + suffix);
    }
    console.log(`[db] One-time migration: copied launchpad.db from Google Drive to local disk (${DB_PATH})`);
}

dataLayer.init(DB_PATH, SCHEMA_PATH);

// ── Automatic backup to Google Drive ─────────────────────────────────────────
// The db now lives locally (see above), so it's no longer continuously
// synced anywhere on its own. This job snapshots it to Drive every 15
// minutes via VACUUM INTO (safe to run on a live, open database — see
// db.js backupTo()). Filenames are keyed by time-of-day slot (96 slots,
// HHMM in 15-min steps) and simply get overwritten every 24 hours, so
// storage stays bounded at 96 files with no separate pruning step, while
// still keeping a full rolling day of history at 15-minute granularity.
// In-memory backup health — surfaced to admins via GET /api/db-backup-status
// (see admin.html) so a failing backup job is visible without needing to
// read pm2 logs. Deliberately not persisted anywhere: if the server itself
// restarts, "since last restart" is an acceptable reset for this purpose.
const dbBackupStatus = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
};

function runDbBackup() {
    dbBackupStatus.lastAttemptAt = new Date().toISOString();
    try {
        fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
        const now = new Date();
        const slotMin = Math.floor(now.getMinutes() / 15) * 15;
        const slot = `${String(now.getHours()).padStart(2, '0')}${String(slotMin).padStart(2, '0')}`;
        dataLayer.backupTo(path.join(DB_BACKUP_DIR, `launchpad_${slot}.db`));
        dbBackupStatus.lastSuccessAt = dbBackupStatus.lastAttemptAt;
        dbBackupStatus.lastError = null;
        dbBackupStatus.consecutiveFailures = 0;
    } catch (e) {
        dbBackupStatus.lastError = e.message;
        dbBackupStatus.consecutiveFailures += 1;
        console.error('[db backup]', e.message);
    }
}
runDbBackup();
setInterval(runDbBackup, 15 * 60 * 1000);

// Still JSON-based (out of scope for this migration — low-traffic, low-stakes data)
const WIDGETS_FILE  = path.join(DRIVE_FOLDER, 'lp_widgets.json');
const NOTES_FILE    = path.join(DRIVE_FOLDER, 'lp_notes.json');
const CHAT_FILE     = path.join(DRIVE_FOLDER, 'lp_chat.json');   // group chat messages
const ANNOUNCEMENT_FILE = path.join(DRIVE_FOLDER, 'lp_announcement.json'); // admin-broadcast banner (manual, not auto-deploy-detected)

// ── Admin config ──────────────────────────────────────────────────────────────
// ADMIN_PASSWORD must be set via env — server will not start without it (see fail-fast above).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// NOTE: the legacy ADMIN_TOKEN (random hex, regenerated every restart) header
// fallback has been removed (audit 3.7). All admin clients authenticate via
// the signed JWT issued by POST /api/admin/login; no frontend code referenced
// X-Admin-Token, so this was a pure footgun with no functional dependency.

// ── Per-file mutex ────────────────────────────────────────────────────────────
class Mutex {
    constructor() { this._queue = Promise.resolve(); }
    run(task) {
        const result = this._queue.then(() => task(), () => task());
        this._queue = result.then(() => {}, () => {});
        return result;
    }
}
const fileMutexes = new Map();
function withFileLock(filePath, task) {
    if (!fileMutexes.has(filePath)) fileMutexes.set(filePath, new Mutex());
    return fileMutexes.get(filePath).run(task);
}

// ── File-based DB helpers ─────────────────────────────────────────────────────
async function readJSON(filePath) {
    try {
        const content = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') return {};          // file not yet created — normal
        // Any other error (EPERM, EACCES, drive offline, corrupt JSON) is logged
        // and re-thrown so callers can surface a proper 503 instead of silently
        // returning {} which causes every authenticated call to 401.
        console.error(`[readJSON] ${filePath}:`, err.message);
        throw err;
    }
}

async function writeJSON(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmpPath, filePath);
}

// upsertClient() — phone-number formatting is business logic specific to this
// app, kept here rather than in db.js (which stays a thin data access layer).
// Delegates the actual write to dataLayer.upsertClientRow().
function upsertClient(data) {
    const key = dataLayer.normalizeCompanyKey(data.company);
    if (!key) return;

    // Format contact number as ####-###-####
    const rawTel = (data.tel || '').replace(/\D/g, '');
    let formattedTel = data.tel || '';
    if (rawTel.length === 11) {
        // 09XXXXXXXXX → 0XXX-XXX-XXXX
        formattedTel = `${rawTel.slice(0,4)}-${rawTel.slice(4,7)}-${rawTel.slice(7)}`;
    } else if (rawTel.length === 10) {
        // 9XXXXXXXXX → 0XXX-XXX-XXXX (missing leading 0)
        formattedTel = `0${rawTel.slice(0,3)}-${rawTel.slice(3,6)}-${rawTel.slice(6)}`;
    }

    dataLayer.upsertClientRow({
        companyName: data.company, address: data.address, attentionTo: data.attentionTo,
        contactNo: formattedTel, tin: data.tin, salesRep: data.salesName, mop: data.mop
    });
}

function sanitiseString(s, maxLen = 500) {
    if (typeof s !== 'string') return '';
    return s.trim().slice(0, maxLen);
}

function validateStoreKey(key) {
    // Must match Q<year>_<4digits>|<companykey>|rev<n>
    return typeof key === 'string' && /^Q\d+_\d{4}\|[^|]+\|rev\d+$/.test(key);
}

// ── CLIENTS API ───────────────────────────────────────────────────────────────

// normalizeCompanyKey() now lives in db.js as the single source of truth —
// accessed here via dataLayer.normalizeCompanyKey(). Removed the duplicate
// copy that used to live in this file (see git history if needed) — having
// two copies drifting apart was exactly the root cause of the company-key
// mismatch bugs (Loob Philippines / RV / Breadtalk, June 2026).
const normalizeCompanyKey = dataLayer.normalizeCompanyKey;

app.get('/api/clients',  (req, res) => {
    try {
        const list = dataLayer.getClients();
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: 'Could not read clients' });
    }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
    try {
        const { companyName, address, attentionTo, contactNo, tin, salesRep, originalKey } = req.body;
        if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'Company Name is required.' });

        dataLayer.upsertClientRow({
            companyName, address: (address||'').trim(), attentionTo: (attentionTo||'').trim(),
            contactNo: (contactNo||'').trim(), tin: (tin||'').trim(), salesRep: (salesRep||'').trim(),
            mop: (req.body.mop||'').trim(), originalKey
        });

        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/clients]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/clients/:companyName', requireAdmin, async (req, res) => {
    try {
        dataLayer.deleteClientByKey(decodeURIComponent(req.params.companyName));
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/clients]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── QUOTES API ────────────────────────────────────────────────────────────────

app.get('/api/quotes',  async (req, res) => {
    try {
        res.json(dataLayer.getAllQuotes());
    } catch (e) {
        console.error('[GET /api/quotes]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Reference images arrive per-item as either an already-persisted
// {filename, path, mimeType} (unchanged from a previous save) or a freshly
// uploaded {token, filename} (from /api/quote-upload-file, not yet on disk).
// This resolves every token to a permanent file under
// DRIVE_FOLDER/<company>/_ref_images/ BEFORE the snapshot is handed to
// dataLayer.saveQuote() — db.js never touches the filesystem itself (see
// db.js's saveQuote() comment), so this promotion has to happen here.
function resolveItemImages(items, companyName, ownedPaths) {
    const folder = (companyName || 'Unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim() || 'Unknown';
    const dir = path.join(DRIVE_FOLDER, folder, '_ref_images');
    // ownedPaths = the exact set of image paths already attached to THIS
    // quote before this save (from dataLayer.getQuoteImagePaths()). Any
    // {path} entry the client sends that isn't in that set is rejected
    // rather than trusted — without this check, any logged-in user could
    // put an arbitrary path (e.g. another quote's reference image, or any
    // other file under DRIVE_FOLDER) into their own quote's images_json and
    // have it read + permanently embedded in their own PDF (IDOR / arbitrary
    // file read within DRIVE_FOLDER, audit 2026-07).
    const ownedSet = new Set(ownedPaths || []);
    return items.map(item => {
        const images = (item.images || []).map(img => {
            if (!img) return null;
            if (img.path) {
                if (!ownedSet.has(img.path)) {
                    console.warn('[resolveItemImages] Rejected untrusted image path (not already owned by this quote):', img.path);
                    return null;
                }
                // Already persisted from an earlier save of THIS quote — pass through as-is.
                return { filename: img.filename || path.basename(img.path), path: img.path, mimeType: img.mimeType || '' };
            }
            if (img.token) {
                const resolved = resolveFileToken(img.token);
                if (!resolved) return null; // token expired or unknown — drop silently
                fs.mkdirSync(dir, { recursive: true });
                const safeName    = (img.filename || resolved.filename || 'image').replace(/[^a-zA-Z0-9._\- ]/g, '_');
                const uniqueName  = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName}`;
                const filePath    = path.join(dir, uniqueName);
                const base64Body  = resolved.dataUrl.split(',')[1] || '';
                fs.writeFileSync(filePath, Buffer.from(base64Body, 'base64'));
                return { filename: img.filename || resolved.filename, path: filePath, mimeType: resolved.mimeType };
            }
            return null;
        }).filter(Boolean);
        return { ...item, images };
    });
}

app.post('/api/quotes', express.json({ limit: '2mb' }), async (req, res) => {
    try {
        const { storeKey, snapshot } = req.body;
        if (!storeKey || !snapshot) return res.status(400).json({ error: 'Missing storeKey or snapshot' });
        if (!validateStoreKey(storeKey)) return res.status(400).json({ error: 'Invalid storeKey format' });
        if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            return res.status(400).json({ error: 'snapshot must be an object' });
        }

        // Reference images: resolve any freshly-uploaded tokens to permanent
        // files BEFORE saving, then clean up any file that was attached to
        // this quote before but isn't referenced anymore (removed by the
        // user, or dropped because its item was deleted) — saveQuote()
        // replaces every quote_items row on every save, so this "old vs new"
        // snapshot comparison is the only place that distinction is visible.
        const oldImagePaths = dataLayer.getQuoteImagePaths(storeKey);
        if (Array.isArray(snapshot.items)) {
            snapshot.items = resolveItemImages(snapshot.items, snapshot.company, oldImagePaths);
        }

        dataLayer.saveQuote(storeKey, snapshot);

        const newImagePaths = new Set();
        (snapshot.items || []).forEach(item => (item.images || []).forEach(img => img && img.path && newImagePaths.add(img.path)));
        oldImagePaths.forEach(p => {
            if (!newImagePaths.has(p)) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.warn('[POST /api/quotes] Could not delete orphaned ref image:', p, e.message); }
            }
        });

        // Return the resolved items (tokens now replaced with permanent
        // paths) so the client can update its in-memory state — otherwise a
        // subsequent Preview/Generate in the same session would still be
        // holding stale/expired tokens instead of the real file path.
        logActivity(req, 'quote_saved', `${storeKey} (${snapshot.company || ''})`);
        res.json({ ok: true, items: snapshot.items });
    } catch (e) {
        console.error('[POST /api/quotes]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/quotes/:storeKey',  async (req, res) => {
    try {
        const storeKey = decodeURIComponent(req.params.storeKey);
        const snap = dataLayer.deleteQuote(storeKey);

        const tryDelete = (p) => {
            try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[PDF DELETE] Removed: ${p}`); } }
            catch (e) { console.warn(`[PDF DELETE] Could not delete: ${e.message}`); }
        };

        if (snap?.pdfPath) {
            tryDelete(snap.pdfPath);
        } else if (snap) {
            const ctrl     = snap.controlNumber || 'Q26_0000';
            const company  = (snap.company || 'Quotation').replace(/[^a-z0-9_\- ]/gi, '_');
            const project  = (snap.projectName || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
            const revNum   = parseInt(snap.revisions) || 0;
            const filename = `${ctrl} ${company}${project ? ' - ' + project : ''}${revNum > 0 ? ' - Rev' + revNum : ''}.pdf`;
            const folder   = (snap.company || 'Unknown').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim() || 'Unknown';
            tryDelete(path.join(DRIVE_FOLDER, folder, filename));
            tryDelete(path.join(DRIVE_FOLDER, filename));
        }

        // Reference images — each item's attached photos live on disk under
        // <company>/_ref_images/; deleteQuote() already collected their paths
        // before the cascade delete removed the quote_items rows.
        (snap?.imagePaths || []).forEach(tryDelete);

        logActivity(req, 'quote_deleted', storeKey);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/quotes]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── SERIALS API ───────────────────────────────────────────────────────────────

app.get('/api/serials',  async (req, res) => {
    try {
        res.json(dataLayer.getAllSerials());
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/serials/next',  async (req, res) => {
    try {
        const companyKey = sanitiseString(req.body.companyKey || '', 200);
        if (!normalizeCompanyKey(companyKey)) return res.status(400).json({ error: 'Missing companyKey' });
        const serial = dataLayer.commitNextSerial(companyKey);
        res.json({ serial });
    } catch (e) {
        console.error('[POST /api/serials/next]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/serials/peek',  async (req, res) => {
    try {
        const companyKey = sanitiseString((req.query.companyKey || ''), 200);
        res.json({ serial: dataLayer.peekNextSerial(companyKey) });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/serials/:companyKey', requireAdmin, async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.companyKey);
        const { value } = req.body;
        if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
            return res.status(400).json({ error: 'value must be a non-negative integer' });
        }
        dataLayer.setSerial(key, value);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/serials/:companyKey', requireAdmin, async (req, res) => {
    try {
        dataLayer.deleteSerial(decodeURIComponent(req.params.companyKey));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/serials — bulk wipe all serials (dev/admin reset)
app.delete('/api/serials', requireAdmin, async (req, res) => {
    try {
        dataLayer.wipeAllSerials();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/serials/rebuild-from-quotes — integrity-check / repair tool.
// With the SQLite schema's UNIQUE(client_id, control_number, revision)
// constraint now preventing the underlying bug at write-time, this endpoint
// is mostly a legacy compatibility shim — but kept as a way to recompute
// serials counters directly from the authoritative quotes table, in case
// the serials table and quotes table ever drift apart (e.g. after a manual
// SQL edit). Counts DISTINCT (control_number, client_id) pairs per company —
// revisions of the same quote are not counted separately.
app.post('/api/serials/rebuild-from-quotes', requireAdmin, async (req, res) => {
    try {
        const report = dataLayer.rebuildSerialsFromQuotes();
        res.json({ ok: true, totalCompanies: report.length, changes: report });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error: ' + e.message });
    }
});

// POST /api/clients/dedupe — OBSOLETE as of the SQLite migration. The bug
// this endpoint used to fix (duplicate client rows from punctuation-variant
// company names) is now structurally impossible: clients.company_key has a
// UNIQUE constraint, so "Loob Philippines" and "Loob Philippines Inc" can
// never become two separate rows in the first place. Kept as a harmless
// no-op so any old cached frontend code that still calls this doesn't break.
app.post('/api/clients/dedupe', requireAdmin, async (req, res) => {
    const total = dataLayer.getClients().length;
    res.json({ ok: true, rowsBefore: total, rowsAfter: total, merged: 0,
        note: 'No-op: clients.company_key is now UNIQUE at the database level, duplicates cannot occur.' });
});

// ── JOB ORDERS API ────────────────────────────────────────────────────────────

app.get('/api/joborders',  async (req, res) => {
    try {
        const lite = req.query.lite === '1' || req.query.lite === 'true';
        res.json(dataLayer.getAllJobOrders({ includeFileData: !lite }));
    } catch (e) {
        console.error('[GET /api/joborders]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/joborders', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const { storeKey, snapshot } = req.body;
        if (!storeKey || !snapshot) return res.status(400).json({ error: 'Missing storeKey or snapshot' });

        dataLayer.saveJobOrder(storeKey, snapshot);
        logActivity(req, 'joborder_saved', `${storeKey} (${snapshot.client || ''})`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/joborders]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/joborders/:storeKey',  async (req, res) => {
    try {
        const storeKey = decodeURIComponent(req.params.storeKey);
        const snap = dataLayer.deleteJobOrder(storeKey);

        const tryDelete = (p) => {
            try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[PDF DELETE] Removed: ${p}`); } }
            catch (e) { console.warn(`[PDF DELETE] Could not delete: ${e.message}`); }
        };

        if (snap?.pdfPath) {
            tryDelete(snap.pdfPath);
        } else if (snap) {
            // No pdf_path on record (older JO, or PDF generation never ran) —
            // rebuild the filename using the same convention as the
            // generate-quotation JO route (joYear-joNum-client) and try that,
            // same fallback the quotes delete route already had.
            const joYear   = deriveJoYear({ dateRaw: snap.dateRaw });
            const client   = (snap.client || 'Client').replace(/[^a-z0-9_\- ]/gi, '_');
            const filename = `JO${joYear}-${snap.joNumber || '0000'} ${client}.pdf`;
            tryDelete(path.join(JO_FOLDER, filename));
        }

        logActivity(req, 'joborder_deleted', storeKey);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── PROOFING API ──────────────────────────────────────────────────────────────
// Parallel module to Job Orders — same CRUD shape, distinct table (see db.js).

app.get('/api/proofing',  async (req, res) => {
    try {
        const lite = req.query.lite === '1' || req.query.lite === 'true';
        res.json(dataLayer.getAllProofing({ includeFileData: !lite }));
    } catch (e) {
        console.error('[GET /api/proofing]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Dashboard stats ──────────────────────────────────────────────────────────
// Aggregates quotes/job-orders/clients into the numbers the Dashboard page
// renders. Reuses dataLayer.getAllQuotes()/getAllJobOrders() (the same shape
// every other page already trusts) instead of writing a parallel raw-SQL
// total calculation, so this can never drift from the PDF's own grand-total
// logic (── Discount ── block above) the way a hand-rolled SQL SUM could.
function monthKeyOf(dateStr) {
    if (!dateStr) return null;
    const m = String(dateStr).match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function quoteFinalTotal(q) {
    const allItems = [
        ...(q.items || []), ...(q.outsourceItems || []), ...(q.flatRateItems || []),
        ...((q.quoteGroups || []).flatMap(g => g.items || []))
    ];
    const gt = allItems.reduce((s, i) => {
        const qty = parseFloat(i.qty) || 0;
        const price = (parseFloat(i.computedUnitPrice) || 0) || (parseFloat(i.unitPrice) || 0);
        return s + qty * price;
    }, 0);
    const type = q.discountType || 'none';
    const val = parseFloat(q.discountValue) || 0;
    let discAmt = 0;
    if (type === 'percent' && val > 0) discAmt = gt * Math.min(val, 100) / 100;
    else if (type === 'flat' && val > 0) discAmt = Math.min(val, gt);
    return { grandTotal: gt, finalTotal: Math.max(gt - discAmt, 0), items: allItems };
}
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const { from, to } = req.query;

        // ── Visibility: non-admin sales reps only ever see their OWN
        // records — never another rep's. This is enforced here server-side
        // (not just hidden in the UI) so it can't be bypassed by editing the
        // request. Admin accounts keep the "All Quotes Visible" behavior
        // they already have everywhere else in the portal (see index.html's
        // "· All Quotes Visible" role text). Any client-supplied ?salesRep=
        // is ignored for non-admins — their own name always wins.
        const isAdmin = !!(req.user && req.user.role === 'admin');
        const salesRep = isAdmin ? (req.query.salesRep || null) : (req.user && req.user.name) || null;

        // ── Quotes: collapse to one row per (company, controlNumber) — the
        // highest revision only, since older revisions are superseded drafts
        // of the same deal, not separate sales. ───────────────────────────
        const quotesObj = dataLayer.getAllQuotes();
        const latestByKey = {};
        Object.values(quotesObj).forEach(q => {
            const key = `${q.company}|${q.controlNumber}`;
            if (!latestByKey[key] || (q.revisions || 0) > (latestByKey[key].revisions || 0)) {
                latestByKey[key] = q;
            }
        });
        const allLatestQuotes = Object.values(latestByKey).map(q => {
            const { grandTotal, finalTotal, items } = quoteFinalTotal(q);
            return { ...q, _grandTotal: grandTotal, _finalTotal: finalTotal, _items: items };
        });

        // The rep-filter dropdown itself is admin-only on the frontend, but
        // guard the option list here too — a non-admin has nothing to pick
        // from besides themselves.
        const salesRepOptions = isAdmin
            ? [...new Set(allLatestQuotes.map(q => q.salesName).filter(Boolean))].sort()
            : (salesRep ? [salesRep] : []);

        const inRange = (dateStr) => {
            if (!dateStr) return !from && !to; // undated quotes only count when no filter is applied
            if (from && dateStr < from) return false;
            if (to && dateStr > to) return false;
            return true;
        };
        const matchesRep = (q) => !salesRep || q.salesName === salesRep;

        const filteredQuotes = allLatestQuotes.filter(q => inRange(q.date) && matchesRep(q));

        const totalQuotedValue = filteredQuotes.reduce((s, q) => s + q._finalTotal, 0);
        const totalQuotesCount = filteredQuotes.length;

        const allClients = dataLayer.getClients();
        const activeClientsCount = new Set(filteredQuotes.map(q => q.company)).size;

        // ── Job Orders / conversions ───────────────────────────────────────
        // Company-scoped match key — control_number is only unique PER
        // CLIENT (schema.sql: UNIQUE(client_id, control_number, revision)),
        // so matching by ctrl_num text alone let a completely different
        // client's job order falsely "convert" this rep's quote whenever
        // both clients happened to reuse the same control-number string
        // (e.g. both on "Q26_0001"). Also: "Job Orders" / "Total Sales" /
        // "Conversion Rate" now all derive from this SAME matched set
        // instead of mixing a JO-salesName filter for one number against an
        // all-time, unscoped ctrl_num-only match for another — that
        // mismatch is what let the dashboard show "0 Job Orders" next to a
        // "100% conversion rate" for the same rep/period (reported 2026-07).
        // This runs BEFORE the sumByKey breakdowns below because "Revenue by
        // Sales Rep" is meant to be actual sales (converted quotes), not raw
        // quoted value — same fix, same reasoning (reported 2026-07).
        const joObj = dataLayer.getAllJobOrders({ includeFileData: false });
        const allJobOrders = Object.values(joObj);
        const companyKeyOf = (s) => (s || '').trim().toUpperCase();
        const convertedKeyToJOIds = new Map(); // "COMPANY||ctrlNum" -> Set of job_order ids
        allJobOrders.forEach(jo => (jo.groups || []).forEach(g => {
            if (!g.ctrlNum) return;
            const key = `${companyKeyOf(jo.client)}||${g.ctrlNum}`;
            if (!convertedKeyToJOIds.has(key)) convertedKeyToJOIds.set(key, new Set());
            convertedKeyToJOIds.get(key).add(jo._jobOrderId);
        }));
        const quoteConvertedJOIds = (q) => convertedKeyToJOIds.get(`${companyKeyOf(q.company)}||${q.controlNumber}`);

        const convertedQuotes = filteredQuotes.filter(q => quoteConvertedJOIds(q));
        const convertedCount = convertedQuotes.length;
        const conversionRate = totalQuotesCount ? (convertedCount / totalQuotesCount) * 100 : 0;
        // "Total Sales" — every quote that actually turned into a Job Order
        // counts as a sale; quoted-but-never-produced work doesn't. This is
        // deliberately a subset of totalQuotedValue, not the same number.
        const totalSalesValue = convertedQuotes.reduce((s, q) => s + q._finalTotal, 0);

        // "Job Orders" KPI — count of distinct JO documents generated for
        // the currently-filtered quotes (same matched set as above), NOT a
        // raw count of job_order rows filtered by jo.salesName — that field
        // reflects whoever filed the JO paperwork, which isn't reliably the
        // same person who made the original quote.
        const filteredJobOrderIds = new Set();
        convertedQuotes.forEach(q => { const ids = quoteConvertedJOIds(q); if (ids) ids.forEach(id => filteredJobOrderIds.add(id)); });
        const totalJobOrders = filteredJobOrderIds.size;

        const sumByKey = (arr, keyFn, valFn) => {
            const map = {};
            arr.forEach(x => {
                const k = keyFn(x) || 'Unspecified';
                map[k] = (map[k] || 0) + valFn(x);
            });
            return map;
        };
        const topN = (map, n) => {
            const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
            const top = sorted.slice(0, n).map(([name, value]) => ({ name, value }));
            const rest = sorted.slice(n).reduce((s, [, v]) => s + v, 0);
            if (rest > 0) top.push({ name: 'Others', value: rest });
            return top;
        };

        // Revenue by Sales Rep = actual sales (quotes that became job
        // orders), not raw quoted value — pulls from convertedQuotes, not
        // filteredQuotes (reported 2026-07: this donut was showing quoted
        // value, same bug class as the old "Total Sales" KPI).
        const salesRepMap = sumByKey(convertedQuotes, q => q.salesName, q => q._finalTotal);
        const salesRepBreakdown = topN(salesRepMap, 6);

        // Top Clients = actual sales (quotes that became job orders), not
        // raw quoted value — same reasoning as the Sales Rep donut above
        // (reported 2026-07: quoted value isn't relevant here).
        const topClientsMap = sumByKey(convertedQuotes, q => q.company, q => q._finalTotal);
        const topClients = topN(topClientsMap, 8);

        const allFilteredItems = filteredQuotes.flatMap(q => q._items.map(i => ({ ...i, _quoteVal: (parseFloat(i.qty) || 0) * ((parseFloat(i.computedUnitPrice) || 0) || (parseFloat(i.unitPrice) || 0)) })));
        const materialMap = sumByKey(allFilteredItems, i => (i.material || '').trim().toUpperCase() || 'UNSPECIFIED', i => i._quoteVal);
        const materialBreakdown = topN(materialMap, 6);

        // ── Trailing 12-month trend (respects salesRep filter, ignores the
        // from/to range so the chart always shows a stable rolling window) ─
        const repFilteredQuotes = allLatestQuotes.filter(matchesRep);
        const repJobOrderIds = new Set();
        repFilteredQuotes.forEach(q => { const ids = quoteConvertedJOIds(q); if (ids) ids.forEach(id => repJobOrderIds.add(id)); });
        const repFilteredJOs = allJobOrders.filter(jo => repJobOrderIds.has(jo._jobOrderId));
        const months = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }) });
        }
        const quotedValueByMonth = {};
        repFilteredQuotes.forEach(q => {
            const k = monthKeyOf(q.date);
            if (k) quotedValueByMonth[k] = (quotedValueByMonth[k] || 0) + q._finalTotal;
        });
        const joCountByMonth = {};
        repFilteredJOs.forEach(jo => {
            const k = monthKeyOf(jo.dateRaw);
            if (k) joCountByMonth[k] = (joCountByMonth[k] || 0) + 1;
        });

        res.json({
            kpi: {
                totalQuotedValue, totalQuotesCount,
                totalJobOrders, totalSalesValue, conversionRate,
                totalClients: allClients.length, activeClientsCount
            },
            monthly: {
                labels: months.map(m => m.label),
                quotedValue: months.map(m => quotedValueByMonth[m.key] || 0),
                jobOrders: months.map(m => joCountByMonth[m.key] || 0)
            },
            salesRepBreakdown, materialBreakdown, topClients,
            salesRepOptions, isAdmin,
            filtersApplied: { from: from || null, to: to || null, salesRep: salesRep || null }
        });
    } catch (e) {
        console.error('[GET /api/dashboard-stats]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Client Performance (Dashboard page's "Client Performance" tab, added
// 2026-07 — "1 tab sales performance ng AE, 2nd tab per client
// performance"). Mirrors /api/dashboard-stats above almost exactly, but
// grouped by client (company) instead of salesperson: the list endpoint
// returns EVERY client (not capped to 8 like the Sales Performance tab's
// "Top Clients" widget) for the leaderboard, and the detail endpoint
// returns one client's own KPIs/trend/breakdowns for the drill-down view.
// Same non-admin visibility rule as dashboard-stats: a non-admin only ever
// sees clients THEY personally quoted/sold to, never another rep's book. ──
app.get('/api/client-performance-list', async (req, res) => {
    try {
        const { from, to } = req.query;
        const isAdmin = !!(req.user && req.user.role === 'admin');
        const salesRep = isAdmin ? null : (req.user && req.user.name) || null;

        const quotesObj = dataLayer.getAllQuotes();
        const latestByKey = {};
        Object.values(quotesObj).forEach(q => {
            const key = `${q.company}|${q.controlNumber}`;
            if (!latestByKey[key] || (q.revisions || 0) > (latestByKey[key].revisions || 0)) {
                latestByKey[key] = q;
            }
        });
        const allLatestQuotes = Object.values(latestByKey).map(q => {
            const { grandTotal, finalTotal, items } = quoteFinalTotal(q);
            return { ...q, _grandTotal: grandTotal, _finalTotal: finalTotal, _items: items };
        });

        const inRange = (dateStr) => {
            if (!dateStr) return !from && !to;
            if (from && dateStr < from) return false;
            if (to && dateStr > to) return false;
            return true;
        };
        const matchesRep = (q) => !salesRep || q.salesName === salesRep;
        const filteredQuotes = allLatestQuotes.filter(q => inRange(q.date) && matchesRep(q));

        const joObj = dataLayer.getAllJobOrders({ includeFileData: false });
        const allJobOrders = Object.values(joObj);
        const companyKeyOf = (s) => (s || '').trim().toUpperCase();
        const convertedKeyToJOIds = new Map(); // "COMPANY||ctrlNum" -> Set of job_order ids
        allJobOrders.forEach(jo => (jo.groups || []).forEach(g => {
            if (!g.ctrlNum) return;
            const key = `${companyKeyOf(jo.client)}||${g.ctrlNum}`;
            if (!convertedKeyToJOIds.has(key)) convertedKeyToJOIds.set(key, new Set());
            convertedKeyToJOIds.get(key).add(jo._jobOrderId);
        }));
        const quoteConvertedJOIds = (q) => convertedKeyToJOIds.get(`${companyKeyOf(q.company)}||${q.controlNumber}`);

        // Group the (already date/rep-filtered) quotes by client, then
        // aggregate each client's own KPI set — same formulas as
        // dashboard-stats, just scoped per-company instead of once overall.
        const byClient = new Map(); // companyKey -> { name, quotes: [] }
        filteredQuotes.forEach(q => {
            const key = companyKeyOf(q.company);
            if (!key) return;
            if (!byClient.has(key)) byClient.set(key, { name: q.company, quotes: [] });
            byClient.get(key).quotes.push(q);
        });

        const clients = [...byClient.values()].map(({ name, quotes }) => {
            const totalQuotedValue = quotes.reduce((s, q) => s + q._finalTotal, 0);
            const totalQuotesCount = quotes.length;
            const convertedQuotes = quotes.filter(q => quoteConvertedJOIds(q));
            const totalSalesValue = convertedQuotes.reduce((s, q) => s + q._finalTotal, 0);
            const jobOrderIds = new Set();
            convertedQuotes.forEach(q => { const ids = quoteConvertedJOIds(q); if (ids) ids.forEach(id => jobOrderIds.add(id)); });
            const totalJobOrders = jobOrderIds.size;
            const conversionRate = totalQuotesCount ? (convertedQuotes.length / totalQuotesCount) * 100 : 0;
            return { name, totalQuotedValue, totalQuotesCount, totalSalesValue, totalJobOrders, conversionRate };
        }).sort((a, b) => b.totalSalesValue - a.totalSalesValue);

        res.json({ clients, isAdmin, filtersApplied: { from: from || null, to: to || null } });
    } catch (e) {
        console.error('[GET /api/client-performance-list]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/client-performance-detail', async (req, res) => {
    try {
        const { from, to, client } = req.query;
        if (!client) return res.status(400).json({ error: 'Missing client' });
        const isAdmin = !!(req.user && req.user.role === 'admin');
        const salesRep = isAdmin ? null : (req.user && req.user.name) || null;
        const companyKeyOf = (s) => (s || '').trim().toUpperCase();
        const clientKey = companyKeyOf(client);

        const quotesObj = dataLayer.getAllQuotes();
        const latestByKey = {};
        Object.values(quotesObj).forEach(q => {
            const key = `${q.company}|${q.controlNumber}`;
            if (!latestByKey[key] || (q.revisions || 0) > (latestByKey[key].revisions || 0)) {
                latestByKey[key] = q;
            }
        });
        // Scoped to this one client (and, for non-admins, this one rep) up
        // front — everything below only ever sees this client's own quotes.
        const clientQuotes = Object.values(latestByKey)
            .filter(q => companyKeyOf(q.company) === clientKey && (!salesRep || q.salesName === salesRep))
            .map(q => {
                const { grandTotal, finalTotal, items } = quoteFinalTotal(q);
                return { ...q, _grandTotal: grandTotal, _finalTotal: finalTotal, _items: items };
            });

        // A non-admin asking about a client they never dealt with (or a
        // typo'd/unknown client name) gets an empty-but-valid response, not
        // a 404/leak of whether the client exists at all — matches
        // dashboard-stats's "own records only, silently" rule.
        if (!clientQuotes.length) {
            return res.json({
                clientName: client, isAdmin,
                kpi: { totalQuotedValue: 0, totalQuotesCount: 0, totalJobOrders: 0, totalSalesValue: 0, conversionRate: 0 },
                monthly: { labels: [], quotedValue: [], jobOrders: [] },
                salesRepBreakdown: [], materialBreakdown: [],
                filtersApplied: { from: from || null, to: to || null }
            });
        }

        const inRange = (dateStr) => {
            if (!dateStr) return !from && !to;
            if (from && dateStr < from) return false;
            if (to && dateStr > to) return false;
            return true;
        };
        const filteredQuotes = clientQuotes.filter(q => inRange(q.date));

        const joObj = dataLayer.getAllJobOrders({ includeFileData: false });
        const allJobOrders = Object.values(joObj);
        const convertedKeyToJOIds = new Map();
        allJobOrders.forEach(jo => (jo.groups || []).forEach(g => {
            if (!g.ctrlNum) return;
            const key = `${companyKeyOf(jo.client)}||${g.ctrlNum}`;
            if (!convertedKeyToJOIds.has(key)) convertedKeyToJOIds.set(key, new Set());
            convertedKeyToJOIds.get(key).add(jo._jobOrderId);
        }));
        const quoteConvertedJOIds = (q) => convertedKeyToJOIds.get(`${companyKeyOf(q.company)}||${q.controlNumber}`);

        const totalQuotedValue = filteredQuotes.reduce((s, q) => s + q._finalTotal, 0);
        const totalQuotesCount = filteredQuotes.length;
        const convertedQuotes = filteredQuotes.filter(q => quoteConvertedJOIds(q));
        const totalSalesValue = convertedQuotes.reduce((s, q) => s + q._finalTotal, 0);
        const conversionRate = totalQuotesCount ? (convertedQuotes.length / totalQuotesCount) * 100 : 0;
        const filteredJobOrderIds = new Set();
        convertedQuotes.forEach(q => { const ids = quoteConvertedJOIds(q); if (ids) ids.forEach(id => filteredJobOrderIds.add(id)); });
        const totalJobOrders = filteredJobOrderIds.size;

        const sumByKey = (arr, keyFn, valFn) => {
            const map = {};
            arr.forEach(x => {
                const k = keyFn(x) || 'Unspecified';
                map[k] = (map[k] || 0) + valFn(x);
            });
            return map;
        };
        const topN = (map, n) => {
            const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
            const top = sorted.slice(0, n).map(([name, value]) => ({ name, value }));
            const rest = sorted.slice(n).reduce((s, [, v]) => s + v, 0);
            if (rest > 0) top.push({ name: 'Others', value: rest });
            return top;
        };

        // Revenue by Sales Rep, scoped to this client — who inside this
        // account is actually closing the deals.
        const salesRepMap = sumByKey(convertedQuotes, q => q.salesName, q => q._finalTotal);
        const salesRepBreakdown = topN(salesRepMap, 6);

        const allFilteredItems = filteredQuotes.flatMap(q => q._items.map(i => ({ ...i, _quoteVal: (parseFloat(i.qty) || 0) * ((parseFloat(i.computedUnitPrice) || 0) || (parseFloat(i.unitPrice) || 0)) })));
        const materialMap = sumByKey(allFilteredItems, i => (i.material || '').trim().toUpperCase() || 'UNSPECIFIED', i => i._quoteVal);
        const materialBreakdown = topN(materialMap, 6);

        // Trailing 12-month trend for this client (ignores from/to, same
        // rolling-window behavior as dashboard-stats's trend chart).
        const clientJobOrderIds = new Set();
        clientQuotes.forEach(q => { const ids = quoteConvertedJOIds(q); if (ids) ids.forEach(id => clientJobOrderIds.add(id)); });
        const clientJOs = allJobOrders.filter(jo => clientJobOrderIds.has(jo._jobOrderId));
        const months = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }) });
        }
        const quotedValueByMonth = {};
        clientQuotes.forEach(q => {
            const k = monthKeyOf(q.date);
            if (k) quotedValueByMonth[k] = (quotedValueByMonth[k] || 0) + q._finalTotal;
        });
        const joCountByMonth = {};
        clientJOs.forEach(jo => {
            const k = monthKeyOf(jo.dateRaw);
            if (k) joCountByMonth[k] = (joCountByMonth[k] || 0) + 1;
        });

        res.json({
            clientName: client, isAdmin,
            kpi: { totalQuotedValue, totalQuotesCount, totalJobOrders, totalSalesValue, conversionRate },
            monthly: {
                labels: months.map(m => m.label),
                quotedValue: months.map(m => quotedValueByMonth[m.key] || 0),
                jobOrders: months.map(m => joCountByMonth[m.key] || 0)
            },
            salesRepBreakdown, materialBreakdown,
            filtersApplied: { from: from || null, to: to || null }
        });
    } catch (e) {
        console.error('[GET /api/client-performance-detail]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/proofing', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const { storeKey, snapshot } = req.body;
        if (!storeKey || !snapshot) return res.status(400).json({ error: 'Missing storeKey or snapshot' });

        dataLayer.saveProofing(storeKey, snapshot);
        logActivity(req, 'proofing_saved', `${storeKey} (${snapshot.client || ''})`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/proofing]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/proofing/:storeKey',  async (req, res) => {
    try {
        const storeKey = decodeURIComponent(req.params.storeKey);
        const snap = dataLayer.deleteProofing(storeKey);

        const tryDelete = (p) => {
            try { if (p && fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[PDF DELETE] Removed: ${p}`); } }
            catch (e) { console.warn(`[PDF DELETE] Could not delete: ${e.message}`); }
        };

        if (snap?.pdfPath) {
            tryDelete(snap.pdfPath);
        } else if (snap) {
            // No pdf_path on record (older Proofing doc, or PDF generation never
            // ran) — rebuild the filename using the same convention as the
            // generate-proofing route (proofYear-proofNum-client), same
            // fallback the JO delete route already has.
            const proofYear = deriveJoYear({ dateRaw: snap.dateRaw });
            const client     = (snap.client || 'Client').replace(/[^a-z0-9_\- ]/gi, '_');
            const proofProject = ((snap.groups && snap.groups[0] && snap.groups[0].projectName) || '')
                .replace(/[^a-z0-9_\- ]/gi, '_').trim();
            const proofProjPart = proofProject ? ` - ${proofProject}` : '';
            const filename   = `PF${proofYear}-${snap.proofNumber || '0000'} ${client}${proofProjPart}.pdf`;
            tryDelete(path.join(PROOFING_FOLDER, filename));
        }

        logActivity(req, 'proofing_deleted', storeKey);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── PDF generation helpers ────────────────────────────────────────────────────

// Puppeteer: one shared browser, mutex-protected relaunch
let browserInstance = null;
const browserMutex  = new Mutex();

function isBrowserAlive(b) {
    if (!b) return false;
    if (typeof b.isConnected === 'function') return b.isConnected();
    try { return b.process() !== null; } catch { return false; }
}

const PUPPETEER_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
];

async function getBrowser() {
    if (isBrowserAlive(browserInstance)) return browserInstance;
    return browserMutex.run(async () => {
        if (isBrowserAlive(browserInstance)) return browserInstance;
        if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
        const browser = await puppeteer.launch({
            headless: true,
            args: PUPPETEER_ARGS,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        });
        browserInstance = browser;
        browser.on('disconnected', () => { console.warn('[Browser] Disconnected.'); browserInstance = null; });
        return browser;
    });
}

// Signature images (uploaded via a signature-pad-style canvas) tend to be
// saved with a lot of blank/transparent margin baked into the PNG itself —
// the actual pen strokes are often only a small fraction of the full
// canvas, so no amount of CSS width/height on the <img> makes the visible
// ink any bigger, it just scales the blank space right along with it.
// This trims each `<img class="sig-auto-crop">` down to the actual drawn
// content (plus a small padding margin) in-browser via canvas, right
// before the PDF is captured — no server-side image library needed.
// Runs against whatever background color sits at the image's top-left
// corner, so it works whether the PNG has a transparent or a white
// background. Any image that fails to decode/crop is left untouched.
async function autoCropSignatures(page) {
    try {
        await page.evaluate(async () => {
            const imgs = Array.from(document.querySelectorAll('img.sig-auto-crop'));
            for (const img of imgs) {
                try {
                    if (!img.complete || img.naturalWidth === 0) {
                        await new Promise(res => { img.onload = res; img.onerror = res; });
                    }
                    const w = img.naturalWidth, h = img.naturalHeight;
                    if (!w || !h) continue;
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const data = ctx.getImageData(0, 0, w, h).data;
                    const cr = data[0], cg = data[1], cb = data[2], ca = data[3];
                    const isBg = (r, g, b, a) => {
                        if (ca < 10) return a < 10; // corner is transparent
                        if (a < 10) return true;
                        return Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb) < 30; // near corner color
                    };
                    let minX = w, minY = h, maxX = -1, maxY = -1;
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const i = (y * w + x) * 4;
                            if (!isBg(data[i], data[i + 1], data[i + 2], data[i + 3])) {
                                if (x < minX) minX = x;
                                if (x > maxX) maxX = x;
                                if (y < minY) minY = y;
                                if (y > maxY) maxY = y;
                            }
                        }
                    }
                    if (maxX < minX || maxY < minY) continue; // nothing but background found
                    const pad = Math.round(Math.max(w, h) * 0.04);
                    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
                    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
                    const cw = maxX - minX + 1, ch = maxY - minY + 1;
                    if (cw >= w && ch >= h) continue; // already tight, nothing to gain
                    const out = document.createElement('canvas');
                    out.width = cw; out.height = ch;
                    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
                    img.src = out.toDataURL('image/png');
                } catch (e) { /* leave this image untouched on any failure */ }
            }
        });
    } catch (e) {
        console.error('[autoCropSignatures]', e.message);
    }
}

async function renderPDF(html, pdfOptions) {
    pdfOptions = pdfOptions || {
        format: 'A4', printBackground: true,
        margin: { top: '0.3in', right: '0.3in', bottom: '0.3in', left: '0.3in' }
    };

    async function attempt() {
        const browser = await getBrowser();
        const page    = await browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
            await autoCropSignatures(page);
            return await page.pdf(pdfOptions);
        } finally {
            await page.close().catch(() => {});
        }
    }

    // Hard 90-second deadline for the entire PDF render (including retry)
    const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('PDF render timed out after 90 s')), 90000));

    const render = async () => {
        try {
            return await attempt();
        } catch (err) {
            const recoverable = err.message && (
                err.message.includes('Target closed') ||
                err.message.includes('Session closed') ||
                err.message.includes('Protocol error')
            );
            if (recoverable) {
                console.warn('[renderPDF] Browser error, retrying…', err.message);
                if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
                return await attempt();
            }
            throw err;
        }
    };

    return Promise.race([render(), timeout]);
}

// Render first page of a PDF (base64 string) as a JPEG data URL using mupdf
// mupdf is ESM-only so we use dynamic import(), cached after first load
let _mupdf = null;
async function getMupdf() {
    if (_mupdf) return _mupdf;
    _mupdf = import('mupdf').then(m => m.default).catch(e => { _mupdf = null; throw e; });
    return _mupdf;
}

async function renderPdfPageAsImage(pdfBase64) {
    try {
        const mupdf   = await getMupdf();
        const pdfBuf  = Buffer.from(pdfBase64, 'base64');
        const doc     = mupdf.Document.openDocument(pdfBuf, 'application/pdf');
        const page    = doc.loadPage(0); // first page (0-indexed)
        const matrix  = mupdf.Matrix.scale(2, 2); // 2x scale → ~150 DPI, clear enough
        const pixmap  = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        const jpegBuf = pixmap.asJPEG(85, false);
        const b64     = Buffer.from(jpegBuf).toString('base64');
        pixmap.destroy();
        page.destroy();
        doc.destroy();
        return `data:image/jpeg;base64,${b64}`;
    } catch (e) {
        console.error('[renderPdfPageAsImage]', e.message);
        return null;
    }
}

// Quick pre-flight check before handing a PDF to Gemini — just opens it with
// mupdf long enough to confirm it isn't password-protected and has pages,
// then throws it away. This used to also render every page to a JPEG and
// send THOSE to Gemini as images, but that discarded the PDF's actual
// embedded text layer and forced Gemini into pure OCR/vision reading of a
// ~150-DPI re-compressed JPEG — noticeably less reliable on dense tables
// than the Gemini web/app UI, which sends PDFs natively. Gemini's API
// natively accepts PDF bytes directly (mimeType: 'application/pdf') and
// extracts embedded text itself when present, so we now do the same thing
// instead of pre-rendering — see callGeminiForQuoteExtraction below. This
// also removes the old 8-page cap (Gemini handles up to 1000 pages natively).
async function assertPdfReadable(pdfBase64) {
    const mupdf  = await getMupdf();
    const pdfBuf = Buffer.from(pdfBase64, 'base64');
    const doc    = mupdf.Document.openDocument(pdfBuf, 'application/pdf');
    try {
        // Password-protected PDFs open "successfully" (openDocument doesn't
        // throw) but every page call on them fails or renders blank, which
        // used to surface as a generic "Could not read this file as a PDF."
        // — a locked PDF from a client is by far the most common reason this
        // feature fails, so it gets its own clear, actionable error instead.
        if (doc.needsPassword()) {
            const err = new Error('This PDF is password-protected. Remove the password and try uploading it again.');
            err.code = 'PASSWORD_PROTECTED';
            throw err;
        }
        if (doc.countPages() < 1) {
            const err = new Error('This PDF has no pages to read.');
            err.code = 'NO_PAGES';
            throw err;
        }
    } finally {
        doc.destroy();
    }
}

// Logo: read from disk once, cached in memory
// Lives at public/ICONS/logo.png (matches jo.html's own <img src="ICONS/logo.png">)
// — this used to look directly under public/, which never existed, so
// fs.existsSync() always failed and every generated PDF silently fell back
// to the plain-text "LAUNCHPAD HOLDINGS OPC" header instead of the logo.
let cachedLogoBase64 = null;
function getLogoBase64() {
    if (cachedLogoBase64 !== null) return cachedLogoBase64;
    try {
        const p = path.join(__dirname, 'public', 'ICONS', 'logo.png');
        cachedLogoBase64 = fs.existsSync(p)
            ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
            : '';
    } catch { cachedLogoBase64 = ''; }
    return cachedLogoBase64;
}

// Shared month lookup
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function formatDateField(raw) {
    if (!raw) return raw;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return raw;
    return `${MONTHS[parseInt(m[2]) - 1]} ${parseInt(m[3])}, ${m[1]}`;
}

// Derives the 2-digit year used in "JO26-0042"-style labels from the job
// order's OWN date (dateRaw, e.g. "2026-06-30"), not from the current
// server time. Using the render-time year breaks across a year boundary —
// reprinting a JO26 job order in January 2027 would otherwise mislabel it
// JO27 (audit 3.4). Falls back to the current year only if no JO date is
// available at all.
function deriveJoYear(data) {
    const raw = (data && (data.dateRaw || data.date)) || '';
    const m = String(raw).match(/^(\d{4})-/);
    if (m) return m[1].slice(-2);
    return String(new Date().getFullYear()).slice(-2);
}

// ── Quotation PDF import ("Upload PDF" button on the Quotation form) ──────────
// Accepts ANY quotation PDF, not just ones this app generated — different
// companies/clients use wildly different layouts, so fixed-position/regex
// text extraction isn't viable here (that only works against one known
// template). Instead: render each page to an image with mupdf (already used
// above for the Image Reference feature) and hand them to Gemini's vision
// API with a JSON schema matching the quote form's fields. The frontend
// shows the result in an editable confirm modal before touching the real
// form — this route only ever returns a best-effort guess, never writes
// anything.
// Primary model first, then a fallback on a different model — separate
// capacity pool, so if gemini-3.5-flash is stuck returning "overloaded" (seen
// repeatedly even after in-model retries — a real, sustained demand spike on
// Google's side, not a one-off blip), falling back can still get the import
// through instead of making the user wait it out or manually retry.
// NOTE: gemini-2.5-flash was tried here first, but Google has since closed it
// off to new-user API keys ("no longer available to new users" error) —
// gemini-3.1-flash-lite is the current lighter-weight Gemini 3.x sibling and
// a real separate model, so it's the fallback now instead.
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const QUOTE_EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        company:      { type: 'string' },
        address:      { type: 'string' },
        tin:          { type: 'string' },
        attentionTo:  { type: 'string' },
        date:         { type: 'string' },
        tel:          { type: 'string' },
        projectName:  { type: 'string' },
        paymentTerms: { type: 'string' },
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    description: { type: 'string' },
                    sizeW:       { type: 'number' },
                    sizeH:       { type: 'number' },
                    sizeUnit:    { type: 'string' },
                    quantity:    { type: 'number' },
                    unitPrice:   { type: 'number' },
                },
                required: ['description', 'quantity'],
            },
        },
    },
    required: ['items'],
};
const QUOTE_EXTRACTION_PROMPT = `You are extracting structured data from a quotation-related document. It may be from any company and in any layout/format — do not assume any particular template. It may be a priced Quotation, OR an unpriced Request for Quotation (RFQ) / item list — handle either case.

Read every page image provided and extract:
- company: the CLIENT's company/business name (not the company issuing the quotation)
- address: the client's address, if shown
- tin: the client's Tax Identification Number, if shown
- attentionTo: the contact person's name the document is addressed to
- date: the document date, as written
- tel: the client's contact/telephone number
- projectName: the project or job title/description, if the document names one distinctly from the line items
- paymentTerms: payment terms as written (e.g. "50% down payment, 50% before delivery")
- items: EVERY line item row from every items/pricing table across ALL pages, in the order they appear, each with:
  - description: the item/material/service description. If the table has an "Area" / location / category column grouping the rows (e.g. "Main Hall Reception", "Small Meeting Rooms"), PREPEND it to the description like "Area — Description" (e.g. "Main Hall Reception — CHUBB Vinyl Sticker Cutout"). Do not create a separate field for the area. If a size/dimension spec appears in the description or its own column (e.g. "48×5\"", "3ft x 5ft", "24in dia"), extract it into sizeW/sizeH/sizeUnit instead — do NOT leave it duplicated inside description.
  - sizeW / sizeH: the item's width/height (or length/diameter for a single dimension) as plain numbers, e.g. 48 and 5. If only one dimension is shown, put it in sizeW and leave sizeH empty. Leave both empty if no size is shown anywhere for that item — do not guess.
  - sizeUnit: the unit exactly as written (e.g. "in", "ft", "cm", "mm"). Leave empty if no size is shown.
  - quantity: a plain number (no units, no text)
  - unitPrice: a plain number (no currency symbols, no thousands-separator commas — e.g. "5,695.06" must become 5695.06). If the document has NO price column at all (e.g. it's an unpriced RFQ / item list), set unitPrice to 0 for every item rather than guessing a price.

Make your best reasonable reading of every field even if you're not fully certain — an empty string is only acceptable if the information genuinely does not appear anywhere in the document.

COMPLETENESS IS CRITICAL: item tables in these documents commonly run 40, 60, even 100+ rows across multiple pages. You MUST return every single row — do not stop early, do not summarize, do not skip rows to save space, and do not sample/truncate the list. Work through the table methodically from the first row to the very last one on the very last page before producing your answer. Returning only the first few rows of a long table is a failure. Do not invent items that aren't shown, either.`;

async function callGeminiForQuoteExtraction(pdfBase64) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        const err = new Error('GEMINI_API_KEY is not set in .env');
        err.code = 'NOT_CONFIGURED';
        throw err;
    }
    // thinkingLevel (string enum) is Gemini 3.x's parameter; 2.5-series models
    // reject/ignore it and use the numeric thinkingBudget instead — for the
    // 2.5-flash fallback this just omits thinkingConfig entirely and lets it
    // use its own default dynamic thinking, same "don't fight the model's own
    // calibration" approach as the 3.5-flash 'medium' choice above.
    function thinkingConfigFor(model) {
        return model.startsWith('gemini-3') ? { thinkingLevel: 'medium' } : undefined;
    }

    let resp, json, lastErr;
    modelLoop:
    for (const model of GEMINI_MODELS) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const thinkingConfig = thinkingConfigFor(model);
        const body = {
            contents: [{
                parts: [
                    { text: QUOTE_EXTRACTION_PROMPT },
                    { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
                ],
            }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: QUOTE_EXTRACTION_SCHEMA,
                maxOutputTokens: 65536,
                ...(thinkingConfig ? { thinkingConfig } : {}),
            },
        };
        // Gemini occasionally comes back with a transient "model overloaded"
        // 503 (high demand on Google's side, nothing wrong with our request)
        // — worth a couple of automatic retries with backoff on THIS model
        // before falling through to the next one in GEMINI_MODELS (separate
        // capacity pool). Genuine errors (bad key, safety block, etc.) come
        // back on the first try and short-circuit straight out, no retry.
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            json = await resp.json().catch(() => null);
            if (resp.ok) break modelLoop;
            const isOverloaded = resp.status === 503 ||
                /overloaded|high demand|unavailable/i.test((json && json.error && json.error.message) || '');
            lastErr = (json && json.error && json.error.message) || `Gemini API returned HTTP ${resp.status}`;
            if (!isOverloaded) {
                const err = new Error(lastErr);
                err.code = 'GEMINI_ERROR';
                throw err;
            }
            if (attempt === MAX_ATTEMPTS) {
                console.warn(`[callGeminiForQuoteExtraction] ${model} still overloaded after ${MAX_ATTEMPTS} attempts, trying next model if any…`);
                break; // fall through to the next model in GEMINI_MODELS
            }
            console.warn(`[callGeminiForQuoteExtraction] ${model} overloaded, retrying (attempt ${attempt}/${MAX_ATTEMPTS})…`);
            await new Promise(r => setTimeout(r, attempt * 3000)); // 3s, 6s
        }
    }
    if (!resp || !resp.ok) {
        const err = new Error(lastErr || 'All Gemini models are currently overloaded. Please try again shortly.');
        err.code = 'GEMINI_ERROR';
        throw err;
    }
    const candidate = json?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
        let msg = 'Gemini returned no extractable content (the PDF may have been blocked by safety filters, or is unreadable).';
        if (finishReason === 'MAX_TOKENS') {
            msg = 'This document has too many items for Gemini to extract in one go. Try splitting it into smaller files and importing each separately.';
        } else if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
            msg = 'This PDF was blocked by Gemini\'s safety filters and could not be read.';
        }
        console.error('[callGeminiForQuoteExtraction] no text — finishReason:', finishReason,
            'thoughtsTokens:', json?.usageMetadata?.thoughtsTokenCount, 'outputTokens:', json?.usageMetadata?.candidatesTokenCount);
        const err = new Error(msg);
        err.code = 'NO_CONTENT';
        throw err;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        const msg = finishReason === 'MAX_TOKENS'
            ? 'This document has too many items — Gemini\'s response got cut off partway through. Try splitting it into smaller files and importing each separately.'
            : 'Gemini response was not valid JSON.';
        console.error('[callGeminiForQuoteExtraction] JSON.parse failed — finishReason:', finishReason, 'text length:', text.length);
        const err = new Error(msg);
        err.code = 'BAD_JSON';
        throw err;
    }
}

// ── PDF import: async job pattern ───────────────────────────────────────────
// A single request/response round trip for this can legitimately take longer
// than Cloudflare Tunnel's edge proxy timeout on a big multi-page/many-item
// document (the Gemini call alone can run past a minute). Rather than hold
// one HTTP request open for the whole thing — which the tunnel will just
// kill, surfacing as a confusing "could not read this PDF" — the POST below
// kicks off the work in the background and returns a jobId immediately; the
// frontend polls the GET route until it's done. No single request is ever
// left waiting on Gemini.
const pdfImportJobs = new Map(); // jobId -> { status, data, error, createdAt }
const PDF_IMPORT_JOB_TTL_MS = 15 * 60 * 1000; // sweep anything older than this
setInterval(() => {
    const cutoff = Date.now() - PDF_IMPORT_JOB_TTL_MS;
    for (const [id, job] of pdfImportJobs) {
        if (job.createdAt < cutoff) pdfImportJobs.delete(id);
    }
}, 5 * 60 * 1000).unref();

app.post('/api/parse-quotation-pdf', express.json({ limit: '25mb' }), async (req, res) => {
    const pdfDataUrl = req.body && req.body.pdfData;
    if (!pdfDataUrl || typeof pdfDataUrl !== 'string' || !pdfDataUrl.startsWith('data:application/pdf')) {
        return res.status(400).json({ error: 'No PDF file provided.' });
    }
    const base64 = pdfDataUrl.split(',')[1] || '';
    if (!base64) return res.status(400).json({ error: 'Empty PDF file.' });

    const jobId = crypto.randomBytes(8).toString('hex');
    pdfImportJobs.set(jobId, { status: 'processing', createdAt: Date.now() });
    res.status(202).json({ jobId });

    // Everything below runs after the response above has already been sent —
    // the client is polling GET /api/parse-quotation-pdf/:jobId for this.
    (async () => {
        try {
            try {
                await assertPdfReadable(base64);
            } catch (e) {
                console.error('[parse-quotation-pdf] pre-flight check failed:', e.code || '', e.message);
                const msg = (e.code === 'PASSWORD_PROTECTED' || e.code === 'NO_PAGES')
                    ? e.message
                    : 'Could not read this file as a PDF. It may be corrupted, or not actually a PDF despite the file extension.';
                pdfImportJobs.set(jobId, { status: 'error', error: msg, createdAt: Date.now() });
                return;
            }

            const extracted = await callGeminiForQuoteExtraction(base64);
            extracted.items = Array.isArray(extracted.items) ? extracted.items : [];
            logActivity(req, 'quotation_pdf_imported', `${extracted.items.length} item(s)`);
            pdfImportJobs.set(jobId, { status: 'done', data: extracted, createdAt: Date.now() });
        } catch (e) {
            console.error('[parse-quotation-pdf]', e.code || '', e.message);
            const msg = e.code === 'NOT_CONFIGURED'
                ? 'PDF import is not configured yet (missing GEMINI_API_KEY).'
                : `Could not read data from this PDF: ${e.message}`;
            pdfImportJobs.set(jobId, { status: 'error', error: msg, createdAt: Date.now() });
        }
    })();
});

// GET /api/parse-quotation-pdf/:jobId — poll for the background job above.
app.get('/api/parse-quotation-pdf/:jobId', (req, res) => {
    const job = pdfImportJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Import job not found (it may have expired).' });
    if (job.status === 'processing') return res.json({ status: 'processing' });
    // Terminal state — hand it back once, then free the memory.
    pdfImportJobs.delete(req.params.jobId);
    if (job.status === 'error') return res.json({ status: 'error', error: job.error });
    return res.json({ status: 'done', success: true, data: job.data });
});

// ── Quotation PDF route ───────────────────────────────────────────────────────
app.post('/api/generate-quotation', express.json({ limit: '20mb' }), async (req, res) => {
    try {
        const data = req.body;

        const isGrouped = !!(data.isGrouped && data.quoteGroups && data.quoteGroups.length);

        if (isGrouped) {
            // Flatten all grouped items for total calculation
            let allItems = [], allFixed = [], allFlat = [];
            (data.quoteGroups || []).forEach(g => {
                (g.items || []).forEach(item => {
                    if (item._type === 'fixed') allFixed.push(item);
                    else if (item._type === 'flat') allFlat.push(item);
                    else allItems.push(item);
                });
            });
            const formatItem = item => {
                const price = parseFloat(item.unitPrice || item.computedUnitPrice) || 0;
                const qty   = parseInt(item.qty || item.quantity) || 0;
                return { ...item, totalAmount: (price * qty).toFixed(2) };
            };
            data.grandTotal = (
                [...allItems, ...allFixed, ...allFlat].map(formatItem)
                    .reduce((s, i) => s + parseFloat(i.totalAmount), 0)
            ).toFixed(2);
            // Reattach processed items back to groups
            data.quoteGroups = (data.quoteGroups || []).map(g => ({
                ...g,
                items: (g.items || []).map(formatItem)
            }));
            // Keep standard item arrays empty to pass validation
            data.items = [{ material: 'grouped', unitPrice: 0, quantity: 0, totalAmount: '0.00' }];
            data.outsourceItems = [];
            data.flatRateItems  = [];
        } else {
            const hasInHouse   = data.items        && data.items.length > 0;
            const hasOutsource = data.outsourceItems && data.outsourceItems.length > 0;
            const hasFlatRate  = data.flatRateItems  && data.flatRateItems.length > 0;
            if (!hasInHouse && !hasOutsource && !hasFlatRate) {
                return res.status(400).send('No items provided. Please add at least one item.');
            }
            data.items = (data.items || []).map(item => {
                const price = parseFloat(item.unitPrice) || 0;
                const qty   = parseInt(item.quantity) || 0;
                return { ...item, totalAmount: (price * qty).toFixed(2) };
            });
            data.outsourceItems = (data.outsourceItems || []).map(item => {
                const price = parseFloat(item.unitPrice) || 0;
                const qty   = parseInt(item.quantity) || 0;
                const mults = item.multipliers || [];
                const formula = mults.length > 0 ? [item.basePrice, ...mults].join(' × ') : String(item.basePrice);
                return { ...item, totalAmount: (price * qty).toFixed(2), formula };
            });
            data.flatRateItems = (data.flatRateItems || []).map(item => {
                const price = parseFloat(item.unitPrice) || 0;
                const qty   = parseInt(item.quantity) || 0;
                return { ...item, totalAmount: (price * qty).toFixed(2) };
            });
            data.grandTotal = (
                [...data.items, ...data.outsourceItems, ...data.flatRateItems]
                    .reduce((s, i) => s + parseFloat(i.totalAmount), 0)
            ).toFixed(2);
        }

        // ── Discount ─────────────────────────────────────────────────────────
        {
            const gt   = parseFloat(data.grandTotal) || 0;
            const type = data.discountType || 'none';
            const val  = parseFloat(data.discountValue) || 0;
            let discAmt = 0;
            if (type === 'percent' && val > 0) {
                discAmt = gt * Math.min(val, 100) / 100;
            } else if (type === 'flat' && val > 0) {
                discAmt = Math.min(val, gt);
            }
            data.discountAmount    = discAmt.toFixed(2);
            data.discountLabel     = type === 'percent' ? `${val}%` : null;
            data.preDiscountTotal  = gt.toFixed(2); // subtotal before discount
            data.grandTotal        = Math.max(gt - discAmt, 0).toFixed(2);
        }

        data.date = formatDateField(data.date);

        // Reference images: resolve to inline base64 for the PDF template —
        // but only when the toggle is on, and only for standard (non-grouped)
        // items, the only place the Simple/Advanced/Fixed Price formula
        // builder (and its attached images) exists. A path means the image
        // was already persisted by a prior Save; a token means it was just
        // uploaded in this session and hasn't been saved yet (e.g. Preview
        // without Save) — same dual resolution db.js documents for saveQuote.
        if (data.includeImageRef && !isGrouped) {
            data.items = (data.items || []).map(item => {
                const resolved = (item.images || []).map(img => {
                    if (!img) return null;
                    try {
                        if (img.path && fs.existsSync(img.path)) {
                            const ext  = path.extname(img.path).toLowerCase();
                            const mime = img.mimeType || (
                                ext === '.png' ? 'image/png' :
                                ext === '.gif' ? 'image/gif'  :
                                ext === '.webp' ? 'image/webp' : 'image/jpeg');
                            const b64 = fs.readFileSync(img.path).toString('base64');
                            return { filename: img.filename, dataUrl: `data:${mime};base64,${b64}` };
                        }
                        if (img.token) {
                            const r = resolveFileToken(img.token);
                            if (r) return { filename: img.filename || r.filename, dataUrl: r.dataUrl };
                        }
                    } catch (e) {
                        console.warn('[generate-quotation] Could not resolve reference image:', e.message);
                    }
                    return null;
                }).filter(Boolean);
                return { ...item, _resolvedImages: resolved };
            });
        }

        const logoBase64 = getLogoBase64();
        const html = generateQuotationHTML(data, logoBase64);
        const pdfBuffer = await renderPDF(html);

        // Build filename / save to Drive
        const ctrl       = data.controlNumber || 'Q26_0000';
        const company    = (data.company || 'Quotation').replace(/[^a-z0-9_\- ]/gi, '_');
        const project    = (data.projectName || '').replace(/[^a-z0-9_\- ]/gi, '_').trim();
        const revNum     = parseInt(data.revisionNumber) || 0;
        const revSuffix  = revNum > 0 ? ` - Rev${revNum}` : '';
        const projPart   = project ? ` - ${project}` : '';
        const filename   = `${ctrl} ${company}${projPart}${revSuffix}.pdf`;

        let savedPdfPath   = null;
        let driveSaveError = null;
        if (!data.skipDriveSave) {
            try {
                const folder = (data.company || 'Unknown')
                    .replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim() || 'Unknown';
                const dir = path.join(DRIVE_FOLDER, folder);
                fs.mkdirSync(dir, { recursive: true });
                const pdfPath = path.join(dir, filename);
                fs.writeFileSync(pdfPath, pdfBuffer);
                savedPdfPath = pdfPath;
                // Persist pdfPath in stored quote
                if (data.storeKey) {
                    try { dataLayer.setQuotePdfPath(data.storeKey, pdfPath); }
                    catch (e) { console.warn('[setQuotePdfPath]', e.message); }
                }
            } catch (saveErr) {
                console.error('[Quotation PDF SAVE]', saveErr.message);
                driveSaveError = saveErr.message;
            }

            // Auto-save client info (fire-and-forget style, but upsertClient is
            // synchronous now — wrap in try/catch instead of .catch())
            try { upsertClient(data); } catch (e) { console.error('[upsertClient]', e.message); }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Access-Control-Expose-Headers', 'X-PDF-Path, X-PDF-Save-Warning');
        // Only claim a Drive path if the write actually succeeded — previously this
        // header was set unconditionally, so the client showed "PDF saved to Drive!"
        // even when the write silently failed (e.g. Drive disconnected), and the
        // history record ended up with no pdfPath while the UI claimed success.
        if (savedPdfPath) {
            res.setHeader('X-PDF-Path', savedPdfPath);
        } else if (driveSaveError) {
            res.setHeader('X-PDF-Save-Warning', encodeURIComponent(
                'PDF was generated but could NOT be saved to Drive: ' + driveSaveError
            ));
        }
        logActivity(req, 'quotation_pdf_generated', filename);
        res.contentType('application/pdf');
        res.send(pdfBuffer);

    } catch (e) {
        console.error('[generate-quotation]', e);
        res.status(500).send('Error generating quotation PDF: ' + e.message);
    }
});

// ── File Upload — token-based temp store ──────────────────────────────────────
// Files are uploaded as raw binary, stored in a server-side Map keyed by a
// short-lived token. Originally JO-only (generate-joborder resolves tokens to
// file data); now also backs the quotation reference-image feature
// (/api/quote-upload-file, 2026-07) — same infra, different callers. Tokens
// expire after 2 hours to prevent unbounded memory use.

const _uploadTokenStore = new Map(); // token → { data: Buffer, mimeType, filename, expiresAt }
const UPLOAD_TOKEN_TTL  = 2 * 60 * 60 * 1000; // 2 hours

// Sweep expired tokens every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of _uploadTokenStore) {
        if (now > entry.expiresAt) _uploadTokenStore.delete(token);
    }
}, 30 * 60 * 1000);

function handleFileUploadToken(req, res) {
    try {
        const mimeType = (req.headers['x-file-type'] || req.headers['content-type'] || 'application/octet-stream').toLowerCase();
        // Clients encodeURIComponent() the filename before setting it as a
        // header (raw header values are restricted to ISO-8859-1 by the
        // fetch spec, and real-world filenames — dashes, accents, phone
        // camera names — routinely fall outside that range). Decode before
        // sanitizing; fall back to the raw value if it wasn't encoded.
        let rawName = req.headers['x-file-name'] || 'file';
        try { rawName = decodeURIComponent(rawName); } catch {}
        const filename = rawName.replace(/[^a-zA-Z0-9._\- ]/g, '_');

        if (!req.body || !req.body.length) {
            return res.status(400).json({ error: 'Empty file' });
        }

        const token = crypto.randomBytes(16).toString('hex');
        _uploadTokenStore.set(token, {
            data:      req.body,          // raw Buffer
            mimeType,
            filename,
            expiresAt: Date.now() + UPLOAD_TOKEN_TTL,
        });

        res.json({ ok: true, token });
    } catch (e) {
        console.error('[POST upload-file]', e.message);
        res.status(500).json({ error: e.message });
    }
}

app.post('/api/jo-upload-file',
    express.raw({ type: () => true, limit: '50mb' }),
    handleFileUploadToken);

// Quotation reference images — same token store/TTL/resolver as the JO
// upload above, just a distinct route so the client code stays readable.
app.post('/api/quote-upload-file',
    express.raw({ type: () => true, limit: '20mb' }),
    handleFileUploadToken);

// Helper used by generate-joborder/generate-quotation to resolve a token to
// a base64 data URL.
function resolveFileToken(token) {
    const entry = _uploadTokenStore.get(token);
    if (!entry) return null;
    const b64 = entry.data.toString('base64');
    return { dataUrl: `data:${entry.mimeType};base64,${b64}`, filename: entry.filename, mimeType: entry.mimeType };
}


app.post('/api/generate-joborder', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const data = req.body;
        if (!data.joNumber) return res.status(400).send('JO Number is required.');
        if (!data.client)   return res.status(400).send('Client name is required.');

        // ── Resolve file tokens to actual file data ───────────────────────────
        // Items may carry a fileToken (uploaded via /api/jo-upload-file) instead
        // of an inline fileData string. Resolve them here before any further use.
        for (const group of (data.groups || [])) {
            for (const item of (group.items || [])) {
                if (item.fileToken && !item.fileData) {
                    const resolved = resolveFileToken(item.fileToken);
                    if (resolved) {
                        item.fileData  = resolved.dataUrl;
                        item.filename  = item.filename || resolved.filename;
                    }
                    delete item.fileToken;
                }
            }
        }
        // Resolve tokens in signedQuotes (group-level attachments)
        for (const group of (data.groups || [])) {
            const files = group.signedQuotes && group.signedQuotes.length
                ? group.signedQuotes
                : (group.signedQuote ? [group.signedQuote] : []);
            for (const f of files) {
                if (f && f.token && !f.data) {
                    const resolved = resolveFileToken(f.token);
                    if (resolved) f.data = resolved.dataUrl;
                    delete f.token;
                }
            }
        }

        const allItems = [];
        (data.groups || []).forEach(group => {
            (group.items || []).forEach(item => {
                allItems.push({ ...item, projectName: group.projectName || '', ctrlNum: group.ctrlNum || '' });
            });
        });
        if (!allItems.length) return res.status(400).send('Add at least one item.');

        // Respects the "Include full Image Reference page(s)" checkbox on
        // the JO form (added back per user request 2026-07 — the previous
        // auto-detect-only behavior always forced this on whenever any item
        // had a file attached, with no way to opt out for the "just want a
        // thumbnail in the table, not a dedicated reference page" case).
        // Still AND-ed with actual image presence — the checkbox can never
        // turn this on if nothing was actually attached.
        data.includeImageRef = !!data.includeImageRef && allItems.some(item => !!item.fileData);

        // ── Pre-render PDF item files to images (for image ref page) ──────────
        if (data.includeImageRef) {
            for (const group of (data.groups || [])) {
                for (const item of (group.items || [])) {
                    if (item.fileData && item.fileData.startsWith('data:application/pdf')) {
                        try {
                            const base64 = item.fileData.split(',')[1];
                            const imgDataUrl = await renderPdfPageAsImage(base64);
                            if (imgDataUrl) {
                                item.fileData        = imgDataUrl;
                                item.fileDataOrigPdf = true;
                            }
                        } catch (e) {
                            console.warn('[JO] PDF→image render failed for item:', item.filename, e.message);
                        }
                    }
                }
            }
        }

        data.displayDate = formatDateField(data.dateRaw || data.date || '') || data.date;

        const logoBase64 = getLogoBase64();
        const html = generateJobOrderHTML({ ...data, allItems, time: data.timeRaw || data.time || '' }, logoBase64);
        let pdfBuffer = await renderPDF(html);

        // ── Collect signed Quote/PO PDFs per group and merge after ACCOUNTING COPY ──
        const signedPdfBuffers = [];
        for (const group of (data.groups || [])) {
            const files = group.signedQuotes && group.signedQuotes.length
                ? group.signedQuotes
                : (group.signedQuote ? [group.signedQuote] : []); // legacy compat
            for (const f of files) {
                if (!f || !f.data) continue;
                try {
                    const base64 = f.data.split(',')[1];
                    if (base64) signedPdfBuffers.push(Buffer.from(base64, 'base64'));
                } catch (e) {
                    console.warn('[JO PDF] Could not parse signedQuote for group:', group.projectName, e.message);
                }
            }
        }

        if (signedPdfBuffers.length > 0) {
            try {
                const merged = await PDFDocument.create();
                const joPdf  = await PDFDocument.load(pdfBuffer);
                const totalPages = joPdf.getPageCount();

                // Accounting Copy is always page 3 (0-indexed: 2).
                // Pages before accounting copy end = pages 0..2 (Sales, Ops, [opt ImgRef], Accounting)
                // We need to find the accounting copy page index dynamically.
                // Since Sales=0, Ops=1, [optional imgRef]=2 if includeImageRef, Accounting = 2 or 3.
                const accountingIdx = data.includeImageRef ? 3 : 2;
                // Insert signed PDFs right after accounting copy page
                const insertAfter = Math.min(accountingIdx, totalPages - 1);

                // Pages before insert point (inclusive)
                for (let p = 0; p <= insertAfter; p++) {
                    const [page] = await merged.copyPages(joPdf, [p]);
                    merged.addPage(page);
                }
                // Insert signed PDF pages
                for (const buf of signedPdfBuffers) {
                    const sigPdf = await PDFDocument.load(buf);
                    const sigPages = await merged.copyPages(sigPdf, sigPdf.getPageIndices());
                    sigPages.forEach(p => merged.addPage(p));
                }
                // Remaining JO pages
                for (let p = insertAfter + 1; p < totalPages; p++) {
                    const [page] = await merged.copyPages(joPdf, [p]);
                    merged.addPage(page);
                }

                pdfBuffer = Buffer.from(await merged.save());
            } catch (mergeErr) {
                console.error('[JO PDF MERGE]', mergeErr.message);
                // Fall through — send unmerged JO PDF if merge fails
            }
        }

        const joNum    = data.joNumber || '0000';
        const client   = (data.client || 'Client').replace(/[^a-z0-9_\- ]/gi, '_');
        const joYear   = deriveJoYear(data);
        const filename = `JO${joYear}-${joNum} ${client}.pdf`;

        let savedPdfPath   = null;
        let driveSaveError = null;
        if (!data.skipDriveSave) {
            try {
                const joFolder = JO_FOLDER;
                fs.mkdirSync(joFolder, { recursive: true });
                const pdfPath = path.join(joFolder, filename);
                fs.writeFileSync(pdfPath, pdfBuffer);
                savedPdfPath = pdfPath;
                if (data.storeKey) {
                    try { dataLayer.setJobOrderPdfPath(data.storeKey, pdfPath); }
                    catch (e) { console.warn('[setJobOrderPdfPath]', e.message); }
                }
            } catch (saveErr) {
                console.error('[JO PDF SAVE]', saveErr.message);
                driveSaveError = saveErr.message;
            }

            // Auto-save client to AMI if not already registered
            if (data.client) {
                const clientKey = normalizeCompanyKey(data.client);
                const existing = dataLayer.getClients().find(c => c._companyKey === clientKey);
                if (!existing) {
                    try {
                        upsertClient({
                            company:     data.client,
                            address:     '',
                            attentionTo: '',
                            tel:         '',
                            tin:         '',
                            salesName:   data.salesName || '',
                        });
                    } catch (e) { console.error('[JO upsertClient]', e.message); }
                }
            }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Access-Control-Expose-Headers', 'X-PDF-Path, X-PDF-Save-Warning');
        // Only claim a Drive path if the write actually succeeded — previously this
        // header was set unconditionally, so the client showed a false success
        // notice even when the write silently failed (e.g. Drive disconnected).
        if (savedPdfPath) {
            res.setHeader('X-PDF-Path', savedPdfPath);
        } else if (driveSaveError) {
            res.setHeader('X-PDF-Save-Warning', encodeURIComponent(
                'PDF was generated but could NOT be saved to Drive: ' + driveSaveError
            ));
        }
        logActivity(req, 'joborder_pdf_generated', filename);
        res.contentType('application/pdf');
        res.send(pdfBuffer);

    } catch (e) {
        console.error('[generate-joborder]', e);
        res.status(500).send('Error generating JO PDF: ' + e.message);
    }
});

app.post('/api/generate-proofing', express.json({ limit: '50mb' }), async (req, res) => {
    try {
        const data = req.body;
        if (!data.proofNumber) return res.status(400).send('Proofing Number is required.');
        if (!data.client)      return res.status(400).send('Client name is required.');

        // ── Resolve file tokens to actual file data ───────────────────────────
        // Items may carry a fileToken (uploaded via /api/jo-upload-file) instead
        // of an inline fileData string. Resolve them here before any further use.
        for (const group of (data.groups || [])) {
            for (const item of (group.items || [])) {
                if (item.fileToken && !item.fileData) {
                    const resolved = resolveFileToken(item.fileToken);
                    if (resolved) {
                        item.fileData  = resolved.dataUrl;
                        item.filename  = item.filename || resolved.filename;
                    }
                    delete item.fileToken;
                }
            }
        }
        // Resolve tokens in signedQuotes (group-level attachments)
        for (const group of (data.groups || [])) {
            const files = group.signedQuotes && group.signedQuotes.length
                ? group.signedQuotes
                : (group.signedQuote ? [group.signedQuote] : []);
            for (const f of files) {
                if (f && f.token && !f.data) {
                    const resolved = resolveFileToken(f.token);
                    if (resolved) f.data = resolved.dataUrl;
                    delete f.token;
                }
            }
        }
        // Resolve the Image Guide reference image token, if any (Proofing-only field).
        if (data.imageGuideFileToken && !data.imageGuideFileData) {
            const resolved = resolveFileToken(data.imageGuideFileToken);
            if (resolved) {
                data.imageGuideFileData = resolved.dataUrl;
                data.imageGuideFilename = data.imageGuideFilename || resolved.filename;
            }
            delete data.imageGuideFileToken;
        }

        const allItems = [];
        (data.groups || []).forEach(group => {
            (group.items || []).forEach(item => {
                allItems.push({ ...item, projectName: group.projectName || '', ctrlNum: group.ctrlNum || '' });
            });
        });
        if (!allItems.length) return res.status(400).send('Add at least one item.');

        // Auto-detect: a reference file was actually attached to at least one
        // item, rather than trusting a manual checkbox someone could forget
        // to (un)check. Attaching a file already signals the intent to have
        // it show up in the printed Proofing sheet -- overrides whatever the
        // client sent.
        data.includeImageRef = allItems.some(item => !!item.fileData);

        // ── Pre-render PDF item files to images (for image ref page) ──────────
        if (data.includeImageRef) {
            for (const group of (data.groups || [])) {
                for (const item of (group.items || [])) {
                    if (item.fileData && item.fileData.startsWith('data:application/pdf')) {
                        try {
                            const base64 = item.fileData.split(',')[1];
                            const imgDataUrl = await renderPdfPageAsImage(base64);
                            if (imgDataUrl) {
                                item.fileData        = imgDataUrl;
                                item.fileDataOrigPdf = true;
                            }
                        } catch (e) {
                            console.warn('[Proofing] PDF→image render failed for item:', item.filename, e.message);
                        }
                    }
                }
            }
        }

        data.displayDate = formatDateField(data.dateRaw || data.date || '') || data.date;

        const logoBase64 = getLogoBase64();
        const html = generateProofingHTML({ ...data, allItems, time: data.timeRaw || data.time || '' }, logoBase64);
        let pdfBuffer = await renderPDF(html);

        // ── Collect signed Quote/PO PDFs per group and merge after OPERATIONS COPY ──
        const signedPdfBuffers = [];
        for (const group of (data.groups || [])) {
            const files = group.signedQuotes && group.signedQuotes.length
                ? group.signedQuotes
                : (group.signedQuote ? [group.signedQuote] : []); // legacy compat
            for (const f of files) {
                if (!f || !f.data) continue;
                try {
                    const base64 = f.data.split(',')[1];
                    if (base64) signedPdfBuffers.push(Buffer.from(base64, 'base64'));
                } catch (e) {
                    console.warn('[Proofing PDF] Could not parse signedQuote for group:', group.projectName, e.message);
                }
            }
        }

        if (signedPdfBuffers.length > 0) {
            try {
                const merged   = await PDFDocument.create();
                const proofPdf = await PDFDocument.load(pdfBuffer);
                const totalPages = proofPdf.getPageCount();

                // Operations Copy is always page 1 (0-indexed: 0), optionally
                // followed by its Image Ref page. Insert signed PDFs right after
                // that block — the nearest equivalent to JO's "after Accounting
                // Copy" position, since Proofing has no Sales/Accounting copies.
                const opsIdx = data.includeImageRef ? 1 : 0;
                const insertAfter = Math.min(opsIdx, totalPages - 1);

                // Pages before insert point (inclusive)
                for (let p = 0; p <= insertAfter; p++) {
                    const [page] = await merged.copyPages(proofPdf, [p]);
                    merged.addPage(page);
                }
                // Insert signed PDF pages
                for (const buf of signedPdfBuffers) {
                    const sigPdf = await PDFDocument.load(buf);
                    const sigPages = await merged.copyPages(sigPdf, sigPdf.getPageIndices());
                    sigPages.forEach(p => merged.addPage(p));
                }
                // Remaining Proofing pages
                for (let p = insertAfter + 1; p < totalPages; p++) {
                    const [page] = await merged.copyPages(proofPdf, [p]);
                    merged.addPage(page);
                }

                pdfBuffer = Buffer.from(await merged.save());
            } catch (mergeErr) {
                console.error('[Proofing PDF MERGE]', mergeErr.message);
                // Fall through — send unmerged Proofing PDF if merge fails
            }
        }

        const proofNum = data.proofNumber || '0000';
        const client   = (data.client || 'Client').replace(/[^a-z0-9_\- ]/gi, '_');
        const proofYear = deriveJoYear(data);
        // Project name: Proofing docs don't have a single top-level project
        // field (unlike Quotations) — items live under per-group projectName,
        // so use the first group's as "the" project name for the filename.
        const proofProject = ((data.groups && data.groups[0] && data.groups[0].projectName) || '')
            .replace(/[^a-z0-9_\- ]/gi, '_').trim();
        const proofProjPart = proofProject ? ` - ${proofProject}` : '';
        const filename = `PF${proofYear}-${proofNum} ${client}${proofProjPart}.pdf`;

        let savedPdfPath   = null;
        let driveSaveError = null;
        if (!data.skipDriveSave) {
            try {
                const proofingFolder = PROOFING_FOLDER;
                fs.mkdirSync(proofingFolder, { recursive: true });
                const pdfPath = path.join(proofingFolder, filename);
                fs.writeFileSync(pdfPath, pdfBuffer);
                savedPdfPath = pdfPath;
                if (data.storeKey) {
                    try { dataLayer.setProofingPdfPath(data.storeKey, pdfPath); }
                    catch (e) { console.warn('[setProofingPdfPath]', e.message); }
                }
            } catch (saveErr) {
                console.error('[Proofing PDF SAVE]', saveErr.message);
                driveSaveError = saveErr.message;
            }

            // Auto-save client to AMI if not already registered
            if (data.client) {
                const clientKey = normalizeCompanyKey(data.client);
                const existing = dataLayer.getClients().find(c => c._companyKey === clientKey);
                if (!existing) {
                    try {
                        upsertClient({
                            company:     data.client,
                            address:     '',
                            attentionTo: '',
                            tel:         '',
                            tin:         '',
                            salesName:   data.salesName || '',
                        });
                    } catch (e) { console.error('[Proofing upsertClient]', e.message); }
                }
            }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Access-Control-Expose-Headers', 'X-PDF-Path, X-PDF-Save-Warning');
        // Only claim a Drive path if the write actually succeeded — same fix
        // as /api/generate-joborder (see comment there): setting this header
        // unconditionally would show a false success notice even when the
        // write silently failed (e.g. Drive disconnected).
        if (savedPdfPath) {
            res.setHeader('X-PDF-Path', savedPdfPath);
        } else if (driveSaveError) {
            res.setHeader('X-PDF-Save-Warning', encodeURIComponent(
                'PDF was generated but could NOT be saved to Drive: ' + driveSaveError
            ));
        }
        logActivity(req, 'proofing_pdf_generated', filename);
        res.contentType('application/pdf');
        res.send(pdfBuffer);

    } catch (e) {
        console.error('[generate-proofing]', e);
        res.status(500).send('Error generating Proofing PDF: ' + e.message);
    }
});

// ── Profiles / Auth API ───────────────────────────────────────────────────────

/* PIN hash: bcrypt (cost 12). Legacy SHA-256+salt hashes (pre-migration) are still
   verifiable via checkPin() and are transparently upgraded to bcrypt on next
   successful login (see /api/profiles/login). */
// PIN_SALT must be set via env — server will not start without it (see fail-fast above).
const PIN_SALT = process.env.PIN_SALT;
const bcrypt = require('bcryptjs');
function hashPin(pin) {
    return bcrypt.hashSync(String(pin), 12);
}
function isLegacySha256Hash(hash) {
    return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}
function legacyHashPin(pin) {
    return crypto.createHash('sha256').update(PIN_SALT + String(pin)).digest('hex');
}
function checkPin(pin, hash) {
    if (!hash) return false;
    if (isLegacySha256Hash(hash)) {
        return legacyHashPin(pin) === hash;
    }
    try {
        return bcrypt.compareSync(String(pin), hash);
    } catch {
        return false;
    }
}

// ── JWT config ────────────────────────────────────────────────────────────────
// JWT_SECRET must be set via env — server will not start without it.
const JWT_SECRET          = process.env.JWT_SECRET;
const JWT_EXPIRES_IN      = process.env.JWT_EXPIRES_IN      || '8h';   // user sessions
const JWT_ADMIN_EXPIRES_IN = process.env.JWT_ADMIN_EXPIRES_IN || '4h';  // admin sessions

function signUserToken(profile) {
    return jwt.sign(
        { sub: profile.id, role: profile.role || 'user', name: profile.name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function signAdminToken() {
    return jwt.sign(
        { sub: 'admin', role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_ADMIN_EXPIRES_IN }
    );
}

// Extract and verify JWT from Authorization: Bearer <token> header.
// Returns the decoded payload or null.
function verifyToken(req) {
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(auth.slice(7), JWT_SECRET);
    } catch {
        return null;
    }
}

function requireAdmin(req, res, next) {
    const payload = verifyToken(req);
    if (payload && payload.role === 'admin') return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Session auth — validates that the caller holds a valid signed JWT for a portal user.
// Falls back to legacy X-Session-Id header during migration.
async function requireSession(req, res, next) {
    // ── JWT path (preferred) ──────────────────────────────────────────────────
    const payload = verifyToken(req);
    if (payload && payload.role === 'user') {
        try {
            const profile = dataLayer.getProfileById(payload.sub);
            if (!profile) return res.status(401).json({ error: 'Invalid session' });
            req.sessionProfile = profile;
            return next();
        } catch(e) {
            console.error('[requireSession] Could not read profiles:', e.message);
            return res.status(503).json({ error: 'Service temporarily unavailable — drive may be offline' });
        }
    }
    // ── Legacy X-Session-Id fallback ──────────────────────────────────────────
    const sessionId = req.headers['x-session-id'] || '';
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const profile = dataLayer.getProfileById(sessionId);
        if (!profile) return res.status(401).json({ error: 'Invalid session' });
        req.sessionProfile = profile;
        next();
    } catch(e) {
        console.error('[requireSession] Could not read profiles:', e.message);
        res.status(503).json({ error: 'Service temporarily unavailable — drive may be offline' });
    }
}

app.post('/api/admin/login', checkRateLimit, (req, res) => {
    const { password } = req.body;
    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(ADMIN_PASSWORD);
    const received = Buffer.from(String(password || ''));
    const match = expected.length === received.length &&
                  crypto.timingSafeEqual(expected, received);
    if (match) {
        const token = signAdminToken();
        logActivity(req, 'admin_login', null);
        // SECURITY: the raw admin master password is never returned to clients.
        // All admin clients use this signed JWT for subsequent requests.
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Incorrect password' });
    }
});

app.get('/api/profiles', async (req, res) => { // NOTE: requires auth (see global /api middleware) — was made private in the CRIT-01 fix; login.html authenticates via /api/profiles/login instead, which IS public
    try {
        const list = dataLayer.getAllProfiles().map(p => ({
            id:        p.id,
            name:      p.name,
            position:  p.position,
            contact:   p.contact,
            email:     p.email,
            role:      p.role || 'user',
            signature: p.signature || null
        }));
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/profiles', requireAdmin, async (req, res) => {
    try {
        const { name, position, contact, email, pin, signature, role } = req.body;
        if (!name || !position || !contact || !email || !pin) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!/^\d{4}$/.test(String(pin))) {
            return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        }
        // Basic email format check
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const id = crypto.randomBytes(8).toString('hex');
        dataLayer.createProfile({
            id, name: sanitiseString(name, 100), position: sanitiseString(position, 100),
            contact: sanitiseString(contact, 50), email: sanitiseString(email, 200),
            role: role === 'admin' ? 'admin' : 'user', pinHash: hashPin(pin), signature: signature || null
        });
        logActivity(req, 'profile_created', `${name} (${email})`);
        res.json({ ok: true, id });
    } catch (e) {
        console.error('[POST /api/profiles]', e.message);
        if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use' });
        res.status(500).json({ error: 'Internal server error: ' + e.message });
    }
});

app.delete('/api/profiles/:id', requireAdmin, async (req, res) => {
    try {
        const _delId = decodeURIComponent(req.params.id);
        dataLayer.deleteProfile(_delId);
        logActivity(req, 'profile_deleted', _delId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/profiles/:id', requireAdmin, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const { name, position, contact, email, signature, role } = req.body;
        if (!name || !position || !contact || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const ok = dataLayer.updateProfile(id, {
            name: sanitiseString(name, 100), position: sanitiseString(position, 100),
            contact: sanitiseString(contact, 50), email: sanitiseString(email, 200),
            role: role === 'admin' ? 'admin' : 'user',
            signature: signature !== undefined ? signature : undefined
        });
        if (!ok) return res.status(404).json({ error: 'Profile not found' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/profiles/:id/pin', requireAdmin, async (req, res) => {
    try {
        const id  = decodeURIComponent(req.params.id);
        const { pin } = req.body;
        if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'Invalid PIN' });
        const ok = dataLayer.updateProfile(id, { pinHash: hashPin(pin) });
        if (!ok) return res.status(404).json({ error: 'Profile not found' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Emergency PIN reset — localhost only, no auth required ───────────────────
// Use this when ALL admin accounts are locked out (bootstrap recovery only).
// Only accepts requests from 127.0.0.1 — never reachable from the internet.
// Usage: POST /api/emergency/reset-pin  { email, pin }
app.post('/api/emergency/reset-pin', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) return res.status(403).json({ error: 'Localhost only' });

    const { email, pin } = req.body;
    if (!email || !pin || !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ error: 'Provide email and 4-digit pin' });
    }
    try {
        const profile = dataLayer.getProfileByEmail(email.trim());
        if (!profile) return res.status(404).json({ error: 'Email not found' });
        dataLayer.updateProfile(profile.id, { pinHash: hashPin(pin) });
        console.log(`[EMERGENCY RESET] PIN reset for: ${profile.name} (${email})`);
        res.json({ ok: true, name: profile.name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Self-update — user updates their own profile by verifying current PIN first
app.put('/api/profiles/:id/self', checkRateLimit, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const { currentPin, name, position, contact, email, newPin, signature } = req.body;

        if (!currentPin || !/^\d{4}$/.test(String(currentPin))) {
            return res.status(400).json({ error: 'Current PIN is required' });
        }
        if (!name || !position || !contact || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (newPin !== undefined && newPin !== '' && !/^\d{4}$/.test(String(newPin))) {
            return res.status(400).json({ error: 'New PIN must be 4 digits' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const profile = dataLayer.getProfileById(id);
        if (!profile || !checkPin(currentPin, profile.pinHash)) {
            // Return same error for not-found and wrong PIN (no enumeration)
            return res.status(401).json({ error: 'Incorrect PIN' });
        }

        const fields = {
            name: sanitiseString(name, 100), position: sanitiseString(position, 100),
            contact: sanitiseString(contact, 50), email: sanitiseString(email, 200)
        };
        if (newPin && /^\d{4}$/.test(String(newPin))) fields.pinHash = hashPin(newPin);
        if (signature !== undefined) fields.signature = signature;
        dataLayer.updateProfile(id, fields);

        const updated = dataLayer.getProfileById(id);
        const { pinHash, ...safe } = updated;
        res.json({ ok: true, profile: safe });
    } catch (e) {
        console.error('[PUT /api/profiles/:id/self]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login — rate-limited
app.post('/api/profiles/login', checkRateLimit, async (req, res) => {
    try {
        const { id, email, pin } = req.body;
        if ((!id && !email) || !pin) return res.status(400).json({ error: 'Missing credentials' });
        if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'Invalid PIN format' });

        const profile = id ? dataLayer.getProfileById(id) : dataLayer.getProfileByEmail(email.trim());
        if (!profile || !checkPin(pin, profile.pinHash)) {
            return res.status(401).json({ error: 'Incorrect email or PIN' });
        }
        // Transparently upgrade legacy SHA-256 PIN hashes to bcrypt now that we know the plaintext PIN was correct.
        if (isLegacySha256Hash(profile.pinHash)) {
            try { dataLayer.updateProfile(profile.id, { pinHash: hashPin(pin) }); } catch (e) { console.error('[PIN upgrade]', e.message); }
        }

        const { pinHash, ...safe } = profile;
        const token = signUserToken(safe);
        logActivity({ user: { sub: profile.id, role: profile.role, name: profile.name }, ip: req.ip }, 'staff_login', null);
        // Return both the JWT and the profile data so the client can display user info
        res.json({ ...safe, token });
    } catch (e) {
        console.error('[POST /api/profiles/login]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Self-service endpoints (authenticated by session id, no admin token) ─────
// Verifies that the JWT `sub` matches the :id param (user can only edit themselves).
// Falls back to legacy X-Session-Id header during migration.

function requireSelf(req, res, next) {
    const paramId = decodeURIComponent(req.params.id);
    // JWT path — any authenticated staff profile may edit their own record,
    // regardless of whether their profile role is 'user' or 'admin' (that
    // role only gates admin-only features elsewhere; it doesn't mean "not
    // allowed to touch your own profile"). Excludes only the fixed
    // super-admin token (sub:'admin' from signAdminToken()), which isn't
    // backed by a real profiles row anyway.
    const payload = verifyToken(req);
    if (payload && payload.sub && payload.sub !== 'admin') {
        if (payload.sub !== paramId) return res.status(401).json({ error: 'Unauthorized' });
        return next();
    }
    // Legacy fallback
    const sessionId = req.headers['x-session-id'] || '';
    if (!sessionId || sessionId !== paramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// PATCH /api/profiles/:id/self  — update name, contact, and/or signature
app.patch('/api/profiles/:id/self', checkRateLimit, requireSelf, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const { name, contact, signature } = req.body;

        const profile = dataLayer.getProfileById(id);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        const fields = {};
        if (name    !== undefined) fields.name    = sanitiseString(name,    100);
        if (contact !== undefined) fields.contact = sanitiseString(contact,  50);
        // signature can be null (remove) or a base64 data URL
        if (signature !== undefined) {
            if (signature === null) {
                fields.signature = null;
            } else if (typeof signature === 'string' && ['data:image/jpeg;base64', 'data:image/png;base64', 'data:image/jpg;base64'].some(prefix => signature.startsWith(prefix))) {
                // Limit to ~2 MB of base64 (~2.7 MB raw string)
                if (signature.length > 3 * 1024 * 1024) {
                    return res.status(400).json({ error: 'Signature image too large (max 2 MB)' });
                }
                fields.signature = signature;
            } else {
                return res.status(400).json({ error: 'Invalid signature format' });
            }
        }
        dataLayer.updateProfile(id, fields);

        res.json({ ok: true });
    } catch (e) {
        console.error('[PATCH /api/profiles/self]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/profiles/:id/self-pin  — change own PIN (requires current PIN)
app.patch('/api/profiles/:id/self-pin', checkRateLimit, requireSelf, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);
        const { currentPin, newPin } = req.body;

        if (!currentPin || !/^\d{4}$/.test(String(currentPin))) return res.status(400).json({ error: 'Invalid currentPin' });
        if (!newPin     || !/^\d{4}$/.test(String(newPin)))     return res.status(400).json({ error: 'Invalid newPin' });
        if (currentPin === newPin) return res.status(400).json({ error: 'New PIN must differ from current PIN' });

        const profile = dataLayer.getProfileById(id);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        if (!checkPin(currentPin, profile.pinHash)) return res.status(401).json({ error: 'Incorrect current PIN' });

        dataLayer.updateProfile(id, { pinHash: hashPin(newPin) });
        res.json({ ok: true });
    } catch (e) {
        console.error('[PATCH /api/profiles/self-pin]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Bulk Import API ───────────────────────────────────────────────────────────
// NOTE: /api/import/profiles, /api/import/quotes, /api/import/serials are
// disabled as of the SQLite migration. They used to overwrite the entire
// lp_profiles.json / lp_quotes.json / lp_serials.json file wholesale with a
// raw JSON blob from the request body — that pattern bypasses every
// constraint the new schema enforces (UNIQUE company keys, foreign keys,
// etc.) and risks silently corrupting the database if the blob is malformed.
// No frontend code calls these endpoints (verified before disabling), so
// this should be a no-op in practice. If a real bulk-import need comes up,
// build a proper endpoint that validates and inserts row-by-row through
// dataLayer, not a raw table replace.
app.post('/api/import/profiles', requireAdmin, async (req, res) => {
    res.status(410).json({ error: 'Disabled after SQLite migration — raw profile import bypassed schema constraints. Use POST /api/profiles per-record instead.' });
});

app.post('/api/import/quotes', requireAdmin, async (req, res) => {
    res.status(410).json({ error: 'Disabled after SQLite migration — raw quote import bypassed schema constraints. Use POST /api/quotes per-record instead.' });
});

app.post('/api/import/serials', requireAdmin, async (req, res) => {
    res.status(410).json({ error: 'Disabled after SQLite migration — use POST /api/serials/rebuild-from-quotes to recompute counters instead.' });
});

app.post('/api/import/clients-xlsx-preview', requireAdmin, express.json({ limit: '20mb' }), async (req, res) => {
    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return res.status(400).json({ error: 'Missing fileBase64' });

        const ExcelJS = getExcel();
        const buf  = Buffer.from(fileBase64, 'base64');
        const wb   = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const ws = wb.worksheets[0];
        if (!ws) return res.status(400).json({ error: 'No worksheet found in file' });

        // Build header map from row 1
        const headers = {};
        ws.getRow(1).eachCell((cell, colNum) => {
            headers[colNum] = String(cell.value || '').trim().toLowerCase();
        });

        const colMatch = (rowValues, ...candidates) => {
            for (const cand of candidates) {
                const col = Object.keys(headers).find(c => headers[c] === cand.toLowerCase());
                if (col) return String(rowValues[col] || '').trim();
            }
            for (const cand of candidates) {
                const col = Object.keys(headers).find(c => headers[c].startsWith(cand.toLowerCase()));
                if (col) return String(rowValues[col] || '').trim();
            }
            for (const cand of candidates) {
                const col = Object.keys(headers).find(c => headers[c].includes(cand.toLowerCase()));
                if (col) return String(rowValues[col] || '').trim();
            }
            return '';
        };

        const formatTel = (raw) => {
            const digits = raw.replace(/\D/g, '');
            if (digits.length === 11) return `${digits.slice(0,4)}-${digits.slice(4,7)}-${digits.slice(7)}`;
            if (digits.length === 10) return `0${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
            return raw;
        };

        const parsed = [];
        ws.eachRow((row, rowNum) => {
            if (rowNum === 1) return; // skip header
            const rv = row.values; // 1-indexed
            const companyName = (colMatch(rv, 'company name', 'company') || '').toUpperCase();
            if (!companyName) return;
            parsed.push({
                companyName,
                address:     colMatch(rv, 'address'),
                attentionTo: colMatch(rv, 'attention to', 'attention', 'contact person', 'attn'),
                contactNo:   formatTel(colMatch(rv, 'contact no.', 'contact no', 'phone', 'mobile', 'tel')),
                tin:         colMatch(rv, 'tin number', 'tin no.', 'tin no', 'tin'),
                salesRep:    colMatch(rv, 'sales rep', 'sales', 'rep'),
            });
        });

        res.json({ rows: parsed });
    } catch (e) {
        console.error('[import/clients-xlsx-preview]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/import/clients-confirm', requireAdmin, async (req, res) => {
    try {
        const { rows } = req.body;
        if (!rows || !Array.isArray(rows)) return res.status(400).json({ error: 'Missing rows' });

        let added = 0, updated = 0;
        const existingKeys = new Set(dataLayer.getClients().map(c => c._companyKey));

        rows.forEach(c => {
            const key = normalizeCompanyKey(c.companyName);
            if (!key) return;
            const isNew = !existingKeys.has(key);
            dataLayer.upsertClientRow({
                companyName: c.companyName, address: (c.address||'').trim(), attentionTo: (c.attentionTo||'').trim(),
                contactNo: (c.contactNo||'').trim(), tin: (c.tin||'').trim(), salesRep: (c.salesRep||'').trim(),
                mop: (c.mop||'').trim()
            });
            if (isNew) { added++; existingKeys.add(key); } else updated++;
        });

        res.json({ ok: true, added, updated });
    } catch (e) {
        console.error('[import/clients-confirm]', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ── HTML generators (keep originals — logic unchanged) ───────────────────────
// These functions are long and layout-specific; copy them verbatim from the
// original server.js. They are left out here to keep this diff-focused file
// readable — paste generateQuotationHTML() and generateJobOrderHTML() below.
// ─────────────────────────────────────────────────────────────────────────────

// Escape user-supplied text before injecting into HTML/PDF templates.
function escHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatPhone(raw) {
    const digits = raw.replace(/\D/g, '');
    // Philippine mobile: 11 digits starting with 09 → 0XXX XXX XXXX
    if (/^09\d{9}$/.test(digits)) {
        return digits.slice(0,4) + ' ' + digits.slice(4,7) + ' ' + digits.slice(7);
    }
    // International format: 639XXXXXXXXX → +63 9XX XXX XXXX
    if (/^639\d{9}$/.test(digits)) {
        return '+63 ' + digits.slice(2,5) + ' ' + digits.slice(5,8) + ' ' + digits.slice(8);
    }
    // Fallback: return as-is
    return raw;
}

function generateJobOrderHTML(data, logoBase64) {
    const logoSrc = logoBase64 || '';

    // Sanitise user-supplied fields before HTML injection
    const joClient    = escHtml(data.client    || '');
    const joSalesName = escHtml(data.salesName || '');
    const joDeadline  = escHtml(data.deadline  || '');
    const joSpecial   = escHtml(data.specialInstructions || '');
    const joDate      = escHtml(data.displayDate || '');
    const joTime      = escHtml(data.time || '');
    const joNumber    = escHtml(data.joNumber || '____');

    const COPY_THEMES = {
        'SALES COPY':       { accentBg:'#519ef3', accentText:'#fff' },
        'OPERATIONS COPY':  { accentBg:'#519ef3', accentText:'#fff' },
        'ACCOUNTING COPY':  { accentBg:'#d500d5', accentText:'#fff' },
        'PRINTING COPY':    { accentBg:'#f5c800', accentText:'#222' },
        'FINISHING COPY':   { accentBg:'#888888', accentText:'#fff' },
    };

    const B = '#333';
    const copies = ['SALES COPY','OPERATIONS COPY','ACCOUNTING COPY','PRINTING COPY','FINISHING COPY'];
    const SIGS   = ['Operations Manager','Printing Personnel','Finishing Personnel','Accounting Personnel'];
    const pageBreak = `<div style="page-break-before:always;"></div>`;

    // Which copies get image ref pages (when includeImageRef is true)
    const IMAGE_REF_COPIES = new Set(['OPERATIONS COPY', 'PRINTING COPY', 'FINISHING COPY']);

    const includeImageRef = !!data.includeImageRef;

    const buildPage = (copyLabel) => {
        const th = COPY_THEMES[copyLabel] || COPY_THEMES['SALES COPY'];
        const A = th.accentBg;
        const T = th.accentText;

        let itemRowsHTML = '';
        let imageRefBoxes = [];   // { seq, projectName, fileData, filename } — only items WITH images

        (data.groups || []).forEach(group => {
            const items = group.items || [];
            if (!items.length) return;

            const projDisplay = group.projectName
                ? `PROJECT NAME: &nbsp;<strong>${escHtml(group.projectName)}</strong>`
                : 'PROJECT NAME:';
            const ctrlTag = (group.ctrlNum && group.ctrlNum !== '—')
                ? `<span style="background:#1A2B45;color:#fff;border-radius:2px;padding:1px 6px;font-family:'Courier New',monospace;font-size:14px;margin-right:6px;">${escHtml(group.ctrlNum)}</span>`
                : '';

            itemRowsHTML += `
            <tr>
              <td colspan="13" style="background:${A};color:${T};font-weight:bold;font-size:16px;padding:4px 8px;border:1px solid ${B};">
                ${ctrlTag}${projDisplay}
              </td>
            </tr>`;

            items.forEach((item, localIdx) => {
                const localSeq = localIdx + 1;
                const hasImage = item.fileData && item.fileData.startsWith('data:image/');
                const chk = (v) => v ? `<span style="font-size:16px;font-weight:bold;">&#10003;</span>` : '';
                const uom = (item.sizeW || item.sizeH) ? (item.sizeUnit || 'ft') : '';

                // File cell: thumbnail for images, PDF icon for PDFs, filename text for others
                let fileCell = '';
                if (item.fileData && item.fileData.startsWith('data:image/') && !item.fileDataOrigPdf) {
                    fileCell = `<div style="text-align:center;"><img src="${item.fileData}" style="max-height:36px;max-width:60px;object-fit:contain;display:block;margin:0 auto;"></div>`
                             + `<div style="font-size:10px;word-break:break-all;text-align:center;color:#555;">${escHtml(item.filename||'')}</div>`;
                } else if (item.filename && item.filename.toLowerCase().endsWith('.pdf') || item.fileDataOrigPdf) {
                    fileCell = `<div style="text-align:center;font-size:20px;">📄</div>`
                             + `<div style="font-size:10px;word-break:break-all;text-align:center;color:#555;">${escHtml(item.filename||'')}</div>`;
                } else {
                    fileCell = escHtml(item.filename || '');
                }

                itemRowsHTML += `
                <tr style="height:28px;">
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(localSeq))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.sizeW||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:13px;color:#555;">x</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.sizeH||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(uom)}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${escHtml(item.media||item.material||'')}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.qty||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.eco)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.uv)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.plot)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.laser)}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};padding:2px 4px;">${fileCell}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${escHtml(item.otherDetails||'')}</td>
                </tr>`;

                // Only add to image ref if has actual image file
                if (hasImage) {
                    imageRefBoxes.push({
                        seq:         localSeq,
                        projectName: group.projectName || '',
                        fileData:    item.fileData,
                        filename:    item.filename || '',
                    });
                }
            });
        });

        // ── Build IMAGE REFERENCES page HTML ─────────────────────────────────
        // Layout grid based on count — prioritize large, clear images
        // 1 item  → 1 col × 1 row (centered, very large)
        // 2 items → 1 col × 2 rows
        // 3 items → 1 col × 3 rows
        // 4 items → 2 col × 2 rows
        // 5 items → 2 col: [3 top, 2 bottom] → just 2 cols, 3 rows
        // 6+      → 3 cols × N rows
        let imageRefPageHTML = '';
        if (imageRefBoxes.length > 0) {
            const count = imageRefBoxes.length;
            const cols  = count <= 3 ? 1 : count === 4 ? 2 : 3;
            const cellW = `${(100 / cols).toFixed(2)}%`;

            // Max image height — shrink as count grows so it fits 1 page
            const imgMaxH = count === 1 ? '580px'
                          : count === 2 ? '270px'
                          : count === 3 ? '170px'
                          : count === 4 ? '240px'
                          : count <= 6  ? '200px'
                          : '150px';

            let gridRows = '';
            for (let i = 0; i < imageRefBoxes.length; i += cols) {
                const rowItems = imageRefBoxes.slice(i, i + cols);
                const pad = cols - rowItems.length;
                gridRows += `<tr>`;
                rowItems.forEach(box => {
                    gridRows += `
                    <td style="width:${cellW};padding:10px 12px;vertical-align:top;text-align:center;border-right:1px solid #e0e0e0;border-bottom:1px solid #e0e0e0;">
                      <div style="font-size:12px;font-weight:bold;color:#1A2B45;margin-bottom:4px;text-align:left;">
                        #${box.seq}${box.projectName ? ' — ' + escHtml(box.projectName) : ''}
                      </div>
                      <img src="${box.fileData}" style="max-width:100%;max-height:${imgMaxH};object-fit:contain;display:block;margin:0 auto;">
                      <div style="font-size:10px;color:#666;margin-top:5px;word-break:break-all;">${escHtml(box.filename)}</div>
                    </td>`;
                });
                for (let p = 0; p < pad; p++) {
                    gridRows += `<td style="width:${cellW};border-bottom:1px solid #e0e0e0;"></td>`;
                }
                gridRows += `</tr>`;
            }

            imageRefPageHTML = `
<div class="jo-page" style="padding:16px;">
  <div style="font-weight:900;font-size:15px;letter-spacing:1px;text-transform:uppercase;
              color:#1A2B45;border-bottom:3px solid #1A2B45;padding-bottom:6px;margin-bottom:12px;">
    IMAGE REFERENCES
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;">
    ${gridRows}
  </table>
</div>`;
        }


        const pageHTML = `
<div class="jo-page">

  <!-- HEADER: logo centered | JOB ORDER accent | JO# + copy label merged accent -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};">
    <tr>
      <td style="width:22%;padding:6px 8px;border-right:2px solid ${B};text-align:center;vertical-align:middle;">
        ${logoSrc
          ? `<img src="${logoSrc}" alt="Launchpad" style="max-height:40px;max-width:120px;object-fit:contain;display:block;margin:0 auto;">`
          : `<span style="font-weight:900;font-size:18px;color:#1A2B45;">LAUNCHPAD</span>`}
      </td>
      <td style="text-align:center;font-size:20px;font-weight:900;letter-spacing:2px;
                 padding:10px 4px;background:${A};color:${T};border-right:2px solid ${B};">
        JOB ORDER
      </td>
      <td style="width:28%;background:${A};color:${T};padding:6px 10px;text-align:center;vertical-align:middle;">
        <div style="font-size:18px;font-weight:900;letter-spacing:1px;font-family:'Courier New',monospace;">JO${deriveJoYear(data)}-${joNumber}</div>
        <div style="font-size:13px;font-weight:bold;margin-top:3px;letter-spacing:0.5px;">${copyLabel}</div>
      </td>
    </tr>
  </table>

  <!-- CLIENT / DATE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="width:10%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">CLIENT:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};font-size:14px;font-weight:bold;">${joClient}</td>
      <td style="width:9%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">DATE:</td>
      <td style="padding:4px 8px;font-size:14px;">${joDate}</td>
    </tr>
    <tr>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">ISSUED BY:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};border-top:1px solid ${B};font-size:14px;">${joSalesName}</td>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">TIME:</td>
      <td style="padding:4px 8px;border-top:1px solid ${B};font-size:14px;">${joTime}</td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <thead>
      <tr style="background:${A};color:${T};">
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">#</th>
        <th colspan="4" style="text-align:center;padding:3px 1px;border:1px solid ${B};font-size:13px;">SIZE</th>
        <th rowspan="2" style="width:22%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">MEDIA</th>
        <th rowspan="2" style="width:6%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">QTY</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">GZ</th>
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">UV</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">PLOT</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">LASER</th>
        <th rowspan="2" style="width:13%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">FILE NAME</th>
        <th rowspan="2" style="text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">OTHER DETAILS</th>
      </tr>
      <tr style="background:${A};color:${T};">
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">W</th>
        <th style="width:3%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">x</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">H</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">UOM</th>
      </tr>
    </thead>
    <tbody>${itemRowsHTML}</tbody>
  </table>

  <!-- SCHEDULE / DELIVERY — content bold, centered, larger font -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        SCHEDULE / DELIVERY
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${joDeadline || '&nbsp;'}
      </td>
    </tr>
  </table>

  <!-- GENERAL REMARKS — content bold, centered, larger font -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        GENERAL REMARKS
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${joSpecial || '&nbsp;'}
      </td>
    </tr>
  </table>

  <!-- SIGNATURES — all black, no accent color, no ink waste -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      ${SIGS.map((name, i) => `
      <td style="width:25%;${i < SIGS.length-1 ? `border-right:1px solid ${B};` : ''}
                 padding:6px 8px 5px;text-align:center;vertical-align:bottom;">
        <div style="font-size:9px;color:#333;text-align:left;margin-bottom:18px;">Received by:</div>
        <div style="border-bottom:1px solid #333;margin:0 6px 3px;"></div>
        <div style="font-size:9px;color:#333;font-weight:bold;">${name}</div>
        <div style="font-size:8px;color:#555;">Name &amp; Date</div>
      </td>`).join('')}
    </tr>
  </table>

</div>`;
        return { html: pageHTML, imageRefPageHTML };
    };

    // ── Assemble pages in correct order ──────────────────────────────────────
    // 1. Sales Copy (no image ref)
    // 2. Operations Copy + Image Ref (optional)
    // 3. Accounting Copy (no image ref)
    // 4. Signed Quote/PO per group (optional, handled in route via pdf-lib)
    // 5. Printing Copy + Image Ref (optional)
    // 6. Finishing Copy + Image Ref (optional)

    const salesPage      = buildPage('SALES COPY');
    const opsPage        = buildPage('OPERATIONS COPY');
    const accountingPage = buildPage('ACCOUNTING COPY');
    const printingPage   = buildPage('PRINTING COPY');
    const finishingPage  = buildPage('FINISHING COPY');

    const parts = [];

    // 1. Sales Copy
    parts.push(salesPage.html);

    // 2. Operations Copy + optional Image Ref
    parts.push(pageBreak + opsPage.html);
    if (includeImageRef && opsPage.imageRefPageHTML)
        parts.push(pageBreak + opsPage.imageRefPageHTML);

    // 3. Accounting Copy
    parts.push(pageBreak + accountingPage.html);

    // 4. Printing Copy + optional Image Ref
    parts.push(pageBreak + printingPage.html);
    if (includeImageRef && printingPage.imageRefPageHTML)
        parts.push(pageBreak + printingPage.imageRefPageHTML);

    // 5. Finishing Copy + optional Image Ref
    parts.push(pageBreak + finishingPage.html);
    if (includeImageRef && finishingPage.imageRefPageHTML)
        parts.push(pageBreak + finishingPage.imageRefPageHTML);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Calibri,'Calibri',Arial,sans-serif; color:#000; background:white; }
  .jo-page { width:7.27in; margin:0 auto; padding:0; }
  table td, table th { vertical-align:middle; }
</style>
</head>
<body>
  ${parts.join('')}
</body>
</html>`;
}

// Parallel clone of generateJobOrderHTML for the Proofing module. Two content
// differences from JO (see task spec):
//   1. The "SCHEDULE / DELIVERY" section is renamed "IMAGE GUIDE" and renders
//      an optional uploaded reference image (imageGuideFileData) plus notes
//      text (imageGuideNotes), instead of just the deadline text.
//   2. Only 3 copies are generated (Operations, Printing, Finishing) instead
//      of JO's 5 — Sales Copy and Accounting Copy are dropped entirely, and
//      SIGS drops "Accounting Personnel" to match.
// Everything else (header/footer layout, items table, image reference pages,
// signature block styling, etc.) is identical to generateJobOrderHTML.
function generateProofingHTML(data, logoBase64) {
    const logoSrc = logoBase64 || '';

    // Sanitise user-supplied fields before HTML injection
    const prClient    = escHtml(data.client    || '');
    const prSalesName = escHtml(data.salesName || '');
    const prImgGuideNotes = escHtml(data.imageGuideNotes || '');
    const prImgGuideImg   = data.imageGuideFileData && data.imageGuideFileData.startsWith('data:image/')
        ? data.imageGuideFileData
        : '';
    const prSpecial   = escHtml(data.specialInstructions || '');
    const prDate      = escHtml(data.displayDate || '');
    const prTime      = escHtml(data.time || '');
    const prNumber    = escHtml(data.proofNumber || '____');

    const COPY_THEMES = {
        'OPERATIONS COPY':  { accentBg:'#519ef3', accentText:'#fff' },
        'PRINTING COPY':    { accentBg:'#f5c800', accentText:'#222' },
        'FINISHING COPY':   { accentBg:'#888888', accentText:'#fff' },
    };

    const B = '#333';
    const copies = ['OPERATIONS COPY','PRINTING COPY','FINISHING COPY'];
    const SIGS   = ['Operations Manager','Printing Personnel','Finishing Personnel'];
    const pageBreak = `<div style="page-break-before:always;"></div>`;

    // Which copies get image ref pages (when includeImageRef is true) — now
    // equal to the full copies list since Sales/Accounting were dropped.
    const IMAGE_REF_COPIES = new Set(['OPERATIONS COPY', 'PRINTING COPY', 'FINISHING COPY']);

    const includeImageRef = !!data.includeImageRef;

    const buildPage = (copyLabel) => {
        const th = COPY_THEMES[copyLabel] || COPY_THEMES['OPERATIONS COPY'];
        const A = th.accentBg;
        const T = th.accentText;

        let itemRowsHTML = '';
        let imageRefBoxes = [];   // { seq, projectName, fileData, filename } — only items WITH images

        (data.groups || []).forEach(group => {
            const items = group.items || [];
            if (!items.length) return;

            const projDisplay = group.projectName
                ? `PROJECT NAME: &nbsp;<strong>${escHtml(group.projectName)}</strong>`
                : 'PROJECT NAME:';
            const ctrlTag = (group.ctrlNum && group.ctrlNum !== '—')
                ? `<span style="background:#1A2B45;color:#fff;border-radius:2px;padding:1px 6px;font-family:'Courier New',monospace;font-size:14px;margin-right:6px;">${escHtml(group.ctrlNum)}</span>`
                : '';

            itemRowsHTML += `
            <tr>
              <td colspan="13" style="background:${A};color:${T};font-weight:bold;font-size:16px;padding:4px 8px;border:1px solid ${B};">
                ${ctrlTag}${projDisplay}
              </td>
            </tr>`;

            items.forEach((item, localIdx) => {
                const localSeq = localIdx + 1;
                const hasImage = item.fileData && item.fileData.startsWith('data:image/');
                const chk = (v) => v ? `<span style="font-size:16px;font-weight:bold;">&#10003;</span>` : '';
                const uom = (item.sizeW || item.sizeH) ? (item.sizeUnit || 'ft') : '';

                // File cell: thumbnail for images, PDF icon for PDFs, filename text for others
                let fileCell = '';
                if (item.fileData && item.fileData.startsWith('data:image/') && !item.fileDataOrigPdf) {
                    fileCell = `<div style="text-align:center;"><img src="${item.fileData}" style="max-height:36px;max-width:60px;object-fit:contain;display:block;margin:0 auto;"></div>`
                             + `<div style="font-size:10px;word-break:break-all;text-align:center;color:#555;">${escHtml(item.filename||'')}</div>`;
                } else if (item.filename && item.filename.toLowerCase().endsWith('.pdf') || item.fileDataOrigPdf) {
                    fileCell = `<div style="text-align:center;font-size:20px;">📄</div>`
                             + `<div style="font-size:10px;word-break:break-all;text-align:center;color:#555;">${escHtml(item.filename||'')}</div>`;
                } else {
                    fileCell = escHtml(item.filename || '');
                }

                itemRowsHTML += `
                <tr style="height:28px;">
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(localSeq))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.sizeW||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:13px;color:#555;">x</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.sizeH||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(uom)}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${escHtml(item.media||item.material||'')}</td>
                  <td style="text-align:center;border:1px solid ${B};font-size:14px;">${escHtml(String(item.qty||''))}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.eco)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.uv)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.plot)}</td>
                  <td style="text-align:center;border:1px solid ${B};">${chk(item.laser)}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};padding:2px 4px;">${fileCell}</td>
                  <td style="vertical-align:middle;border:1px solid ${B};font-size:14px;padding:2px 4px;">${escHtml(item.otherDetails||'')}</td>
                </tr>`;

                // Only add to image ref if has actual image file
                if (hasImage) {
                    imageRefBoxes.push({
                        seq:         localSeq,
                        projectName: group.projectName || '',
                        fileData:    item.fileData,
                        filename:    item.filename || '',
                    });
                }
            });
        });

        // ── Build IMAGE REFERENCES page HTML ─────────────────────────────────
        // Layout grid based on count — prioritize large, clear images
        // 1 item  → 1 col × 1 row (centered, very large)
        // 2 items → 1 col × 2 rows
        // 3 items → 1 col × 3 rows
        // 4 items → 2 col × 2 rows
        // 5 items → 2 col: [3 top, 2 bottom] → just 2 cols, 3 rows
        // 6+      → 3 cols × N rows
        let imageRefPageHTML = '';
        if (imageRefBoxes.length > 0) {
            const count = imageRefBoxes.length;
            const cols  = count <= 3 ? 1 : count === 4 ? 2 : 3;
            const cellW = `${(100 / cols).toFixed(2)}%`;

            // Max image height — shrink as count grows so it fits 1 page
            const imgMaxH = count === 1 ? '580px'
                          : count === 2 ? '270px'
                          : count === 3 ? '170px'
                          : count === 4 ? '240px'
                          : count <= 6  ? '200px'
                          : '150px';

            let gridRows = '';
            for (let i = 0; i < imageRefBoxes.length; i += cols) {
                const rowItems = imageRefBoxes.slice(i, i + cols);
                const pad = cols - rowItems.length;
                gridRows += `<tr>`;
                rowItems.forEach(box => {
                    gridRows += `
                    <td style="width:${cellW};padding:10px 12px;vertical-align:top;text-align:center;border-right:1px solid #e0e0e0;border-bottom:1px solid #e0e0e0;">
                      <div style="font-size:12px;font-weight:bold;color:#1A2B45;margin-bottom:4px;text-align:left;">
                        #${box.seq}${box.projectName ? ' — ' + escHtml(box.projectName) : ''}
                      </div>
                      <img src="${box.fileData}" style="max-width:100%;max-height:${imgMaxH};object-fit:contain;display:block;margin:0 auto;">
                      <div style="font-size:10px;color:#666;margin-top:5px;word-break:break-all;">${escHtml(box.filename)}</div>
                    </td>`;
                });
                for (let p = 0; p < pad; p++) {
                    gridRows += `<td style="width:${cellW};border-bottom:1px solid #e0e0e0;"></td>`;
                }
                gridRows += `</tr>`;
            }

            imageRefPageHTML = `
<div class="jo-page" style="padding:16px;">
  <div style="font-weight:900;font-size:15px;letter-spacing:1px;text-transform:uppercase;
              color:#1A2B45;border-bottom:3px solid #1A2B45;padding-bottom:6px;margin-bottom:12px;">
    IMAGE REFERENCES
  </div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;">
    ${gridRows}
  </table>
</div>`;
        }

        // ── Build IMAGE GUIDE cell content ────────────────────────────────────
        // Proofing-only difference from JO's "SCHEDULE / DELIVERY" section:
        // shows the optional uploaded reference image AND/OR the notes text.
        // Falls back to '&nbsp;' (like JO) when neither is present, so the
        // cell doesn't collapse to zero height.
        let imageGuideContent = '';
        if (prImgGuideImg) {
            imageGuideContent += `<img src="${prImgGuideImg}" style="max-height:220px;max-width:100%;object-fit:contain;display:block;margin:0 auto;">`;
        }
        if (prImgGuideNotes) {
            imageGuideContent += `<div style="${prImgGuideImg ? 'margin-top:8px;' : ''}">${prImgGuideNotes}</div>`;
        }
        if (!imageGuideContent) imageGuideContent = '&nbsp;';

        const pageHTML = `
<div class="jo-page">

  <!-- HEADER: logo centered | JOB ORDER accent | PR# + copy label merged accent -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};">
    <tr>
      <td style="width:22%;padding:6px 8px;border-right:2px solid ${B};text-align:center;vertical-align:middle;">
        ${logoSrc
          ? `<img src="${logoSrc}" alt="Launchpad" style="max-height:40px;max-width:120px;object-fit:contain;display:block;margin:0 auto;">`
          : `<span style="font-weight:900;font-size:18px;color:#1A2B45;">LAUNCHPAD</span>`}
      </td>
      <td style="text-align:center;font-size:20px;font-weight:900;letter-spacing:2px;
                 padding:10px 4px;background:${A};color:${T};border-right:2px solid ${B};">
        PROOFING
      </td>
      <td style="width:28%;background:${A};color:${T};padding:6px 10px;text-align:center;vertical-align:middle;">
        <div style="font-size:18px;font-weight:900;letter-spacing:1px;font-family:'Courier New',monospace;">PF${deriveJoYear(data)}-${prNumber}</div>
        <div style="font-size:13px;font-weight:bold;margin-top:3px;letter-spacing:0.5px;">${copyLabel}</div>
      </td>
    </tr>
  </table>

  <!-- CLIENT / DATE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="width:10%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">CLIENT:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};font-size:14px;font-weight:bold;">${prClient}</td>
      <td style="width:9%;font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};white-space:nowrap;">DATE:</td>
      <td style="padding:4px 8px;font-size:14px;">${prDate}</td>
    </tr>
    <tr>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">ISSUED BY:</td>
      <td style="padding:4px 8px;border-right:2px solid ${B};border-top:1px solid ${B};font-size:14px;">${prSalesName}</td>
      <td style="font-weight:bold;font-size:13px;padding:4px 6px;border-right:1px solid ${B};border-top:1px solid ${B};white-space:nowrap;">TIME:</td>
      <td style="padding:4px 8px;border-top:1px solid ${B};font-size:14px;">${prTime}</td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <thead>
      <tr style="background:${A};color:${T};">
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">#</th>
        <th colspan="4" style="text-align:center;padding:3px 1px;border:1px solid ${B};font-size:13px;">SIZE</th>
        <th rowspan="2" style="width:22%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">MEDIA</th>
        <th rowspan="2" style="width:6%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">QTY</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">GZ</th>
        <th rowspan="2" style="width:4%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">UV</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">PLOT</th>
        <th rowspan="2" style="width:5%;text-align:center;vertical-align:middle;padding:3px 1px;border:1px solid ${B};font-size:13px;">LASER</th>
        <th rowspan="2" style="width:13%;text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">FILE NAME</th>
        <th rowspan="2" style="text-align:center;vertical-align:middle;padding:3px 2px;border:1px solid ${B};font-size:13px;">OTHER DETAILS</th>
      </tr>
      <tr style="background:${A};color:${T};">
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">W</th>
        <th style="width:3%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">x</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">H</th>
        <th style="width:6%;text-align:center;padding:2px 1px;border:1px solid ${B};font-size:13px;">UOM</th>
      </tr>
    </thead>
    <tbody>${itemRowsHTML}</tbody>
  </table>

  <!-- IMAGE GUIDE — Proofing-only section, replaces JO's SCHEDULE / DELIVERY.
       Renders the optional uploaded reference image and/or notes text. -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        IMAGE GUIDE
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${imageGuideContent}
      </td>
    </tr>
  </table>

  <!-- GENERAL REMARKS — content bold, centered, larger font -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      <td style="background:${A};color:${T};font-weight:bold;font-size:13px;letter-spacing:1px;
                 text-transform:uppercase;text-align:center;padding:3px 6px;border-bottom:1px solid ${B};">
        GENERAL REMARKS
      </td>
    </tr>
    <tr>
      <td style="padding:10px 12px;font-size:16px;font-weight:bold;text-align:center;min-height:44px;">
        ${prSpecial || '&nbsp;'}
      </td>
    </tr>
  </table>

  <!-- SIGNATURES — all black, no accent color, no ink waste -->
  <table style="width:100%;border-collapse:collapse;border:2px solid ${B};border-top:none;">
    <tr>
      ${SIGS.map((name, i) => `
      <td style="width:${(100/SIGS.length).toFixed(2)}%;${i < SIGS.length-1 ? `border-right:1px solid ${B};` : ''}
                 padding:6px 8px 5px;text-align:center;vertical-align:bottom;">
        <div style="font-size:9px;color:#333;text-align:left;margin-bottom:18px;">Received by:</div>
        <div style="border-bottom:1px solid #333;margin:0 6px 3px;"></div>
        <div style="font-size:9px;color:#333;font-weight:bold;">${name}</div>
        <div style="font-size:8px;color:#555;">Name &amp; Date</div>
      </td>`).join('')}
    </tr>
  </table>

</div>`;
        return { html: pageHTML, imageRefPageHTML };
    };

    // ── Assemble pages in correct order ──────────────────────────────────────
    // 1. Operations Copy + Image Ref (optional)
    // 2. Signed Quote/PO per group (optional, handled in route via pdf-lib)
    // 3. Printing Copy + Image Ref (optional)
    // 4. Finishing Copy + Image Ref (optional)

    const opsPage       = buildPage('OPERATIONS COPY');
    const printingPage  = buildPage('PRINTING COPY');
    const finishingPage = buildPage('FINISHING COPY');

    const parts = [];

    // 1. Operations Copy + optional Image Ref
    parts.push(opsPage.html);
    if (includeImageRef && opsPage.imageRefPageHTML)
        parts.push(pageBreak + opsPage.imageRefPageHTML);

    // 2. Printing Copy + optional Image Ref
    parts.push(pageBreak + printingPage.html);
    if (includeImageRef && printingPage.imageRefPageHTML)
        parts.push(pageBreak + printingPage.imageRefPageHTML);

    // 3. Finishing Copy + optional Image Ref
    parts.push(pageBreak + finishingPage.html);
    if (includeImageRef && finishingPage.imageRefPageHTML)
        parts.push(pageBreak + finishingPage.imageRefPageHTML);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Calibri,'Calibri',Arial,sans-serif; color:#000; background:white; }
  .jo-page { width:7.27in; margin:0 auto; padding:0; }
  table td, table th { vertical-align:middle; }
</style>
</head>
<body>
  ${parts.join('')}
</body>
</html>`;
}

// Renders the reference-image strip that follows an item's row in the
// printed quotation, right inside the same items table (colspan across all
// 8 columns) — placed here rather than a separate summary page so whoever
// opens the PDF sees each photo next to the line item it actually belongs
// to. Only rendered when data.includeImageRef is true and the item actually
// has resolved images (see the /api/generate-quotation route, which
// populates item._resolvedImages with real data URLs before this template
// ever runs — this function never touches disk or tokens itself).
function refImagesRowHtml(item) {
    const imgs = item._resolvedImages || [];
    if (!imgs.length) return '';
    return `
        <tr>
          <td colspan="8" style="padding:6px 6px 12px;border-bottom:1px solid #eee;">
            <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;">
              <span style="font-size:10px;color:#888;padding-top:6px;white-space:nowrap;">Reference:</span>
              ${imgs.map(img => `
                <div style="width:70px;height:70px;background:#f1efe8;border:1px solid #ddd;border-radius:3px;overflow:hidden;">
                  <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:cover;">
                </div>
              `).join('')}
            </div>
          </td>
        </tr>`;
}

function generateQuotationHTML(data, logoBase64) {
    const formatCurrency = (num) =>
        parseFloat(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── VAT display modes ───────────────────────────────────────────────────
    // Three independent-looking checkboxes, but really 2 controls (mutually
    // exclusive in the UI — see index.html's includeVatCheck/vatExclusiveCheck
    // onchange handlers):
    //   - showVatBreakdown: adds an informational "VAT 12%" line under the
    //     footer. Doesn't touch any prices — Grand Total is unaffected. It's
    //     just "for reference, here's what 12% of this would be."
    //   - vatExAuto (only meaningful when data.vatExclusive is also true):
    //     actually recomputes every item's displayed Unit Price/Subtotal to
    //     be VAT-exclusive (divide by 1.12), and force-shows the VAT line
    //     (it's needed to explain how the shrunk Subtotal gets back to the
    //     same Grand Total the client actually pays).
    //   - vatExclusive without vatExAuto ("label-only"): the original/legacy
    //     behavior — just relabels Grand Total as "(VAT EX)", no recompute.
    // Grand Total itself (data.grandTotal, already post-discount — see the
    // "── Discount ──" block in /api/generate-quotation) is INVARIANT across
    // every mode: it's always the actual amount the client pays.
    const showVatBreakdown = !!data.includeVat;
    const vatExAuto        = !!(data.vatExclusive && data.vatExAuto);
    const showVatLine      = showVatBreakdown || vatExAuto;

    // Divides a VAT-inclusive figure into its VAT-exclusive equivalent for
    // display — applied whenever the table's prices should read VAT-ex:
    // vatExAuto (the dedicated "VAT exclusive + Auto-adjust" combo) OR
    // plain "Show VAT breakdown" (2026-07 request — the item table's own
    // Unit Price/Subtotal columns should already show VAT-ex figures,
    // matching the VAT-ex footer, instead of the table staying
    // VAT-inclusive while only the footer got adjusted). Each field (unit
    // price, row subtotal, running subtotal) is divided independently off
    // its own original VAT-inclusive value rather than re-derived from each
    // other, so a small (±0.01) rounding difference between "unit price ×
    // qty" and "row subtotal" is expected and normal — the VAT line below
    // always makes the column foot back to the real Grand Total regardless.
    const vatExDisplay = (amount) => {
        const n = parseFloat(amount) || 0;
        return (vatExAuto || showVatBreakdown) ? n / 1.12 : n;
    };

    // Column totals row shown right under the last item row. Pulls from
    // whichever item arrays actually got rendered above (grouped OR the
    // plain items/outsource/flat-rate arrays — never both), normalizing the
    // differing field names between grouped items (qty/computedUnitPrice)
    // and regular items (quantity/unitPrice/totalAmount).
    const _totalsSourceItems = (data.isGrouped && data.quoteGroups && data.quoteGroups.length)
        ? data.quoteGroups.flatMap(g => (g.items || []))
        : [
            ...data.items.filter(i => i.material !== 'grouped'),
            ...(data.outsourceItems || []),
            ...(data.flatRateItems || []),
          ];
    const _colTotals = _totalsSourceItems.reduce((acc, item) => {
        const price = parseFloat(item.unitPrice || item.computedUnitPrice || 0) || 0;
        const qty   = parseInt(item.qty || item.quantity || 0) || 0;
        const total = parseFloat(item.totalAmount != null ? item.totalAmount : (price * qty)) || 0;
        acc.qty      += qty;
        acc.subtotal += total;
        return acc;
    }, { qty: 0, subtotal: 0 });

    // preDiscountTotal (the original VAT-inclusive sum of every item, before
    // discount) and grandTotal (the final, post-discount, invariant figure
    // the client actually pays) are both already computed server-side in
    // /api/generate-quotation's "── Discount ──" block — reuse them rather
    // than re-deriving, so this always matches exactly.
    const preDiscountTotal = parseFloat(data.preDiscountTotal != null ? data.preDiscountTotal : _colTotals.subtotal) || 0;
    const discountAmt      = parseFloat(data.discountAmount) || 0;
    const finalGrandTotal  = parseFloat(data.grandTotal) || 0;

    // Footer "Subtotal" row — VAT-exclusive (÷1.12) in vatExAuto AND plain
    // "Show VAT breakdown" mode now, matching the item table above (both
    // now go through vatExDisplay's same condition) — this HAS to divide
    // preDiscountTotal, not finalGrandTotal, or it stops summing to what
    // the table's now-VAT-ex rows actually add up to whenever a discount
    // is applied.
    const footerSubtotal = (vatExAuto || showVatBreakdown) ? preDiscountTotal / 1.12 : preDiscountTotal;

    // VAT line amount: a balancing figure so Subtotal − Discount + VAT
    // === Grand Total exactly, regardless of any ÷1.12 rounding drift —
    // same formula for vatExAuto and plain showVatBreakdown now that both
    // divide the table's prices the same way.
    let vatLineAmount = 0;
    if (vatExAuto || showVatBreakdown) {
        vatLineAmount = finalGrandTotal - (footerSubtotal - discountAmt);
    }

    // "Show VAT breakdown" mode (informational-only, not vatExAuto) gets
    // its Subtotal row relabeled "SUB TOTAL VAT EX" per 2026-07 request —
    // value is the same footerSubtotal as vatExAuto, just a different
    // label since vatExAuto never renamed it away from "SUBTOTAL".
    const vatExOnlyBreakdown = showVatBreakdown && !vatExAuto;
    const subtotalLabel = vatExOnlyBreakdown ? 'SUB TOTAL VAT EX' : 'SUBTOTAL';
    const subtotalValue = footerSubtotal;

    // Grand Total label suffix — only needed when there's no VAT line above
    // to already make the treatment explicit.
    const gtSuffix = showVatLine ? '' : (data.vatExclusive ? ' (VAT EX)' : ' (VAT IN)');

    // Unified footer — same 4 rows (Subtotal / [Discount] / [VAT 12%] /
    // Grand Total) in every mode, using the same fixed 8-column layout as
    // the items table (colspan 6 + label cell + value cell). Discount row
    // is dropped entirely (not just zeroed) whenever there's no discount,
    // across every VAT mode — no more "DISCOUNT: PHP 0.00" clutter. Its
    // label no longer shows the "(10%)"-style percentage suffix either —
    // always just "DISCOUNT:", regardless of discount type.
    // Subtotal row itself is now also conditional (2026-07 request): with
    // no VAT breakdown and no discount, Subtotal and Grand Total are the
    // same number anyway — just show Grand Total alone instead of a
    // redundant "SUBTOTAL: X / GRAND TOTAL: X" pair.
    const showSubtotalRow = showVatLine || discountAmt > 0;

    const totalsRowHtml = `
      ${showSubtotalRow ? `
      <tr style="border-top:2px solid #333;">
        <td colspan="6"></td>
        <td class="text-right" style="white-space:nowrap;padding-top:10px;"><strong>${subtotalLabel}:</strong></td>
        <td class="text-right" style="white-space:nowrap;padding-top:10px;"><strong>PHP ${formatCurrency(subtotalValue)}</strong></td>
      </tr>` : ''}
      ${discountAmt > 0 ? `
      <tr>
        <td colspan="6"></td>
        <td class="text-right" style="font-size:11px;color:#555;white-space:nowrap;">DISCOUNT:</td>
        <td class="text-right" style="font-size:11px;color:#555;white-space:nowrap;">PHP ${formatCurrency(discountAmt)}</td>
      </tr>` : ''}
      ${showVatLine ? `
      <tr>
        <td colspan="6"></td>
        <td class="text-right" style="font-size:11px;color:#555;white-space:nowrap;font-style:italic;">VAT 12%:</td>
        <td class="text-right" style="font-size:11px;color:#555;white-space:nowrap;font-style:italic;">PHP ${formatCurrency(vatLineAmount)}</td>
      </tr>` : ''}
      <tr class="total-row">
        <td colspan="6"></td>
        <td class="text-center" style="white-space:nowrap;">GRAND TOTAL${gtSuffix}:</td>
        <td class="text-right">PHP ${formatCurrency(finalGrandTotal)}</td>
      </tr>`;

    const logoSrc = logoBase64 || '';
    const logoTag = logoSrc
        ? `<img src="${logoSrc}" alt="Launchpad Logo" style="max-width:250px;height:auto;margin-bottom:10px;">`
        : `<div style="font-size:20px;font-weight:bold;margin-bottom:10px;">LAUNCHPAD HOLDINGS OPC</div>`;

    // Revision badge for the PDF
    const revNum    = parseInt(data.revisionNumber) || 0;
    const revBadge  = revNum > 0
        ? `<span style="display:inline-block;background:#e74c3c;color:white;font-size:11px;font-weight:bold;padding:2px 8px;border-radius:3px;margin-left:8px;">Rev ${revNum}</span>`
        : '';

    // Sanitise all user-supplied text fields before HTML injection
    const d = {
        company:      escHtml(data.company),
        address:      escHtml(data.address),
        tin:          escHtml(data.tin),
        attentionTo:  escHtml(data.attentionTo),
        projectName:  escHtml(data.projectName),
        date:         escHtml(data.date),
        tel:          escHtml(formatPhone(data.tel || '')),
        controlNumber:escHtml(data.controlNumber),
        salesContact: escHtml(data.salesContact || ''),
        salesEmail:   escHtml(data.salesEmail   || ''),
        salesName:    escHtml(data.salesName    || ''),
        salesPosition:escHtml(data.salesPosition || ''),
        leadTime:     escHtml(data.leadTime     || '____'),
        paymentTerms: escHtml(data.paymentTerms || 'COD for first time customers'),
    };

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; color: #000; font-size: 13px; line-height: 1.4; width: 7.5in; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 25px; position: relative; }
    .company-info { font-size: 11px; color: #333; margin-top: 5px; line-height: 1.5; }
    .title { font-size: 22px; font-weight: bold; margin: 20px 0; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Control number — top-right corner */
    .ctrl-block {
        position: absolute;
        top: 0;
        right: 0;
        text-align: right;
        font-size: 11px;
        color: #555;
        line-height: 1.6;
    }
    .ctrl-block .ctrl-num {
        font-size: 13px;
        font-weight: bold;
        color: #2c3e50;
        font-family: 'Courier New', monospace;
        letter-spacing: 0.5px;
    }

    /* Info block. Two layouts:
       - .info-row.two-col (Company/Date, TIN #/Contact No.): a 4-column
         GRID (label|value|label|value), not flex — this is what actually
         guarantees "Date:" and "Contact No.:" start at the same x as each
         other (their own fixed 110px column), the same way "Company:"/
         "TIN #:"/"Attention To:" already align on the left. Flex-based
         "shrink to content" sizing (tried earlier) can't do this: each
         right-side label would sit wherever its OWN row's value happened
         to end, which drifts row to row depending on value length — the
         exact misalignment being fixed here. The left value column gets
         2fr vs the right value's 1fr so long company names get most of
         the room, since Date/Contact No. rarely need much.
       - .info-row (Attention To/Address/Project): plain flex, label
         (110px) + value (flex-grow:1) spanning the FULL row width, so long
         values (esp. Address) wrap within the whole page width instead of
         a narrow column. */
    .info-container { margin-bottom: 20px; }
    .info-row { display: flex; margin-bottom: 6px; }
    /* column-gap:0 so label→value stays flush (matching the solo flex
       rows below, which have no gap either) — the visual gap belongs only
       BEFORE the second label, added as padding-right on the first value
       (2nd grid child) instead of a uniform column-gap, which was pushing
       Company's/TIN #'s own value away from its label too and misaligning
       it against Attention To/Address/Project's flush label+value. */
    .info-row.two-col { display: grid; grid-template-columns: 110px 2fr 110px 1fr; column-gap: 0; }
    .info-row.two-col > .value:nth-child(2) { padding-right: 12px; }
    .label { font-weight: bold; width: 110px; flex-shrink: 0; }
    .value { flex-grow: 1; }

    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 10px 6px; text-align: left; font-weight: bold; }
    td { padding: 10px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    .text-center { text-align: center; }
    .text-right  { text-align: right; }
    .total-row td { font-weight: bold; border-top: 1px solid #000; border-bottom: 1px solid #000; padding-top: 12px; }

    .terms-section { margin: 20px 0; font-size: 11.5px; line-height: 1.5; }
    .terms-section p { margin: 1.5em 0 0 0; }
    .terms-section p:first-child { margin-top: 0; }
    .signature-container { margin-top: 40px; display: flex; justify-content: space-between; }
    .sig-box { width: 45%; }
    .sig-line { border-top: 1px solid #000; margin-top: 50px; padding-top: 5px; width: 220px; }
  </style>
</head>
<body>
  <div class="header">
    ${logoTag}
    <div class="company-info">
      Unit 3006 One Corporate Centre Building, Julia Vargas Avenue,<br>
      Ortigas Center San Antonio Pasig City<br>
      ${d.salesContact} / ${d.salesEmail}
    </div>

    <!-- Control Number top-right -->
    <div class="ctrl-block">
      <div>Control No.</div>
      <div class="ctrl-num">${d.controlNumber}${revBadge}</div>
    </div>
  </div>

  <div class="title">PRICE QUOTATION</div>

  <div class="info-container">
    <div class="info-row two-col">
      <span class="label">Company:</span><span class="value">${d.company}</span>
      <span class="label">Date:</span><span class="value">${d.date}</span>
    </div>
    <div class="info-row two-col">
      <span class="label">TIN #:</span><span class="value">${d.tin}</span>
      <span class="label">Contact No.:</span><span class="value">${d.tel}</span>
    </div>
    <div class="info-row"><span class="label">Attention To:</span><span class="value">${d.attentionTo}</span></div>
    <div class="info-row"><span class="label">Address:</span><span class="value">${d.address}</span></div>
    ${data.projectName ? `<div class="info-row"><span class="label">Project:</span><span class="value" style="font-weight:bold;color:#2c3e50;">${d.projectName}</span></div>` : ''}
  </div>

  <p style="margin-bottom: 15px;"><strong>To Whom It May Concern,</strong></p>
  <p style="margin-bottom: 20px;">Greetings! Thank you for giving us an opportunity to serve you. Here is our quotation for the following items for your consideration and approval.</p>

  <table>
    <thead>
      <tr>
        <th style="width:31%;">Materials</th>
        <th class="text-center" style="width:8%;">W</th>
        <th class="text-center" style="width:3%;"></th>
        <th class="text-center" style="width:8%;">H</th>
        <th class="text-center" style="width:10%;">UOM</th>
        <th class="text-right"  style="width:15%;">Unit Price</th>
        <th class="text-center" style="width:8%;">Qty</th>
        <th class="text-right"  style="width:16%;">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${data.isGrouped && data.quoteGroups && data.quoteGroups.length ? (() => {
        const renderItem = (item) => {
            const price = parseFloat(item.unitPrice || item.computedUnitPrice || 0);
            const qty   = parseInt(item.qty || item.quantity || 0);
            const total = (price * qty).toFixed(2);
            if (item._type === 'flat') return `
            <tr>
              <td>${escHtml(item.material || '')}</td>
              <td class="text-center"></td><td class="text-center"></td>
              <td class="text-center"></td><td class="text-center"></td>
              <td class="text-right">${price ? formatCurrency(vatExDisplay(price)) : ''}</td>
              <td class="text-center">${qty || ''}</td>
              <td class="text-right">${formatCurrency(vatExDisplay(total))}</td>
            </tr>`;
            return `
            <tr>
              <td>${escHtml(item.material || '')}</td>
              <td class="text-center">${item.sizeW ? escHtml(String(item.sizeW)) : '—'}</td>
              <td class="text-center">${item.sizeW && item.sizeH ? 'x' : ''}</td>
              <td class="text-center">${item.sizeH ? escHtml(String(item.sizeH)) : '—'}</td>
              <td class="text-center">${escHtml(item.sizeUnit || '')}</td>
              <td class="text-right">${price ? formatCurrency(vatExDisplay(price)) : ''}</td>
              <td class="text-center">${qty || ''}</td>
              <td class="text-right">${formatCurrency(vatExDisplay(total))}</td>
            </tr>`;
        };
        return data.quoteGroups.map(g => `
            <tr>
              <td colspan="8" style="background:#4A90E2;color:white;font-weight:bold;font-size:13px;text-align:center;padding:6px 8px;letter-spacing:0.5px;">
                ${escHtml(g.name || 'GROUP')}
              </td>
            </tr>
            ${(g.items || []).map(renderItem).join('')}
        `).join('');
      })() : `
      ${data.items.filter(i => i.material !== 'grouped').map(item => `
        <tr>
          <td>${escHtml(item.material || '')}</td>
          <td class="text-center">${item.sizeW !== '' && item.sizeW != null ? escHtml(String(item.sizeW)) : '—'}</td>
          <td class="text-center">${(item.sizeW !== '' && item.sizeW != null && item.sizeH !== '' && item.sizeH != null) ? 'x' : ''}</td>
          <td class="text-center">${item.sizeH !== '' && item.sizeH != null ? escHtml(String(item.sizeH)) : '—'}</td>
          <td class="text-center">${escHtml(item.sizeUnit || '')}</td>
          <td class="text-right">${item.unitPrice ? formatCurrency(vatExDisplay(item.unitPrice)) : ''}</td>
          <td class="text-center">${escHtml(String(item.quantity || ''))}</td>
          <td class="text-right">${formatCurrency(vatExDisplay(item.totalAmount))}</td>
        </tr>
        ${refImagesRowHtml(item)}
      `).join('')}
      ${(data.outsourceItems || []).map(item => `
        <tr>
          <td>${escHtml(item.material || '')}</td>
          <td class="text-center">${item.sizeW ? escHtml(String(item.sizeW)) : '—'}</td>
          <td class="text-center">${(item.sizeW && item.sizeH) ? 'x' : ''}</td>
          <td class="text-center">${item.sizeH ? escHtml(String(item.sizeH)) : '—'}</td>
          <td class="text-center">${escHtml(item.sizeUnit || '')}</td>
          <td class="text-right">${item.unitPrice ? formatCurrency(vatExDisplay(item.unitPrice)) : ''}</td>
          <td class="text-center">${escHtml(String(item.quantity || ''))}</td>
          <td class="text-right">${formatCurrency(vatExDisplay(item.totalAmount))}</td>
        </tr>
      `).join('')}
      ${(data.flatRateItems || []).map(item => `
        <tr>
          <td>${escHtml(item.material || '')}</td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-center"></td>
          <td class="text-right">${item.unitPrice ? formatCurrency(vatExDisplay(item.unitPrice)) : ''}</td>
          <td class="text-center">${escHtml(String(item.quantity || ''))}</td>
          <td class="text-right">${formatCurrency(vatExDisplay(item.totalAmount))}</td>
        </tr>
      `).join('')}`}
      ${totalsRowHtml}
    </tbody>
  </table>

  <p style="margin-top: 5px;"><strong>LEAD TIME:</strong> ${d.leadTime} Working Days, Upon Confirmation</p>
  <!-- ── Terms always start on a new page ── -->
  <div class="terms-section" style="page-break-before: always;">
    <p style="margin-bottom:8px;"><strong>TERMS &amp; CONDITIONS:</strong></p>

    <p><strong>Price Validity: 15 Days</strong></p>

    <p><em>*Sundays and holidays are not included in the cost.</em></p>

    <p><strong>Payment Terms: ${d.paymentTerms}.<br>
    We require at least 50% down payment for bulk orders (Php 500k and above) and customized/personalized items before production starts. Email or text us to let us know when payment is made for confirmation purposes. Once payment is confirmed or cleared (for cheque payments) we will arrange the design proofing &amp; production of your order as soon as possible.</strong></p>

    <p>
      <strong>*After design proof/sample approval no revisions/refunds can be made unless approved by both parties<br>
      *Above prices may vary depending on design and quantity<br>
      *Prices for other plastic banner/poster designs are also available upon request<br>
      *Prices are subject to change without prior notice</strong>
    </p>

    ${(function(){
      var banks = data.bankDetails ? data.bankDetails.split(',') : ['bdo','ub','gcash'];
      var has = function(v){ return banks.includes(v); };
      var out = '';
      if(has('bdo'))   out += '<p><strong>Bank Payment Details:<br>Banco De Oro (BDO)<br>Bank Account Name: LAUNCHPAD HOLDINGS OPC<br>Bank Account Number: 000668097626</strong></p>';
      if(has('ub'))    out += '<p><strong>Bank Payment Details:<br>UnionBank (UB)<br>Bank Account Name: LAUNCHPAD HOLDINGS OPC<br>Bank Account Number: 000910035428</strong></p>';
      if(has('gcash')) out += '<p><strong>GCash:<br>Account Name: V******* T.<br>Account Number: 0961 929 3603</strong></p>';
      return out;
    })()}

    <p>
      1. Late Payments shall be charge a penalty of 2% per month compounded or 24% Annually. Partial Payments shall be first applied to accumulated penalties, interest, then principal balance in that order.<br>
      2. This quotation serves as the official agreement between LAUNCHPAD HOLDINGS OPC and the COMPANY listed above.<br>
      3. A high resolution file should be supplied by the client.<br>
      4. Should the client decide to terminate the contract during fabrication and design conception including mock-up/sampler, a bill will still be issued up to the point where the project has been stopped.<br>
      5. The fees/breakdown is PACKAGED COST, Launchpad Holdings OPC shall not forbear liquidation.
    </p>

    <p>
      <strong>COLOR &amp; APPEARANCE DISCLAIMER:</strong><br>
      Due to the many variations in monitors and browsers, color samples and appearance may appear different on different monitors. Computer and mobile device monitors are not all calibrated equally and color and appearance reproduction on the internet is not precise. Since it is not possible to guarantee our online colors and appearance will look the same on all computers and devices, we cannot guarantee that what you see on your monitors accurately portrays the color and appearance of the actual finished product.
    </p>

    <p>
      We hope that this quotation merits your humble company's approval.<br>
      As you signify your conformity, this letter shall serve as our contract.
    </p>
  </div>

  <div class="signature-container">
    <div class="sig-box">
      <p><strong>Sincerely,</strong></p>
      <div style="position:relative;height:70px;">
        ${data.salesSignature
          ? `<img class="sig-auto-crop" src="${data.salesSignature}" alt="Signature" style="position:absolute;bottom:0;left:0;width:220px;height:auto;max-height:70px;object-fit:contain;">`
          : ''
        }
      </div>
      <div class="sig-line" style="margin-top:0;">
        <strong>${d.salesName}</strong><br>
        ${d.salesPosition}
      </div>
    </div>
    <div class="sig-box" style="display:flex;flex-direction:column;align-items:flex-end;">
      <div style="width:220px;">
        <p><strong>Conforme:</strong></p>
        <div style="border:1px dashed #000;height:80px;margin:15px 0;"></div>
        <p style="text-align:center;font-size:11px;font-weight:bold;">Authorized Signature / Date</p>
      </div>
    </div>
  </div>
</body>
</html>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────


// ── Widget positions per user ─────────────────────────────────────────────
// Verifies the caller's JWT identity (sub/id or name) matches the :username
// route param, so one user can't read or overwrite another user's notes/widgets
// just by knowing/guessing their username (audit 2.1).
function requireOwnUsername(req, res, next) {
    const paramUser = decodeURIComponent(req.params.username);
    const payload = verifyToken(req);
    if (payload && payload.role === 'user' && (payload.sub === paramUser || payload.name === paramUser)) {
        return next();
    }
    if (payload && payload.role === 'admin') return next(); // admins may inspect/fix any user's data
    // Legacy X-Session-Id fallback
    const sessionId = req.headers['x-session-id'] || '';
    if (sessionId && sessionId === paramUser) return next();
    return res.status(403).json({ error: 'Forbidden: cannot access another user\'s data' });
}

app.get('/api/widgets/:username', requireOwnUsername, async (req, res) => {
    try { const db = await readJSON(WIDGETS_FILE); res.json(db[req.params.username] || {}); }
    catch(e) { res.json({}); }
});
app.post('/api/widgets/:username', requireOwnUsername, async (req, res) => {
    try {
        // Guard against bloated payloads (widget config should never exceed 256 KB)
        const raw = JSON.stringify(req.body);
        if (raw.length > 256 * 1024) return res.status(413).json({ error: 'Widget data too large (max 256 KB)' });
        await withFileLock(WIDGETS_FILE, async () => {
            const db = await readJSON(WIDGETS_FILE);
            db[req.params.username] = req.body;
            await writeJSON(WIDGETS_FILE, db);
        });
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Notes per user ────────────────────────────────────────────────────────
app.get('/api/notes/:username', requireOwnUsername, async (req, res) => {
    try { const db = await readJSON(NOTES_FILE); res.json(db[req.params.username] || []); }
    catch(e) { res.json([]); }
});
app.post('/api/notes/:username', requireOwnUsername, async (req, res) => {
    try {
        // Guard against bloated payloads (notes should never exceed 512 KB)
        const raw = JSON.stringify(req.body);
        if (raw.length > 512 * 1024) return res.status(413).json({ error: 'Notes data too large (max 512 KB)' });
        await withFileLock(NOTES_FILE, async () => {
            const db = await readJSON(NOTES_FILE);
            db[req.params.username] = req.body;
            await writeJSON(NOTES_FILE, db);
        });
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Announcement banner (manual, admin-triggered) ────────────────────────────
// Replaces the earlier auto-detect-a-new-deploy notifier: instead of guessing
// from a server-restart stamp, an admin explicitly posts a message from the
// menu.html announcement button, and every active session polling this
// endpoint (see public/update-notifier.js) shows it as a top banner. Kept as
// a single-object JSON file — same low-traffic/low-stakes pattern as
// WIDGETS_FILE/NOTES_FILE above, no need for a SQLite table.
app.get('/api/announcement', async (req, res) => {
    try {
        const data = await readJSON(ANNOUNCEMENT_FILE);
        res.json(data && data.id ? data : {});
    } catch (e) { res.json({}); }
});

app.post('/api/announcement', requireAdmin, async (req, res) => {
    try {
        const message = sanitiseString(req.body && req.body.message, 500);
        if (!message) return res.status(400).json({ error: 'Message is required.' });
        const forceReload = !!(req.body && req.body.forceReload);
        // Force-reload always implies the button (it's how someone skips the
        // countdown), regardless of what the client sent for showReload.
        const showReload = forceReload || !!(req.body && req.body.showReload);
        const announcement = {
            id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            message,
            showReload,
            forceReload,
            postedBy: (req.user && req.user.name) || 'Admin',
            postedAt: Date.now(),
        };
        await withFileLock(ANNOUNCEMENT_FILE, async () => {
            await writeJSON(ANNOUNCEMENT_FILE, announcement);
        });
        logActivity(req, 'announcement_posted', `${message}${forceReload ? ' [force-reload]' : showReload ? ' [reload button]' : ''}`);
        res.json({ ok: true, announcement });
    } catch (e) {
        console.error('[POST /api/announcement]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/announcement', requireAdmin, async (req, res) => {
    try {
        await withFileLock(ANNOUNCEMENT_FILE, async () => {
            await writeJSON(ANNOUNCEMENT_FILE, {});
        });
        logActivity(req, 'announcement_cleared', null);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DELETE /api/announcement]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ══════════════════════════════════════════════════════════════════════════════
// GROUP CHAT
// Messages stored in lp_chat.json as an array (newest last), max 500 kept.
// Real-time delivery via Server-Sent Events — each connected client gets an
// open /api/chat/stream connection; posting a message broadcasts to all.
// ══════════════════════════════════════════════════════════════════════════════

const _chatClients = new Set(); // active SSE response objects

// Broadcast a message object to all connected SSE clients
function chatBroadcast(msg) {
    const data = 'data: ' + JSON.stringify(msg) + '\n\n';
    for (const res of _chatClients) {
        try { res.write(data); } catch {}
    }
}

// GET /api/chat/history — last N messages
app.get('/api/chat/history',  async (req, res) => {
    try {
        const db  = await readJSON(CHAT_FILE);
        const msgs = Array.isArray(db) ? db : [];
        res.json(msgs.slice(-200)); // send last 200
    } catch { res.json([]); }
});

// GET /api/chat/stream — SSE stream for real-time messages
app.get('/api/chat/stream',  (req, res) => {
    res.setHeader('Content-Type',       'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control',      'no-cache, no-transform');
    res.setHeader('Connection',         'keep-alive');
    res.setHeader('X-Accel-Buffering',  'no');   // nginx
    res.setHeader('X-Cloudflare-No-Transform', 'true');
    res.setHeader('Transfer-Encoding',  'identity');
    res.flushHeaders();
    // Immediately flush an initial comment so Cloudflare knows this is streaming
    res.write(': connected\n\n');

    // Heartbeat every 15s (shorter than Cloudflare's 100s SSE timeout)
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);

    _chatClients.add(res);
    req.on('close', () => {
        clearInterval(hb);
        _chatClients.delete(res);
    });
});

// POST /api/chat/send — post a message
app.post('/api/chat/send', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });

        // Derive sender identity from the authenticated session rather than
        // trusting the request body — prevents impersonating other users'
        // display names in chat (audit 2.2).
        let sender = '';
        let senderId = '';
        const payload = verifyToken(req);
        if (payload && payload.role === 'user') {
            sender = payload.name || '';
            senderId = payload.sub || '';
        } else if (payload && payload.role === 'admin') {
            sender = 'Admin';
            senderId = 'admin';
        } else {
            // Legacy X-Session-Id fallback — resolve the display name server-side too
            const sessionId = req.headers['x-session-id'] || '';
            if (sessionId) {
                try {
                    const profile = dataLayer.getProfileById(sessionId);
                    if (profile) { sender = profile.name; senderId = profile.id; }
                } catch {}
            }
        }
        if (!sender) return res.status(401).json({ error: 'Not authenticated' });

        const msg = {
            id:       crypto.randomBytes(8).toString('hex'),
            sender:   sanitiseString(sender, 100),
            senderId: senderId || '',
            text:     text.trim().slice(0, 2000),
            ts:       Date.now()
        };

        // Persist
        await withFileLock(CHAT_FILE, async () => {
            let db = await readJSON(CHAT_FILE);
            if (!Array.isArray(db)) db = [];
            db.push(msg);
            if (db.length > 500) db = db.slice(-500); // keep last 500
            await writeJSON(CHAT_FILE, db);
        });

        // Broadcast to all SSE clients
        chatBroadcast(msg);

        res.json({ ok: true, msg });
    } catch (e) {
        console.error('[POST /api/chat/send]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/suggestions — submit feedback via the FAB "Suggestion" form on
// the Quotation/Job Order/Proofing pages. Identity is derived from the
// authenticated session (same approach as /api/chat/send) rather than
// trusting a client-supplied name, so submissions can't be spoofed.
app.post('/api/suggestions', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || !text.trim()) return res.status(400).json({ error: 'Empty suggestion' });

        let userName = '';
        let userId   = '';
        let role     = '';
        const payload = verifyToken(req);
        if (payload && payload.role === 'user') {
            userName = payload.name || '';
            userId   = payload.sub || '';
            role     = 'user';
        } else if (payload && payload.role === 'admin') {
            userName = 'Admin';
            userId   = 'admin';
            role     = 'admin';
        } else {
            // Legacy X-Session-Id fallback — resolve identity server-side too
            const sessionId = req.headers['x-session-id'] || '';
            if (sessionId) {
                try {
                    const profile = dataLayer.getProfileById(sessionId);
                    if (profile) { userName = profile.name; userId = profile.id; role = profile.role || 'user'; }
                } catch {}
            }
        }
        if (!userName) return res.status(401).json({ error: 'Not authenticated' });

        const row = dataLayer.addSuggestion({
            userId,
            userName: sanitiseString(userName, 100),
            role,
            text: sanitiseString(text, 2000)
        });
        res.json({ ok: true, suggestion: row });
    } catch (e) {
        console.error('[POST /api/suggestions]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/suggestions — admin-only listing for the dashboard's Suggestions tab
app.get('/api/suggestions', requireAdmin, async (req, res) => {
    try {
        res.json(dataLayer.getAllSuggestions());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PATCH /api/suggestions/:id — admin-only, toggle resolved/unresolved
app.patch('/api/suggestions/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const row = dataLayer.setSuggestionResolved(id, !!(req.body && req.body.resolved));
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true, suggestion: row });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/suggestions/:id — admin-only
app.delete('/api/suggestions/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        dataLayer.deleteSuggestion(id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/open-file',  (req, res) => {
    try {
        const { filePath } = req.body;
        if (!filePath || typeof filePath !== 'string') {
            return res.status(400).json({ error: 'Missing filePath' });
        }
        // Security: only allow files inside known folders, resolved via realpath
        // to defeat UNC-path / symlink-chain sandbox bypasses (see audit 1.5).
        const normalized = resolveSandboxedFile(filePath);
        if (!normalized) {
            return res.status(403).json({ error: 'Access denied' });
        }
        // Windows: open file with its default application (e.g. Adobe, Edge PDF viewer)
        require('child_process').spawn('cmd.exe', ['/c', 'start', '', normalized], {
            detached: true, stdio: 'ignore'
        }).unref();
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/open-file]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// NOTE: a /api/show-in-folder endpoint (explorer.exe /select) briefly lived
// here (2026-07) but was reverted — it only ever opens Explorer on the
// SERVER's own machine, not on whichever user's machine clicked the button.
// True "reveal in folder" on the CLIENT's own PC isn't achievable from a web
// page without either a native helper/protocol handler installed on every
// user's machine, or the File System Access API's native Save dialog (both
// considered too complicated for now — see chat 2026-07-14). Toast buttons
// are back to the original "Open File" (browser-tab stream via
// /api/view-file) behavior.

// POST /api/view-file-token — exchanges the caller's normal auth (Bearer header,
// not a URL param) for a short-lived (15 min), single-purpose token scoped to
// exactly one sandboxed file path. This token is what gets put in the
// window.open() URL instead of the full session JWT, so a leaked URL (browser
// history, server/Cloudflare access logs, Referer headers) only exposes a
// narrow, soon-expiring capability — not the user's actual session credential.
app.post('/api/view-file-token', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        const normalized = resolveSandboxedFile(filePath);
        if (!normalized) return res.status(403).json({ error: 'Access denied' });
        const token = jwt.sign({ purpose: 'view-file', path: normalized }, JWT_SECRET, { expiresIn: '15m' });
        res.json({ token });
    } catch (e) {
        console.error('[POST /api/view-file-token]', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/view-file', async (req, res) => {
    try {
        // Auth: Bearer header (preferred), OR a short-lived ?vtoken= issued by
        // /api/view-file-token (scoped to one file, 15-min expiry — NOT the
        // full session JWT, see audit 2.6), OR legacy fallbacks during migration.
        let ok = false;
        let vtokenPath = null;
        const auth = req.headers['authorization'] || '';
        if (auth.startsWith('Bearer ')) {
            try { jwt.verify(auth.slice(7), process.env.JWT_SECRET); ok = true; } catch {}
        }
        if (!ok && req.query.vtoken) {
            try {
                const payload = jwt.verify(req.query.vtoken, JWT_SECRET);
                if (payload.purpose === 'view-file' && payload.path) {
                    ok = true;
                    vtokenPath = payload.path;
                }
            } catch {}
        }
        // Legacy: full session token in URL — still accepted for backward
        // compatibility with any not-yet-updated clients, but new frontend code
        // uses vtoken above instead.
        if (!ok && req.query.token) {
            try { jwt.verify(req.query.token, process.env.JWT_SECRET); ok = true; } catch {}
        }
        // Legacy sessionId fallback — validate against DB
        if (!ok && req.query.sessionId) {
            try {
                const profile = dataLayer.getProfileById(req.query.sessionId);
                if (profile) ok = true;
            } catch {}
        }
        if (!ok) {
            res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
                <h2>Session expired</h2>
                <p>Your login session has expired or is invalid. Please close this tab and log in again.</p>
                <a href="/login.html" style="color:#4A90E2;">Go to Login</a>
            </body></html>`);
            return;
        }

        // If we authenticated via a vtoken, it's already scoped to one exact
        // realpath — use that directly rather than re-resolving an arbitrary
        // ?path= query param.
        let normalized;
        if (vtokenPath) {
            normalized = resolveSandboxedFile(vtokenPath);
        } else {
            const filePath = req.query.path;
            if (!filePath || typeof filePath !== 'string') {
                return res.status(400).send('Missing path');
            }
            // Security: only allow files inside known folders, resolved via realpath
            // to defeat UNC-path / symlink-chain sandbox bypasses (see audit 1.5).
            normalized = resolveSandboxedFile(filePath);
        }
        if (!normalized) {
            return res.status(403).send('Access denied');
        }
        const filename = path.basename(normalized);
        // Was hardcoded to application/pdf — this endpoint now also serves
        // quotation reference images (added 2026-07), so pick the type from
        // the extension instead of assuming every file here is a PDF.
        const ext = path.extname(normalized).toLowerCase();
        const contentType = ext === '.png'  ? 'image/png'
                          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                          : ext === '.gif'  ? 'image/gif'
                          : ext === '.webp' ? 'image/webp'
                          : 'application/pdf';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        fs.createReadStream(normalized).pipe(res);
    } catch (e) {
        console.error('[GET /api/view-file]', e.message);
        res.status(500).send(e.message);
    }
});

// ── Direct Print ─────────────────────────────────────────────────────────────
const os           = require('os');
const { execFile } = require('child_process');

const SUMATRA_PATH = process.env.SUMATRA_PATH || 'C:\\Users\\inqui\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe';
const PRINTER_NAME = process.env.PRINTER_NAME || 'EPSON WF-C5890 Series';

app.get('/api/print/status',  (req, res) => {
    const sumatraOk = fs.existsSync(SUMATRA_PATH);
    res.json({ ok: sumatraOk, sumatra: sumatraOk, printer: PRINTER_NAME });
});

// ── Widget file upload for printing (raw binary, any file type) ──────────────
app.post('/api/print-upload',
    express.raw({ type: () => true, limit: '100mb' }),
    async (req, res) => {
    try {
        const mimeType  = (req.headers['x-file-type'] || 'application/octet-stream').toLowerCase();
        // See handleFileUploadToken() above for why this is encoded/decoded.
        let origName = req.headers['x-file-name'] || 'print_file';
        try { origName = decodeURIComponent(origName); } catch {}
        const filename  = origName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const copies    = Math.min(parseInt(req.headers['x-copies'] || '1') || 1, 99);
        const paperSize = req.headers['x-paper-size'] || 'A4';
        // Page range (PDF only -- SumatraPDF is the only print path that
        // understands this). Same format SumatraPDF's own -print-settings
        // takes: "1-3,5". Blank/missing = print every page, same as before
        // this option existed. Validated against a narrow charset before
        // use -- anything else is treated the same as "not specified" rather
        // than erroring out, since a bad page range shouldn't block printing
        // the whole document.
        const pagesRaw = (req.headers['x-pages'] || '').trim();
        const pages    = /^[\d,\-\s]*$/.test(pagesRaw) ? pagesRaw.replace(/\s+/g, '') : '';

        if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty file.' });
        if (!fs.existsSync(SUMATRA_PATH)) return res.status(500).json({ error: 'SumatraPDF not found on server.' });

        // Write to temp file preserving original extension
        const tmpPath = path.join(os.tmpdir(), `lp_print_${Date.now()}_${filename}`);
        fs.writeFileSync(tmpPath, req.body);
        console.log(`[PRINT] Temp file written: ${tmpPath} (${req.body.length} bytes)`);

        const isPDF   = mimeType.includes('pdf')  || filename.toLowerCase().endsWith('.pdf');
        const isImage = mimeType.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|tiff|webp)$/i.test(filename);

        let printPromise;

        if (isPDF) {
            // PDFs: use SumatraPDF. -print-settings takes one comma-joined
            // list mixing the page range and the copy count together (e.g.
            // "1-3,5,2x"), not two separate flags.
            const settingsParts = [];
            if (pages) settingsParts.push(pages);
            if (copies > 1) settingsParts.push(`${copies}x`);
            const settings = settingsParts.join(',');
            const args = [
                '-print-to-default',
                ...(settings ? ['-print-settings', settings] : []),
                tmpPath
            ];
            console.log(`[PRINT] SumatraPDF args:`, args.join(' '));
            printPromise = new Promise((resolve, reject) => {
                execFile(SUMATRA_PATH, args, { timeout: 60000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[PRINT] SumatraPDF error:', err.message, stderr);
                        reject(new Error('SumatraPDF: ' + (err.message || 'Print failed')));
                    } else {
                        console.log('[PRINT] SumatraPDF ok', stdout || '');
                        resolve();
                    }
                });
            });
        } else if (isImage) {
            // Images: use Windows Photo Viewer / shimgvw via rundll32 — most reliable for images
            // rundll32 shimgvw.dll,ImageView_PrintTo /pt "file" "printer"
            // Get default printer name via PowerShell first
            const psGetPrinter = `(Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Default=$true").Name`;
            console.log('[PRINT] Getting default printer name...');
            printPromise = new Promise((resolve, reject) => {
                execFile('powershell.exe', ['-NoProfile', '-Command', psGetPrinter], { timeout: 10000 },
                    (err, stdout) => {
                        const printerName = (stdout || '').trim();
                        if (!printerName) {
                            // Fallback: PowerShell Start-Process print verb
                            const psCmd = `Start-Process -FilePath '${tmpPath.replace(/'/g, "''")}' -Verb Print -Wait`;
                            execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 60000 },
                                (e2, o2, e2err) => {
                                    if (e2) reject(new Error('Image print failed: ' + e2.message));
                                    else resolve();
                                }
                            );
                            return;
                        }
                        console.log(`[PRINT] Default printer: ${printerName}`);
                        // rundll32 shimgvw.dll,ImageView_PrintTo /pt "filepath" "printer"
                        const rundllArgs = [
                            'shimgvw.dll,ImageView_PrintTo',
                            '/pt',
                            tmpPath,
                            printerName
                        ];
                        console.log('[PRINT] rundll32 args:', rundllArgs.join(' '));
                        execFile('rundll32.exe', rundllArgs, { timeout: 60000 },
                            (e3, o3, e3err) => {
                                if (e3) {
                                    console.error('[PRINT] rundll32 error:', e3.message);
                                    reject(new Error('Image print failed: ' + e3.message));
                                } else {
                                    console.log('[PRINT] rundll32 ok');
                                    resolve();
                                }
                            }
                        );
                    }
                );
            });
        } else {
            // Non-PDF/image: use Windows shell print verb (handles Word, Excel, etc.)
            // shell execute: rundll32 url.dll,FileProtocolHandler is unreliable
            // Better: use PowerShell Start-Process with -Verb Print
            const psCmd = `Start-Process -FilePath '${tmpPath.replace(/'/g, "''")}' -Verb Print -Wait`;
            console.log(`[PRINT] PowerShell print:`, psCmd);
            printPromise = new Promise((resolve, reject) => {
                execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 60000 },
                    (err, stdout, stderr) => {
                        if (err) {
                            console.error('[PRINT] PowerShell error:', err.message, stderr);
                            reject(new Error('PowerShell print: ' + (err.message || 'failed')));
                        } else resolve();
                    }
                );
            });
        }

        await printPromise;
        // Delay cleanup slightly so the print spooler can read the file
        setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 5000);

        logActivity(req, 'print', origName);
        res.json({ ok: true, message: `Sent to printer: ${origName} (${copies} cop${copies>1?'ies':'y'}, ${paperSize}${pages && isPDF ? `, pages ${pages}` : ''})` });
    } catch (e) {
        console.error('[POST /api/print-upload]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/print',  async (req, res) => {
    try {
        const { pdfPath, pdfBase64, filename } = req.body;
        // Copies/page-range, same as /api/print-upload's options -- see the
        // Print Options modal (app.js/jo.html) that now sits in front of
        // every direct-print action. Validated the same narrow way: a bad
        // page range is treated as "not specified" instead of blocking the
        // print entirely.
        const copies    = Math.min(Math.max(1, parseInt(req.body.copies) || 1), 99);
        const pagesRaw  = String(req.body.pages || '').trim();
        const pages     = /^[\d,\-\s]*$/.test(pagesRaw) ? pagesRaw.replace(/\s+/g, '') : '';
        const settingsParts = [];
        if (pages) settingsParts.push(pages);
        if (copies > 1) settingsParts.push(`${copies}x`);
        const printSettings = settingsParts.join(',');

        // Validate SumatraPDF is available
        if (!fs.existsSync(SUMATRA_PATH)) {
            return res.status(500).json({ error: 'SumatraPDF not found on server.' });
        }

        let tmpPath = null;
        let usedTmp = false;

        if (pdfPath) {
            // SECURITY: sandbox pdfPath to known folders via realpath resolution —
            // prevents path traversal and symlink/UNC bypasses (same policy as
            // /api/view-file and /api/open-file).
            const normalized = resolveSandboxedFile(pdfPath);
            if (!normalized) {
                return res.status(403).json({ error: 'Access denied: path outside allowed folders.' });
            }
            tmpPath = normalized;
        } else if (pdfBase64) {
            const fname = (filename || `lp_print_${Date.now()}.pdf`).replace(/[^a-zA-Z0-9._\- ]/g, '_');
            tmpPath = path.join(os.tmpdir(), fname);
            fs.writeFileSync(tmpPath, Buffer.from(pdfBase64, 'base64'));
            usedTmp = true;
        } else {
            return res.status(400).json({ error: 'Provide pdfPath or pdfBase64.' });
        }

        const printArgs = [
            '-print-to', PRINTER_NAME,
            ...(printSettings ? ['-print-settings', printSettings] : []),
            tmpPath
        ];
        await new Promise((resolve, reject) => {
            execFile(SUMATRA_PATH, printArgs, { timeout: 30000 }, (err) => {
                if (usedTmp) fs.unlink(tmpPath, () => {});
                if (err) reject(err);
                else resolve();
            });
        });

        logActivity(req, 'print', filename || pdfPath || '');
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/print]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Print: Fit-to-Page image composer (requested 2026-07; redesigned into a
// full-screen ribbon editor later that same month) ───────────────────────────
// The old image branch of /api/print-upload prints a picture "as-is" via
// Windows Photo Viewer (shimgvw.dll) with zero layout control, which is why
// staff kept opening Word/Google Docs first just to stretch a photo to fill
// the page before printing. This instead builds a real print-ready PDF —
// the photo already cropped/rotated client-side and placed at an exact
// physical position and size on the page — through the same Puppeteer
// pipeline used for every other document in this file, then sends *that*
// PDF through SumatraPDF, the one print path that has always been reliable.
//
// The editor's ribbon gives exact Position (a 3x3 alignment grid, or free
// drag) and exact Width/Height in cm, computed client-side against the
// paper's physical millimeter dimensions. Those numbers (xMm/yMm/widthMm/
// heightMm) are passed straight through here as CSS "mm" units -- no need
// to reconcile them against a separate PDF margin, so the page margin is
// always 0 and left/top/width/height fully control placement. This also
// makes the live client-side preview a true WYSIWYG match for what prints.
function buildImageLayoutHTML(pages, opts) {
    const pageHtml = pages.map((p, i) => {
        const xMm = (typeof p.xMm === 'number' && isFinite(p.xMm)) ? p.xMm : 0;
        const yMm = (typeof p.yMm === 'number' && isFinite(p.yMm)) ? p.yMm : 0;
        const wMm = (typeof p.widthMm === 'number' && p.widthMm > 0) ? p.widthMm : 190;
        const hMm = (typeof p.heightMm === 'number' && p.heightMm > 0) ? p.heightMm : 277;
        const style = `position:absolute; left:${xMm}mm; top:${yMm}mm; width:${wMm}mm; height:${hMm}mm;`;
        const brk = i < pages.length - 1 ? 'page-break-after:always;' : '';
        return `<div class="pg" style="${brk}"><img src="${p.dataUrl}" style="${style}"></div>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body { width:100%; height:100%; }
        .pg { position:relative; width:100vw; height:100vh; overflow:hidden; }
    </style></head><body>${pageHtml}</body></html>`;
    const pdfOptions = {
        format: opts.paperSize || 'A4',
        landscape: !!opts.landscape,
        printBackground: true,
        // The client's editor now fully controls placement (including any
        // desired blank border, via the image's own xMm/yMm) -- so the PDF
        // page itself is margin-free rather than double-applying a margin
        // the user never sees reflected in the live preview.
        margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
    };
    return { html, pdfOptions };
}

// Renders every page of a just-built PDF buffer as a JPEG data URL, for an
// accurate on-screen "this is exactly what will print" confirmation —
// reuses the same mupdf pipeline as renderPdfPageAsImage() above, just
// walking every page instead of only the first.
async function renderAllPdfPagesAsImages(pdfBuffer) {
    const mupdf  = await getMupdf();
    const doc    = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
    const count  = doc.countPages();
    const matrix = mupdf.Matrix.scale(1.4, 1.4); // ~100 DPI — plenty for an on-screen preview
    const out    = [];
    try {
        for (let i = 0; i < count; i++) {
            const page   = doc.loadPage(i);
            const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
            out.push(`data:image/jpeg;base64,${Buffer.from(pixmap.asJPEG(80, false)).toString('base64')}`);
            pixmap.destroy();
            page.destroy();
        }
    } finally {
        doc.destroy();
    }
    return out;
}

async function printPdfBufferViaSumatra(pdfBuffer, copies) {
    if (!fs.existsSync(SUMATRA_PATH)) throw new Error('SumatraPDF not found on server.');
    const tmpPath = path.join(os.tmpdir(), `lp_print_fit_${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, pdfBuffer);
    const settings = copies > 1 ? `${copies}x` : '';
    const args = ['-print-to-default', ...(settings ? ['-print-settings', settings] : []), tmpPath];
    await new Promise((resolve, reject) => {
        execFile(SUMATRA_PATH, args, { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) { console.error('[PRINT-FIT] SumatraPDF error:', err.message, stderr); reject(new Error('SumatraPDF: ' + (err.message || 'Print failed'))); }
            else resolve();
        });
    });
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 5000);
}

// POST /api/print-fit-preview — builds the composed PDF and returns a JPEG
// of every page so the user can confirm the layout before anything is
// actually sent to the printer.
app.post('/api/print-fit-preview', express.json({ limit: '80mb' }), async (req, res) => {
    try {
        const { pages, paperSize, landscape, margin } = req.body || {};
        if (!Array.isArray(pages) || !pages.length) return res.status(400).json({ error: 'No pages provided.' });
        const { html, pdfOptions } = buildImageLayoutHTML(pages, { paperSize, landscape, margin });
        const pdfBuffer = await renderPDF(html, pdfOptions);
        const images = await renderAllPdfPagesAsImages(pdfBuffer);
        res.json({ ok: true, images });
    } catch (e) {
        console.error('[POST /api/print-fit-preview]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/print-fit — builds the same composed PDF and sends it straight
// to the server printer via SumatraPDF.
app.post('/api/print-fit', express.json({ limit: '80mb' }), async (req, res) => {
    try {
        const { pages, paperSize, landscape, margin, copies } = req.body || {};
        if (!Array.isArray(pages) || !pages.length) return res.status(400).json({ error: 'No pages provided.' });
        const copiesNum = Math.min(Math.max(1, parseInt(copies) || 1), 99);
        const { html, pdfOptions } = buildImageLayoutHTML(pages, { paperSize, landscape, margin });
        const pdfBuffer = await renderPDF(html, pdfOptions);
        await printPdfBufferViaSumatra(pdfBuffer, copiesNum);
        logActivity(req, 'print', `Fit-to-page image job (${pages.length} page${pages.length > 1 ? 's' : ''})`);
        res.json({ ok: true, message: `Sent to printer! (${pages.length} page${pages.length > 1 ? 's' : ''}, ${copiesNum} cop${copiesNum > 1 ? 'ies' : 'y'})` });
    } catch (e) {
        console.error('[POST /api/print-fit]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/print-preview-pdf — rasterizes a dropped PDF's pages to JPEG
// data URLs so the fullscreen print tool (requested 2026-07, extended same
// month to cover any file type, not just images) can show a real page-by-
// page preview for PDFs too, not just a generic "file loaded" confirmation.
// Preview-only: the actual print job still goes through the existing raw-
// binary /api/print-upload path (SumatraPDF), unchanged.
app.post('/api/print-preview-pdf', express.json({ limit: '80mb' }), async (req, res) => {
    try {
        const { pdfBase64 } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ error: 'No PDF provided.' });
        const base64Data = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
        const pdfBuffer = Buffer.from(base64Data, 'base64');
        const images = await renderAllPdfPagesAsImages(pdfBuffer);
        res.json({ ok: true, images });
    } catch (e) {
        console.error('[POST /api/print-preview-pdf]', e.message);
        // Not fatal — the client falls back to a no-preview confirmation
        // screen and can still send the file to print.
        res.status(500).json({ error: e.message });
    }
});

// GET /api/spotlight-images — lists the Windows-Spotlight-style wallpaper
// images in public/ICONS/spotlight so menu.html can pick one at random on
// each load without needing directory listing enabled on the static server.
const SPOTLIGHT_DIR = path.join(__dirname, 'public', 'ICONS', 'spotlight');
const SPOTLIGHT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
app.get('/api/spotlight-images', async (req, res) => {
    try {
        const files = await fsp.readdir(SPOTLIGHT_DIR);
        const images = files.filter(f => SPOTLIGHT_EXTS.has(path.extname(f).toLowerCase()));
        res.json(images);
    } catch {
        res.json([]); // folder missing/empty — frontend falls back to a solid background
    }
});

// ── Health check endpoint ─────────────────────────────────────────────────────
// Returns drive status so the client can show a warning banner instead of
// mysterious 401s (which were caused by readJSON returning {} on drive errors).
app.get('/api/health', async (req, res) => {
    const driveOk = fs.existsSync(DRIVE_FOLDER);
    const joOk    = fs.existsSync(JO_FOLDER);
    let profilesOk = false;
    try {
        profilesOk = dataLayer.getAllProfiles().length > 0;
    } catch {}
    const ok = driveOk && profilesOk;

    // Unauthenticated callers only get the boolean overall status (needed for
    // uptime monitors / load balancers) — not the internal infra breakdown.
    let authed = false;
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) {
        try { jwt.verify(auth.slice(7), process.env.JWT_SECRET); authed = true; } catch {}
    }

    if (!authed) {
        return res.status(ok ? 200 : 503).json({ ok, ts: Date.now(), bootId: SERVER_BOOT_ID });
    }
    res.status(ok ? 200 : 503).json({
        ok,
        drive: driveOk,
        joFolder: joOk,
        profiles: profilesOk,
        bootId: SERVER_BOOT_ID,
        ts: Date.now()
    });
});

// GET /api/db-backup-status — admin-only visibility into the 15-min VACUUM
// INTO backup job (see runDbBackup above), so a failing backup is visible
// from the admin UI instead of only in pm2 logs.
app.get('/api/db-backup-status', requireAdmin, (req, res) => {
    res.json(dbBackupStatus);
});

// ── Startup ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Drive folder: ${DRIVE_FOLDER}`);
    console.log(`PIN_SALT prefix: ${(process.env.PIN_SALT||'').slice(0,8)}...`); // first 8 chars only
    const driveOk = fs.existsSync(DRIVE_FOLDER);
    console.log(`Drive folder accessible: ${driveOk}`);
    if (!driveOk) {
        console.warn('⚠️  WARNING: Drive folder NOT found! PDFs and quotes will not save.');
    } else {
        console.log('✅ Drive folder OK');
    }
    const joOk = fs.existsSync(JO_FOLDER);
    if (!joOk) {
        console.warn('⚠️  WARNING: JO folder NOT found! JO PDFs will not save. Expected:', JO_FOLDER);
    } else {
        console.log('✅ JO folder OK');
    }
    // CSV dedup-on-startup removed — clients.company_key is UNIQUE at the
    // database level now, so the duplicate-row bug this used to patch around
    // (see git history / PENDING_CONFLICTS.md) can no longer occur.
    try {
        const clientCount = dataLayer.getClients().length;
        console.log(`✅ Clients table OK (${clientCount} unique entries)`);
    } catch (e) {
        console.warn('⚠️  Could not read clients table:', e.message);
    }
    getBrowser()
        .then(() => console.log('✅ Puppeteer browser pre-launched.'))
        .catch(err => console.error('⚠️  Failed to pre-launch browser:', err.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`\n${signal} received, shutting down...`);
    if (browserInstance) {
        const browser = browserInstance;
        const proc    = browser.process();
        browserInstance = null; // null out first so 'disconnected' event doesn't re-trigger

        let closedCleanly = false;
        try {
            await Promise.race([
                browser.close().then(() => { closedCleanly = true; }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
            ]);
        } catch {
            // Only force-kill if graceful close timed out AND process is still alive
            const isAlive = proc && !proc.killed && proc.exitCode === null;
            if (!closedCleanly && isAlive) {
                if (process.platform === 'win32') {
                    require('child_process').spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
                } else {
                    proc.kill('SIGKILL');
                }
            }
        }
    }
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
