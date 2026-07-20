// ============================================================================
// Launchpad Portal — SQLite Data Access Layer
//
// This module is a drop-in replacement for the JSON-file-based storage that
// server.js used to call directly (readJSON/writeJSON/readClientsCSV/etc).
// Each exported function here mirrors the SHAPE of data the old functions
// returned, so the existing route handlers in server.js need only swap their
// storage calls — the request/response contract with the frontend (app.js,
// index.html, jo.html, admin.html) does NOT change. No frontend changes
// needed for this refactor.
//
// Why a shim layer instead of rewriting every route inline:
// the old code had 74 call sites touching JSON files directly. Centralizing
// storage logic here means future bugs (like the company-key mismatch saga)
// get fixed in ONE place, and the SQL schema's constraints (UNIQUE on
// (client_id, control_number, revision), etc.) now do the validation work
// that used to be scattered, inconsistent, hand-rolled checks across the
// codebase.
// ============================================================================

// Uses Node's BUILT-IN node:sqlite module — no native compilation, no
// Visual Studio Build Tools, no Python required. Available in Node 22.5+
// (stable enough as of Node 24). This replaced an earlier plan to use the
// better-sqlite3 npm package, which failed to install on the production
// Windows server (missing Python toolchain, then missing Visual Studio
// Build Tools — see deploy notes). node:sqlite needs neither.
//
// node:sqlite's DatabaseSync has a smaller API than better-sqlite3 (no
// .pragma(), no .transaction()) — the thin wrapper below adds those two
// conveniences so the rest of this file didn't need to change when we
// switched implementations.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

class CompatDatabase {
    constructor(dbPath) {
        this._db = new DatabaseSync(dbPath);
    }
    pragma(setting) {
        // node:sqlite has no .pragma() helper — run it as a plain statement.
        this._db.exec(`PRAGMA ${setting}`);
    }
    exec(sql) {
        this._db.exec(sql);
    }
    prepare(sql) {
        const stmt = this._db.prepare(sql);
        return {
            run: (...args) => {
                const r = stmt.run(...args);
                // better-sqlite3 returns lastInsertRowid/changes; node:sqlite's
                // StatementSync.run() returns the same field names already,
                // but we normalize here in case that ever changes upstream.
                return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
            },
            get: (...args) => stmt.get(...args),
            all: (...args) => stmt.all(...args),
        };
    }
    transaction(fn) {
        // better-sqlite3's .transaction(fn) returns a callable that wraps fn
        // in BEGIN/COMMIT/ROLLBACK. node:sqlite has no equivalent, so we
        // replicate it manually. Nested transactions are not supported here
        // (none of db.js's functions call a transaction from inside another).
        return (...args) => {
            this._db.exec('BEGIN');
            try {
                const result = fn(...args);
                this._db.exec('COMMIT');
                return result;
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch {}
                throw e;
            }
        };
    }
    close() {
        this._db.close();
    }
}

let db = null;

