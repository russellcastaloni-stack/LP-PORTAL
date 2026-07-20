-- ============================================================================
-- Launchpad Portal — SQLite Schema
-- Replaces: lp_quotes.json, lp_joborders.json, lp_clients.csv, lp_serials.json,
--           lp_profiles.json, lp_widgets.json, lp_notes.json, lp_chat.json
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;   -- better concurrent read/write than default

-- ── Clients ──────────────────────────────────────────────────────────────────
-- Replaces lp_clients.csv. company_key is the canonical dedup key
-- (normalizeCompanyKey output) — UNIQUE makes duplicates structurally
-- impossible, unlike the old CSV which silently allowed "Loob Philippines"
-- and "Loob Philippines Inc" as two separate rows.
CREATE TABLE clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_key   TEXT NOT NULL UNIQUE,   -- normalizeCompanyKey(company_name)
    company_name  TEXT NOT NULL,          -- display name, as typed (uppercased)
    address       TEXT DEFAULT '',
    attention_to  TEXT DEFAULT '',
    contact_no    TEXT DEFAULT '',
    tin           TEXT DEFAULT '',
    sales_rep     TEXT DEFAULT '',        -- profile.name of assigned rep (nullable = unassigned)
    mop           TEXT DEFAULT '',        -- comma-separated bank/payment method codes
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clients_sales_rep ON clients(sales_rep);

-- ── Profiles (users) ─────────────────────────────────────────────────────────
-- Replaces lp_profiles.json. role replaces the old isAdmin-flag-on-session
-- hack — it's now a real column the server can query/enforce directly.
CREATE TABLE profiles (
    id            TEXT PRIMARY KEY,        -- keep existing hex ids from migration
    name          TEXT NOT NULL,
    position      TEXT DEFAULT '',
    contact       TEXT DEFAULT '',
    email         TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    pin_hash      TEXT NOT NULL,
    signature     TEXT,                    -- base64 data URL, nullable
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The plain UNIQUE above is case-sensitive, but every lookup in db.js
-- (getProfileByEmail) matches on LOWER(email). Without this second index,
-- "A@x.com" and "a@x.com" could both be inserted as distinct rows, silently
-- defeating the uniqueness the app relies on (fix: audit 2026-07 review).
CREATE UNIQUE INDEX idx_profiles_email_lower ON profiles(LOWER(email));

-- ── Serials ──────────────────────────────────────────────────────────────────
-- Replaces lp_serials.json. Kept as its own table (not derived live from
-- quotes table) because the counter must increment atomically and fast on
-- every quote creation — a COUNT(*) over quotes on every request would be
-- correct but slower at scale. The /api/serials/rebuild-from-quotes endpoint
-- concept becomes a periodic integrity-check query instead (see below).
CREATE TABLE serials (
    company_key   TEXT PRIMARY KEY REFERENCES clients(company_key) ON UPDATE CASCADE,
    next_serial   INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))  -- audit trail for manual adjustments (audit 4.4)
);

