// ============================================================================
// One-time repair for the TEXT -> REAL money-column migration (2026-07).
//
// WHY THIS EXISTS: schema.sql/db.js were updated to store quote_items.{qty,
// unit_price,computed_unit_price,flat_price} and quotes.discount_value as
// REAL instead of TEXT. On first restart after that change, db.js's
// _applySchemaPatches() rebuilt those tables using SQLite's CAST(x AS REAL).
//
// CAST(x AS REAL) takes the LONGEST NUMERIC PREFIX of a string. That's fine
// for genuine garbage ("TBD" -> 0), but WRONG for comma-formatted numbers:
// CAST('5,695.06' AS REAL) = 5.0, not 5695.06 — it silently truncates at the
// comma. lp_quotes.json (the pre-SQLite source file, untouched by the schema
// migration) still has the original text, e.g. "computedUnitPrice": "5,695.06".
// This script re-derives the CORRECT numeric value from that original JSON
// (stripping thousands-separator commas before parsing) and fixes any
// quote_items/quotes row where the migrated value doesn't match.
//
// SAFE BY DEFAULT: running this with no flags only prints a report — it does
// NOT modify the database. Re-run with --apply to actually write the fixes,
// after reviewing the report. Always back up launchpad.db before --apply.
//
// Usage:
//   node repair-money-columns.js            (dry run — writes repair-report.json)
//   node repair-money-columns.js --apply    (applies the fixes it found)
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');

const DRIVE_FOLDER = process.env.DRIVE_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. Launchpad Portal\\1. Quotations';
const DB_PATH = path.join(DRIVE_FOLDER, 'launchpad.db');
const QUOTES_JSON = path.join(DRIVE_FOLDER, 'lp_quotes.json');

console.log(`[repair] Mode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (report only)'}`);
console.log(`[repair] DB:    ${DB_PATH}`);
console.log(`[repair] JSON:  ${QUOTES_JSON}`);

if (!fs.existsSync(DB_PATH)) { console.error(`[repair] launchpad.db not found at ${DB_PATH}`); process.exit(1); }
if (!fs.existsSync(QUOTES_JSON)) { console.error(`[repair] lp_quotes.json not found at ${QUOTES_JSON} — nothing to repair against.`); process.exit(1); }

