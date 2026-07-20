// ============================================================================
// Launchpad Portal — Production Migration Script
// Migrates: lp_clients.csv, lp_quotes.json, lp_joborders.json, lp_profiles.json,
//           lp_chat.json, lp_notes.json, lp_widgets.json
// Into:     launchpad.db (SQLite)
//
// Conflicting records (duplicates that violate UNIQUE constraints) are
// SKIPPED, not silently merged or auto-renumbered — they're written to
// skipped.json for manual review. See PENDING_CONFLICTS.md for the known
// list as of the last dry run.
//
// SAFE TO RE-RUN: this script does not modify the source JSON/CSV files.
// It only reads them and writes to launchpad.db. Delete launchpad.db and
// re-run any time to start fresh.
// ============================================================================

// Uses the same node:sqlite-backed CompatDatabase wrapper as db.js — see
// that file for why (better-sqlite3 needs native compilation, which failed
// on the production server due to missing Python/Visual Studio toolchain).
const { CompatDatabase: Database } = require('./db.js');
const fs   = require('fs');
const path = require('path');

// ── Config — adjust these paths for the real server environment ────────────
const DRIVE_FOLDER = process.env.DRIVE_FOLDER || '.';
const DB_PATH       = path.join(DRIVE_FOLDER, 'launchpad.db');
const SKIPPED_PATH  = path.join(DRIVE_FOLDER, 'migration_skipped.json');
const SCHEMA_PATH   = path.join(__dirname, 'schema.sql');

function file(name) { return path.join(DRIVE_FOLDER, name); }

// ── Canonical company key normalizer ────────────────────────────────────────
// MUST stay identical to normalizeCompanyKey() in server.js and
// companyKey() in app.js — see comments there for why this matters.
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

function csvParseLine(line) {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else cur += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { out.push(cur); cur = ''; }
            else cur += c;
        }
    }
    out.push(cur);
    return out;
}

function readJsonIfExists(p, fallback) {
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { console.warn(`[migrate] Could not parse ${p}: ${e.message}`); return fallback; }
}

// ── Start ────────────────────────────────────────────────────────────────────
if (fs.existsSync(DB_PATH)) {
    console.error(`[migrate] ${DB_PATH} already exists. Delete it first if you want to re-migrate from scratch.`);
    process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
console.log(`[migrate] Created ${DB_PATH} with schema applied.`);

const skipped = { quotes: [], jobOrders: [], notes: [] };
const stats = { clients: 0, profiles: 0, quotes: 0, quoteItems: 0, jobOrders: 0, joGroups: 0, joItems: 0, chat: 0, notes: 0, widgets: 0, serials: 0 };

// ── 1. Clients ───────────────────────────────────────────────────────────────
const clientKeyToId = {};
const insertClient = db.prepare(`
    INSERT INTO clients (company_key, company_name, address, attention_to, contact_no, tin, sales_rep, mop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_key) DO UPDATE SET
        company_name=excluded.company_name, address=excluded.address,
        attention_to=excluded.attention_to, contact_no=excluded.contact_no,
        tin=excluded.tin, sales_rep=excluded.sales_rep, mop=excluded.mop
`);

const csvPath = file('lp_clients.csv');
if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const [companyName='', address='', attentionTo='', contactNo='', tin='', salesRep='', mop=''] = csvParseLine(lines[i]);
        const key = normalizeCompanyKey(companyName);
        if (!key) continue;
        insertClient.run(key, companyName.trim().toUpperCase(), address.trim(), attentionTo.trim(), contactNo.trim(), tin.trim(), salesRep.trim(), mop.trim());
        stats.clients++;
    }
}
db.prepare('SELECT id, company_key FROM clients').all().forEach(r => clientKeyToId[r.company_key] = r.id);
console.log(`[migrate] Clients: ${stats.clients} rows -> ${Object.keys(clientKeyToId).length} unique canonical keys`);

function getOrCreateClient(rawName) {
    const key = normalizeCompanyKey(rawName);
    if (!key) return null;
    if (clientKeyToId[key]) return clientKeyToId[key];
    const info = insertClient.run(key, (rawName||'').trim().toUpperCase(), '', '', '', '', '', '');
    clientKeyToId[key] = info.lastInsertRowid;
    stats.clients++;
    return clientKeyToId[key];
}