-- ── Quotes ───────────────────────────────────────────────────────────────────
-- Replaces lp_quotes.json. The OLD system encoded (controlNumber, companyKey,
-- revision) into a single string storeKey like "Q26_0001|rv|rev2" — that
-- string was hand-parsed everywhere (split('|'), regex on '|rev(\d+)$', etc),
-- which is exactly how the duplicate-control-number and stale-key bugs crept
-- in. Here those three concepts become three real columns with constraints
-- the database enforces, so "two quotes with the same control_number for the
-- same client" becomes a UNIQUE violation, not a maybe-bug discovered months
-- later by manually diffing JSON files.
CREATE TABLE quotes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    control_number   TEXT NOT NULL,         -- e.g. 'Q26_0001' (display form, kept verbatim)
    client_id        INTEGER NOT NULL REFERENCES clients(id),
    revision         INTEGER NOT NULL DEFAULT 0,
    project_name     TEXT DEFAULT '',
    address           TEXT DEFAULT '',
    tin               TEXT DEFAULT '',
    attention_to      TEXT DEFAULT '',
    quote_date        TEXT,                  -- ISO date string
    tel               TEXT DEFAULT '',
    lead_time         TEXT DEFAULT '',
    payment_terms     TEXT DEFAULT '',
    sales_name        TEXT NOT NULL,         -- denormalized snapshot of who created it
    sales_contact     TEXT DEFAULT '',
    sales_email       TEXT DEFAULT '',
    sales_position    TEXT DEFAULT '',
    is_grouped        INTEGER NOT NULL DEFAULT 0,  -- boolean
    include_vat       INTEGER NOT NULL DEFAULT 0,
    vat_exclusive     INTEGER NOT NULL DEFAULT 0,
    discount_type     TEXT,
    discount_value    REAL,                  -- was TEXT; numeric so totals/aggregates are safe (audit 2026-07)
    bank_details      TEXT,
    pdf_path          TEXT,                  -- last-saved file path on the Drive
    include_image_ref INTEGER NOT NULL DEFAULT 0,  -- show item reference images in the printed PDF (2026-07)
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_saved        TEXT NOT NULL DEFAULT (datetime('now')),

    -- This is the constraint that the old JSON-key system could never enforce:
    -- one client cannot have two quotes with the same (control_number, revision).
    UNIQUE(client_id, control_number, revision)
);
CREATE INDEX idx_quotes_client ON quotes(client_id);
CREATE INDEX idx_quotes_control ON quotes(control_number);
CREATE INDEX idx_quotes_sales_name ON quotes(sales_name);

-- ── Quote line items ─────────────────────────────────────────────────────────
-- Replaces the items[]/outsourceItems[]/flatRateItems[] arrays embedded in
-- each quote JSON blob. item_type distinguishes which pricing model applied.
CREATE TABLE quote_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id           INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    item_type          TEXT NOT NULL CHECK(item_type IN ('inhouse','outsource','flatrate')),
    group_name         TEXT,                 -- only set when is_grouped quotes use named groups
    material           TEXT DEFAULT '',
    size_w             TEXT DEFAULT '',
    size_h             TEXT DEFAULT '',
    size_unit          TEXT DEFAULT '',
    qty                REAL NOT NULL DEFAULT 0,   -- was TEXT; numeric so SUM/aggregates are safe (audit 2026-07)
    unit_price         REAL NOT NULL DEFAULT 0,   -- was TEXT
    computed_unit_price REAL NOT NULL DEFAULT 0,  -- was TEXT
    flat_fee           INTEGER NOT NULL DEFAULT 0,
    flat_price         REAL NOT NULL DEFAULT 0,   -- was TEXT
    multipliers_json   TEXT DEFAULT '[]',     -- kept as JSON array text — small, variable-length list
    addons_json        TEXT DEFAULT '[]',
    formula_json       TEXT DEFAULT '{}',     -- Simple/Advanced/Fixed Price formula-builder state
                                               -- (fbMode, fbComponents, fbOuterMult, fbAdvFormula,
                                               -- fixedFormula, fixedMults, fixedManualPrice) — without
                                               -- this, only the final computed price was saved and the
                                               -- formula itself was lost on reload (fixed 2026-07).
    images_json        TEXT DEFAULT '[]',     -- [{filename, path, mimeType}, ...] — reference images
                                               -- attached to this item. The actual image bytes live as
                                               -- files on disk under DRIVE_FOLDER/<company>/_ref_images/
                                               -- (kept out of SQLite to avoid bloating the DB); this
                                               -- column only stores the pointers (added 2026-07).
    base_price         REAL NOT NULL DEFAULT 0,  -- "Fixed Price" (outsource) base price BEFORE
                                               -- multipliers are applied — was silently discarded on
                                               -- every save for standalone outsource items (unit_price
                                               -- read from a field the client never populated) and for
                                               -- grouped 'fixed' sub-items (no column existed at all).
                                               -- Fixed 2026-07.
    group_item_type    TEXT,                  -- 'inhouse'|'fixed'|'flat' — ONLY meaningful for rows
                                               -- inside a quote group (group_name IS NOT NULL). Grouped
                                               -- items used to all collapse to item_type='inhouse' on
                                               -- reload regardless of which sub-widget (In-House/Fixed
                                               -- Price/Flat Rate) they were actually entered as, because
                                               -- nothing persisted the client's per-item `_type` tag.
                                               -- Fixed 2026-07.
    sort_order         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);