function init(dbPath, schemaPath) {
    if (db) return db;
    const isNew = !fs.existsSync(dbPath);
    db = new CompatDatabase(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    if (isNew) {
        db.exec(fs.readFileSync(schemaPath, 'utf8'));
        console.log(`[db] Created new database at ${dbPath}`);
    } else {
        // schema.sql evolves over time, but init() only ever applies it to a
        // brand-new database file — an already-existing launchpad.db never
        // picks up later additions (e.g. serials.updated_at, login_attempts
        // were both added to schema.sql well after this DB was first
        // created). This patch step closes that gap: each check is
        // idempotent, so it's safe to run on every single server start
        // regardless of how old the DB file is.
        try { _applySchemaPatches(); }
        catch (e) { console.error('[db] Schema patch step failed (server will still start):', e.message); }
    }
    return db;
}

function _applySchemaPatches() {
    // serials.updated_at — added so manual adjustments leave an audit trail.
    // node:sqlite's ALTER TABLE doesn't support a non-constant DEFAULT (e.g.
    // datetime('now')) on ADD COLUMN, so add it nullable first, then backfill
    // existing rows separately. Every write path already sets this column
    // explicitly going forward (see commitNextSerial/setSerial), so it being
    // nullable at the schema level doesn't matter in practice.
    const serialsCols = db.prepare("PRAGMA table_info(serials)").all().map(c => c.name);
    if (!serialsCols.includes('updated_at')) {
        db.exec("ALTER TABLE serials ADD COLUMN updated_at TEXT");
        db.exec("UPDATE serials SET updated_at = datetime('now') WHERE updated_at IS NULL");
        console.log('[db] Schema patch applied: serials.updated_at');
    }

    // login_attempts — backs the rate limiter's persistent store; without
    // this table every checkRateLimit() call fails (logged, but silently
    // falls back to allowing the request, defeating the lockout).
    const hasLoginAttempts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='login_attempts'"
    ).get();
    if (!hasLoginAttempts) {
        db.exec(`
            CREATE TABLE login_attempts (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                ip    TEXT NOT NULL,
                ts    INTEGER NOT NULL
            );
            CREATE INDEX idx_login_attempts_ip_ts ON login_attempts(ip, ts);
        `);
        console.log('[db] Schema patch applied: created login_attempts table');
    }

    // suggestions — user-submitted feedback via the FAB "Suggestion" form on
    // the Quotation/Job Order/Proofing pages. Admin-only listing lives in the
    // dashboard's Suggestions tab.
    const hasSuggestions = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='suggestions'"
    ).get();
    if (!hasSuggestions) {
        db.exec(`
            CREATE TABLE suggestions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     TEXT,
                user_name   TEXT NOT NULL,
                role        TEXT,
                text        TEXT NOT NULL,
                resolved    INTEGER NOT NULL DEFAULT 0,
                ts          TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX idx_suggestions_ts ON suggestions(ts);
        `);
        console.log('[db] Schema patch applied: created suggestions table');
    } else {
        // Covers a DB that already picked up the table from an earlier
        // deploy of this patch, before the resolved/delete-actions feature
        // (and its column) existed.
        const suggestionsCols = db.prepare("PRAGMA table_info(suggestions)").all().map(c => c.name);
        if (!suggestionsCols.includes('resolved')) {
            db.exec('ALTER TABLE suggestions ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
            console.log('[db] Schema patch applied: suggestions.resolved');
        }
    }

    // profiles email case-insensitive uniqueness (audit 2026-07) — the plain
    // UNIQUE on profiles.email is case-sensitive, but every lookup
    // (getProfileByEmail) matches on LOWER(email), so "A@x.com" and
    // "a@x.com" could previously both be inserted as separate rows,
    // silently defeating the uniqueness the app relies on. If case-variant
    // duplicates already exist, creating the index would fail outright —
    // detect that first and just warn instead of crashing startup.
    const hasEmailLowerIdx = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_profiles_email_lower'"
    ).get();
    if (!hasEmailLowerIdx) {
        const dupes = db.prepare(`
            SELECT LOWER(email) AS e, COUNT(*) AS n FROM profiles GROUP BY LOWER(email) HAVING n > 1
        `).all();
        if (dupes.length > 0) {
            console.error(`[db] Schema patch SKIPPED: ${dupes.length} case-variant duplicate profile email(s) found ` +
                `(e.g. "${dupes[0].e}"). Merge/rename the duplicates, then restart to enforce case-insensitive uniqueness.`);
        } else {
            db.exec('CREATE UNIQUE INDEX idx_profiles_email_lower ON profiles(LOWER(email))');
            console.log('[db] Schema patch applied: idx_profiles_email_lower');
        }
    }

    // quote_items money columns were TEXT — blocked SQL-level SUM/aggregates
    // and allowed non-numeric garbage into price/qty fields (audit 2026-07).
    // Rebuild the table with REAL columns. CAST(x AS REAL) mirrors the
    // parseFloat(x)||0 fallback server.js already applies everywhere it
    // reads these fields, so this changes the storage type, not the values
    // the app has effectively been treating them as all along.
    const qiCols = db.prepare("PRAGMA table_info(quote_items)").all();
    const qtyCol = qiCols.find(c => c.name === 'qty');
    if (qtyCol && qtyCol.type.toUpperCase() !== 'REAL') {
        // Flag rows whose text wasn't a clean number BEFORE the CAST-to-0
        // fallback below runs, so any real "garbage" data isn't silently
        // erased without a trace.
        const numericRe = /^\s*-?\d+(\.\d+)?\s*$/;
        const suspect = db.prepare(
            'SELECT id, quote_id, qty, unit_price, computed_unit_price, flat_price FROM quote_items'
        ).all().filter(r => [r.qty, r.unit_price, r.computed_unit_price, r.flat_price]
            .some(v => v !== '' && v !== null && !numericRe.test(String(v))));
        if (suspect.length > 0) {
            console.warn(`[db] quote_items money migration: ${suspect.length} row(s) had non-numeric text ` +
                `(now treated as 0), e.g. quote_item id=${suspect[0].id} (quote_id=${suspect[0].quote_id}). Review old PDFs/totals for that quote if it matters.`);
        }

        db.exec('PRAGMA foreign_keys = OFF');
        try {
            db.exec('BEGIN');
            db.exec(`
                CREATE TABLE quote_items_new (
                    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                    quote_id           INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
                    item_type          TEXT NOT NULL CHECK(item_type IN ('inhouse','outsource','flatrate')),
                    group_name         TEXT,
                    material           TEXT DEFAULT '',
                    size_w             TEXT DEFAULT '',
                    size_h             TEXT DEFAULT '',
                    size_unit          TEXT DEFAULT '',
                    qty                REAL NOT NULL DEFAULT 0,
                    unit_price         REAL NOT NULL DEFAULT 0,
                    computed_unit_price REAL NOT NULL DEFAULT 0,
                    flat_fee           INTEGER NOT NULL DEFAULT 0,
                    flat_price         REAL NOT NULL DEFAULT 0,
                    multipliers_json   TEXT DEFAULT '[]',
                    addons_json        TEXT DEFAULT '[]',
                    sort_order         INTEGER NOT NULL DEFAULT 0
                )
            `);
            db.exec(`
                INSERT INTO quote_items_new
                    (id, quote_id, item_type, group_name, material, size_w, size_h, size_unit,
                     qty, unit_price, computed_unit_price, flat_fee, flat_price, multipliers_json, addons_json, sort_order)
                SELECT id, quote_id, item_type, group_name, material, size_w, size_h, size_unit,
                       CAST(qty AS REAL), CAST(unit_price AS REAL), CAST(computed_unit_price AS REAL),
                       flat_fee, CAST(flat_price AS REAL), multipliers_json, addons_json, sort_order
                FROM quote_items
            `);
            db.exec('DROP TABLE quote_items');
            db.exec('ALTER TABLE quote_items_new RENAME TO quote_items');
            db.exec('CREATE INDEX idx_quote_items_quote ON quote_items(quote_id)');
            const fkCheck1 = db.prepare('PRAGMA foreign_key_check(quote_items)').all();
            if (fkCheck1.length > 0) throw new Error('foreign_key_check failed after quote_items rebuild: ' + JSON.stringify(fkCheck1));
            db.exec('COMMIT');
            console.log('[db] Schema patch applied: quote_items money columns TEXT -> REAL');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch {}
            console.error('[db] quote_items money migration FAILED, rolled back (app still starts on old schema):', e.message);
        } finally {
            db.exec('PRAGMA foreign_keys = ON');
        }
    }

    // quotes.discount_value was TEXT — same issue/fix as quote_items above.
    // Rebuilding this table also requires recreating its indexes, UNIQUE
    // constraint, and the trg_quotes_last_saved trigger (all dropped
    // automatically when the old table is dropped).
    const qCols = db.prepare("PRAGMA table_info(quotes)").all();
    const discCol = qCols.find(c => c.name === 'discount_value');
    if (discCol && discCol.type.toUpperCase() !== 'REAL') {
        db.exec('PRAGMA foreign_keys = OFF');
        try {
            db.exec('BEGIN');
            db.exec(`
                CREATE TABLE quotes_new (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    control_number   TEXT NOT NULL,
                    client_id        INTEGER NOT NULL REFERENCES clients(id),
                    revision         INTEGER NOT NULL DEFAULT 0,
                    project_name     TEXT DEFAULT '',
                    address           TEXT DEFAULT '',
                    tin               TEXT DEFAULT '',
                    attention_to      TEXT DEFAULT '',
                    quote_date        TEXT,
                    tel               TEXT DEFAULT '',
                    lead_time         TEXT DEFAULT '',
                    payment_terms     TEXT DEFAULT '',
                    sales_name        TEXT NOT NULL,
                    sales_contact     TEXT DEFAULT '',
                    sales_email       TEXT DEFAULT '',
                    sales_position    TEXT DEFAULT '',
                    is_grouped        INTEGER NOT NULL DEFAULT 0,
                    include_vat       INTEGER NOT NULL DEFAULT 0,
                    vat_exclusive     INTEGER NOT NULL DEFAULT 0,
                    discount_type     TEXT,
                    discount_value    REAL,
                    bank_details      TEXT,
                    pdf_path          TEXT,
                    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
                    last_saved        TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(client_id, control_number, revision)
                )
            `);
            db.exec(`
                INSERT INTO quotes_new
                    (id, control_number, client_id, revision, project_name, address, tin, attention_to,
                     quote_date, tel, lead_time, payment_terms, sales_name, sales_contact, sales_email, sales_position,
                     is_grouped, include_vat, vat_exclusive, discount_type, discount_value, bank_details, pdf_path,
                     created_at, last_saved)
                SELECT id, control_number, client_id, revision, project_name, address, tin, attention_to,
                       quote_date, tel, lead_time, payment_terms, sales_name, sales_contact, sales_email, sales_position,
                       is_grouped, include_vat, vat_exclusive, discount_type,
                       CASE WHEN discount_value IS NULL OR TRIM(discount_value) = '' THEN NULL ELSE CAST(discount_value AS REAL) END,
                       bank_details, pdf_path, created_at, last_saved
                FROM quotes
            `);
            db.exec('DROP TABLE quotes');
            db.exec('ALTER TABLE quotes_new RENAME TO quotes');
            db.exec('CREATE INDEX idx_quotes_client ON quotes(client_id)');
            db.exec('CREATE INDEX idx_quotes_control ON quotes(control_number)');
            db.exec('CREATE INDEX idx_quotes_sales_name ON quotes(sales_name)');
            db.exec(`
                CREATE TRIGGER trg_quotes_last_saved
                AFTER UPDATE ON quotes
                FOR EACH ROW WHEN NEW.last_saved = OLD.last_saved
                BEGIN
                    UPDATE quotes SET last_saved = datetime('now') WHERE id = NEW.id;
                END
            `);
            const fkCheck2 = db.prepare('PRAGMA foreign_key_check(quote_items)').all();
            if (fkCheck2.length > 0) throw new Error('foreign_key_check failed after quotes rebuild: ' + JSON.stringify(fkCheck2));
            db.exec('COMMIT');
            console.log('[db] Schema patch applied: quotes.discount_value TEXT -> REAL');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch {}
            console.error('[db] quotes.discount_value migration FAILED, rolled back (app still starts on old schema):', e.message);
        } finally {
            db.exec('PRAGMA foreign_keys = ON');
        }
    }

    // quote_items.formula_json — the Simple/Advanced/Fixed Price formula
    // builder state (fbMode, fbComponents, fbAdvFormula, fixedFormula, etc.)
    // was captured client-side and sent to the server on every save, but had
    // no column to land in, so only the final computed price was ever
    // persisted. Reopening a saved quote silently lost the formula the price
    // was built from (reported 2026-07). This is a plain additive column
    // with a constant default, so — unlike the money-column rebuilds above —
    // no table rebuild is needed.
    const qiCols2 = db.prepare("PRAGMA table_info(quote_items)").all().map(c => c.name);
    if (!qiCols2.includes('formula_json')) {
        db.exec("ALTER TABLE quote_items ADD COLUMN formula_json TEXT DEFAULT '{}'");
        console.log('[db] Schema patch applied: quote_items.formula_json');
    }

    // quote_items.images_json + quotes.include_image_ref — per-item reference
    // image attachments (added 2026-07, see schema.sql comments). Both are
    // plain additive columns with constant defaults, so no rebuild needed.
    const qiCols3 = db.prepare("PRAGMA table_info(quote_items)").all().map(c => c.name);
    if (!qiCols3.includes('images_json')) {
        db.exec("ALTER TABLE quote_items ADD COLUMN images_json TEXT DEFAULT '[]'");
        console.log('[db] Schema patch applied: quote_items.images_json');
    }
    const qCols2 = db.prepare("PRAGMA table_info(quotes)").all().map(c => c.name);
    if (!qCols2.includes('include_image_ref')) {
        db.exec("ALTER TABLE quotes ADD COLUMN include_image_ref INTEGER NOT NULL DEFAULT 0");
        console.log('[db] Schema patch applied: quotes.include_image_ref');
    }

    // quote_items.base_price + group_item_type (audit 2026-07 full-system
    // check): standalone "Fixed Price" (outsource) items and grouped
    // 'fixed'/'flat' sub-items were losing their base price / multipliers /
    // sub-type on every save-reload cycle — same root cause as the
    // Additional Fees bug fixed earlier the same day (saveQuote() reading a
    // field the client never populates). See schema.sql comments.
    const qiCols4 = db.prepare("PRAGMA table_info(quote_items)").all().map(c => c.name);
    if (!qiCols4.includes('base_price')) {
        db.exec("ALTER TABLE quote_items ADD COLUMN base_price REAL NOT NULL DEFAULT 0");
        console.log('[db] Schema patch applied: quote_items.base_price');
    }
    if (!qiCols4.includes('group_item_type')) {
        db.exec("ALTER TABLE quote_items ADD COLUMN group_item_type TEXT");
        console.log('[db] Schema patch applied: quote_items.group_item_type');
    }

    // Proofing module (parallel clone of Job Orders, added 2026-07) — an
    // already-existing launchpad.db was created before these tables existed
    // in schema.sql, so (same rationale as login_attempts above) they must be
    // created here as an idempotent patch, not just added to schema.sql,
    // otherwise every /api/proofing call on a pre-existing DB would fail with
    // "no such table: proofing".
    const hasProofing = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='proofing'"
    ).get();
    if (!hasProofing) {
        db.exec(`
            CREATE TABLE proofing (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                proof_number          TEXT NOT NULL UNIQUE,
                client_id             INTEGER REFERENCES clients(id),
                client_name_raw       TEXT NOT NULL,
                issued_by             TEXT DEFAULT '',
                sales_name            TEXT DEFAULT '',
                image_guide_notes     TEXT DEFAULT '',
                image_guide_file_data TEXT,
                image_guide_filename  TEXT DEFAULT '',
                special_instructions  TEXT DEFAULT '',
                date_raw              TEXT,
                time_raw              TEXT,
                pdf_path              TEXT,
                created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                last_saved            TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX idx_proofing_client ON proofing(client_id);

            CREATE TABLE proofing_groups (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                proofing_id      INTEGER NOT NULL REFERENCES proofing(id) ON DELETE CASCADE,
                ctrl_num         TEXT,
                project_name     TEXT DEFAULT '',
                sort_order       INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_proofing_groups_proofing ON proofing_groups(proofing_id);
            CREATE INDEX idx_proofing_groups_ctrl ON proofing_groups(ctrl_num);

            CREATE TABLE proofing_items (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id        INTEGER NOT NULL REFERENCES proofing_groups(id) ON DELETE CASCADE,
                media           TEXT DEFAULT '',
                size_w          TEXT DEFAULT '',
                size_h          TEXT DEFAULT '',
                size_unit       TEXT DEFAULT '',
                qty             TEXT DEFAULT '',
                eco             INTEGER NOT NULL DEFAULT 0,
                uv              INTEGER NOT NULL DEFAULT 0,
                plot            INTEGER NOT NULL DEFAULT 0,
                laser           INTEGER NOT NULL DEFAULT 0,
                filename        TEXT DEFAULT '',
                file_data       TEXT,
                other_details   TEXT DEFAULT '',
                sort_order      INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_proofing_items_group ON proofing_items(group_id);

            CREATE TRIGGER trg_proofing_last_saved
            AFTER UPDATE ON proofing
            FOR EACH ROW WHEN NEW.last_saved = OLD.last_saved
            BEGIN
                UPDATE proofing SET last_saved = datetime('now') WHERE id = NEW.id;
            END;
        `);
        console.log('[db] Schema patch applied: created proofing/proofing_groups/proofing_items tables');
    }

    // activity_log — persistent audit trail (who did what), added after this
    // DB was already in use elsewhere, so create it here too for existing installs.
    const hasActivityLog = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='activity_log'"
    ).get();
    if (!hasActivityLog) {
        db.exec(`
            CREATE TABLE activity_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          TEXT NOT NULL DEFAULT (datetime('now')),
                user_id     TEXT,
                user_name   TEXT,
                role        TEXT,
                action      TEXT NOT NULL,
                details     TEXT,
                ip          TEXT
            );
            CREATE INDEX idx_activity_log_ts ON activity_log(ts);
        `);
        console.log('[db] Schema patch applied: created activity_log table');
    }
}

