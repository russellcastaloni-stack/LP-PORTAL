// ============================================================================
// Read-only diagnostic: checks what the LIVE server actually sees for job
// orders, using the exact same DB_PATH/SCHEMA_PATH resolution as server.js
// (same DRIVE_FOLDER env var, same launchpad.db filename). Run this ON THE
// SERVER, from the app folder:
//
//     node check-joborders.js
//
// It does NOT modify anything — pure SELECT queries. Safe to run any time.
// ============================================================================
const path = require('path');
const fs   = require('fs');
const dataLayer = require('./db.js');

const DRIVE_FOLDER = process.env.DRIVE_FOLDER
    || 'G:\\Shared drives\\JOBS (OPERATIONS)\\8_SALES\\1. Launchpad Portal\\1. Quotations';
const DB_PATH     = path.join(DRIVE_FOLDER, 'launchpad.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

console.log('Checking DB at:', DB_PATH);
console.log('DB file exists:', fs.existsSync(DB_PATH));
if (!fs.existsSync(DB_PATH)) {
    console.log('\n>>> This is the problem: the server is configured to look for launchpad.db here,');
    console.log('>>> but no file exists at that path. Check your DRIVE_FOLDER env var / .env file.');
    process.exit(1);
}

dataLayer.init(DB_PATH, SCHEMA_PATH);
const db = dataLayer.CompatDatabase ? null : null; // (init() above already opened it internally)

// Use the same public API server.js uses, so this reflects EXACTLY what
// GET /api/joborders would return.
const all = dataLayer.getAllJobOrders({ includeFileData: false });
const keys = Object.keys(all);

console.log('\nTotal job orders visible via getAllJobOrders():', keys.length);
if (keys.length) {
    console.log('\nFirst 5:');
    keys.slice(0, 5).forEach(k => {
        const jo = all[k];
        console.log(`  ${k}  ->  client="${jo.client}"  salesName="${jo.salesName}"  lastSaved=${jo.lastSaved}`);
    });
} else {
    console.log('\n>>> Zero rows returned. Next step: open launchpad.db directly (e.g. with the');
    console.log('>>> "DB Browser for SQLite" free tool) and run: SELECT COUNT(*) FROM job_orders;');
    console.log('>>> If that count is also 0, the data genuinely never made it into this DB file.');
    console.log('>>> If that count is > 0, something is filtering/erroring between the DB and this script —');
    console.log('>>> send me the COUNT(*) result and I will dig further.');
}