if (APPLY) {
    const backupPath = DB_PATH + `.before-repair-${Date.now()}.bak`;
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[repair] Backed up launchpad.db to: ${backupPath}`);
}

// Correctly parses a possibly comma-formatted / possibly-garbage numeric
// string. This is the fix for the CAST(x AS REAL) truncation-at-comma bug —
// strip thousands separators BEFORE parsing, same intent as the app's own
// display formatting (toLocaleString) just inverted.
function fixNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    const s = String(v).replace(/,/g, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}
function fixNumOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).replace(/,/g, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}
function closeEnough(a, b) {
    const an = a === null || a === undefined ? null : Number(a);
    const bn = b === null || b === undefined ? null : Number(b);
    if (an === null && bn === null) return true;
    if (an === null || bn === null) return false;
    return Math.abs(an - bn) < 1e-6;
}

// Copied verbatim from db.js — MUST stay identical. storeKey's embedded
// company segment is the RAW text (e.g. "...consultancy inc."), but
// clients.company_key has suffixes like inc/corp/corporation/ltd stripped.
// Matching on the raw segment instead of this normalized form silently
// misses every company name ending in one of those suffixes (found via a
// too-low matched-quote count on first run — see conversation).
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

const db = new DatabaseSync(DB_PATH);
const quotesJson = JSON.parse(fs.readFileSync(QUOTES_JSON, 'utf8'));

const report = { checkedQuotes: 0, matchedQuotes: 0, unmatchedQuotes: [], itemFixes: [], discountFixes: [], itemCountMismatches: [] };

const findQuote = db.prepare(`
    SELECT q.id FROM quotes q JOIN clients c ON c.id = q.client_id
    WHERE c.company_key = ? AND q.control_number = ? AND q.revision = ?
`);
const getItems = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order');
const getQuote = db.prepare('SELECT id, discount_value FROM quotes WHERE id = ?');
const updateItem = db.prepare(`
    UPDATE quote_items SET qty=?, unit_price=?, computed_unit_price=?, flat_price=? WHERE id=?
`);
const updateDiscount = db.prepare('UPDATE quotes SET discount_value=? WHERE id=?');

for (const storeKey of Object.keys(quotesJson)) {
    const v = quotesJson[storeKey];
    const parts = storeKey.split('|');
    if (parts.length < 3) continue;
    const [ctrl, rawCompanyKey, revPart] = parts;
    const revMatch = revPart.match(/^rev(\d+)$/);
    const revision = revMatch ? parseInt(revMatch[1]) : (v.revisions || 0);
    // Match migrate.js's own lookup precedence: prefer the normalized
    // display company name, fall back to the raw storeKey segment only if
    // there's no company field at all.
    const companyKey = normalizeCompanyKey(v.company) || rawCompanyKey;

    report.checkedQuotes++;
    const quoteRow = findQuote.get(companyKey, ctrl, revision);
    if (!quoteRow) { report.unmatchedQuotes.push(storeKey); continue; }
    report.matchedQuotes++;
    const quoteId = quoteRow.id;

    // Rebuild the exact same flat, ordered item list migrate.js/db.js produce
    // (items, then outsourceItems, then flatRateItems, then quoteGroups items),
    // with the field mapping each insert path actually used.
    const expected = [];
    (v.items || []).forEach(item => expected.push({
        qty: item.qty, unit_price: '', computed_unit_price: item.computedUnitPrice, flat_price: item.flatPrice
    }));
    (v.outsourceItems || []).forEach(item => expected.push({
        qty: item.qty || item.quantity, unit_price: item.unitPrice, computed_unit_price: '', flat_price: ''
    }));
    (v.flatRateItems || []).forEach(item => expected.push({
        qty: item.qty || item.quantity, unit_price: item.unitPrice, computed_unit_price: '', flat_price: ''
    }));
    (v.quoteGroups || []).forEach(group => (group.items || []).forEach(item => expected.push({
        qty: item.qty || item.quantity, unit_price: item.unitPrice, computed_unit_price: item.computedUnitPrice, flat_price: ''
    })));

    const dbItems = getItems.all(quoteId);
    if (dbItems.length !== expected.length) {
        report.itemCountMismatches.push({ storeKey, quoteId, dbCount: dbItems.length, jsonCount: expected.length });
        // Don't guess pairings when counts disagree — skip rather than risk
        // writing a fix to the wrong row.
        continue;
    }

    dbItems.forEach((row, idx) => {
        const exp = expected[idx];
        const correct = {
            qty: fixNum(exp.qty), unit_price: fixNum(exp.unit_price),
            computed_unit_price: fixNum(exp.computed_unit_price), flat_price: fixNum(exp.flat_price)
        };
        const mismatched = !closeEnough(row.qty, correct.qty) || !closeEnough(row.unit_price, correct.unit_price) ||
            !closeEnough(row.computed_unit_price, correct.computed_unit_price) || !closeEnough(row.flat_price, correct.flat_price);
        if (mismatched) {
            report.itemFixes.push({
                storeKey, quoteId, itemId: row.id, sortOrder: row.sort_order,
                before: { qty: row.qty, unit_price: row.unit_price, computed_unit_price: row.computed_unit_price, flat_price: row.flat_price },
                after: correct
            });
            if (APPLY) updateItem.run(correct.qty, correct.unit_price, correct.computed_unit_price, correct.flat_price, row.id);
        }
    });

    const correctDiscount = fixNumOrNull(v.discountValue);
    const currentQuote = getQuote.get(quoteId);
    if (!closeEnough(currentQuote.discount_value, correctDiscount)) {
        report.discountFixes.push({ storeKey, quoteId, before: currentQuote.discount_value, after: correctDiscount });
        if (APPLY) updateDiscount.run(correctDiscount, quoteId);
    }
}

db.close();

fs.writeFileSync(path.join(__dirname, 'repair-report.json'), JSON.stringify(report, null, 2));

console.log(`\n[repair] Checked ${report.checkedQuotes} quotes from lp_quotes.json, matched ${report.matchedQuotes} in launchpad.db.`);
console.log(`[repair] Unmatched (no longer in DB, or created after migration): ${report.unmatchedQuotes.length}`);
console.log(`[repair] Item count mismatches (skipped, needs manual look): ${report.itemCountMismatches.length}`);
console.log(`[repair] Quote item fields that need fixing: ${report.itemFixes.length}`);
console.log(`[repair] Quote discount_value fields that need fixing: ${report.discountFixes.length}`);
console.log(`[repair] Full detail written to repair-report.json`);
if (!APPLY && (report.itemFixes.length > 0 || report.discountFixes.length > 0)) {
    console.log(`\n[repair] This was a DRY RUN — nothing was changed. Review repair-report.json, then re-run with --apply.`);
}