function requireDb() {
    if (!db) throw new Error('db.init() must be called before using the data layer');
    return db;
}

// ── Company key normalizer ──────────────────────────────────────────────────
// Canonical version — server.js's normalizeCompanyKey() and app.js's
// companyKey() MUST stay byte-for-byte identical to this. See the long
// comment trail in CONVERSATION HISTORY (Loob Philippines / RV / Breadtalk
// bug, June 2026) for why this one function caused weeks of duplicate data.
// Caps free-form text fields server-side. The frontend has no maxlength
// enforcement on textareas (material, address, etc.) — without this, a
// pasted huge value gets stored permanently and re-sent on every
// getAllQuotes()/getAllJobOrders() call (audit 7.2).
function cap(s, maxLen) {
    if (s === null || s === undefined) return s;
    s = String(s);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// num()/numOrNull() — quote_items.{qty,unit_price,computed_unit_price,flat_price}
// and quotes.discount_value are REAL columns (fixed from TEXT, audit 2026-07).
// SQLite's column-affinity coercion only converts values that already LOOK
// like a number — binding '' or undefined into a REAL column just stores
// the text as-is, silently recreating the old TEXT-in-a-numeric-column bug.
// Coercing here, at the one place every quote item/discount gets written,
// guarantees the column only ever holds real numbers going forward.
//
// Strip thousands-separator commas BEFORE parsing — the pre-migration data
// showed real values like "5,695.06" (from the app's own toLocaleString
// formatting getting saved back). parseFloat('5,695.06') would silently
// stop at the comma and return 5; stripping commas first avoids repeating
// that bug on every future save (see repair-money-columns.js for the
// one-time cleanup this required on existing rows).
function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function normalizeCompanyKey(name) {
    let s = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return '';
    const suffixes = /\b(inc|incorporated|corp|corporation|ltd|limited|co|company)\.?$/;
    let paren = '';
    const parenMatch = s.match(/\s*(\([^()]*\))\s*$/);
    if (parenMatch) { paren = ' ' + parenMatch[1]; s = s.slice(0, parenMatch.index).trim(); }
    let prev;
    do {
        prev = s;
        s = s.replace(/[.,]\s*$/, '').trim();
        s = s.replace(suffixes, '').trim();
        s = s.replace(/[.,]\s*$/, '').trim();
    } while (s !== prev && s.length > 0);
    return ((s || (name || '').trim().toLowerCase()) + paren).trim();
}

// ── storeKey helpers ─────────────────────────────────────────────────────────
// The old system encoded (controlNumber, companyKey, revision) into a string
// like "Q26_0001|loob philippines|rev2". The frontend still sends/expects
// this exact format, so we keep constructing/parsing it here at the
// boundary — internally everything is normalized SQL columns.
function buildStoreKey(controlNumber, companyKey, revision) {
    return `${controlNumber}|${companyKey}|rev${revision}`;
}
function parseStoreKey(storeKey) {
    const parts = String(storeKey).split('|');
    if (parts.length < 3) return null;
    const [controlNumber, companyKey, revPart] = parts;
    const m = revPart.match(/^rev(\d+)$/);
    if (!m) return null;
    return { controlNumber, companyKey, revision: parseInt(m[1]) };
}

function getOrCreateClientId(companyName) {
    const key = normalizeCompanyKey(companyName);
    if (!key) return null;
    const existing = requireDb().prepare('SELECT id FROM clients WHERE company_key = ?').get(key);
    if (existing) return existing.id;
    const info = requireDb().prepare(`
        INSERT INTO clients (company_key, company_name) VALUES (?, ?)
    `).run(key, (companyName || '').trim().toUpperCase());
    return info.lastInsertRowid;
}

// ── Clients ──────────────────────────────────────────────────────────────────
// Mirrors the old readClientsCSV() shape: array of plain objects with
// companyName/address/attentionTo/contactNo/tin/salesRep/mop fields.
function getClients() {
    const rows = requireDb().prepare('SELECT * FROM clients ORDER BY company_name').all();
    return rows.map(r => ({
        companyName: r.company_name, address: r.address, attentionTo: r.attention_to,
        contactNo: r.contact_no, tin: r.tin, salesRep: r.sales_rep, mop: r.mop,
        _companyKey: r.company_key, _id: r.id
    }));
}

function upsertClientRow({ companyName, address, attentionTo, contactNo, tin, salesRep, mop, originalKey }) {
    const key = normalizeCompanyKey(companyName);
    if (!key) throw new Error('Company name is required');
    if (originalKey && originalKey !== key) {
        // Renaming an existing client — update the row in place rather than
        // insert+orphan-the-old-one, so existing quotes/JOs (which reference
        // client_id, not the name) keep working.
        const oldRow = requireDb().prepare('SELECT id FROM clients WHERE company_key = ?').get(originalKey);
        if (oldRow) {
            requireDb().prepare(`
                UPDATE clients SET company_key=?, company_name=?, address=?, attention_to=?,
                    contact_no=?, tin=?, sales_rep=?, mop=?, updated_at=datetime('now')
                WHERE id = ?
            `).run(key, (companyName||'').trim().toUpperCase(), address||'', attentionTo||'',
                contactNo||'', tin||'', salesRep||'', mop||'', oldRow.id);
            return;
        }
    }
    requireDb().prepare(`
        INSERT INTO clients (company_key, company_name, address, attention_to, contact_no, tin, sales_rep, mop)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_key) DO UPDATE SET
            company_name=excluded.company_name, address=excluded.address,
            attention_to=excluded.attention_to, contact_no=excluded.contact_no,
            tin=excluded.tin, sales_rep=excluded.sales_rep, mop=excluded.mop,
            updated_at=datetime('now')
    `).run(key, (companyName||'').trim().toUpperCase(), address||'', attentionTo||'',
        contactNo||'', tin||'', salesRep||'', mop||'');
}

function deleteClientByKey(companyKey) {
    const key = normalizeCompanyKey(companyKey);
    requireDb().prepare('DELETE FROM clients WHERE company_key = ?').run(key);
}

// upsertClient() — same calling convention as the old server.js function:
// pass the quote/JO `data` object, it extracts company/address/etc itself.
function upsertClient(data) {
    upsertClientRow({
        companyName: data.company, address: data.address, attentionTo: data.attentionTo,
        contactNo: data.tel, tin: data.tin, salesRep: data.salesName, mop: data.mop
    });
}

// ── Serials ──────────────────────────────────────────────────────────────────
function getAllSerials() {
    const rows = requireDb().prepare('SELECT company_key, next_serial FROM serials').all();
    const out = {};
    rows.forEach(r => out[r.company_key] = r.next_serial - 1); // old format stored "last used", not "next"
    return out;
}

function peekNextSerial(companyName) {
    const key = normalizeCompanyKey(companyName);
    const row = requireDb().prepare('SELECT next_serial FROM serials WHERE company_key = ?').get(key);
    return row ? row.next_serial : 1;
}

function commitNextSerial(companyName) {
    const key = normalizeCompanyKey(companyName);
    if (!key) throw new Error('Missing companyKey');
    // Auto-create the client row if it doesn't exist yet — committing a serial
    // for a brand-new company (first quote ever for them) is the normal case,
    // not an edge case. The old JSON-based system had no such requirement, so
    // this keeps behavior identical despite serials now having a FK to clients.
    getOrCreateClientId(companyName);
    const tx = requireDb().transaction(() => {
        const row = requireDb().prepare('SELECT next_serial FROM serials WHERE company_key = ?').get(key);
        const serial = row ? row.next_serial : 1;
        requireDb().prepare(`
            INSERT INTO serials (company_key, next_serial, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(company_key) DO UPDATE SET next_serial = excluded.next_serial, updated_at = datetime('now')
        `).run(key, serial + 1);
        return serial;
    });
    return tx();
}

function setSerial(companyKey, value) {
    const key = normalizeCompanyKey(companyKey);
    if (value === 0) {
        requireDb().prepare('DELETE FROM serials WHERE company_key = ?').run(key);
    } else {
        getOrCreateClientId(companyKey); // FK requires the client row to exist first
        requireDb().prepare(`
            INSERT INTO serials (company_key, next_serial, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(company_key) DO UPDATE SET next_serial = excluded.next_serial, updated_at = datetime('now')
        `).run(key, value + 1);
    }
}

function deleteSerial(companyKey) {
    requireDb().prepare('DELETE FROM serials WHERE company_key = ?').run(normalizeCompanyKey(companyKey));
}

function wipeAllSerials() {
    requireDb().prepare('DELETE FROM serials').run();
}

// Recompute every company's serial counter directly from the quotes table —
// counts DISTINCT (control_number, client_id) pairs, so revisions of the same
// quote (rev0, rev1, rev2...) count once, not once per revision. Returns a
// diff report of any company whose stored counter didn't match the computed
// count (informational — useful after manual SQL edits or data imports).
function rebuildSerialsFromQuotes() {
    const computed = requireDb().prepare(`
        SELECT c.company_key AS key, COUNT(DISTINCT q.control_number) AS cnt
        FROM quotes q JOIN clients c ON c.id = q.client_id
        GROUP BY c.company_key
    `).all();

    const report = [];
    const tx = requireDb().transaction(() => {
        const existing = {};
        requireDb().prepare('SELECT company_key, next_serial FROM serials').all()
            .forEach(r => existing[r.company_key] = r.next_serial);

        const upsert = requireDb().prepare(`
            INSERT INTO serials (company_key, next_serial, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(company_key) DO UPDATE SET next_serial = excluded.next_serial, updated_at = datetime('now')
        `);
        computed.forEach(row => {
            const newNext = row.cnt + 1;
            const before = existing[row.key] ?? null;
            if (before !== newNext) report.push({ companyKey: row.key, before: before ? before - 1 : null, after: row.cnt });
            upsert.run(row.key, newNext);
            delete existing[row.key];
        });
        // Any leftover serials entries have no matching quotes at all — leave them as-is
        // (could be a company with a manually-set serial but zero quotes yet, which is valid).
    });
    tx();
    return report;
}

// ── Quotes ───────────────────────────────────────────────────────────────────
// getAllQuotes() returns the EXACT shape the frontend expects: an object
// keyed by storeKey string, each value a flat snapshot object matching what
// used to live in lp_quotes.json (so app.js's existing rendering code needs
// zero changes).
function getAllQuotes() {
    const rows = requireDb().prepare(`
        SELECT q.*, c.company_key, c.company_name
        FROM quotes q JOIN clients c ON c.id = q.client_id
    `).all();
    const itemsByQuote = {};
    requireDb().prepare('SELECT * FROM quote_items ORDER BY quote_id, sort_order').all().forEach(it => {
        if (!itemsByQuote[it.quote_id]) itemsByQuote[it.quote_id] = [];
        itemsByQuote[it.quote_id].push(it);
    });

    const out = {};
    rows.forEach(r => {
        const storeKey = buildStoreKey(r.control_number, r.company_key, r.revision);
        const items = itemsByQuote[r.id] || [];
        const inhouse    = items.filter(i => i.item_type === 'inhouse' && !i.group_name);
        const outsource  = items.filter(i => i.item_type === 'outsource');
        const flatrate   = items.filter(i => i.item_type === 'flatrate');
        const groupedRaw = items.filter(i => i.item_type === 'inhouse' && i.group_name);
        const groups = {};
        groupedRaw.forEach(i => {
            if (!groups[i.group_name]) groups[i.group_name] = { name: i.group_name, items: [] };
            groups[i.group_name].items.push(itemRowToObj(i));
        });

        out[storeKey] = {
            controlNumber: r.control_number, company: r.company_name, revisions: r.revision,
            projectName: r.project_name, address: r.address, tin: r.tin, attentionTo: r.attention_to,
            date: r.quote_date, tel: r.tel, leadTime: r.lead_time, paymentTerms: r.payment_terms,
            salesName: r.sales_name, salesContact: r.sales_contact, salesEmail: r.sales_email,
            salesPosition: r.sales_position, isGrouped: !!r.is_grouped, includeVat: !!r.include_vat,
            vatExclusive: !!r.vat_exclusive, discountType: r.discount_type, discountValue: r.discount_value,
            bankDetails: r.bank_details ? JSON.parse(r.bank_details) : undefined,
            pdfPath: r.pdf_path, includeImageRef: !!r.include_image_ref, createdAt: r.created_at, lastSaved: r.last_saved,
            items: inhouse.map(itemRowToObj),
            outsourceItems: outsource.map(itemRowToObj),
            flatRateItems: flatrate.map(itemRowToObj),
            quoteGroups: Object.values(groups),
            _quoteId: r.id, _clientId: r.client_id
        };
    });
    return out;
}

function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}
function itemRowToObj(i) {
    // formula_json carries the Simple/Advanced/Fixed Price formula-builder
    // state. Rows saved before this column existed (or non-inhouse items,
    // which never had a formula builder) parse to {}, so every field below
    // comes back undefined — restoreSnapshot() in app.js already has `||`
    // fallbacks for each of these, same as it did before this column existed.
    const formula = safeJsonParse(i.formula_json || '{}', {});
    return {
        material: i.material, sizeW: i.size_w, sizeH: i.size_h, sizeUnit: i.size_unit, qty: i.qty,
        unitPrice: i.unit_price, computedUnitPrice: i.computed_unit_price,
        flatFee: !!i.flat_fee, flatPrice: i.flat_price,
        // basePrice: the "Fixed Price" base amount before multipliers, for
        // standalone outsource items and grouped 'fixed' sub-items (0/unused
        // for every other item type). group_item_type/_type: only meaningful
        // for rows inside a quote group — restoreSnapshot()/addQuoteGroup()
        // in app.js use it to decide which sub-widget (In-House/Fixed
        // Price/Flat Rate) to rebuild each group row as. Both added 2026-07.
        basePrice: i.base_price, _type: i.group_item_type || undefined,
        multipliers: safeJsonParse(i.multipliers_json || '[]', []), addons: safeJsonParse(i.addons_json || '[]', []),
        fbMode: formula.fbMode, fbComponents: formula.fbComponents, fbOuterMult: formula.fbOuterMult,
        fbAdvFormula: formula.fbAdvFormula, fixedFormula: formula.fixedFormula,
        fixedMults: formula.fixedMults, fixedManualPrice: formula.fixedManualPrice,
        // images_json is [{filename, path, mimeType}, ...] — the file bytes
        // themselves live on disk (see schema.sql comment), this is just the
        // pointer list. Old rows / non-inhouse items parse to [].
        images: safeJsonParse(i.images_json || '[]', [])
    };
}