-- ── Job Orders ───────────────────────────────────────────────────────────────
-- Replaces lp_joborders.json. jo_number is the manually-typed JO# (not
-- server-generated, unlike quote control numbers) — kept as TEXT since it's
-- sometimes alphanumeric in practice.
CREATE TABLE job_orders (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    jo_number          TEXT NOT NULL UNIQUE,
    client_id          INTEGER REFERENCES clients(id),  -- nullable: client may not be in clients table
    client_name_raw    TEXT NOT NULL,         -- as typed, in case client_id can't be resolved
    issued_by          TEXT DEFAULT '',
    sales_name         TEXT DEFAULT '',
    deadline           TEXT DEFAULT '',
    special_instructions TEXT DEFAULT '',
    date_raw           TEXT,
    time_raw           TEXT,
    pdf_path           TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    last_saved         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jo_client ON job_orders(client_id);

-- ── Job Order groups (each JO can have multiple project groups) ────────────
CREATE TABLE job_order_groups (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    job_order_id     INTEGER NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
    ctrl_num         TEXT,                   -- references quotes.control_number, but NOT a
                                              -- foreign key — a JO can reference a quote that
                                              -- was later deleted; we keep the JO record intact
    project_name     TEXT DEFAULT '',
    sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_jo_groups_jo ON job_order_groups(job_order_id);
CREATE INDEX idx_jo_groups_ctrl ON job_order_groups(ctrl_num);

-- ── Job Order items ──────────────────────────────────────────────────────────
-- file_data (base64 images) are large — stored in a separate table from the
-- group/JO metadata so listing JOs doesn't require loading megabytes of
-- embedded image data for rows you're not displaying yet.
CREATE TABLE job_order_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        INTEGER NOT NULL REFERENCES job_order_groups(id) ON DELETE CASCADE,
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
    file_data       TEXT,                    -- base64 data URL, can be large
    other_details   TEXT DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_jo_items_group ON job_order_items(group_id);

-- ── Proofing ─────────────────────────────────────────────────────────────────
-- Parallel module to Job Orders (same shape), used for internal proofing
-- sign-off sheets. proof_number is the manually-typed PR# (not
-- server-generated), same convention as jo_number.
CREATE TABLE proofing (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    proof_number          TEXT NOT NULL UNIQUE,
    client_id             INTEGER REFERENCES clients(id),  -- nullable: client may not be in clients table
    client_name_raw       TEXT NOT NULL,         -- as typed, in case client_id can't be resolved
    issued_by             TEXT DEFAULT '',
    sales_name            TEXT DEFAULT '',
    image_guide_notes     TEXT DEFAULT '',       -- replaces JO's "deadline" field
    image_guide_file_data TEXT,                  -- base64 data URL of the uploaded reference image, can be large
    image_guide_filename  TEXT DEFAULT '',
    special_instructions  TEXT DEFAULT '',
    date_raw              TEXT,
    time_raw              TEXT,
    pdf_path              TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    last_saved            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_proofing_client ON proofing(client_id);

-- ── Proofing groups (each Proofing doc can have multiple project groups) ────
CREATE TABLE proofing_groups (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    proofing_id      INTEGER NOT NULL REFERENCES proofing(id) ON DELETE CASCADE,
    ctrl_num         TEXT,                   -- references quotes.control_number, but NOT a
                                              -- foreign key — a Proofing doc can reference a
                                              -- quote that was later deleted; we keep the
                                              -- Proofing record intact
    project_name     TEXT DEFAULT '',
    sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_proofing_groups_proofing ON proofing_groups(proofing_id);
CREATE INDEX idx_proofing_groups_ctrl ON proofing_groups(ctrl_num);

-- ── Proofing items ───────────────────────────────────────────────────────────
-- file_data (base64 images) are large — stored in a separate table from the
-- group/proofing metadata so listing Proofing docs doesn't require loading
-- megabytes of embedded image data for rows you're not displaying yet.
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
    file_data       TEXT,                    -- base64 data URL, can be large
    other_details   TEXT DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_proofing_items_group ON proofing_items(group_id);

-- ── Chat messages ────────────────────────────────────────────────────────────
-- Replaces lp_chat.json.
CREATE TABLE chat_messages (
    id          TEXT PRIMARY KEY,           -- keep existing hex ids
    sender      TEXT NOT NULL,
    sender_id   TEXT DEFAULT '',
    text        TEXT NOT NULL,
    ts          INTEGER NOT NULL            -- unix ms, as before
);
CREATE INDEX idx_chat_ts ON chat_messages(ts);

-- ── Login attempts ───────────────────────────────────────────────────────────
-- Backs the rate limiter (server.js checkRateLimit). Persisting attempts here
-- (instead of only in an in-memory Map) means a deliberate or accidental
-- server restart can no longer be used to bypass the 15-minute brute-force
-- lockout window (see audit 2.3).
CREATE TABLE login_attempts (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ip    TEXT NOT NULL,
    ts    INTEGER NOT NULL            -- unix ms
);
CREATE INDEX idx_login_attempts_ip_ts ON login_attempts(ip, ts);

-- ── Activity log ─────────────────────────────────────────────────────────────
-- Persistent audit trail of who did what — separate from PM2's console
-- output (which is a live/ephemeral tail, not meant for long-term history).
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

-- ── Suggestions ──────────────────────────────────────────────────────────────
-- Free-form feedback/suggestions submitted by portal users via the FAB
-- button on the Quotation/Job Order/Proofing forms. Listed admin-only in the
-- dashboard's Suggestions tab.
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

-- ── Notes & widgets ──────────────────────────────────────────────────────────
-- Replaces lp_notes.json / lp_widgets.json. Kept generic/schemaless on
-- purpose — these are small, low-traffic, free-form admin scratch data where
-- a rigid schema would add migration overhead for no real safety benefit.
CREATE TABLE notes (
    id          TEXT PRIMARY KEY,
    data_json   TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE widgets (
    id          TEXT PRIMARY KEY,
    data_json   TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Automatic audit timestamps ──────────────────────────────────────────────
-- These triggers ensure last_saved/updated_at are always current even when a
-- row is updated by a path other than the normal application code (e.g. a
-- manual SQL fix) — closes the gap noted in audit 4.2, where last_saved was
-- previously only set by hand in db.js.
CREATE TRIGGER trg_quotes_last_saved
AFTER UPDATE ON quotes
FOR EACH ROW WHEN NEW.last_saved = OLD.last_saved
BEGIN
    UPDATE quotes SET last_saved = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_job_orders_last_saved
AFTER UPDATE ON job_orders
FOR EACH ROW WHEN NEW.last_saved = OLD.last_saved
BEGIN
    UPDATE job_orders SET last_saved = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_proofing_last_saved
AFTER UPDATE ON proofing
FOR EACH ROW WHEN NEW.last_saved = OLD.last_saved
BEGIN
    UPDATE proofing SET last_saved = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_profiles_updated_at
AFTER UPDATE ON profiles
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE profiles SET updated_at = datetime('now') WHERE id = NEW.id;
END;
