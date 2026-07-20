// Basic smoke tests for db.js — the SQLite data access layer.
//
// Run with: npm test  (node's built-in test runner, node --test)
// No new dependency needed — Node 22.5+ (already required by package.json)
// ships node:test and node:assert out of the box, matching this project's
// existing preference for zero-native-dependency tooling (see db.js's
// node:sqlite comment for why that preference exists at all).
//
// Uses a throwaway temp database file per run, in the OS temp directory —
// never touches the real data/launchpad.db.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const dataLayer = require('./db.js');

const TMP_DB      = path.join(os.tmpdir(), `launchpad-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

test.before(() => {
    dataLayer.init(TMP_DB, SCHEMA_PATH);
});

test.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
    }
});

test('normalizeCompanyKey collapses common business-name variants', () => {
    // This is the exact bug class that caused duplicate serials/records in
    // production ("Loob Philippines" vs "Loob Philippines Inc.") — the two
    // must always normalize to the same key.
    assert.equal(
        dataLayer.normalizeCompanyKey('Loob Philippines Inc.'),
        dataLayer.normalizeCompanyKey('Loob Philippines')
    );
    assert.equal(dataLayer.normalizeCompanyKey('  ACME   Corp.  '), 'acme');
    assert.equal(dataLayer.normalizeCompanyKey(''), '');
    assert.equal(dataLayer.normalizeCompanyKey('Sample Co. (Branch A)'), 'sample (branch a)');
});

test('buildStoreKey / parseStoreKey round-trip', () => {
    const key = dataLayer.buildStoreKey('Q26_0001', 'acme', 2);
    assert.equal(key, 'Q26_0001|acme|rev2');
    assert.deepEqual(dataLayer.parseStoreKey(key), { controlNumber: 'Q26_0001', companyKey: 'acme', revision: 2 });
    assert.equal(dataLayer.parseStoreKey('not-a-valid-key'), null);
});

test('serial commit/peek: peek never advances, commit always does', () => {
    const company = `Test Serial Co ${Date.now()}`;
    assert.equal(dataLayer.peekNextSerial(company), 1);
    assert.equal(dataLayer.peekNextSerial(company), 1, 'peeking twice must not advance the counter');
    assert.equal(dataLayer.commitNextSerial(company), 1);
    assert.equal(dataLayer.peekNextSerial(company), 2, 'peek must reflect the committed serial');
    assert.equal(dataLayer.commitNextSerial(company), 2);
});

test('saveQuote / getAllQuotes / deleteQuote round-trip', () => {
    // company_name is always stored upper-cased (see getOrCreateClientId) —
    // using an already-uppercase name here so the round-trip assertion
    // below doesn't need to special-case that transform.
    const company    = `ROUND TRIP CO ${Date.now()}`;
    const companyKey = dataLayer.normalizeCompanyKey(company);
    const storeKey   = dataLayer.buildStoreKey('Q26_9999', companyKey, 0);

    dataLayer.saveQuote(storeKey, {
        company, address: '123 Test St', createdAt: new Date().toISOString(),
        items: [{ material: 'Tarpaulin', sizeW: '3', sizeH: '4', sizeUnit: 'ft', qty: 1, computedUnitPrice: 500 }],
        outsourceItems: [], flatRateItems: [],
    });

    const all = dataLayer.getAllQuotes();
    assert.ok(all[storeKey], 'saved quote should be retrievable by its storeKey');
    assert.equal(all[storeKey].company, company);
    assert.equal(all[storeKey].items.length, 1);
    assert.equal(all[storeKey].items[0].computedUnitPrice, 500);

    const deleted = dataLayer.deleteQuote(storeKey);
    assert.ok(deleted, 'deleteQuote should return the deleted row');
    assert.equal(dataLayer.getAllQuotes()[storeKey], undefined, 'quote should be gone after delete');
});

test('backupTo() produces a valid, non-empty snapshot file', () => {
    const backupPath = path.join(os.tmpdir(), `launchpad-test-backup-${Date.now()}.db`);
    try {
        dataLayer.backupTo(backupPath);
        assert.ok(fs.existsSync(backupPath), 'backup file should have been created');
        assert.ok(fs.statSync(backupPath).size > 0, 'backup file should not be empty');
    } finally {
        try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    }
});