// Flat list of every reference-image file path currently attached to a
// quote's items — used BEFORE saveQuote() re-inserts quote_items (which
// deletes and replaces every row) to know which on-disk files are being
// dropped, and BEFORE deleteQuote() removes the quote entirely. Pure lookup,
// no filesystem access here — server.js owns actually deleting the files.
function getQuoteImagePaths(storeKey) {
    const parsed = parseStoreKey(storeKey);
    if (!parsed) return [];
    const key = normalizeCompanyKey(parsed.companyKey);
    const clientRow = requireDb().prepare('SELECT id FROM clients WHERE company_key = ?').get(key);
    if (!clientRow) return [];
    const quoteRow = requireDb().prepare(
        'SELECT id FROM quotes WHERE client_id=? AND control_number=? AND revision=?'
    ).get(clientRow.id, parsed.controlNumber, parsed.revision);
    if (!quoteRow) return [];
    const rows = requireDb().prepare('SELECT images_json FROM quote_items WHERE quote_id = ?').all(quoteRow.id);
    const paths = [];
    rows.forEach(r => {
        safeJsonParse(r.images_json || '[]', []).forEach(img => { if (img && img.path) paths.push(img.path); });
    });
    return paths;
}

// saveQuote() — same calling convention as the old POST /api/quotes route:
// pass the storeKey string and the snapshot object exactly as the frontend
// sends them.
function saveQuote(storeKey, snapshot) {
    const parsed = parseStoreKey(storeKey);
    if (!parsed) throw new Error('Invalid storeKey format');
    const clientId = getOrCreateClientId(snapshot.company || parsed.companyKey);

    const tx = requireDb().transaction(() => {
        const existing = requireDb().prepare(`
            SELECT id, created_at FROM quotes WHERE client_id=? AND control_number=? AND revision=?
        `).get(clientId, parsed.controlNumber, parsed.revision);

        let quoteId;
        const createdAt = existing ? existing.created_at : (snapshot.createdAt || new Date().toISOString());
        const lastSaved = new Date().toISOString();

        if (existing) {
            requireDb().prepare(`
                UPDATE quotes SET project_name=?, address=?, tin=?, attention_to=?, quote_date=?, tel=?,
                    lead_time=?, payment_terms=?, sales_name=?, sales_contact=?, sales_email=?, sales_position=?,
                    is_grouped=?, include_vat=?, vat_exclusive=?, discount_type=?, discount_value=?,
                    bank_details=?, pdf_path=?, include_image_ref=?, last_saved=?
                WHERE id=?
            `).run(cap(snapshot.projectName,500)||'', cap(snapshot.address,1000)||'', cap(snapshot.tin,100)||'', cap(snapshot.attentionTo,200)||'',
                snapshot.date||null, cap(snapshot.tel,100)||'', cap(snapshot.leadTime,200)||'', cap(snapshot.paymentTerms,200)||'',
                cap(snapshot.salesName,200)||'', cap(snapshot.salesContact,100)||'', cap(snapshot.salesEmail,200)||'', cap(snapshot.salesPosition,200)||'',
                snapshot.isGrouped?1:0, snapshot.includeVat?1:0, snapshot.vatExclusive?1:0,
                snapshot.discountType||null, numOrNull(snapshot.discountValue),
                snapshot.bankDetails?JSON.stringify(snapshot.bankDetails):null, snapshot.pdfPath||null,
                snapshot.includeImageRef?1:0, lastSaved, existing.id);
            quoteId = existing.id;
            requireDb().prepare('DELETE FROM quote_items WHERE quote_id = ?').run(quoteId);
        } else {
            const info = requireDb().prepare(`
                INSERT INTO quotes (control_number, client_id, revision, project_name, address, tin, attention_to,
                    quote_date, tel, lead_time, payment_terms, sales_name, sales_contact, sales_email, sales_position,
                    is_grouped, include_vat, vat_exclusive, discount_type, discount_value, bank_details, pdf_path,
                    include_image_ref, created_at, last_saved)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(parsed.controlNumber, clientId, parsed.revision, cap(snapshot.projectName,500)||'', cap(snapshot.address,1000)||'',
                cap(snapshot.tin,100)||'', cap(snapshot.attentionTo,200)||'', snapshot.date||null, cap(snapshot.tel,100)||'',
                cap(snapshot.leadTime,200)||'', cap(snapshot.paymentTerms,200)||'', cap(snapshot.salesName,200)||'', cap(snapshot.salesContact,100)||'',
                cap(snapshot.salesEmail,200)||'', cap(snapshot.salesPosition,200)||'', snapshot.isGrouped?1:0, snapshot.includeVat?1:0,
                snapshot.vatExclusive?1:0, snapshot.discountType||null, numOrNull(snapshot.discountValue),
                snapshot.bankDetails?JSON.stringify(snapshot.bankDetails):null, snapshot.pdfPath||null,
                snapshot.includeImageRef?1:0, createdAt, lastSaved);
            quoteId = info.lastInsertRowid;
        }

        const insertItem = requireDb().prepare(`
            INSERT INTO quote_items (quote_id, item_type, group_name, material, size_w, size_h, size_unit, qty,
                unit_price, computed_unit_price, flat_fee, flat_price, multipliers_json, addons_json, formula_json, images_json,
                base_price, group_item_type, sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        let sortOrder = 0;
        (snapshot.items||[]).forEach(item => {
            // Only standard (non-grouped) in-house items use the Simple/
            // Advanced/Fixed Price formula builder — capture its full state
            // here so reopening the quote later restores the same tab/
            // formula instead of just the number it last computed to.
            const formulaJson = JSON.stringify({
                fbMode: item.fbMode || 'simple',
                fbComponents: item.fbComponents || [{ price: 0, mult: 1 }],
                fbOuterMult: item.fbOuterMult != null ? item.fbOuterMult : 1,
                fbAdvFormula: item.fbAdvFormula || '',
                fixedFormula: item.fixedFormula || '',
                fixedMults: item.fixedMults || [],
                fixedManualPrice: item.fixedManualPrice || 0
            });
            // item.images must already be resolved to {filename, path,
            // mimeType} by the time it reaches here — server.js resolves any
            // upload tokens to permanent disk files BEFORE calling
            // saveQuote() (this layer doesn't touch the filesystem).
            const imagesJson = JSON.stringify(item.images || []);
            insertItem.run(quoteId, 'inhouse', null, cap(item.material,500)||'', item.sizeW||'', item.sizeH||'',
                item.sizeUnit||'', num(item.qty), 0, num(item.computedUnitPrice), item.flatFee?1:0,
                num(item.flatPrice), JSON.stringify(item.multipliers||[]), JSON.stringify(item.addons||[]), formulaJson, imagesJson,
                0, null, sortOrder++);
        });
        (snapshot.outsourceItems||[]).forEach(item => {
            // "Fixed Price" items on the client (base price × multipliers =
            // final unit price). _captureSnapshotV2() never sets
            // item.unitPrice — only basePrice/multipliers/computedUnitPrice —
            // so reading item.unitPrice here (as this used to) always wrote
            // 0, and basePrice/multipliers had nowhere to land at all
            // (no base_price column, multipliers_json hardcoded to '[]').
            // Every outsource item's real price and formula silently reset
            // to 0/empty on the very next save. Fixed 2026-07 (same audit
            // that caught the Additional Fees bug).
            const finalPrice = num(item.computedUnitPrice) || num(item.unitPrice);
            insertItem.run(quoteId, 'outsource', null, cap(item.material,500)||'', item.sizeW||'', item.sizeH||'',
                item.sizeUnit||'', num(item.qty||item.quantity), finalPrice, finalPrice, 0, 0,
                JSON.stringify(item.multipliers||[]), '[]', '{}', '[]',
                num(item.basePrice), null, sortOrder++);
        });
        (snapshot.flatRateItems||[]).forEach(item => {
            // "Additional Fees" section on the client. The client captures
            // this row's price as item.flatPrice (and mirrors it into
            // item.computedUnitPrice) — it never sets item.unitPrice. This
            // used to read num(item.unitPrice), which is always 0 for these
            // rows, and hardcoded flat_price=0 too, so the fee amount was
            // silently discarded on every save. Fix: pull the real price
            // from whichever field is actually populated and write it to
            // every price column a reader might look at (unit_price,
            // computed_unit_price, flat_price) so it survives reload
            // regardless of which one itemRowToObj/app.js ends up using.
            const feePrice = num(item.flatPrice) || num(item.unitPrice) || num(item.computedUnitPrice);
            insertItem.run(quoteId, 'flatrate', null, cap(item.material,500)||'', '', '', '', num(item.qty||item.quantity),
                feePrice, feePrice, 1, feePrice, '[]', '[]', '{}', '[]', 0, null, sortOrder++);
        });
        (snapshot.quoteGroups||[]).forEach(group => {
            (group.items||[]).forEach(item => {
                // Grouped quote items carry a client-side item._type tag
                // ('inhouse'|'fixed'|'flat', set by collectQuoteGroups())
                // that used to be discarded entirely — every grouped item
                // came back as item_type='inhouse' on reload regardless of
                // which sub-widget it was actually entered under, and
                // 'fixed' sub-items lost their multipliers (hardcoded to
                // '[]') with nowhere to store basePrice at all. item_type
                // itself must stay 'inhouse' here (it's what the CHECK
                // constraint allows and what getAllQuotes() uses, alongside
                // group_name, to detect "this row belongs to a group") —
                // group_item_type is the new column that actually remembers
                // the sub-widget. Fixed 2026-07.
                const groupItemType = item._type === 'fixed' || item._type === 'flat' ? item._type : 'inhouse';
                const price = num(item.unitPrice) || num(item.flatPrice) || num(item.computedUnitPrice);
                // Grouped 'inhouse' sub-items use the same Simple/Advanced/
                // Fixed Price formula builder as standalone items, but this
                // state was never captured for grouped items — formula_json
                // was hardcoded to '{}', so reopening a group always reset
                // the formula panel to defaults, which then recomputed the
                // price as 0 and overwrote whatever was restored (reported
                // 2026-07, same day as the group_item_type fix above).
                // Non-inhouse sub-items ('fixed'/'flat') don't use this
                // panel at all, so they keep '{}' same as before. Likewise
                // images_json: grouped items can carry reference images
                // (addItem() renders the same UI), captured only for the
                // 'inhouse' sub-type for the same reason.
                const formulaJson = groupItemType === 'inhouse' ? JSON.stringify({
                    fbMode: item.fbMode || 'simple',
                    fbComponents: item.fbComponents || [{ price: 0, mult: 1 }],
                    fbOuterMult: item.fbOuterMult != null ? item.fbOuterMult : 1,
                    fbAdvFormula: item.fbAdvFormula || '',
                    fixedFormula: item.fixedFormula || '',
                    fixedMults: item.fixedMults || [],
                    fixedManualPrice: item.fixedManualPrice || 0
                }) : '{}';
                const imagesJson = groupItemType === 'inhouse' ? JSON.stringify(item.images || []) : '[]';
                insertItem.run(quoteId, 'inhouse', cap(group.name||group.projectName,200)||null, cap(item.material,500)||'',
                    item.sizeW||'', item.sizeH||'', item.sizeUnit||'', num(item.qty||item.quantity),
                    price, price, groupItemType === 'flat' ? 1 : 0, groupItemType === 'flat' ? price : 0,
                    JSON.stringify(item.multipliers||[]), '[]', formulaJson, imagesJson,
                    num(item.basePrice), groupItemType, sortOrder++);
            });
        });
        return quoteId;
    });
    return tx();
}

// Surgical pdf_path update — used right after writing a PDF to disk, where
// we only want to set one column without re-running the full saveQuote()
// upsert (which would require re-passing every other field).
function setQuotePdfPath(storeKey, pdfPath) {
    const parsed = parseStoreKey(storeKey);
    if (!parsed) return false;
    const key = normalizeCompanyKey(parsed.companyKey);
    const clientRow = requireDb().prepare('SELECT id FROM clients WHERE company_key = ?').get(key);
    if (!clientRow) return false;
    const info = requireDb().prepare(`
        UPDATE quotes SET pdf_path = ? WHERE client_id=? AND control_number=? AND revision=?
    `).run(pdfPath, clientRow.id, parsed.controlNumber, parsed.revision);
    return info.changes > 0;
}

function deleteQuote(storeKey) {
    const parsed = parseStoreKey(storeKey);
    if (!parsed) return null;
    const key = normalizeCompanyKey(parsed.companyKey);
    const clientRow = requireDb().prepare('SELECT id FROM clients WHERE company_key = ?').get(key);
    if (!clientRow) return null;
    const row = requireDb().prepare(`
        SELECT q.*, c.company_name FROM quotes q JOIN clients c ON c.id=q.client_id
        WHERE q.client_id=? AND q.control_number=? AND q.revision=?
    `).get(clientRow.id, parsed.controlNumber, parsed.revision);
    if (!row) return null;
    // Capture image paths BEFORE the cascade delete removes quote_items —
    // server.js uses these to clean up the actual files on disk (this layer
    // never touches the filesystem itself).
    const imagePaths = requireDb().prepare('SELECT images_json FROM quote_items WHERE quote_id = ?').all(row.id)
        .flatMap(r => safeJsonParse(r.images_json || '[]', []).map(img => img && img.path).filter(Boolean));
    requireDb().prepare('DELETE FROM quotes WHERE id = ?').run(row.id); // cascades to quote_items
    return { controlNumber: row.control_number, company: row.company_name, projectName: row.project_name,
        revisions: row.revision, pdfPath: row.pdf_path, imagePaths };
}

// ── Job Orders ───────────────────────────────────────────────────────────────
function getAllJobOrders(opts = {}) {
    const includeFileData = opts.includeFileData !== false;
    const rows = requireDb().prepare(`
        SELECT jo.*, c.company_key FROM job_orders jo LEFT JOIN clients c ON c.id = jo.client_id
    `).all();
    const groupsByJO = {};
    requireDb().prepare('SELECT * FROM job_order_groups ORDER BY job_order_id, sort_order').all().forEach(g => {
        if (!groupsByJO[g.job_order_id]) groupsByJO[g.job_order_id] = [];
        groupsByJO[g.job_order_id].push(g);
    });
    // List views (includeFileData=false) skip file_data entirely at the SQL
    // level — the admin dashboard loads this on every page render and the
    // base64 images can be multiple MB per item (audit 3.2).
    const itemCols = includeFileData
        ? '*'
        : 'id, group_id, media, size_w, size_h, size_unit, qty, eco, uv, plot, laser, filename, other_details, sort_order';
    const itemsByGroup = {};
    requireDb().prepare(`SELECT ${itemCols} FROM job_order_items ORDER BY group_id, sort_order`).all().forEach(it => {
        if (!itemsByGroup[it.group_id]) itemsByGroup[it.group_id] = [];
        itemsByGroup[it.group_id].push(it);
    });

    const out = {};
    rows.forEach(r => {
        const companyKey = r.company_key || normalizeCompanyKey(r.client_name_raw);
        // Year prefix is derived from the JO's own date/creation time, not a
        // hardcoded '26' — avoids the Y2K-style bug where every new JO past a
        // year boundary would still be labeled JO26-... (audit 3.5).
        const joYearSrc = (r.date_raw || r.created_at || '').match(/^(\d{4})/);
        const joYear = joYearSrc ? joYearSrc[1].slice(-2) : String(new Date().getFullYear()).slice(-2);
        const storeKey = `JO${joYear}-${r.jo_number}|${companyKey}`;
        const groups = (groupsByJO[r.id] || []).map(g => ({
            ctrlNum: g.ctrl_num, projectName: g.project_name,
            items: (itemsByGroup[g.id] || []).map(i => ({
                media: i.media, sizeW: i.size_w, sizeH: i.size_h, sizeUnit: i.size_unit, qty: i.qty,
                eco: !!i.eco, uv: !!i.uv, plot: !!i.plot, laser: !!i.laser,
                filename: i.filename, fileData: includeFileData ? i.file_data : undefined, otherDetails: i.other_details
            }))
        }));
        out[storeKey] = {
            joNumber: r.jo_number, client: r.client_name_raw, issuedBy: r.issued_by, salesName: r.sales_name,
            deadline: r.deadline, specialInstructions: r.special_instructions, dateRaw: r.date_raw,
            timeRaw: r.time_raw, pdfPath: r.pdf_path, createdAt: r.created_at, lastSaved: r.last_saved,
            groups, _jobOrderId: r.id
        };
    });
    return out;
}

function saveJobOrder(storeKey, snapshot) {
    // Match any 2-digit year prefix (JO25-, JO26-, JO27-, ...) — see audit 3.5.
    const m = String(storeKey).match(/^JO\d{2}-(.+?)\|(.+)$/);
    const joNumber = m ? m[1] : (snapshot.joNumber || storeKey);
    const clientId = getOrCreateClientId(snapshot.client || '');

    const tx = requireDb().transaction(() => {
        const existing = requireDb().prepare('SELECT id, created_at FROM job_orders WHERE jo_number = ?').get(joNumber);
        const createdAt = existing ? existing.created_at : (snapshot.createdAt || new Date().toISOString());
        const lastSaved = new Date().toISOString();
        let jobOrderId;

        if (existing) {
            requireDb().prepare(`
                UPDATE job_orders SET client_id=?, client_name_raw=?, issued_by=?, sales_name=?, deadline=?,
                    special_instructions=?, date_raw=?, time_raw=?, pdf_path=?, last_saved=?
                WHERE id=?
            `).run(clientId, cap(snapshot.client,200)||'', cap(snapshot.issuedBy,100)||'', cap(snapshot.salesName,200)||'',
                cap(snapshot.deadline,200)||'', cap(snapshot.specialInstructions,2000)||'', snapshot.dateRaw||null,
                snapshot.timeRaw||null, snapshot.pdfPath||null, lastSaved, existing.id);
            jobOrderId = existing.id;
            requireDb().prepare('DELETE FROM job_order_groups WHERE job_order_id = ?').run(jobOrderId); // cascades items
        } else {
            const info = requireDb().prepare(`
                INSERT INTO job_orders (jo_number, client_id, client_name_raw, issued_by, sales_name, deadline,
                    special_instructions, date_raw, time_raw, pdf_path, created_at, last_saved)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(joNumber, clientId, cap(snapshot.client,200)||'', cap(snapshot.issuedBy,100)||'', cap(snapshot.salesName,200)||'',
                cap(snapshot.deadline,200)||'', cap(snapshot.specialInstructions,2000)||'', snapshot.dateRaw||null,
                snapshot.timeRaw||null, snapshot.pdfPath||null, createdAt, lastSaved);
            jobOrderId = info.lastInsertRowid;
        }

        const insertGroup = requireDb().prepare(`INSERT INTO job_order_groups (job_order_id, ctrl_num, project_name, sort_order) VALUES (?,?,?,?)`);
        const insertItem  = requireDb().prepare(`
            INSERT INTO job_order_items (group_id, media, size_w, size_h, size_unit, qty, eco, uv, plot, laser,
                filename, file_data, other_details, sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        let groupOrder = 0;
        (snapshot.groups||[]).forEach(group => {
            const gInfo = insertGroup.run(jobOrderId, group.ctrlNum||null, cap(group.projectName,200)||'', groupOrder++);
            const groupId = gInfo.lastInsertRowid;
            let itemOrder = 0;
            (group.items||[]).forEach(item => {
                insertItem.run(groupId, cap(item.media,200)||'', item.sizeW||'', item.sizeH||'', item.sizeUnit||'',
                    item.qty||'', item.eco?1:0, item.uv?1:0, item.plot?1:0, item.laser?1:0, cap(item.filename,255)||'',
                    item.fileData||null, cap(item.otherDetails,2000)||'', itemOrder++);
            });
        });
        return jobOrderId;
    });
    return tx();
}

// Surgical pdf_path update for job orders, same rationale as setQuotePdfPath.
function setJobOrderPdfPath(storeKey, pdfPath) {
    const m = String(storeKey).match(/^JO\d{2}-(.+?)\|/);
    const joNumber = m ? m[1] : storeKey;
    const info = requireDb().prepare('UPDATE job_orders SET pdf_path = ? WHERE jo_number = ?').run(pdfPath, joNumber);
    return info.changes > 0;
}

function deleteJobOrder(storeKey) {
    const m = String(storeKey).match(/^JO\d{2}-(.+?)\|/);
    const joNumber = m ? m[1] : storeKey;
    const row = requireDb().prepare('SELECT * FROM job_orders WHERE jo_number = ?').get(joNumber);
    if (!row) return null;
    requireDb().prepare('DELETE FROM job_orders WHERE id = ?').run(row.id); // cascades
    // Return enough fields for server.js to reconstruct the expected PDF
    // filename as a fallback when pdf_path wasn't recorded — same reasoning
    // as deleteQuote() below (audit 2026-07: JO delete had no such fallback).
    return { pdfPath: row.pdf_path, joNumber: row.jo_number, client: row.client_name_raw, dateRaw: row.date_raw };
}

// ── Proofing ─────────────────────────────────────────────────────────────────
// Parallel module to Job Orders — same shape/logic, renamed columns, and
// image_guide_file_data/image_guide_filename replace JO's plain "deadline"
// text field (Proofing's "Image Guide" section supports an uploaded
// reference image in addition to notes text).
function getAllProofing(opts = {}) {
    const includeFileData = opts.includeFileData !== false;
    const rows = requireDb().prepare(`
        SELECT pr.*, c.company_key FROM proofing pr LEFT JOIN clients c ON c.id = pr.client_id
    `).all();
    const groupsByProofing = {};
    requireDb().prepare('SELECT * FROM proofing_groups ORDER BY proofing_id, sort_order').all().forEach(g => {
        if (!groupsByProofing[g.proofing_id]) groupsByProofing[g.proofing_id] = [];
        groupsByProofing[g.proofing_id].push(g);
    });
    // List views (includeFileData=false) skip file_data entirely at the SQL
    // level — the admin dashboard loads this on every page render and the
    // base64 images can be multiple MB per item (same rationale as JO, audit 3.2).
    const itemCols = includeFileData
        ? '*'
        : 'id, group_id, media, size_w, size_h, size_unit, qty, eco, uv, plot, laser, filename, other_details, sort_order';
    const itemsByGroup = {};
    requireDb().prepare(`SELECT ${itemCols} FROM proofing_items ORDER BY group_id, sort_order`).all().forEach(it => {
        if (!itemsByGroup[it.group_id]) itemsByGroup[it.group_id] = [];
        itemsByGroup[it.group_id].push(it);
    });

    const out = {};
    rows.forEach(r => {
        const companyKey = r.company_key || normalizeCompanyKey(r.client_name_raw);
        // Year prefix is derived from the Proofing doc's own date/creation
        // time, not a hardcoded value — same reasoning as JO (audit 3.5).
        const prYearSrc = (r.date_raw || r.created_at || '').match(/^(\d{4})/);
        const prYear = prYearSrc ? prYearSrc[1].slice(-2) : String(new Date().getFullYear()).slice(-2);
        const storeKey = `PF${prYear}-${r.proof_number}|${companyKey}`;
        const groups = (groupsByProofing[r.id] || []).map(g => ({
            ctrlNum: g.ctrl_num, projectName: g.project_name,
            items: (itemsByGroup[g.id] || []).map(i => ({
                media: i.media, sizeW: i.size_w, sizeH: i.size_h, sizeUnit: i.size_unit, qty: i.qty,
                eco: !!i.eco, uv: !!i.uv, plot: !!i.plot, laser: !!i.laser,
                filename: i.filename, fileData: includeFileData ? i.file_data : undefined, otherDetails: i.other_details
            }))
        }));
        out[storeKey] = {
            proofNumber: r.proof_number, client: r.client_name_raw, issuedBy: r.issued_by, salesName: r.sales_name,
            imageGuideNotes: r.image_guide_notes,
            imageGuideFileData: includeFileData ? r.image_guide_file_data : undefined,
            imageGuideFilename: r.image_guide_filename,
            specialInstructions: r.special_instructions, dateRaw: r.date_raw,
            timeRaw: r.time_raw, pdfPath: r.pdf_path, createdAt: r.created_at, lastSaved: r.last_saved,
            groups, _proofingId: r.id
        };
    });
    return out;
}

function saveProofing(storeKey, snapshot) {
    // Match any 2-digit year prefix (PF25-, PF26-, PF27-, ...) — see audit 3.5.
    const m = String(storeKey).match(/^PF\d{2}-(.+?)\|(.+)$/);
    const proofNumber = m ? m[1] : (snapshot.proofNumber || storeKey);
    const clientId = getOrCreateClientId(snapshot.client || '');

    const tx = requireDb().transaction(() => {
        const existing = requireDb().prepare('SELECT id, created_at FROM proofing WHERE proof_number = ?').get(proofNumber);
        const createdAt = existing ? existing.created_at : (snapshot.createdAt || new Date().toISOString());
        const lastSaved = new Date().toISOString();
        let proofingId;

        if (existing) {
            requireDb().prepare(`
                UPDATE proofing SET client_id=?, client_name_raw=?, issued_by=?, sales_name=?, image_guide_notes=?,
                    image_guide_file_data=?, image_guide_filename=?,
                    special_instructions=?, date_raw=?, time_raw=?, pdf_path=?, last_saved=?
                WHERE id=?
            `).run(clientId, cap(snapshot.client,200)||'', cap(snapshot.issuedBy,100)||'', cap(snapshot.salesName,200)||'',
                cap(snapshot.imageGuideNotes,2000)||'', snapshot.imageGuideFileData||null, cap(snapshot.imageGuideFilename,255)||'',
                cap(snapshot.specialInstructions,2000)||'', snapshot.dateRaw||null,
                snapshot.timeRaw||null, snapshot.pdfPath||null, lastSaved, existing.id);
            proofingId = existing.id;
            requireDb().prepare('DELETE FROM proofing_groups WHERE proofing_id = ?').run(proofingId); // cascades items
        } else {
            const info = requireDb().prepare(`
                INSERT INTO proofing (proof_number, client_id, client_name_raw, issued_by, sales_name, image_guide_notes,
                    image_guide_file_data, image_guide_filename, special_instructions, date_raw, time_raw, pdf_path, created_at, last_saved)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(proofNumber, clientId, cap(snapshot.client,200)||'', cap(snapshot.issuedBy,100)||'', cap(snapshot.salesName,200)||'',
                cap(snapshot.imageGuideNotes,2000)||'', snapshot.imageGuideFileData||null, cap(snapshot.imageGuideFilename,255)||'',
                cap(snapshot.specialInstructions,2000)||'', snapshot.dateRaw||null,
                snapshot.timeRaw||null, snapshot.pdfPath||null, createdAt, lastSaved);
            proofingId = info.lastInsertRowid;
        }

        const insertGroup = requireDb().prepare(`INSERT INTO proofing_groups (proofing_id, ctrl_num, project_name, sort_order) VALUES (?,?,?,?)`);
        const insertItem  = requireDb().prepare(`
            INSERT INTO proofing_items (group_id, media, size_w, size_h, size_unit, qty, eco, uv, plot, laser,
                filename, file_data, other_details, sort_order)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        let groupOrder = 0;
        (snapshot.groups||[]).forEach(group => {
            const gInfo = insertGroup.run(proofingId, group.ctrlNum||null, cap(group.projectName,200)||'', groupOrder++);
            const groupId = gInfo.lastInsertRowid;
            let itemOrder = 0;
            (group.items||[]).forEach(item => {
                insertItem.run(groupId, cap(item.media,200)||'', item.sizeW||'', item.sizeH||'', item.sizeUnit||'',
                    item.qty||'', item.eco?1:0, item.uv?1:0, item.plot?1:0, item.laser?1:0, cap(item.filename,255)||'',
                    item.fileData||null, cap(item.otherDetails,2000)||'', itemOrder++);
            });
        });
        return proofingId;
    });
    return tx();
}

// Surgical pdf_path update for proofing, same rationale as setJobOrderPdfPath.
function setProofingPdfPath(storeKey, pdfPath) {
    const m = String(storeKey).match(/^PF\d{2}-(.+?)\|/);
    const proofNumber = m ? m[1] : storeKey;
    const info = requireDb().prepare('UPDATE proofing SET pdf_path = ? WHERE proof_number = ?').run(pdfPath, proofNumber);
    return info.changes > 0;
}

function deleteProofing(storeKey) {
    const m = String(storeKey).match(/^PF\d{2}-(.+?)\|/);
    const proofNumber = m ? m[1] : storeKey;
    const row = requireDb().prepare('SELECT * FROM proofing WHERE proof_number = ?').get(proofNumber);
    if (!row) return null;
    // Grab the first group's project name before deleting — server.js's
    // fallback filename reconstruction needs it to match the real save name.
    const firstGroup = requireDb().prepare(
        'SELECT project_name FROM proofing_groups WHERE proofing_id = ? ORDER BY sort_order LIMIT 1'
    ).get(row.id);
    requireDb().prepare('DELETE FROM proofing WHERE id = ?').run(row.id); // cascades
    // Return enough fields for server.js to reconstruct the expected PDF
    // filename as a fallback when pdf_path wasn't recorded — same reasoning
    // as deleteJobOrder() above.
    return {
        pdfPath: row.pdf_path, proofNumber: row.proof_number, client: row.client_name_raw, dateRaw: row.date_raw,
        groups: firstGroup ? [{ projectName: firstGroup.project_name }] : []
    };
}

// ── Profiles ─────────────────────────────────────────────────────────────────
function getAllProfiles() {
    const rows = requireDb().prepare('SELECT * FROM profiles').all();
    return rows.map(profileRowToObj);
}
function getProfileById(id) {
    const row = requireDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return row ? profileRowToObj(row) : null;
}
function getProfileByEmail(email) {
    const row = requireDb().prepare('SELECT * FROM profiles WHERE LOWER(email) = LOWER(?)').get(email);
    return row ? profileRowToObj(row) : null;
}
function profileRowToObj(r) {
    return { id: r.id, name: r.name, position: r.position, contact: r.contact, email: r.email,
        role: r.role, pinHash: r.pin_hash, signature: r.signature, createdAt: r.created_at };
}
function createProfile({ id, name, position, contact, email, role, pinHash, signature }) {
    requireDb().prepare(`
        INSERT INTO profiles (id, name, position, contact, email, role, pin_hash, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, position, contact, email, role === 'admin' ? 'admin' : 'user', pinHash, signature || null);
}
function updateProfile(id, fields) {
    const row = requireDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!row) return false;
    const merged = {
        name: fields.name !== undefined ? fields.name : row.name,
        position: fields.position !== undefined ? fields.position : row.position,
        contact: fields.contact !== undefined ? fields.contact : row.contact,
        email: fields.email !== undefined ? fields.email : row.email,
        role: fields.role !== undefined ? (fields.role === 'admin' ? 'admin' : 'user') : row.role,
        signature: fields.signature !== undefined ? fields.signature : row.signature,
        pin_hash: fields.pinHash !== undefined ? fields.pinHash : row.pin_hash
    };
    requireDb().prepare(`
        UPDATE profiles SET name=?, position=?, contact=?, email=?, role=?, signature=?, pin_hash=? WHERE id=?
    `).run(merged.name, merged.position, merged.contact, merged.email, merged.role, merged.signature, merged.pin_hash, id);
    return true;
}
function deleteProfile(id) {
    requireDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

// ── Login attempts (persistent rate-limit backing store) ────────────────────
// See schema.sql login_attempts table and audit 2.3: keeping this in SQLite
// instead of only an in-memory Map means a server restart can't be used to
// reset a brute-force lockout window.
function recordLoginAttempt(ip) {
    requireDb().prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').run(ip, Date.now());
}
function countRecentLoginAttempts(ip, windowMs) {
    const since = Date.now() - windowMs;
    const row = requireDb().prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts >= ?').get(ip, since);
    return row ? row.n : 0;
}
function oldestRecentLoginAttempt(ip, windowMs) {
    const since = Date.now() - windowMs;
    const row = requireDb().prepare('SELECT MIN(ts) AS t FROM login_attempts WHERE ip = ? AND ts >= ?').get(ip, since);
    return row ? row.t : null;
}
function pruneOldLoginAttempts(windowMs) {
    const cutoff = Date.now() - windowMs;
    requireDb().prepare('DELETE FROM login_attempts WHERE ts < ?').run(cutoff);
}

// ── Backup ───────────────────────────────────────────────────────────────────
// Writes a fully consistent, single-file snapshot of the live database to
// destPath using SQLite's own VACUUM INTO command. This is the safe way to
// copy a WAL-mode database while it's still open and being written to —
// unlike a plain fs.copyFile, it can never grab a half-written page, and
// unlike copying the raw .db file, it doesn't need the -wal/-shm sidecars
// to come along for the copy to be valid (see 2026-07 SQLITE_PROTOCOL /
// Google-Drive incident — DATABASE-MIGRATION.md has the full story).
// destPath's parent directory must already exist; VACUUM INTO does not
// create directories and fails outright if the target already exists.
function backupTo(destPath) {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    const escaped = destPath.replace(/'/g, "''");
    requireDb().exec(`VACUUM INTO '${escaped}'`);
}

// ── Activity log ─────────────────────────────────────────────────────────────
// Persistent, queryable audit trail — deliberately separate from the PM2
// console request log (server.js), which is a live tail only and isn't meant
// to be scrolled back through days/weeks later.
function recordActivity({ userId, userName, role, action, details, ip }) {
    try {
        requireDb().prepare(
            'INSERT INTO activity_log (user_id, user_name, role, action, details, ip) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(userId || null, userName || null, role || null, action, details || null, ip || null);
    } catch (e) {
        // Never let logging itself break the request it's logging.
        console.error('[db] recordActivity failed:', e.message);
    }
}
function getRecentActivity({ limit = 200, userId = null, action = null } = {}) {
    let sql = 'SELECT * FROM activity_log';
    const conditions = [];
    const params = [];
    if (userId) { conditions.push('user_id = ?'); params.push(userId); }
    if (action) { conditions.push('action = ?'); params.push(action); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 200, 2000));
    return requireDb().prepare(sql).all(...params);
}

// ── Suggestions (FAB feedback form) ─────────────────────────────────────────
function addSuggestion({ userId, userName, role, text }) {
    const info = requireDb().prepare(
        'INSERT INTO suggestions (user_id, user_name, role, text) VALUES (?, ?, ?, ?)'
    ).run(userId || null, userName, role || null, text);
    return requireDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid);
}
function getAllSuggestions({ limit = 500 } = {}) {
    return requireDb().prepare('SELECT * FROM suggestions ORDER BY id DESC LIMIT ?')
        .all(Math.min(parseInt(limit) || 500, 2000));
}
function setSuggestionResolved(id, resolved) {
    requireDb().prepare('UPDATE suggestions SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
    return requireDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
}
function deleteSuggestion(id) {
    requireDb().prepare('DELETE FROM suggestions WHERE id = ?').run(id);
}

module.exports = {
    init, normalizeCompanyKey, buildStoreKey, parseStoreKey, CompatDatabase,
    getClients, upsertClientRow, upsertClient, deleteClientByKey,
    getAllSerials, peekNextSerial, commitNextSerial, setSerial, deleteSerial, wipeAllSerials, rebuildSerialsFromQuotes,
    getAllQuotes, saveQuote, deleteQuote, setQuotePdfPath, getQuoteImagePaths,
    getAllJobOrders, saveJobOrder, deleteJobOrder, setJobOrderPdfPath,
    getAllProofing, saveProofing, deleteProofing, setProofingPdfPath,
    getAllProfiles, getProfileById, getProfileByEmail, createProfile, updateProfile, deleteProfile,
    recordLoginAttempt, countRecentLoginAttempts, oldestRecentLoginAttempt, pruneOldLoginAttempts,
    recordActivity, getRecentActivity,
    addSuggestion, getAllSuggestions, setSuggestionResolved, deleteSuggestion,
    backupTo,
};