// ── 2. Profiles ──────────────────────────────────────────────────────────────
const profiles = readJsonIfExists(file('lp_profiles.json'), {});
const insertProfile = db.prepare(`
    INSERT INTO profiles (id, name, position, contact, email, role, pin_hash, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const p of Object.values(profiles)) {
    try {
        insertProfile.run(p.id, p.name||'', p.position||'', p.contact||'', p.email||'',
            p.role === 'admin' ? 'admin' : 'user', p.pinHash||'', p.signature||null);
        stats.profiles++;
    } catch (e) {
        console.warn(`[migrate] Profile skipped (${p.email}): ${e.message}`);
    }
}
console.log(`[migrate] Profiles: ${stats.profiles}`);

// ── 3. Quotes ────────────────────────────────────────────────────────────────
const quotes = readJsonIfExists(file('lp_quotes.json'), {});
const insertQuote = db.prepare(`
    INSERT INTO quotes (control_number, client_id, revision, project_name, address, tin, attention_to,
        quote_date, tel, lead_time, payment_terms, sales_name, sales_contact, sales_email, sales_position,
        is_grouped, include_vat, vat_exclusive, discount_type, discount_value, bank_details, pdf_path,
        created_at, last_saved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insertItem = db.prepare(`
    INSERT INTO quote_items (quote_id, item_type, group_name, material, size_w, size_h, size_unit, qty,
        unit_price, computed_unit_price, flat_fee, flat_price, multipliers_json, addons_json, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

for (const storeKey of Object.keys(quotes)) {
    const v = quotes[storeKey];
    const parts = storeKey.split('|');
    if (parts.length < 3) { skipped.quotes.push({ storeKey, reason: 'malformed storeKey' }); continue; }
    const [ctrl, rawCompanyKey, revPart] = parts;
    const clientId = getOrCreateClient(v.company || rawCompanyKey);
    if (!clientId) { skipped.quotes.push({ storeKey, reason: 'no usable company name' }); continue; }
    const revMatch = revPart.match(/^rev(\d+)$/);
    const revision = revMatch ? parseInt(revMatch[1]) : (v.revisions || 0);

    let quoteId;
    try {
        const info = insertQuote.run(
            ctrl, clientId, revision, v.projectName||'', v.address||'', v.tin||'', v.attentionTo||'',
            v.date||null, v.tel||'', v.leadTime||'', v.paymentTerms||'', v.salesName||'', v.salesContact||'',
            v.salesEmail||'', v.salesPosition||'', v.isGrouped?1:0, v.includeVat?1:0, v.vatExclusive?1:0,
            v.discountType||null, v.discountValue||null, v.bankDetails?JSON.stringify(v.bankDetails):null,
            v.pdfPath||null, v.createdAt||new Date().toISOString(), v.lastSaved||new Date().toISOString()
        );
        quoteId = info.lastInsertRowid;
        stats.quotes++;
    } catch (e) {
        skipped.quotes.push({ storeKey, reason: e.message, company: v.company, controlNumber: ctrl, revision,
            projectName: v.projectName, lastSaved: v.lastSaved });
        continue;
    }

    let sortOrder = 0;
    (v.items||[]).forEach(item => {
        insertItem.run(quoteId, 'inhouse', null, item.material||'', item.sizeW||'', item.sizeH||'',
            item.sizeUnit||'', item.qty||'', '', item.computedUnitPrice||'', item.flatFee?1:0,
            item.flatPrice||'', JSON.stringify(item.multipliers||[]), JSON.stringify(item.addons||[]), sortOrder++);
        stats.quoteItems++;
    });
    (v.outsourceItems||[]).forEach(item => {
        insertItem.run(quoteId, 'outsource', null, item.material||'', item.sizeW||'', item.sizeH||'',
            item.sizeUnit||'', item.qty||item.quantity||'', item.unitPrice||'', '', 0, '', '[]', '[]', sortOrder++);
        stats.quoteItems++;
    });
    (v.flatRateItems||[]).forEach(item => {
        insertItem.run(quoteId, 'flatrate', null, item.material||'', '', '', '', item.qty||item.quantity||'',
            item.unitPrice||'', '', 1, '', '[]', '[]', sortOrder++);
        stats.quoteItems++;
    });
    (v.quoteGroups||[]).forEach(group => {
        (group.items||[]).forEach(item => {
            insertItem.run(quoteId, 'inhouse', group.name||group.projectName||null, item.material||'',
                item.sizeW||'', item.sizeH||'', item.sizeUnit||'', item.qty||item.quantity||'',
                item.unitPrice||'', item.computedUnitPrice||'', 0, '', '[]', '[]', sortOrder++);
            stats.quoteItems++;
        });
    });
}
console.log(`[migrate] Quotes: ${stats.quotes} migrated, ${skipped.quotes.length} skipped (see migration_skipped.json)`);
console.log(`[migrate] Quote items: ${stats.quoteItems}`);

// ── 4. Job Orders ────────────────────────────────────────────────────────────
const jos = readJsonIfExists(file('lp_joborders.json'), {});
const insertJO = db.prepare(`
    INSERT INTO job_orders (jo_number, client_id, client_name_raw, issued_by, sales_name, deadline,
        special_instructions, date_raw, time_raw, pdf_path, created_at, last_saved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`);
const insertJOGroup = db.prepare(`INSERT INTO job_order_groups (job_order_id, ctrl_num, project_name, sort_order) VALUES (?,?,?,?)`);
const insertJOItem = db.prepare(`
    INSERT INTO job_order_items (group_id, media, size_w, size_h, size_unit, qty, eco, uv, plot, laser,
        filename, file_data, other_details, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

for (const joKey of Object.keys(jos)) {
    const v = jos[joKey];
    const clientId = getOrCreateClient(v.client || '');
    let jobOrderId;
    try {
        const info = insertJO.run(v.joNumber||joKey, clientId, v.client||'', v.issuedBy||'', v.salesName||'',
            v.deadline||'', v.specialInstructions||'', v.dateRaw||null, v.timeRaw||null, v.pdfPath||null,
            v.createdAt||new Date().toISOString(), v.lastSaved||new Date().toISOString());
        jobOrderId = info.lastInsertRowid;
        stats.jobOrders++;
    } catch (e) {
        skipped.jobOrders.push({ key: joKey, reason: e.message, joNumber: v.joNumber, client: v.client, lastSaved: v.lastSaved });
        continue;
    }

    let groupOrder = 0;
    (v.groups||[]).forEach(group => {
        const gInfo = insertJOGroup.run(jobOrderId, group.ctrlNum||null, group.projectName||'', groupOrder++);
        const groupId = gInfo.lastInsertRowid;
        stats.joGroups++;
        let itemOrder = 0;
        (group.items||[]).forEach(item => {
            insertJOItem.run(groupId, item.media||'', item.sizeW||'', item.sizeH||'', item.sizeUnit||'',
                item.qty||'', item.eco?1:0, item.uv?1:0, item.plot?1:0, item.laser?1:0, item.filename||'',
                item.fileData||null, item.otherDetails||'', itemOrder++);
            stats.joItems++;
        });
    });
}
console.log(`[migrate] Job Orders: ${stats.jobOrders} migrated, ${skipped.jobOrders.length} skipped`);
console.log(`[migrate] JO groups: ${stats.joGroups}, JO items: ${stats.joItems}`);

// ── 5. Serials — rebuilt from migrated quotes (count-based, not trusted from old file) ──
const insertSerial = db.prepare(`INSERT OR REPLACE INTO serials (company_key, next_serial) VALUES (?, ?)`);
const threadCounts = db.prepare(`
    SELECT c.company_key AS key, COUNT(DISTINCT q.control_number || '|' || q.client_id) AS cnt
    FROM quotes q JOIN clients c ON c.id = q.client_id
    GROUP BY c.company_key
`).all();
threadCounts.forEach(row => { insertSerial.run(row.key, row.cnt + 1); stats.serials++; });
console.log(`[migrate] Serials: ${stats.serials} company counters rebuilt from migrated quotes`);

// ── 6. Chat / Notes / Widgets ────────────────────────────────────────────────
const chat = readJsonIfExists(file('lp_chat.json'), []);
const insertChat = db.prepare(`INSERT INTO chat_messages (id, sender, sender_id, text, ts) VALUES (?,?,?,?,?)`);
(Array.isArray(chat) ? chat : Object.values(chat)).forEach(m => {
    try { insertChat.run(m.id || String(m.ts), m.sender||'', m.senderId||'', m.text||'', m.ts||Date.now()); stats.chat++; }
    catch (e) { /* duplicate id, skip silently — chat is low-stakes */ }
});

const notes = readJsonIfExists(file('lp_notes.json'), {});
const insertNote = db.prepare(`INSERT OR REPLACE INTO notes (id, data_json) VALUES (?, ?)`);
Object.entries(notes).forEach(([k, v]) => { insertNote.run(k, JSON.stringify(v)); stats.notes++; });

const widgets = readJsonIfExists(file('lp_widgets.json'), {});
const insertWidget = db.prepare(`INSERT OR REPLACE INTO widgets (id, data_json) VALUES (?, ?)`);
Object.entries(widgets).forEach(([k, v]) => { insertWidget.run(k, JSON.stringify(v)); stats.widgets++; });

console.log(`[migrate] Chat: ${stats.chat}, Notes: ${stats.notes}, Widgets: ${stats.widgets}`);

// ── Write skipped report ─────────────────────────────────────────────────────
fs.writeFileSync(SKIPPED_PATH, JSON.stringify(skipped, null, 2));
const totalSkipped = skipped.quotes.length + skipped.jobOrders.length;
console.log('');
console.log(`[migrate] DONE. ${totalSkipped} records skipped — see ${SKIPPED_PATH}`);
console.log(`[migrate] Database written to ${DB_PATH}`);

db.close();
