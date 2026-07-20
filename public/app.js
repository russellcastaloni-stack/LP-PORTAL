        /* ═══════════════════════════════════════════════════════
           STORAGE → server API (Google Drive backed)
           All quote data lives in G:\Shared drives\...\lp_quotes.json
           Serials live in lp_serials.json in the same folder
        ═══════════════════════════════════════════════════════ */

        // Auto-detect server — works whether opened as localhost or via IP from another computer
        const API = window.location.origin;

        // Size unit is now a fixed picker (ft/in/m/cm/mm) instead of free text --
        // JO's <select class="jo-unit"> does an exact string match against these
        // 5 values, so any typo/case/synonym typed into a free-text field here
        // silently failed to pre-select the right unit on the JO side. Requested
        // 2026-07 ("gawin picker ang UOM sa quote di kasi nabbabasa ng JO pag
        // text input"). normalizeUom() also maps a few obvious synonyms so old
        // saved quotes / AI-extracted PDF imports still land on a sane default.
        const UOM_OPTIONS = ['ft', 'in', 'm', 'cm', 'mm'];
        function normalizeUom(v) {
            const s = String(v || '').trim().toLowerCase();
            if (UOM_OPTIONS.includes(s)) return s;
            if (['feet', 'foot', 'feets'].includes(s)) return 'ft';
            if (['inch', 'inches', '"'].includes(s)) return 'in';
            if (['meter', 'meters', 'metre', 'metres'].includes(s)) return 'm';
            if (['centimeter', 'centimeters', 'centimetre', 'centimetres'].includes(s)) return 'cm';
            if (['millimeter', 'millimeters', 'millimetre', 'millimetres'].includes(s)) return 'mm';
            return 'ft';
        }
        function uomSelectHtml(selected) {
            const sel = normalizeUom(selected || 'ft');
            return '<select class="sizeUnit" style="text-align:center;">' +
                UOM_OPTIONS.map(function (u) {
                    return '<option value="' + u + '"' + (u === sel ? ' selected' : '') + '>' + u + '</option>';
                }).join('') +
                '</select>';
        }

        // Wrap fetch to always send Authorization: Bearer <jwt> for server-side auth
        const _nativeFetch = window.fetch;
        window.fetch = function(url, opts) {
            if (typeof url === 'string' && url.startsWith(API + '/api/')) {
                opts = opts ? Object.assign({}, opts) : {};
                opts.headers = Object.assign({}, opts.headers || {});
                try {
                    const s = sessionStorage.getItem('lp_session');
                    if (s) {
                        const p = JSON.parse(s);
                        if (p && p.token) opts.headers['Authorization'] = 'Bearer ' + p.token;
                        else if (p && p.id) opts.headers['X-Session-Id'] = p.id; // legacy fallback
                    }
                } catch {}
            }
            return _nativeFetch.call(this, url, opts);
        };

        // Opens a Drive-stored PDF in a new tab using a short-lived, single-file
        // "view token" (see audit 2.6) instead of putting the full session JWT in
        // the URL — keeps the long-lived credential out of browser history,
        // access logs, and Referer headers. Falls back to the legacy ?token=
        // form only if the token-exchange call fails (e.g. older server).
        async function openViewFile(pdfPath) {
            if (!pdfPath) return;
            // Open synchronously first (still inside the click's user-gesture window),
            // then redirect once the async token fetch resolves — window.open() called
            // AFTER an await gets silently blocked by popup blockers in most browsers.
            const newWin = window.open('', '_blank');
            const raw = sessionStorage.getItem('lp_session');
            if (!raw) { if (newWin) newWin.close(); alert('Your session has expired. Please log out and log back in.'); return; }
            let sess;
            try { sess = JSON.parse(raw); } catch { if (newWin) newWin.close(); alert('Could not read your session. Please log out and log back in.'); return; }
            const tok = sess.token || '';
            const sid = sess.id || '';
            if (!tok && !sid) { if (newWin) newWin.close(); alert('Your session is invalid. Please log out and log back in.'); return; }
            if (tok) {
                try {
                    const r = await fetch(`${API}/api/view-file-token`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: pdfPath })
                    });
                    const d = await r.json();
                    if (d.token) {
                        const url = `${API}/api/view-file?path=${encodeURIComponent(pdfPath)}&vtoken=${encodeURIComponent(d.token)}`;
                        if (newWin) newWin.location.href = url; else window.open(url, '_blank');
                        return;
                    }
                } catch {}
            }
            const auth = tok ? '&token=' + encodeURIComponent(tok) : '&sessionId=' + encodeURIComponent(sid);
            const url = `${API}/api/view-file?path=${encodeURIComponent(pdfPath)}${auth}`;
            if (newWin) newWin.location.href = url; else window.open(url, '_blank');
        }

        /* ── Generate → Open switch (animated status button) ──────────────────
           Drives the .gen-switch button's data-state (idle/loading/done) and
           label text. Purely presentational — callers still do their own
           fetch/try-catch, this just reflects the outcome on the button. */
        function setGenSwitchState(btn, state) {
            if (!btn) return;
            btn.dataset.state = state;
            btn.disabled = (state === 'loading');
            const label = btn.querySelector('.gen-label');
            if (!label) return;
            if (state === 'loading') label.textContent = 'Generating…';
            else if (state === 'done') label.textContent = label.dataset.doneText || 'Open PDF';
            else label.textContent = label.dataset.idleText || label.textContent;
        }

        // Last successfully generated PDF for the Quotation form's Generate
        // button — once it's showing "Open PDF" (data-state="done"), clicking
        // it again should open this instead of re-submitting the form.
        let _lastGeneratedPdfInfo = null;
        async function openGeneratedPdf(info) {
            if (!info) return;
            if (info.pdfPath) {
                await openViewFile(info.pdfPath);
            } else if (info.blob) {
                const url = window.URL.createObjectURL(new File([info.blob], info.filename || 'document.pdf', { type: 'application/pdf' }));
                window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);
            }
        }

        function toggleOtherPayment() {
            const sel = document.getElementById('paymentTerms');
            const grp = document.getElementById('otherPaymentGroup');
            const inp = document.getElementById('otherPaymentTerms');
            if (sel.value === 'others') {
                grp.style.display = '';
                inp.required = true;
            } else {
                grp.style.display = 'none';
                inp.required = false;
                inp.value = '';
            }
        }

        function getPaymentTerms() {
            const s = document.getElementById('paymentTerms');
            return s.value === 'others' ? document.getElementById('otherPaymentTerms').value : s.value;
        }

        // companyKey() MUST stay byte-for-byte identical to normalizeCompanyKey()
        // in server.js — if they ever drift apart, control numbers and client
        // records silently duplicate (see: "Loob Philippines" vs "Loob Philippines
        // Inc" bug, June 2026). Strips trailing punctuation and common business
        // suffixes (Inc., Corp., Ltd., Co.) so name variants collapse to one key.
        function companyKey(name) {
            let s = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (!s) return '';
            const suffixes = /\b(inc|incorporated|corp|corporation|ltd|limited|co|company)\.?$/;
            let paren = '';
            const parenMatch = s.match(/\s*(\([^()]*\))\s*$/);
            if (parenMatch) {
                paren = ' ' + parenMatch[1];
                s = s.slice(0, parenMatch.index).trim();
            }
            let prev;
            do {
                prev = s;
                s = s.replace(/[.,]\s*$/, '').trim();
                s = s.replace(suffixes, '').trim();
                s = s.replace(/[.,]\s*$/, '').trim();
            } while (s !== prev && s.length > 0);
            const result = (s || (name || '').trim().toLowerCase()) + paren;
            return result.trim();
        }

        function buildControlNumber(serial) {
            return `Q26_${String(serial).padStart(4, '0')}`;
        }

        /* ── State ── */
        let currentControlNumber = '';
        let currentRevision      = 0;
        let _loadedFromSnapshot  = false;
        let _loadedStoreKey      = null;   // storeKey of the quote currently loaded (null = new quote)
        let _cachedDb            = null;   // in-memory cache so UI stays snappy

        /* Load quotes from server (with cache) */
        async function loadDB(force = false) {
            if (_cachedDb && !force) return _cachedDb;
            try {
                const r = await fetch(`${API}/api/quotes`);
                _cachedDb = await r.json();
            } catch { _cachedDb = {}; }
            return _cachedDb;
        }

        /* Save one quote to server */
        async function saveQuote(storeKey, snapshot) {
            const r = await fetch(`${API}/api/quotes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storeKey, snapshot })
            });
            // Reference images: the server resolves any freshly-uploaded
            // {token} entries to a permanent {path} on disk and echoes back
            // the resolved item list — merge those paths back into itemState
            // so a subsequent Preview/Generate in this same session embeds
            // the real file instead of a token that may since have expired.
            try {
                const d = await r.json();
                if (d && d.ok && Array.isArray(d.items) && !snapshot.isGrouped) {
                    const wrappers = Array.from(document.querySelectorAll('#items .item-wrapper'));
                    wrappers.forEach((wrapper, i) => {
                        const idMatch = wrapper.id.match(/^item(\d+)$/);
                        const resolvedItem = d.items[i];
                        if (idMatch && resolvedItem && itemState[idMatch[1]]) {
                            itemState[idMatch[1]].images = resolvedItem.images || [];
                            renderRefImages(parseInt(idMatch[1]));
                        }
                    });
                }
            } catch {}
            if (_cachedDb) _cachedDb[storeKey] = snapshot; // update cache
        }

        /* Delete one quote from server */
        async function deleteQuoteFromServer(storeKey) {
            await fetch(`${API}/api/quotes/${encodeURIComponent(storeKey)}`, { method: 'DELETE' });
            if (_cachedDb) delete _cachedDb[storeKey];
        }

        /* Reset serial for a company key on the server */
        async function resetSerial(companyKeyStr) {
            try {
                await fetch(`${API}/api/serials/${encodeURIComponent(companyKeyStr)}`, { method: 'DELETE' });
            } catch (err) { console.warn("[resetSerial] Failed:", err); }
        }

        /* After deleting quotes, recalculate serials so they reflect the highest
           remaining quote number for each company. If a company has no quotes left,
           its serial is removed entirely so numbering restarts from 1. */
        async function syncSerialsAfterDelete() {
            const db = _cachedDb || {};

            // Build a map of companyKey → highest serial number still in DB
            // storeKey format: Q26_XXXX|companykey|revN
            // The serial number is the numeric part of the control number (e.g. 0003 → 3)
            const highestSerial = {};
            Object.keys(db).forEach(k => {
                const parts = k.split('|');
                if (parts.length < 2) return;
                const ctrlNum  = parts[0]; // e.g. "Q26_0003"
                const cKey     = parts[1]; // e.g. "toyota"
                const match    = ctrlNum.match(/Q\d+_(\d+)/);
                if (!match) return;
                const num = parseInt(match[1], 10);
                if (!highestSerial[cKey] || num > highestSerial[cKey]) {
                    highestSerial[cKey] = num;
                }
            });

            // Get all serial keys currently on the server
            try {
                const r = await fetch(`${API}/api/serials`);
                const serials = await r.json();

                for (const key of Object.keys(serials)) {
                    const correct = highestSerial[key] || 0;
                    if (correct === 0) {
                        // No quotes left for this company — remove serial entirely
                        await resetSerial(key);
                    } else if (serials[key] !== correct) {
                        // Set serial to the highest remaining quote number
                        await fetch(`${API}/api/serials/${encodeURIComponent(key)}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ value: correct })
                        });
                    }
                }
            } catch (err) { console.warn("[syncSerialsAfterDelete] Failed:", err); }
        }

        /* Peek next serial for company (no commit) */
        async function peekNextSerial(companyName) {
            try {
                const r = await fetch(`${API}/api/serials/peek?companyKey=${encodeURIComponent(companyKey(companyName))}`);
                const j = await r.json();
                return (typeof j.serial === 'number' && j.serial > 0) ? j.serial : 1;
            } catch { return 1; }
        }
        /* Commit serial for company → returns the new serial number */
        async function commitSerial(companyName) {
            const r = await fetch(`${API}/api/serials/next`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ companyKey: companyKey(companyName) })
            });
            if (!r.ok) {
                throw new Error(`Failed to reserve control number (HTTP ${r.status}). Please try again.`);
            }
            const j = await r.json();
            if (typeof j.serial !== 'number' || j.serial <= 0) {
                throw new Error('Server returned an invalid serial number.');
            }
            return j.serial;
        }

        /* ── Control number init & live preview ── */
        async function initControlNumber() {
            // No company name yet — don't peek a meaningless serial for the '' key.
            // currentControlNumber stays blank until the user types a company name.
            currentControlNumber = '';
            currentRevision = 0;
            _loadedStoreKey = null;
            refreshCtrlDisplay();
            resetLoadedMode();
        }

        /* Debounce helper */
        let _peekTimer = null;
        document.getElementById('company').addEventListener('input', function() {
            if (_loadedFromSnapshot) return;
            clearTimeout(_peekTimer);
            const name = this.value.trim();
            if (!name) {
                currentControlNumber = '';
                refreshCtrlDisplay();
                return;
            }
            _peekTimer = setTimeout(async () => {
                const serial = await peekNextSerial(name);
                currentControlNumber = buildControlNumber(serial);
                refreshCtrlDisplay();
            }, 300);
        });

        function refreshCtrlDisplay() {
            document.getElementById('ctrlDisplay').textContent = currentControlNumber || '— (type company name)';
            const revEl = document.getElementById('ctrlRevDisplay');
            revEl.textContent = currentRevision > 0 ? `Rev${currentRevision}` : '';
        }

        /* ── Snapshot helpers ── */
        function captureSnapshot() {
            const items = [];
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row = wrapper.querySelector('.item-row');

                const multipliers = [];
                wrapper.querySelectorAll('.multVal').forEach(inp => {
                    multipliers.push(parseFloat(inp.value) || 0);
                });

                const addons = [];
                wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                    addons.push({
                        desc:  tag.querySelector('.addon-desc').value,
                        price: parseFloat(tag.querySelector('.addon-price').value) || 0,
                        qty:   parseFloat(tag.querySelector('.addon-qty').value)   || 1
                    });
                });

                const manualBtn = wrapper.querySelector('[id^="btnManual"]');
                const isManual  = manualBtn ? manualBtn.classList.contains('active') : false;
                const formulaInp = wrapper.querySelector('[id^="manualFormula"]:not([id^="manualFormulaR"])');

                items.push({
                    material:           row.querySelector('.material').value,
                    sizeW:              row.querySelector('input.sizeW').value,
                    sizeH:              row.querySelector('input.sizeH').value,
                    sizeUnit:           row.querySelector('.sizeUnit').value,
                    multipliers,
                    addons,
                    isManual,
                    manualFormula:      isManual && formulaInp ? formulaInp.value : '',
                    computedUnitPrice:  row.querySelector('input.price').value,
                    qty:                row.querySelector('input.qty').value
                });
            });

            // Capture flat rate items
            const flatRateItems = [];
            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                flatRateItems.push({
                    material:  row.querySelector('.material').value,
                    flatPrice: row.querySelector('input.flatPrice').value,
                    qty:       row.querySelector('input.qty').value,
                    computedUnitPrice: row.querySelector('input.flatPrice').value
                });
            });

            // Capture outsource items
            const outsourceItems = [];
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                outsourceItems.push({
                    material:   row.querySelector('.material').value,
                    sizeW:      row.querySelector('input.sizeW').value,
                    sizeH:      row.querySelector('input.sizeH').value,
                    sizeUnit:   row.querySelector('.sizeUnit').value,
                    basePrice:  wrapper.querySelector('input.outsourceBase').value,
                    multipliers: mults,
                    computedUnitPrice: row.querySelector('input.price').value,
                    qty:        row.querySelector('input.qty').value
                });
            });

            const now = new Date().toISOString();
            return {
                controlNumber: currentControlNumber,
                revisions:     currentRevision,
                createdAt:     now,
                lastSaved:     now,
                isGrouped:     _isGroupedMode,
                quoteGroups:   _isGroupedMode ? collectQuoteGroups() : [],
                company:       document.getElementById('company').value,
                address:       document.getElementById('address').value,
                tin:           document.getElementById('tin').value,
                attentionTo:   document.getElementById('attentionTo').value,
                date:          document.getElementById('date').value,
                tel:           document.getElementById('tel').value,
                leadTime:      document.getElementById('leadTime').value,
                projectName:   document.getElementById('projectName').value,
                paymentTerms:  getPaymentTerms(),
                salesName:     document.getElementById('salesName').value,
                salesContact:  document.getElementById('salesContact').value,
                salesEmail:    document.getElementById('salesEmail').value,
                salesPosition: document.getElementById('salesPosition').value,
                bankDetails:   document.getElementById('bankDetailsSelect')?.value || '',
                includeVat:    document.getElementById('includeVatCheck')?.checked || false,
                vatExclusive:  document.getElementById('vatExclusiveCheck')?.checked || false,
                vatExAuto:     document.getElementById('vatExAutoCheck')?.checked || false,
                discountType:  document.getElementById('discountType')?.value || 'none',
                discountValue: document.getElementById('discountValue')?.value || '',
                items,
                outsourceItems,
                flatRateItems
            };
        }

        /* ── Loaded-mode: swap buttons when editing a saved quote ─────────────
           New quote:              Preview Quote + Generate Quote (→ Open PDF
                                    once generated, via the gen-switch button)
           Loaded quote, unedited: just "Open PDF" — opens the REAL saved file
           Loaded quote, edited:   Overwrite Existing + Generate as Revision
        ── */
        let _loadedQuotePdfPath = null; // pdfPath of the quote loadQuote() just opened
        let _loadedQuoteDirty   = false;

        function refreshActionButtons() {
            const btnPreview = document.getElementById('btnPreviewQuote');
            const btnGen     = document.getElementById('btnGenerateQuote');
            const btnOpen    = document.getElementById('btnOpenLoaded');
            const btnOvr     = document.getElementById('btnOverwrite');
            const btnRev     = document.getElementById('btnRevision');
            const loaded = !!_loadedStoreKey;

            if (!loaded) {
                if (btnPreview) btnPreview.style.display = '';
                if (btnGen)     btnGen.style.display = '';
                if (btnOpen)    btnOpen.style.display = 'none';
                if (btnOvr)     btnOvr.style.display = 'none';
                if (btnRev)     btnRev.style.display = 'none';
                return;
            }

            // Loaded quote — the plain Generate button never applies here;
            // you already have a real PDF for this quote.
            if (btnGen) btnGen.style.display = 'none';

            if (!_loadedQuoteDirty && _loadedQuotePdfPath) {
                // Untouched since loading — just offer to open the real file.
                if (btnPreview) btnPreview.style.display = 'none';
                if (btnOpen)    btnOpen.style.display = '';
                if (btnOvr)     btnOvr.style.display = 'none';
                if (btnRev)     btnRev.style.display = 'none';
            } else {
                // Either edited, or this loaded quote has no saved PDF yet
                // (e.g. the Drive write failed originally) — bring Preview
                // Quote back (useful again once the content differs from the
                // saved PDF) alongside Overwrite/Revision.
                if (btnPreview) btnPreview.style.display = '';
                if (btnOpen)    btnOpen.style.display = 'none';
                if (btnOvr)     btnOvr.style.display = '';
                if (btnRev)     btnRev.style.display = '';
            }
        }

        // Marks the currently-loaded quote as edited so the action bar swaps
        // from "Open PDF" to Overwrite/Generate-as-Revision. Only listens for
        // REAL user interaction (input/change events, clicks on add/remove
        // buttons) — restoreSnapshot() only ever assigns .value/.checked and
        // calls its add-row functions directly rather than .click()'ing
        // anything, so loading a quote never triggers this itself.
        function markLoadedQuoteDirty() {
            if (!_loadedStoreKey || _loadedQuoteDirty) return;
            _loadedQuoteDirty = true;
            refreshActionButtons();
        }

        async function openLoadedQuotePdf() {
            if (!_loadedQuotePdfPath) return;
            await openViewFile(_loadedQuotePdfPath);
        }

        function setLoadedMode(snap) {
            _loadedQuotePdfPath = (snap && snap.pdfPath) || null;
            _loadedQuoteDirty   = false;
            refreshActionButtons();
        }
        function resetLoadedMode() {
            _loadedQuotePdfPath = null;
            _loadedQuoteDirty   = false;
            refreshActionButtons();
            // Fresh form context — any previously "Open PDF" state no longer
            // refers to this quote.
            const btnGen = document.getElementById('btnGenerateQuote');
            if (btnGen) setGenSwitchState(btnGen, 'idle');
            _lastGeneratedPdfInfo = null;
        }

        async function overwriteQuote() {
            if (!_loadedStoreKey) { alert('No loaded quote to overwrite.'); return; }
            if (!confirm('Overwrite this quote? The existing data will be replaced.')) return;
            document.getElementById('loading').classList.add('show');
            try {
                const result = await _submitQuote({ forceStoreKey: _loadedStoreKey, forceRevision: currentRevision });
                if (result) {
                    // Re-saved successfully — back to "Open PDF" for this quote.
                    _loadedQuotePdfPath = result.pdfPath;
                    _loadedQuoteDirty = false;
                    refreshActionButtons();
                }
            }
            finally { document.getElementById('loading').classList.remove('show'); }
        }

        async function generateRevision() {
            if (!_loadedStoreKey) { alert('No loaded quote to revise.'); return; }
            document.getElementById('loading').classList.add('show');
            try {
                const db = await loadDB(true);
                const parts = _loadedStoreKey.split('|');
                const baseKey = parts[0] + '|' + parts[1];
                const existingRevs = Object.keys(db).filter(k => k.startsWith(baseKey + '|rev'));
                const maxRev = existingRevs.length > 0
                    ? Math.max(...existingRevs.map(k => { const m = k.match(/\|rev(\d+)$/); return m ? parseInt(m[1]) : 0; }))
                    : currentRevision;
                const newRev = maxRev + 1;
                const newStoreKey = baseKey + '|rev' + newRev;
                const result = await _submitQuote({ forceStoreKey: newStoreKey, forceRevision: newRev });
                if (result) {
                    currentRevision = newRev;
                    _loadedStoreKey = newStoreKey;
                    refreshCtrlDisplay();
                    // New revision saved successfully — back to "Open PDF" for it.
                    _loadedQuotePdfPath = result.pdfPath;
                    _loadedQuoteDirty = false;
                    refreshActionButtons();
                }
            } finally { document.getElementById('loading').classList.remove('show'); }
        }

        function restoreSnapshot(snap, opts) {
            // opts.isParked = true: restore form data but treat as new quote (no overwrite button)
            const isParked = opts && opts.isParked;
            // Always set _loadedFromSnapshot=true during restore to suppress serial-peek on company input
            _loadedFromSnapshot = true;
            currentControlNumber = snap.controlNumber;
            currentRevision      = snap.revisions || 0;

            document.getElementById('company').value     = snap.company     || '';
            document.getElementById('address').value     = snap.address     || '';
            document.getElementById('tin').value         = snap.tin         || '';
            document.getElementById('attentionTo').value = snap.attentionTo || '';
            document.getElementById('date').value        = snap.date        || '';
            document.getElementById('tel').value         = snap.tel         || '';
            document.getElementById('leadTime').value    = snap.leadTime    || '0';
            document.getElementById('projectName').value = snap.projectName || '';
            // Restore payment terms
            const ptSel = document.getElementById('paymentTerms');
            const ptOpts = Array.from(ptSel.options).map(o => o.value);
            if (snap.paymentTerms && ptOpts.includes(snap.paymentTerms)) {
                ptSel.value = snap.paymentTerms;
            } else if (snap.paymentTerms) {
                ptSel.value = 'others';
                document.getElementById('otherPaymentTerms').value = snap.paymentTerms;
            }
            toggleOtherPayment();
            // Restore sales personnel
            document.getElementById('salesName').value     = snap.salesName     || '';
            document.getElementById('salesContact').value  = snap.salesContact  || '';
            document.getElementById('salesEmail').value    = snap.salesEmail    || '';
            document.getElementById('salesPosition').value = snap.salesPosition || '';
            const bankSel = document.getElementById('bankDetailsSelect');
            if (bankSel && snap.bankDetails) {
                bankSel.value = snap.bankDetails;
                // Restore checkboxes
                const saved = snap.bankDetails.split(',');
                document.querySelectorAll('.bank-chk').forEach(chk => {
                    chk.checked = saved.includes(chk.value);
                });
                if (typeof updateBankLabel === 'function') updateBankLabel();
            }

            // Restore VAT checkboxes + update label immediately
            const vatChk     = document.getElementById('includeVatCheck');
            const vatExChk   = document.getElementById('vatExclusiveCheck');
            const vatExAutoChk = document.getElementById('vatExAutoCheck');
            if (vatChk)   vatChk.checked   = !!snap.includeVat;
            if (vatExChk) vatExChk.checked = !!snap.vatExclusive;
            if (vatExAutoChk) {
                vatExAutoChk.disabled = !snap.vatExclusive;
                vatExAutoChk.checked  = !!snap.vatExclusive && !!snap.vatExAuto;
            }
            const gtLabelEl = document.getElementById('grandTotalLabel');
            if (gtLabelEl) gtLabelEl.textContent = snap.vatExclusive ? 'Grand Total (VAT Ex):' : 'Grand Total:';

            // Restore discount
            const discTypeSel = document.getElementById('discountType');
            const discValInp  = document.getElementById('discountValue');
            const discSfxEl   = document.getElementById('discountValueSuffix');
            if (discTypeSel) discTypeSel.value = snap.discountType || 'none';
            if (discValInp)  discValInp.value  = snap.discountValue || '';
            // Show/hide input based on restored type
            const restoredType = snap.discountType || 'none';
            if (discValInp)  discValInp.style.display  = restoredType !== 'none' ? '' : 'none';
            if (discSfxEl) {
                discSfxEl.style.display = restoredType !== 'none' ? '' : 'none';
                discSfxEl.textContent   = restoredType === 'percent' ? '%' : '';
            }

            // Rebuild items — grouped or standard
            if (snap.isGrouped && snap.quoteGroups && snap.quoteGroups.length) {
                // Switch to grouped mode first (without clearing since items are empty)
                if (!_isGroupedMode) {
                    _isGroupedMode = true;
                    document.getElementById('standardMode').style.display = 'none';
                    document.getElementById('groupedMode').style.display = '';
                    document.getElementById('quoteModeLabel').textContent = 'Grouped Quote';
                    document.getElementById('quoteModeLabel').style.color = '#4A90E2';
                    document.getElementById('quoteModeLabel').style.fontWeight = 'bold';
                    document.getElementById('btnToggleGrouped').textContent = 'Switch to Standard Quote';
                    document.getElementById('btnToggleGrouped').style.background = '#636e72';
                }
                document.getElementById('quoteGroups').innerHTML = '';
                _groupIdCounter = 0;
                snap.quoteGroups.forEach(g => addQuoteGroup(g));
            } else {
                // Standard mode restore
                if (_isGroupedMode) {
                    _isGroupedMode = false;
                    document.getElementById('standardMode').style.display = '';
                    document.getElementById('groupedMode').style.display = 'none';
                    document.getElementById('quoteModeLabel').textContent = 'Standard Quote';
                    document.getElementById('quoteModeLabel').style.color = '#555';
                    document.getElementById('quoteModeLabel').style.fontWeight = 'normal';
                    document.getElementById('btnToggleGrouped').textContent = 'Switch to Grouped Quote';
                    document.getElementById('btnToggleGrouped').style.background = '#4A90E2';
                }

            // Rebuild items
            document.getElementById('items').innerHTML = '';
            itemCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);

            (snap.items || snap.inHouseItems || snap.lineItems || []).forEach(saved => {
                // Legacy: old flat fee items migrate to the flat rate section
                if (saved.flatFee) {
                    addFlatRateItem();
                    const fr = document.getElementById('flatRate' + flatRateCount);
                    if (fr) {
                        fr.querySelector('.material').value  = saved.material || '';
                        fr.querySelector('input.flatPrice').value = saved.flatPrice || saved.computedUnitPrice || 0;
                        fr.querySelector('input.qty').value       = saved.qty || 1;
                    }
                    return;
                }

                let fbMode       = saved.fbMode || 'simple';
                let fbComponents = saved.fbComponents || null;
                let fbOuterMult  = saved.fbOuterMult  != null ? saved.fbOuterMult : 1;
                let fbAdvFormula = saved.fbAdvFormula  || '';

                if (!fbComponents) {
                    if (saved.isManual && saved.manualFormula) {
                        fbMode       = 'adv';
                        fbAdvFormula = saved.manualFormula;
                        fbComponents = [{ price: 0, mult: 1 }];
                    } else if (saved.multipliers && saved.multipliers.length > 0) {
                        fbComponents = saved.multipliers.map(v => ({ price: v, mult: 1 }));
                    } else {
                        fbComponents = [{ price: 0, mult: 1 }];
                    }
                }

                // Detect legacy snapshot: no formula builder data at all
                const isLegacy = !saved.fbMode && !saved.fbComponents && !saved.isManual
                    && !(saved.multipliers && saved.multipliers.length > 0);

                addItem({ mode: fbMode, components: fbComponents, outerMult: fbOuterMult, advFormula: fbAdvFormula,
                    fixedFormula: saved.fixedFormula || '', fixedMults: saved.fixedMults || [],
                    fixedManualPrice: saved.fixedManualPrice || 0, images: saved.images || [] });
                const id      = itemCount;
                const wrapper = document.getElementById('item' + id);
                const row     = wrapper.querySelector('.item-row');

                row.querySelector('.material').value        = saved.material  || '';
                row.querySelector('.sizeUnit').value   = normalizeUom(saved.sizeUnit);
                row.querySelector('input.qty').value        = saved.qty       || 1;
                row.querySelector('input.sizeW').value      = saved.sizeW     || '';
                row.querySelector('input.sizeH').value      = saved.sizeH     || '';

                // Sync Fixed Price formula input after DOM is ready
                const fixedInp = document.getElementById('fbFixedInput' + id);
                if (fixedInp) fixedInp.value = itemState[id].fixedFormula || '';

                // Legacy quotes: force the stored computed price into Fixed Price mode
                // so the user sees the correct price and can edit it manually
                if (isLegacy && saved.computedUnitPrice) {
                    const storedPrice = parseFloat(String(saved.computedUnitPrice).replace(/,/g,'')) || 0;
                    if (storedPrice > 0) {
                        itemState[id].mode             = 'fixed';
                        itemState[id].fixedManualPrice = storedPrice;
                        syncPanelFromState(id);
                        // Show the price in the field
                        const pf = row.querySelector('input.price');
                        if (pf) { pf.value = storedPrice.toString(); pf.style.background='#fffbea'; pf.style.color='#7c5a00'; pf.style.cursor='text'; pf.oninput=function(){onPriceInput(id,this);}; }
                    }
                }

                (saved.addons || []).forEach(a => {
                    addAddon(id);
                    const aNum = addonCounters[id];
                    const tag  = document.getElementById(`addon_${id}_${aNum}`);
                    tag.querySelector('.addon-desc').value  = a.desc  || '';
                    tag.querySelector('.addon-price').value = a.price || 0;
                    tag.querySelector('.addon-qty').value   = a.qty   || 1;
                });
            });

            // Rebuild outsource items
            document.getElementById('outsourceItems').innerHTML = '';
            const _oSec = document.getElementById('outsourceSection'); if (_oSec) _oSec.style.display = 'none';
            outsourceCount = 0;
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);

            if ((snap.outsourceItems || []).length > 0) {
                const sec = document.getElementById('outsourceSection');
                if (sec) sec.style.display = '';
            }
            (snap.outsourceItems || []).forEach(saved => {
                addOutsourceItem();
                const id      = outsourceCount;
                const wrapper = document.getElementById('outsource' + id);
                const row     = wrapper.querySelector('.item-row');

                row.querySelector('.material').value  = saved.material || '';
                row.querySelector('input.sizeW').value     = saved.sizeW    || '';
                row.querySelector('input.sizeH').value     = saved.sizeH    || '';
                row.querySelector('.sizeUnit').value  = normalizeUom(saved.sizeUnit);
                row.querySelector('input.qty').value       = saved.qty      || 1;
                wrapper.querySelector('input.outsourceBase').value = saved.basePrice || '';

                (saved.multipliers || []).forEach(v => {
                    addOutsourceMult(id);
                    const mNum = outMultCounters[id];
                    document.getElementById(`outMult_${id}_${mNum}`).querySelector('.outMultVal').value = v;
                });
            });

            // Rebuild flat rate items
            restoreFlatRateItems(snap.flatRateItems || snap.flatItems || []);
            } // end standard mode restore
            calculateTotals();
            refreshCtrlDisplay();
            if (isParked) {
                // Parked quote: generate a fresh serial for this client (same company, next number)
                // _loadedFromSnapshot stays true during the async peek so company listener won't fire
                (async () => {
                    const company = document.getElementById('company').value;
                    const serial  = await peekNextSerial(company);
                    currentControlNumber = buildControlNumber(serial);
                    currentRevision = 0;
                    _loadedStoreKey = null;
                    refreshCtrlDisplay();
                    resetLoadedMode();
                    // Now allow company input to update serial again
                    _loadedFromSnapshot = false;
                })();
            } else {
                setLoadedMode(snap);
                _loadedFromSnapshot = true; // keep suppressed for saved quotes
            }
            // Auto-resize all material textareas after restore
            document.querySelectorAll('.material').forEach(el => {
                if (el.tagName === 'TEXTAREA') autoResizeTextarea(el);
            });
        }
        function restoreFlatRateItems(snapItems) {
            document.getElementById('flatRateItems').innerHTML = '';
            flatRateCount = 0;
            (snapItems || []).forEach(saved => {
                addFlatRateItem();
                const row = document.getElementById('flatRate' + flatRateCount);
                if (row) {
                    row.querySelector('.material').value  = saved.material  || '';
                    row.querySelector('input.flatPrice').value = saved.flatPrice || saved.computedUnitPrice || 0;
                    row.querySelector('input.qty').value       = saved.qty       || 1;
                }
            });
            calculateTotals();
        }

        /* ── Direct Print ── */
        async function printDirect({ pdfPath, pdfBase64, filename }) {
            const btn = event?.currentTarget;
            const origText = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Printing…'; }
            try {
                const body = pdfPath
                    ? { pdfPath }
                    : { pdfBase64, filename };
                const r = await fetch(`${API}/api/print`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await r.json();
                if (!r.ok || !data.ok) throw new Error(data.error || 'Print failed');
                // Success feedback
                if (btn) { btn.innerHTML = '✅ Sent!'; btn.style.background = '#27ae60'; }
                setTimeout(() => {
                    if (btn) { btn.innerHTML = origText; btn.disabled = false; btn.style.background = ''; }
                }, 3000);
            } catch (err) {
                alert('Print error: ' + err.message);
                if (btn) { btn.innerHTML = origText; btn.disabled = false; }
            }
        }

        // Direct-print now asks for copies/page-range first instead of a
        // plain confirm() — same options as the "Connect to Server Printer"
        // widget. Both the History list's 🖨️ button and the post-generate
        // toast's "Print Direct" button funnel through here, so both get
        // the same modal for free.
        let _pendingPrintJob = null; // { pdfPath, filename, btn, origText }

        function handleHistoryPrint(btn) {
            const pdfPath  = btn.dataset.pdfPath;
            const filename = btn.dataset.filename;
            if (!pdfPath) {
                alert('Generate the PDF first (load the quote then click Generate Quote) to enable direct printing.');
                return;
            }
            openPrintOptionsModal({ pdfPath, filename, btn });
        }

        function openPrintOptionsModal({ pdfPath, filename, btn }) {
            _pendingPrintJob = { pdfPath, filename, btn, origText: btn ? btn.innerHTML : '' };
            document.getElementById('printOptFilename').textContent = filename || '';
            document.getElementById('printOptCopies').value = 1;
            document.getElementById('printOptPages').value  = '';
            document.getElementById('printOptionsModal').classList.add('open');
        }
        function closePrintOptionsModal() {
            document.getElementById('printOptionsModal').classList.remove('open');
            _pendingPrintJob = null;
        }
        function confirmPrintOptions() {
            if (!_pendingPrintJob) return;
            const { pdfPath, filename, btn, origText } = _pendingPrintJob;
            const copies = Math.min(Math.max(1, parseInt(document.getElementById('printOptCopies').value) || 1), 99);
            const pages  = (document.getElementById('printOptPages').value || '').trim();
            closePrintOptionsModal();

            if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
            fetch(`${API}/api/print`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdfPath, filename, copies, pages })
            })
            .then(r => r.json())
            .then(data => {
                if (!data.ok) throw new Error(data.error || 'Print failed');
                if (btn) {
                    btn.innerHTML = '✅';
                    btn.style.color = '#27ae60';
                    setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; btn.style.color = ''; }, 3000);
                }
            })
            .catch(err => {
                alert('Print error: ' + err.message);
                if (btn) { btn.innerHTML = origText; btn.disabled = false; }
            });
        }

        async function handleHistoryOpen(btn) {
            const pdfPath = btn.dataset.pdfPath;
            if (!pdfPath) return;
            await openViewFile(pdfPath);
        }

        async function persistQuote(revision) {
            const snap = _captureSnapshotV2();
            snap.revisions = revision;
            snap.lastSaved = new Date().toISOString();
            // Each revision gets its own key — nothing is ever overwritten
            const storeKey = currentControlNumber + '|' + companyKey(snap.company) + '|rev' + revision;
            await saveQuote(storeKey, snap);
        }

        /* ── Section Clear Functions ── */
        function clearClientInfo() {
            if (!confirm('Clear all Client Information fields?')) return;
            ['company','address','tel','tin','attentionTo','projectName'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            document.getElementById('leadTime').value = '0';
            document.getElementById('date').valueAsDate = new Date();
            document.getElementById('paymentTerms').value = 'COD for first time customers';
            document.getElementById('otherPaymentTerms').value = '';
            document.getElementById('otherPaymentGroup').style.display = 'none';
            initControlNumber(); // reset control number preview for blank company
        }

        function clearInHouseItems() {
            if (!confirm('Remove all In-House items?')) return;
            document.getElementById('items').innerHTML = '';
            itemCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);
            calculateTotals();
        }

        function clearOutsourceItems() {
            if (!confirm('Remove all Fixed Price items?')) return;
            const sec = document.getElementById('outsourceSection');
            if (sec) sec.style.display = 'none';
            document.getElementById('outsourceItems').innerHTML = '';
            const _oSec = document.getElementById('outsourceSection'); if (_oSec) _oSec.style.display = 'none';
            outsourceCount = 0;
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);
            calculateTotals();
        }

        function clearFlatRateItems() {
            if (!confirm('Remove all Flat Rate items?')) return;
            document.getElementById('flatRateItems').innerHTML = '';
            flatRateCount = 0;
            calculateTotals();
        }

        /* ── History modal ── */
        let _historyViewMode = 'mine';

        async function openHistory() {
            _historyViewMode = 'mine';
            document.getElementById('historyModal').classList.add('open');
            document.getElementById('historyList').innerHTML = '<div class="history-empty">Loading...</div>';

            const isAdmin   = _currentProfile && _currentProfile.role === 'admin';
            const canDelete = isDevMode() || isAdmin;
            const footer    = document.getElementById('historyFooter');
            if (footer) footer.className = 'modal-footer' + (canDelete ? ' dev-visible' : '');

            // Inject My Quotes / All Quotes toggle for admin accounts
            const existingToggle = document.getElementById('historyViewToggle');
            if (existingToggle) existingToggle.remove();
            if (isAdmin) {
                const toggle = document.createElement('div');
                toggle.id = 'historyViewToggle';
                toggle.style.cssText = 'display:flex;gap:0;margin-bottom:10px;border:1.5px solid #4A90E2;border-radius:8px;overflow:hidden;flex-shrink:0;';
                toggle.innerHTML = `
                    <button id="btnViewMine" onclick="setHistoryView('mine')"
                        style="flex:1;padding:7px 14px;font-size:13px;font-weight:600;border:none;cursor:pointer;background:#4A90E2;color:#fff;transition:all 0.15s;">
                        My Quotes
                    </button>
                    <button id="btnViewAll" onclick="setHistoryView('all')"
                        style="flex:1;padding:7px 14px;font-size:13px;font-weight:600;border:none;cursor:pointer;background:#fff;color:#4A90E2;transition:all 0.15s;">
                        All Quotes
                    </button>`;
                const searchBox = document.getElementById('historySearch');
                if (searchBox) searchBox.parentNode.insertBefore(toggle, searchBox);
            }

            await loadDB(true);
            renderHistory(_historyViewMode);
        }

        function setHistoryView(mode) {
            _historyViewMode = mode;
            const btnMine = document.getElementById('btnViewMine');
            const btnAll  = document.getElementById('btnViewAll');
            if (btnMine && btnAll) {
                if (mode === 'mine') {
                    btnMine.style.background = '#4A90E2'; btnMine.style.color = '#fff';
                    btnAll.style.background  = '#fff';    btnAll.style.color  = '#4A90E2';
                } else {
                    btnAll.style.background  = '#4A90E2'; btnAll.style.color  = '#fff';
                    btnMine.style.background = '#fff';    btnMine.style.color = '#4A90E2';
                }
            }
            renderHistory(mode);
        }
        function closeHistory() {
            document.getElementById('historyModal').classList.remove('open');
            const s = document.getElementById('historySearch');
            if (s) s.value = '';
        }
        // Close on overlay click
        document.getElementById('historyModal').addEventListener('click', function(e) {
            if (e.target === this) closeHistory();
        });

        /* ── Pricelist floating panel (read-only embedded sheet preview) ──
           Uses Google Sheets' "Publish to web" embed view (pubhtml), which is
           the only way Google allows a Sheet to be shown inside an iframe on
           another site — the normal /edit URL sends X-Frame-Options and will
           NOT load in an iframe no matter how it's wrapped. If the sheet is
           ever unpublished/republished, the fallback link in the panel always
           still works, since it's a plain new-tab open of the real /edit URL. */
        // Published-to-web ID (from File > Share > Publish to web) — different
        // from the original file ID, and required for the iframe embed to work.
        const SHEET_PUBLISHED_ID = '2PACX-1vQo9MX1YI8nscgPcIPmYNvdfRrXCg3ZucyOk18P6gzAKCGfRs7S-2UvMHOZvyZDP7BRzY7A_maxYO6I';

        /* ── Generic left-side floating sheet panel (Pricelist, Online JO
           Sheet, and any future ones follow this exact same pattern) ──
           Each panel is described by a small config object: the panel/frame/
           zoom-label element ids, the URL to load, and the zoom state. Kept
           generic instead of copy-pasting a whole new set of functions per
           panel — this is exactly the kind of duplication that drifts apart
           over time (see: the PR/PF prefix mess in Proofing). */
        const _sheetPanels = {
            pricelist: {
                panelId: 'pricelistPanel', frameId: 'pricelistFrame', labelId: 'pricelistZoomLabel',
                url: `https://docs.google.com/spreadsheets/d/e/${SHEET_PUBLISHED_ID}/pubhtml?widget=true&headers=false`,
                zoom: 0.8,
            },
            // Messenger embedding was tried and confirmed a dead end — Meta's
            // servers actively reject embedded requests server-side ("Your
            // Request Couldn't be Processed"), no client-side workaround.
            // Online JO Sheet lives on jo.html only (its own self-contained
            // markup/JS, not app.js) — Quotations only shows Pricelist.
            // Notifications is a plain static panel (no iframe) —
            // frameId/labelId/url are left null and every iframe-specific
            // step below is guarded on frameId being set. (Account Settings
            // no longer has a panel — the gear icon now navigates straight to
            // menu.html?openSettings=1 in one click, requested 2026-07.)
            notif:    { panelId: 'notifPanel',    frameId: null, labelId: null, url: null, zoom: 1 },
            // Other Tools (Calculator/Calendar/Notepad/Print) split out of the
            // Settings panel into its own sidebar menu (requested 2026-07).
            tools:    { panelId: 'toolsPanel',      frameId: null, labelId: null, url: null, zoom: 1 },
        };
        const SHEET_MIN_ZOOM = 0.5, SHEET_MAX_ZOOM = 2.5, SHEET_ZOOM_STEP = 0.1;

        function applySheetZoom(key) {
            const cfg = _sheetPanels[key];
            if (!cfg.frameId) return;
            const frame = document.getElementById(cfg.frameId);
            const label = document.getElementById(cfg.labelId);
            if (!frame) return;
            frame.style.transform = `scale(${cfg.zoom})`;
            frame.style.width  = (100 / cfg.zoom) + '%';
            frame.style.height = (100 / cfg.zoom) + '%';
            if (label) label.textContent = Math.round(cfg.zoom * 100) + '%';
        }
        function sheetZoom(key, direction) {
            const cfg = _sheetPanels[key];
            cfg.zoom = Math.min(SHEET_MAX_ZOOM, Math.max(SHEET_MIN_ZOOM, cfg.zoom + direction * SHEET_ZOOM_STEP));
            applySheetZoom(key);
        }
        // Scrolling over an embedded sheet can "chain" through to the page
        // underneath once the sheet's own internal scroll bottoms/tops out —
        // this happens at the browser/compositor level even across a
        // cross-origin iframe boundary, so a wheel listener on our side can't
        // reliably catch/block all of it. Simplest fix that actually works:
        // just freeze the outer page's scroll entirely while any panel is
        // open, and unfreeze once none are.
        function setSheetScrollLock() {
            const anyOpen = Object.values(_sheetPanels).some(cfg => {
                const panel = document.getElementById(cfg.panelId);
                return panel && panel.classList.contains('open');
            });
            document.body.style.overflow = anyOpen ? 'hidden' : '';
        }
        function toggleSheetPanel(key) {
            const cfg = _sheetPanels[key];
            const frame = cfg.frameId ? document.getElementById(cfg.frameId) : null;
            const panel = document.getElementById(cfg.panelId);
            if (!panel) return;
            // Only (re)point the src on first open — avoids reloading/losing
            // scroll position on every toggle. NOTE: checking `frame.src`
            // directly doesn't work here — an <iframe src=""> resolves the
            // .src PROPERTY to the current page's own URL (browsers treat an
            // empty src as "resolve against base"), not an empty string, so
            // that check is always truthy. Reading the attribute instead of
            // the resolved property avoids that trap.
            if (frame && !frame.getAttribute('src')) {
                frame.src = cfg.url;
                applySheetZoom(key); // set the default 80% the first time the sheet loads
            }
            const opening = !panel.classList.contains('open');
            // Mutual exclusivity: all these panels slide in from the same
            // left edge and would visually stack on top of each other if
            // more than one were open at once, so opening one closes the
            // rest — including Chat, which docks to the same left edge now
            // but tracks its own open state separately (not in this map).
            if (opening) {
                Object.values(_sheetPanels).forEach(other => {
                    if (other !== cfg) document.getElementById(other.panelId)?.classList.remove('open');
                });
                if (window.chatClose) window.chatClose();
                // Collapse the expanded sidebar first — otherwise the panel
                // would render partly underneath it (they're both anchored
                // to the sidebar's left edge, and the sidebar sits on top).
                document.getElementById('navSidebar')?.classList.remove('expanded');
            }
            panel.classList.toggle('open');
            setSheetScrollLock();
            // Auto-focus the iframe on open so Ctrl+F targets the sheet right
            // away instead of the outer page — the browser's native find bar
            // reaches inside cross-origin iframes just fine (it works at the
            // browser level, not through JS/DOM), it just needs focus to be
            // there first, same as any other frame.
            if (opening && frame) setTimeout(() => frame.focus(), 300);
        }
        function togglePricelistPanel() { toggleSheetPanel('pricelist'); }
        function pricelistZoom(direction) { sheetZoom('pricelist', direction); }
        function toggleNotifPanel() { toggleSheetPanel('notif'); }
        function toggleToolsPanel() { toggleSheetPanel('tools'); }

        // Reddit-style sidebar expand/collapse — no dedicated button anymore;
        // the rail simply expands while the mouse is over it and collapses
        // back to icon-only on mouse-out.
        (function () {
            const sidebar = document.getElementById('navSidebar');
            if (!sidebar) return;
            sidebar.addEventListener('mouseenter', () => sidebar.classList.add('expanded'));
            sidebar.addEventListener('mouseleave', () => sidebar.classList.remove('expanded'));
        })();

        // Suggestion FAB — identity is derived server-side from the
        // Authorization header (already auto-attached by the fetch wrapper
        // above), so we only ever send the free-text body here.
        function openSuggestModal() {
            document.getElementById('suggestModalBg').classList.add('open');
            const t = document.getElementById('suggestText');
            t.value = '';
            const m = document.getElementById('suggestMsg');
            m.textContent = ''; m.className = 'suggest-modal-msg';
            setTimeout(() => t.focus(), 50);
        }
        function closeSuggestModal() {
            document.getElementById('suggestModalBg').classList.remove('open');
        }
        async function submitSuggestion() {
            const textEl = document.getElementById('suggestText');
            const msgEl  = document.getElementById('suggestMsg');
            const btn    = document.getElementById('suggestSubmitBtn');
            const text = textEl.value.trim();
            if (!text) { msgEl.textContent = 'Please enter a suggestion first.'; msgEl.className = 'suggest-modal-msg err'; return; }
            btn.disabled = true; btn.textContent = 'Sending…';
            try {
                const r = await fetch(window.location.origin + '/api/suggestions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || 'Failed to send suggestion');
                closeSuggestModal();
                showToast('Thanks! Your suggestion was sent.', 'ok');
            } catch (e) {
                msgEl.textContent = e.message || 'Failed to send suggestion.'; msgEl.className = 'suggest-modal-msg err';
            } finally {
                btn.disabled = false; btn.textContent = 'Submit';
            }
        }

        // Small floating confirmation toast. Fires once per call and
        // auto-hides itself — it never lingers or reappears on its own.
        let _lpToastTimer = null;
        function showToast(message, type = 'ok') {
            const el = document.getElementById('lpToast');
            if (!el) return;
            clearTimeout(_lpToastTimer);
            el.textContent = message;
            el.className = 'lp-toast ' + type;
            void el.offsetWidth; // force reflow so the transition re-triggers even if already visible
            el.classList.add('show');
            _lpToastTimer = setTimeout(() => el.classList.remove('show'), 3000);
        }
        // Account Settings now just navigates to menu.html, which owns the
        // real Profile/Change PIN/E-Signature modal (see #settingsOverlay
        // there) — no separate copy of that UI lives here.

        // Close on outside click — panels have no dark backdrop (by design,
        // so the form stays visible/usable while one is open), so "click
        // outside to close" has to be done manually via a document-level
        // listener instead of the usual overlay-click pattern. Clicks inside
        // a panel (including its own tab, a child element) are ignored here —
        // the tab's own onclick already handles toggling. Clicks inside an
        // iframe itself never reach this listener at all (cross-origin
        // content doesn't bubble click events to the parent document), so
        // interacting with a sheet never closes its panel.
        document.addEventListener('click', function(e) {
            // Clicks on the sidebar rail itself are what OPEN these panels —
            // its onclick handlers run first, then this same click bubbles
            // up to here, so it must be excluded or every panel would
            // instantly re-close itself right after opening.
            if (e.target.closest('#navSidebar')) return;
            Object.values(_sheetPanels).forEach(cfg => {
                const panel = document.getElementById(cfg.panelId);
                if (!panel.classList.contains('open')) return;
                if (panel.contains(e.target)) return;
                panel.classList.remove('open');
            });
            setSheetScrollLock();
            // Chat docks to the same left edge now but tracks its own open
            // state separately (.w-visible, not .open) — give it the same
            // click-outside-to-close behavior for consistency.
            const chatEl = document.getElementById('ww-chat');
            if (chatEl && chatEl.classList.contains('w-visible') && !chatEl.contains(e.target)) {
                if (window.chatClose) window.chatClose();
            }
        });

        /* ── Quotation "Upload PDF" import ────────────────────────────────────
           Reads ANY quotation PDF (not just ones this app generated) via a
           Gemini vision call on the server (see /api/parse-quotation-pdf),
           shows the result in an editable confirm modal, and only touches the
           real form once the user clicks Confirm — this route only ever
           returns a best-effort guess. Items always land as regular in-house
           items in "Fixed Price" mode (fbMode: 'fixed', a manually-entered
           price with no W×H formula) — size (W/H/unit) is still carried over
           as plain info fields for display, it just isn't used to compute
           the price the way it would in "Simple"/"Advanced" mode. */
        function triggerQuotePdfUpload() {
            document.getElementById('quotePdfFileInput').click();
        }

        async function handleQuotePdfFileSelected(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = ''; // allow re-selecting the same file later
            if (!file) return;
            if (file.type !== 'application/pdf') {
                alert('Please select a PDF file.');
                return;
            }

            const loadingEl = document.getElementById('pdfImportLoading');
            const loadingText = document.getElementById('pdfImportLoadingText');
            loadingEl.classList.add('show');
            if (loadingText) loadingText.textContent = 'Reading PDF…';
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload  = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                });

                // The server kicks this off as a background job and returns a
                // jobId right away — a big/many-item PDF can take Gemini well
                // over a minute, and holding one HTTP request open that long
                // through the Cloudflare Tunnel just gets it killed by the
                // edge proxy's timeout. Polling a few seconds apart instead
                // means no single request has to survive the whole thing.
                const startResp = await fetch(`${API}/api/parse-quotation-pdf`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pdfData: dataUrl }),
                });
                const startJson = await startResp.json().catch(() => null);
                if (!startResp.ok || !startJson || !startJson.jobId) {
                    alert((startJson && startJson.error) || 'Could not read this PDF.');
                    return;
                }

                if (loadingText) loadingText.textContent = 'Extracting data with Gemini… this can take a minute for long documents.';

                const jobId = startJson.jobId;
                const startedAt = Date.now();
                const POLL_MS = 2500;
                const MAX_WAIT_MS = 5 * 60 * 1000; // give up after 5 minutes
                let result = null;
                while (Date.now() - startedAt < MAX_WAIT_MS) {
                    await new Promise(r => setTimeout(r, POLL_MS));
                    const pollResp = await fetch(`${API}/api/parse-quotation-pdf/${jobId}`);
                    const pollJson = await pollResp.json().catch(() => null);
                    if (!pollResp.ok || !pollJson) continue; // transient hiccup — keep polling
                    if (pollJson.status === 'processing') continue;
                    result = pollJson;
                    break;
                }
                if (!result) {
                    alert('This is taking unusually long — please try again, or with a smaller PDF.');
                    return;
                }
                if (result.status === 'error' || !result.success) {
                    alert(result.error || 'Could not read this PDF.');
                    return;
                }
                openPdfImportModal(result.data);
            } catch (e) {
                alert('Upload failed: ' + e.message);
            } finally {
                loadingEl.classList.remove('show');
            }
        }

        function openPdfImportModal(data) {
            document.getElementById('piCompany').value      = data.company      || '';
            document.getElementById('piDate').value         = data.date         || '';
            document.getElementById('piAddress').value      = data.address      || '';
            document.getElementById('piTel').value          = data.tel          || '';
            document.getElementById('piTin').value          = data.tin          || '';
            document.getElementById('piAttentionTo').value  = data.attentionTo  || '';
            document.getElementById('piProjectName').value  = data.projectName  || '';
            document.getElementById('piPaymentTerms').value = data.paymentTerms || '';

            const body  = document.getElementById('piItemsBody');
            body.innerHTML = '';
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length) {
                items.forEach(it => pdfImportAddItemRow(it));
            } else {
                pdfImportAddItemRow(); // keep the table non-empty
            }

            document.getElementById('pdfImportModal').classList.add('open');
        }

        function closePdfImportModal() {
            document.getElementById('pdfImportModal').classList.remove('open');
        }

        // Built with createElement + .value assignments (not innerHTML string
        // concatenation) so AI-extracted text can never be interpreted as
        // markup — no manual HTML-escaping helper needed at all.
        function pdfImportAddItemRow(item) {
            item = item || {};
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #f0f0f0';

            const tdDesc = document.createElement('td');
            tdDesc.style.padding = '4px';
            const descInput = document.createElement('textarea');
            descInput.rows = 1;
            descInput.className = 'pi-desc';
            descInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;resize:none;';
            descInput.value = item.description || '';
            tdDesc.appendChild(descInput);

            const tdSize = document.createElement('td');
            tdSize.style.padding = '4px';
            tdSize.style.cssText += 'display:flex;gap:3px;align-items:center;';
            const sizeWInput = document.createElement('input');
            sizeWInput.type = 'number';
            sizeWInput.step = 'any';
            sizeWInput.min = '0';
            sizeWInput.placeholder = 'W';
            sizeWInput.className = 'pi-sizeW';
            sizeWInput.style.cssText = 'width:100%;min-width:0;padding:6px 4px;border:1px solid #ddd;border-radius:4px;font-size:13px;text-align:center;';
            sizeWInput.value = (item.sizeW !== undefined && item.sizeW !== null) ? item.sizeW : '';
            const sizeXSpan = document.createElement('span');
            sizeXSpan.textContent = '×';
            sizeXSpan.style.cssText = 'color:#999;flex-shrink:0;';
            const sizeHInput = document.createElement('input');
            sizeHInput.type = 'number';
            sizeHInput.step = 'any';
            sizeHInput.min = '0';
            sizeHInput.placeholder = 'H';
            sizeHInput.className = 'pi-sizeH';
            sizeHInput.style.cssText = 'width:100%;min-width:0;padding:6px 4px;border:1px solid #ddd;border-radius:4px;font-size:13px;text-align:center;';
            sizeHInput.value = (item.sizeH !== undefined && item.sizeH !== null) ? item.sizeH : '';
            tdSize.appendChild(sizeWInput);
            tdSize.appendChild(sizeXSpan);
            tdSize.appendChild(sizeHInput);

            const tdUnit = document.createElement('td');
            tdUnit.style.padding = '4px';
            const unitInput = document.createElement('select');
            unitInput.className = 'pi-sizeUnit';
            unitInput.style.cssText = 'width:100%;padding:6px 4px;border:1px solid #ddd;border-radius:4px;font-size:13px;text-align:center;';
            const preselectedUom = normalizeUom(item.sizeUnit || 'ft');
            UOM_OPTIONS.forEach(function (u) {
                const opt = document.createElement('option');
                opt.value = u;
                opt.textContent = u;
                if (u === preselectedUom) opt.selected = true;
                unitInput.appendChild(opt);
            });
            tdUnit.appendChild(unitInput);

            const tdQty = document.createElement('td');
            tdQty.style.padding = '4px';
            const qtyInput = document.createElement('input');
            qtyInput.type = 'number';
            qtyInput.min = '0';
            qtyInput.className = 'pi-qty';
            qtyInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;text-align:center;';
            qtyInput.value = (item.quantity !== undefined && item.quantity !== null && item.quantity !== '') ? item.quantity : 1;
            tdQty.appendChild(qtyInput);

            const tdPrice = document.createElement('td');
            tdPrice.style.padding = '4px';
            const priceInput = document.createElement('input');
            priceInput.type = 'number';
            priceInput.step = 'any';
            priceInput.min = '0';
            priceInput.className = 'pi-price';
            priceInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;text-align:right;';
            priceInput.value = (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '') ? item.unitPrice : '';
            tdPrice.appendChild(priceInput);

            const tdRemove = document.createElement('td');
            tdRemove.style.padding = '4px';
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'background:none;border:none;color:#d32f2f;cursor:pointer;font-size:14px;';
            removeBtn.onclick = () => tr.remove();
            tdRemove.appendChild(removeBtn);

            tr.appendChild(tdDesc);
            tr.appendChild(tdSize);
            tr.appendChild(tdUnit);
            tr.appendChild(tdQty);
            tr.appendChild(tdPrice);
            tr.appendChild(tdRemove);
            document.getElementById('piItemsBody').appendChild(tr);
        }

        // Best-effort "whatever date format the PDF had" → the native
        // <input type="date"> field's required YYYY-MM-DD. Browsers silently
        // reject any other format for a date input, so an unparseable string
        // is left blank for the user to type in themselves rather than
        // looking like the field got cleared for no reason.
        function guessDateToISO(str) {
            if (!str) return '';
            const d = new Date(str);
            if (isNaN(d.getTime())) return '';
            const yyyy = d.getFullYear();
            const mm   = String(d.getMonth() + 1).padStart(2, '0');
            const dd   = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }

        function confirmPdfImport() {
            if (_isGroupedMode) {
                alert('Switch to "Standard Quote" mode first (top of the form) before importing from a PDF.');
                return;
            }

            document.getElementById('company').value     = (document.getElementById('piCompany').value || '').toUpperCase();
            document.getElementById('address').value     = document.getElementById('piAddress').value || '';
            document.getElementById('tin').value         = document.getElementById('piTin').value || '';
            document.getElementById('tel').value         = document.getElementById('piTel').value || '';
            document.getElementById('attentionTo').value = document.getElementById('piAttentionTo').value || '';
            document.getElementById('projectName').value = document.getElementById('piProjectName').value || '';

            const iso = guessDateToISO(document.getElementById('piDate').value);
            if (iso) document.getElementById('date').value = iso;

            const paymentTermsVal = document.getElementById('piPaymentTerms').value || '';
            const ptSelect = document.getElementById('paymentTerms');
            const matched  = Array.from(ptSelect.options).find(o => o.value.toLowerCase() === paymentTermsVal.toLowerCase());
            if (matched) {
                ptSelect.value = matched.value;
            } else if (paymentTermsVal) {
                ptSelect.value = 'others';
                toggleOtherPayment();
                document.getElementById('otherPaymentTerms').value = paymentTermsVal;
            }

            // Land items as regular in-house items in "Fixed Price" mode
            // (fbMode: 'fixed') rather than "Additional Fees" — Fixed Price
            // is meant for exactly this (a plain manually-entered price, no
            // W×H formula), shows up in the main Items section instead of a
            // separate one, and is what addItem()'s own opts already support
            // directly (mode + fixedManualPrice), so the price field and
            // totals sync correctly without extra work.
            document.querySelectorAll('#piItemsBody tr').forEach(tr => {
                const desc     = tr.querySelector('.pi-desc').value.trim();
                const qty      = tr.querySelector('.pi-qty').value;
                const price    = parseFloat(tr.querySelector('.pi-price').value) || 0;
                const sizeW    = tr.querySelector('.pi-sizeW').value;
                const sizeH    = tr.querySelector('.pi-sizeH').value;
                const sizeUnit = tr.querySelector('.pi-sizeUnit').value.trim();
                if (!desc && !price) return; // skip fully-blank rows
                addItem({ mode: 'fixed', fixedManualPrice: price });
                const row = document.getElementById('item' + itemCount);
                row.querySelector('.material').value  = desc;
                row.querySelector('.qty').value        = qty || 1;
                row.querySelector('input.sizeW').value    = sizeW;
                row.querySelector('input.sizeH').value    = sizeH;
                row.querySelector('.sizeUnit').value = sizeUnit;
            });
            calculateTotals();

            closePdfImportModal();
        }

        function renderHistory(viewMode) {
            const db    = _cachedDb || {};
            const list  = document.getElementById('historyList');
            const countEl = document.getElementById('historyCount');
            const query = (document.getElementById('historySearch')?.value || '').trim().toLowerCase();
            const devMode   = isDevMode();
            const isAdmin   = _currentProfile && _currentProfile.role === 'admin';
            const canDelete = devMode || isAdmin;
            // viewMode: 'mine' | 'all' — only relevant for admin; regular users always see 'mine'
            const showAll = isAdmin && (viewMode === 'all');

            let keys = Object.keys(db);

            if (keys.length === 0) {
                list.innerHTML = '<div class="history-empty">No saved quotes yet.</div>';
                if (countEl) countEl.textContent = '';
                return;
            }

            // Filter by sales rep.
            // Admin with showAll=true: see all quotes from all reps.
            // Everyone else (including admin on 'mine' view): see only their own quotes.
            const isAllDevView = devMode && _currentProfile && _currentProfile.id === '__dev__';
            if (!showAll && !isAllDevView && _currentProfile && _currentProfile.name) {
                const myName = _currentProfile.name.trim().toLowerCase();
                keys = keys.filter(k => (db[k].salesName || '').trim().toLowerCase() === myName);
            }

            // ── Group by company name (folder), then by controlNumber|companyKey (quote group) ──
            // storeKey format: Q26_XXXX|companykey|revN
            const byCompany = {}; // companyName → { baseKey → [storeKeys] }
            keys.forEach(k => {
                const snap = db[k];
                const companyName = (snap.company || '(No Company)').trim();
                const parts   = k.split('|');
                const baseKey = parts[0] + '|' + (parts[1] || '');
                if (!byCompany[companyName]) byCompany[companyName] = {};
                if (!byCompany[companyName][baseKey]) byCompany[companyName][baseKey] = [];
                byCompany[companyName][baseKey].push(k);
            });

            // Sort revisions within each quote group (highest first)
            Object.values(byCompany).forEach(quoteGroups => {
                Object.values(quoteGroups).forEach(arr => {
                    arr.sort((a, b) => {
                        const ra = parseInt((a.match(/\|rev(\d+)$/) || [,0])[1]);
                        const rb = parseInt((b.match(/\|rev(\d+)$/) || [,0])[1]);
                        return rb - ra;
                    });
                });
            });

            // Sort quote groups within each company folder by latest saved (newest first)
            const sortedQuoteGroups = (quoteGroups) => {
                return Object.keys(quoteGroups).sort((a, b) => {
                    const la = db[quoteGroups[a][0]]?.lastSaved || '';
                    const lb = db[quoteGroups[b][0]]?.lastSaved || '';
                    return new Date(lb) - new Date(la);
                });
            };

            // Sort companies by their most-recently-modified quote
            let companyNames = Object.keys(byCompany).sort((a, b) => {
                const latestA = sortedQuoteGroups(byCompany[a])[0];
                const latestB = sortedQuoteGroups(byCompany[b])[0];
                const la = latestA ? db[byCompany[a][latestA][0]]?.lastSaved || '' : '';
                const lb = latestB ? db[byCompany[b][latestB][0]]?.lastSaved || '' : '';
                return new Date(lb) - new Date(la);
            });

            const totalQuoteGroups = companyNames.reduce((n, c) => n + Object.keys(byCompany[c]).length, 0);

            // Apply search filter across companies
            if (query) {
                companyNames = companyNames.filter(c => {
                    if (c.toLowerCase().includes(query)) return true;
                    return Object.values(byCompany[c]).some(revs =>
                        revs.some(k => {
                            const s = db[k];
                            const hay = [s.controlNumber || '', s.company || '', s.projectName || ''].join(' ').toLowerCase();
                            return hay.includes(query);
                        })
                    );
                });
            }

            if (countEl) {
                countEl.textContent = query
                    ? `${companyNames.length} of ${Object.keys(byCompany).length} compan${Object.keys(byCompany).length !== 1 ? 'ies' : 'y'} match`
                    : `${totalQuoteGroups} quote${totalQuoteGroups !== 1 ? 's' : ''} · ${Object.keys(byCompany).length} compan${Object.keys(byCompany).length !== 1 ? 'ies' : 'y'}`;
            }

            if (companyNames.length === 0) {
                list.innerHTML = `<div class="history-empty">No quotes match "<strong>${query}</strong>".</div>`;
                return;
            }

            const hl = (text) => {
                if (!query || !text) return text || '';
                const idx = text.toLowerCase().indexOf(query);
                if (idx === -1) return text;
                return text.slice(0, idx)
                    + `<mark style="background:#fff3b0;border-radius:2px;padding:0 1px;">${text.slice(idx, idx + query.length)}</mark>`
                    + text.slice(idx + query.length);
            };

            list.innerHTML = companyNames.map(companyName => {
                const quoteGroups = byCompany[companyName];
                const groupKeys   = sortedQuoteGroups(quoteGroups);
                const totalRevs   = groupKeys.length;

                // Grab latest snapshot for this company (for "New Quote" pre-fill)
                const newestGroupKey = groupKeys[0];
                const newestSnap     = db[quoteGroups[newestGroupKey][0]];
                const lastModified   = new Date(newestSnap?.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                const safeCompany    = companyName.replace(/'/g, "\\'");

                // Build quote rows inside folder
                const quoteRows = groupKeys.map(gk => {
                    const revKeys      = quoteGroups[gk];
                    const latestKey    = revKeys[0];
                    const latest       = db[latestKey];
                    const hasRevs      = revKeys.length > 1;
                    const latestRevNum = latest.revisions || 0;
                    const latestLabel  = latestRevNum > 0 ? `Rev${latestRevNum}` : 'Original';
                    const safeLatest   = latestKey.replace(/'/g, "\\'");
                    const saved = new Date(latest.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                    const salesPerson  = latest.salesName
                        ? `<span style="color:#27ae60;font-size:11px;">${latest.salesName}${latest.salesPosition ? ' · ' + latest.salesPosition : ''}</span>`
                        : '';

                    // Delete button — visible to all users for their own quotes
                    const deleteBtn = `<button class="btn-delete-hist" title="Delete this quote" onclick="event.stopPropagation();deleteQuote(event,'${safeLatest}')">🗑</button>`;

                    // Print button — always visible; data-* avoids all quote-escaping issues
                    const safePdfPath = (latest.pdfPath || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                    const safeFilename = ((latest.controlNumber||'quote') + '.pdf').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
                    const printBtn = `<button
                        class="btn-print-hist"
                        style="background:none;border:none;color:${latest.pdfPath?'#aaa':'#ddd'};cursor:pointer;font-size:16px;padding:4px 6px;flex-shrink:0;"
                        title="${latest.pdfPath ? 'Print PDF directly' : 'Generate PDF first to enable direct print'}"
                        data-pdf-path="${safePdfPath}"
                        data-filename="${safeFilename}"
                        onclick="event.stopPropagation();handleHistoryPrint(this)">🖨️</button>`;

                    const openBtn = latest.pdfPath ? `<button
                        class="btn-open-hist"
                        style="background:#4A90E2;border:none;color:white;cursor:pointer;font-size:11px;font-weight:bold;padding:4px 8px;flex-shrink:0;border-radius:4px;font-family:inherit;"
                        title="Open saved PDF"
                        data-pdf-path="${safePdfPath}"
                        onclick="event.stopPropagation();handleHistoryOpen(this)">Open File</button>` : '';

                    // Checkboxes visible to admin and dev mode
                    const checkboxHtml = canDelete
                        ? `<input type="checkbox" class="history-checkbox" data-key="${safeLatest}"
                            onclick="event.stopPropagation(); updateDeleteCount();">`
                        : '';

                    // Revision dropdown rows
                    const revDropdownItems = hasRevs ? revKeys.slice(1).map(rk => {
                        const rs     = db[rk];
                        const rvNum  = rs.revisions || 0;
                        const rvLabel = rvNum > 0 ? `Rev${rvNum}` : 'Original';
                        const rvSaved = new Date(rs.lastSaved).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
                        const safeRk  = rk.replace(/'/g, "\\'");
                        const devCb   = canDelete
                            ? `<input type="checkbox" class="history-checkbox" data-key="${safeRk}"
                                onclick="event.stopPropagation(); updateDeleteCount();" style="margin-right:4px;">`
                            : '';
                        return `
                          <div class="history-rev-row" onclick="loadQuote('${safeRk}')" title="Load ${rvLabel}">
                            ${devCb}
                            <span class="history-rev-label ${rvNum === 0 ? 'rev-original' : ''}">${rvLabel}</span>
                            <span class="history-rev-date">Saved: ${rvSaved}</span>
                            <button class="btn-delete-hist" title="Delete" onclick="event.stopPropagation();deleteQuote(event,'${safeRk}')">🗑</button>
                          </div>`;
                    }).join('') : '';

                    const dropdownToggle = hasRevs
                        ? `<button class="btn-rev-toggle" title="Show all revisions"
                              onclick="event.stopPropagation(); toggleRevDropdown(this)">▾</button>`
                        : '';

                    return `
                      <div class="history-item">
                        <div class="history-item-top" onclick="loadQuote('${safeLatest}')" style="cursor:pointer;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;" title="Click to load this quote">
                          ${checkboxHtml}
                          <span class="history-ctrl" style="flex-shrink:0;">${hl(latest.controlNumber || latestKey)}</span>
                          <div class="history-info" style="flex:1;min-width:0;overflow:hidden;">
                            <div class="history-meta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                              ${latest.projectName ? `<span style="color:#7f5af0;font-size:11px;">${hl(latest.projectName)}</span> · ` : ''}${salesPerson ? salesPerson + ' · ' : ''}Saved: ${saved}
                            </div>
                          </div>
                          <span class="history-rev ${latestRevNum > 0 ? '' : 'rev-original-badge'}" style="flex-shrink:0;">${latestLabel}</span>
                          ${dropdownToggle}
                          ${openBtn}
                          ${printBtn}
                          ${deleteBtn}
                        </div>
                        ${hasRevs ? `<div class="history-rev-dropdown">${revDropdownItems}</div>` : ''}
                      </div>`;
                }).join('');

                return `
                  <div class="company-folder" id="folder-${btoa(companyName).replace(/[^a-zA-Z0-9]/g,'')}">
                    <div class="company-folder-header" onclick="toggleFolder(this)">
                      <span class="folder-company-name">${hl(companyName)}</span>
                      <span class="folder-meta">Last modified: ${lastModified}</span>
                      <span class="folder-quote-count">${totalRevs} quote${totalRevs !== 1 ? 's' : ''}</span>
                      <span class="folder-chevron">▶</span>
                    </div>
                    <div class="company-folder-body">
                      <button class="btn-new-for-company" onclick="newQuoteForCompany('${safeCompany}')">
                        New quote for ${companyName}
                      </button>
                      ${quoteRows}
                    </div>
                  </div>`;
            }).join('');
        }

        function toggleFolder(header) {
            header.classList.toggle('open');
            header.nextElementSibling.classList.toggle('open');
        }

        function toggleRevDropdown(btn) {
            const item = btn.closest('.history-item');
            const dropdown = item.querySelector('.history-rev-dropdown');
            if (!dropdown) return;
            const isOpen = dropdown.classList.toggle('open');
            btn.textContent = isOpen ? '▴' : '▾';
        }

        /* Pre-fill company info from the most recent quote for that company, then close modal */
        async function newQuoteForCompany(companyName) {
            const db = _cachedDb || {};
            // Find the most recently saved quote for this company
            const matchingKeys = Object.keys(db).filter(k =>
                (db[k].company || '').trim().toLowerCase() === companyName.trim().toLowerCase()
            );
            if (!matchingKeys.length) { closeHistory(); return; }

            // Pick the most recently saved
            matchingKeys.sort((a, b) => new Date(db[b].lastSaved) - new Date(db[a].lastSaved));
            const snap = db[matchingKeys[0]];

            // Reset form fully first (new quote — no loaded key, fresh serial)
            _loadedStoreKey     = null;
            _loadedFromSnapshot = false;
            currentRevision     = 0;

            // Pre-fill company fields only
            document.getElementById('company').value     = snap.company     || '';
            document.getElementById('address').value     = snap.address     || '';
            document.getElementById('tin').value         = snap.tin         || '';
            document.getElementById('tel').value         = snap.tel         || '';
            const ptSel  = document.getElementById('paymentTerms');
            const ptOpts = Array.from(ptSel.options).map(o => o.value);
            if (snap.paymentTerms && ptOpts.includes(snap.paymentTerms)) {
                ptSel.value = snap.paymentTerms;
            } else if (snap.paymentTerms) {
                ptSel.value = 'others';
                document.getElementById('otherPaymentTerms').value = snap.paymentTerms;
            }
            toggleOtherPayment();

            // Clear project-specific fields
            document.getElementById('attentionTo').value = '';
            document.getElementById('projectName').value = '';
            document.getElementById('leadTime').value    = '0';
            document.getElementById('date').valueAsDate  = new Date();

            // Clear items
            document.getElementById('items').innerHTML = '';
            document.getElementById('outsourceItems').innerHTML = '';
            const _oSec = document.getElementById('outsourceSection'); if (_oSec) _oSec.style.display = 'none';
            itemCount = 0; outsourceCount = 0;
            Object.keys(multCounters).forEach(k => delete multCounters[k]);
            Object.keys(addonCounters).forEach(k => delete addonCounters[k]);
            Object.keys(outMultCounters).forEach(k => delete outMultCounters[k]);

            // Get a fresh serial for this company
            const serial = await peekNextSerial(snap.company || '');
            currentControlNumber = buildControlNumber(serial);
            calculateTotals();
            refreshCtrlDisplay();
            closeHistory();
        }

        function loadQuote(storeKey) {
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            if (!snap) { alert('Quote not found: ' + storeKey); return; }
            _loadedStoreKey = storeKey;
            try {
                restoreSnapshot(snap);
            } catch(e) {
                console.error('[loadQuote] restoreSnapshot crashed:', e);
                alert('Error loading quote: ' + e.message + '\nCheck console for details.');
                return;
            }
            closeHistory();
        }

        /* ── Build the /api/generate-quotation payload straight from a saved snapshot ── */
        function snapshotToApiPayload(snap) {
            const mapItem = it => ({
                material:  it.material  || '',
                sizeW:     it.sizeW     || '',
                sizeH:     it.sizeH     || '',
                sizeUnit:  it.sizeUnit  || '',
                unitPrice: String(it.unitPrice || it.computedUnitPrice || 0).replace(/,/g, ''),
                quantity:  it.qty || it.quantity || 0,
                images:    it.images || []
            });
            const mapOutsource = it => ({
                material:    it.material  || '',
                sizeW:       it.sizeW     || '',
                sizeH:       it.sizeH     || '',
                sizeUnit:    it.sizeUnit  || '',
                basePrice:   parseFloat(it.basePrice) || 0,
                multipliers: it.multipliers || [],
                unitPrice:   String(it.unitPrice || it.computedUnitPrice || 0).replace(/,/g, ''),
                quantity:    it.qty || it.quantity || 0
            });
            const mapFlat = it => ({
                material:  it.material || '',
                unitPrice: String(it.flatPrice || it.unitPrice || it.computedUnitPrice || 0).replace(/,/g, ''),
                quantity:  it.qty || it.quantity || 1
            });

            // For grouped snapshots, pass groups through and let the server flatten them
            const isGrouped = !!(snap.isGrouped && snap.quoteGroups && snap.quoteGroups.length);

            return {
                controlNumber:  snap.controlNumber,
                revisionNumber: snap.revisions || 0,
                company:        snap.company       || '',
                address:        snap.address       || '',
                tin:            snap.tin           || '',
                attentionTo:    snap.attentionTo   || '',
                date:           snap.date          || '',
                tel:            snap.tel           || '',
                leadTime:       snap.leadTime       || '',
                projectName:    snap.projectName   || '',
                paymentTerms:   snap.paymentTerms   || '',
                salesName:      snap.salesName      || '',
                salesContact:   snap.salesContact   || '',
                salesEmail:     snap.salesEmail     || '',
                salesPosition:  snap.salesPosition  || '',
                salesSignature: snap.salesSignature || null,
                bankDetails:    snap.bankDetails    || 'bdo,ub,gcash',
                isGrouped,
                quoteGroups:      isGrouped ? snap.quoteGroups : [],
                items:            isGrouped ? [] : (snap.items || []).map(mapItem),
                outsourceItems:   isGrouped ? [] : (snap.outsourceItems || []).map(mapOutsource),
                flatRateItems:    isGrouped ? [] : (snap.flatRateItems  || []).map(mapFlat),
                // Reference images are auto-included whenever the saved quote actually
                // has any attached (no manual toggle anymore).
                includeImageRef:  !isGrouped && (snap.items || []).some(it => it.images && it.images.length > 0),
                skipDriveSave:  true  // history preview -- never re-save/overwrite Drive PDF
            };
        }

        /* ── Preview PDF for a saved quote, without touching its revision/serial ── */
        async function previewQuote(storeKey, e) {
            if (e) e.stopPropagation();
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            if (!snap) return;

            // Open synchronously first (still inside the click's user-gesture window),
            // then redirect once the PDF blob is ready — window.open() called AFTER an
            // await gets silently blocked by popup blockers in most browsers, which is
            // especially likely here since PDF generation can take a few seconds.
            const newWin = window.open('', '_blank');

            document.getElementById('loading').classList.add('show');
            try {
                const data = snapshotToApiPayload(snap);
                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(errText || 'Failed to generate PDF preview');
                }

                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `${data.controlNumber}_${data.company}.pdf`;

                const blob = await response.blob();
                const namedFile = new File([blob], filename, { type: 'application/pdf' });
                const url = window.URL.createObjectURL(namedFile);
                if (newWin) newWin.location.href = url; else window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);
            } catch (err) {
                if (newWin) newWin.close();
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }

        async function deleteQuote(e, storeKey) {
            e.stopPropagation();
            const db   = _cachedDb || {};
            const snap = db[storeKey];
            const label = snap ? `${snap.controlNumber} - ${snap.company}` : storeKey;
            if (!confirm(`Delete quote "${label}"? This cannot be undone.`)) return;
            await deleteQuoteFromServer(storeKey);
            await syncSerialsAfterDelete();
            const companyVal = document.getElementById('company').value;
            if (companyVal) {
                const serial = await peekNextSerial(companyVal);
                currentControlNumber = buildControlNumber(serial);
                currentRevision = 0;
                refreshCtrlDisplay();
            }
            renderHistory(_historyViewMode);
        }

        /* ═══════════════════════════════════════════════════════
           ITEM BUILDER — Visual Formula Builder
           Replaces old multiplier-tag + manual-formula system.
           Each in-house item has:
             • Simple mode: N component rows (W×H×price×mult) + outer multiplier
             • Advanced mode: validated formula bar (pre-filled from Simple)
             • Add-on materials (unchanged)
        ═══════════════════════════════════════════════════════ */
        let itemCount = 0;
        let outsourceCount = 0;
        // Per-item state: { mode: 'simple'|'adv', components: [{price,mult}], outerMult: 1, advFormula: '' }
        const itemState = {};
        const addonCounters = {};

        // Whether any in-house item currently has an attached reference image.
        // Reference images are only supported on in-house items (see mapOutsource
        // in snapshotToApiPayload, which never carries an images field). Used to
        // auto-include reference images in the printed PDF instead of a manual
        // "Include reference images" toggle -- attaching an image IS the intent.
        function hasAnyReferenceImages() {
            return Object.values(itemState).some(s => s && Array.isArray(s.images) && s.images.length > 0);
        }

        // Keep legacy aliases so snapshot/restore still work
        const multCounters    = {};
        const outMultCounters = {};

        document.getElementById('date').valueAsDate = new Date();

        /* ── Delegate recalc on any input inside #items or #outsourceItems ── */
        document.getElementById('items').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('sizeW')   ||
                e.target.classList.contains('sizeH')   ||
                e.target.classList.contains('qty')     ||
                e.target.classList.contains('fb-price-input') ||
                e.target.classList.contains('fb-outer-input') ||
                e.target.classList.contains('fb-adv-input')   ||
                e.target.classList.contains('addon-price')    ||
                e.target.classList.contains('addon-qty')
            ) { calculateTotals(); }
        });

        document.getElementById('outsourceItems').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('sizeW')        ||
                e.target.classList.contains('sizeH')        ||
                e.target.classList.contains('qty')          ||
                e.target.classList.contains('outsourceBase') ||
                e.target.classList.contains('outMultVal')
            ) { calculateTotals(); }
        });

        initControlNumber();

        /* ────────────────────────────────────────────────────
           addItem — creates one in-house item with the new
           visual formula builder panel
        ──────────────────────────────────────────────────── */
        function addItem(opts) {
            itemCount++;
            const id = itemCount;

            // Default state
            itemState[id] = {
                mode:        'simple',
                components:  [{ price: 0 }],
                outerMult:   1,
                advFormula:  '',
                fixedFormula:      '',   // formula for reference in Fixed Price mode
                fixedMults:        [],   // multipliers applied to manual unit price
                fixedManualPrice:  0,    // manual unit price value (stored here, not read from DOM)
                images:      []          // [{token,filename} freshly uploaded | {path,filename,mimeType} already saved]
            };

            // Apply opts (used by restoreSnapshot)
            if (opts) {
                if (opts.mode)       itemState[id].mode        = opts.mode;
                if (opts.components) itemState[id].components  = opts.components;
                if (opts.outerMult !== undefined) itemState[id].outerMult = opts.outerMult;
                if (opts.advFormula)  itemState[id].advFormula  = opts.advFormula;
                if (opts.fixedFormula  != null)   itemState[id].fixedFormula      = opts.fixedFormula;
                if (opts.fixedMults)              itemState[id].fixedMults        = opts.fixedMults;
                if (opts.fixedManualPrice != null) itemState[id].fixedManualPrice = opts.fixedManualPrice;
                if (opts.images)                  itemState[id].images           = opts.images;
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'item-wrapper';
            wrapper.id = 'item' + id;

            // ── Main row (description, size, unit, price, qty, subtotal, remove) ──
            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = `
                <textarea placeholder="Description" class="material" rows="1" style="resize:none;overflow:hidden;"></textarea>
                <div class="size-cell">
                    <div class="size-split">
                        <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                        <span>×</span>
                        <input type="number" step="any" min="0" placeholder="H" class="sizeH">
                    </div>
                </div>
                ${uomSelectHtml('ft')}
                <input type="text" class="price" placeholder="0.00" readonly
                    oninput="onPriceInput(${id}, this)"
                    style="text-align:right;background:#f0f4ff;color:#2c3e50;font-weight:bold;border:1px solid #c5d5f0;cursor:default;">
                <input type="number" min="1" value="1" class="qty" style="text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00"
                    style="background:#f8f9fa;font-weight:bold;border:1px solid #ccd1d1;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeItem(${id})">✕</button>`;

            // ── Formula builder panel ──
            const panel = document.createElement('div');
            panel.className = 'fb-panel';
            panel.id = 'fbPanel' + id;
            panel.innerHTML = buildPanelHTML(id);

            // ── Add-on section (unchanged) ──
            const addonSection = document.createElement('div');
            addonSection.className = 'addon-section';
            addonSection.innerHTML = `
                <div class="addon-section-title">Add-on Materials <span style="font-weight:normal;color:#999;">(added to Unit Price, hidden in PDF)</span></div>
                <div class="addon-tags" id="addonTags${id}"></div>
                <button type="button" class="btn-add-addon" onclick="addAddon(${id})">+ Add-on Material</button>
                <div class="addon-total-hint" id="addonHint${id}"></div>`;

            // ── Reference images (optional, per item — see refimg* functions) ──
            const refimgSection = document.createElement('div');
            refimgSection.className = 'refimg-section';
            refimgSection.innerHTML = `
                <div class="refimg-section-title">Reference Images <span style="font-weight:normal;color:#999;">(attached images are automatically included in the printed PDF)</span></div>
                <div class="refimg-strip" id="refimgStrip${id}"></div>
                <input type="file" id="refimgInput${id}" accept="image/png,image/jpeg,image/gif,image/webp" multiple
                    style="display:none;" onchange="handleRefImageSelect(${id}, this)">
                <button type="button" class="btn-add-refimg" onclick="document.getElementById('refimgInput${id}').click()">+ Add Image</button>`;

            wrapper.appendChild(row);
            wrapper.appendChild(panel);
            wrapper.appendChild(addonSection);
            wrapper.appendChild(refimgSection);
            document.getElementById('items').appendChild(wrapper);

            // If restored opts had specific values, populate them into the DOM now
            if (opts) syncPanelFromState(id);
            renderRefImages(id);

            calculateTotals();
        }

        /* ── Reference images (per item, optional in the printed PDF) ──────────
           itemState[id].images holds a mix of:
             { token, filename }              — uploaded this session, not saved yet
             { path, filename, mimeType }     — already persisted by a prior Save
           Thumbnails for the token case use an instant local FileReader data URL
           (cached in _refImgPreviewCache); the path case fetches a short-lived
           view token the same way openViewFile() does for PDFs, then caches the
           resulting URL so re-renders don't re-fetch it every time. */
        const _refImgPreviewCache = new Map(); // token or path -> preview URL (data: or /api/view-file?...)

        function renderRefImages(id) {
            const strip = document.getElementById('refimgStrip' + id);
            if (!strip) return;
            const images = (itemState[id] && itemState[id].images) || [];
            strip.innerHTML = images.map((img, idx) => {
                const key = img.token || img.path;
                const cached = _refImgPreviewCache.get(key);
                const src = cached || '';
                if (!cached) resolveRefImagePreview(img).then(url => {
                    if (url) { _refImgPreviewCache.set(key, url); renderRefImages(id); }
                });
                return `
                <div class="refimg-thumb">
                    <div class="refimg-thumb-box">
                        ${src ? `<img src="${src}" alt="${escAttr(img.filename||'')}">` : ''}
                        <button type="button" class="refimg-thumb-remove" onclick="removeRefImage(${id},${idx})" title="Remove">✕</button>
                    </div>
                    <div class="refimg-thumb-name" title="${escAttr(img.filename||'')}">${escAttr(img.filename||'')}</div>
                </div>`;
            }).join('');
        }

        function escAttr(s) {
            return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        }

        // Resolves one image entry to a browser-displayable URL. Freshly
        // uploaded (token-only) images already have their preview cached at
        // upload time (see handleRefImageSelect) — this only needs to hit the
        // server for the {path} case, i.e. an image restored from a
        // previously-saved quote with no local File object to re-read. Uses
        // the same short-lived view-token exchange as openViewFile() for
        // PDFs, never the long-lived session JWT.
        async function resolveRefImagePreview(img) {
            if (!img.path) return null; // token-only with no cache entry yet — nothing to fetch
            try {
                const r = await fetch(`${API}/api/view-file-token`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: img.path })
                });
                const d = await r.json();
                if (d.token) return `${API}/api/view-file?path=${encodeURIComponent(img.path)}&vtoken=${encodeURIComponent(d.token)}`;
            } catch {}
            return null;
        }

        // Resizes an image file down to a small JPEG before upload — these are
        // shown as a 60px in-app thumbnail and a 70px strip in the printed PDF,
        // so a full-resolution original just bloats disk storage and PDF size
        // for no visible benefit. Same technique/limits as jo.html's
        // processFileAttach() for consistency.
        function resizeImageForUpload(file) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = function() {
                    URL.revokeObjectURL(url);
                    const MAX = 400;
                    let w = img.width, h = img.height;
                    if (w > MAX || h > MAX) {
                        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                        else       { w = Math.round(w * MAX / h); h = MAX; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob failed')), 'image/jpeg', 0.8);
                };
                img.onerror = () => reject(new Error('Could not read image'));
                img.src = url;
            });
        }

        async function handleRefImageSelect(id, input) {
            const files = Array.from(input.files || []);
            input.value = '';
            if (!files.length) return;
            const s = itemState[id];
            if (!s) return;
            for (const file of files) {
                try {
                    const resizedBlob = await resizeImageForUpload(file);
                    const localPreview = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = e => resolve(e.target.result);
                        reader.onerror = () => reject(new Error('Could not read file'));
                        reader.readAsDataURL(resizedBlob);
                    });

                    const r = await fetch(`${API}/api/quote-upload-file`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'image/jpeg', 'X-File-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(file.name) },
                        body: resizedBlob
                    });
                    const d = await r.json();
                    if (!d.ok || !d.token) { alert(`Could not upload "${file.name}".`); continue; }

                    _refImgPreviewCache.set(d.token, localPreview);
                    s.images = s.images || [];
                    s.images.push({ token: d.token, filename: file.name });
                    renderRefImages(id);
                } catch (e) {
                    alert(`Error uploading "${file.name}": ` + e.message);
                }
            }
        }

        function removeRefImage(id, idx) {
            const s = itemState[id];
            if (!s || !s.images) return;
            s.images.splice(idx, 1);
            renderRefImages(id);
        }

        /* Build the inner HTML of a formula panel for item `id` */
        function buildPanelHTML(id) {
            return `
            <div class="fb-tabs">
                <button type="button" class="fb-tab active" id="fbTabSimple${id}" onclick="fbSwitchMode(${id},'simple')">Simple</button>
                <button type="button" class="fb-tab" id="fbTabAdv${id}" onclick="fbSwitchMode(${id},'adv')">Advanced ƒ(x)</button>
                <button type="button" class="fb-tab" id="fbTabFixed${id}" onclick="fbSwitchMode(${id},'fixed')">Fixed Price</button>
            </div>

            <div class="fb-simple" id="fbSimple${id}">
                <div class="fb-comp-label">Components</div>
                <div class="fb-comp-list" id="fbCompList${id}"></div>
                <button type="button" class="fb-btn-add-comp" onclick="fbAddComp(${id})">+ Add Component</button>
                <div class="fb-outer-row">
                    <span class="fb-outer-label">( sum ) ×</span>
                    <input type="number" step="any" min="0.001" value="1" class="fb-outer-input" id="fbOuter${id}"
                        oninput="itemState[${id}].outerMult=parseFloat(this.value)||1; calculateTotals()">
                    <span class="fb-outer-hint" id="fbOuterHint${id}"></span>
                </div>
            </div>

            <div class="fb-adv" id="fbAdv${id}" style="display:none;">
                <div class="fb-adv-row">
                    <span class="fb-adv-equals">ƒ =</span>
                    <input type="text" class="fb-adv-input" id="fbAdvInput${id}"
                        placeholder="e.g. ((W*H*450)+(W*H*120))*1.5"
                        oninput="itemState[${id}].advFormula=this.value; calculateTotals()"
                        autocomplete="off" spellcheck="false">
                </div>
                <div class="fb-adv-status" id="fbAdvStatus${id}">&nbsp;</div>
                <div class="fb-adv-tip">Use <strong>W</strong> and <strong>H</strong> for dimensions. Operators: + − * / and ( )</div>
            </div>

            <div class="multiplier-row" id="fbFixed${id}" style="display:none;">
                <div class="outsource-base-row">
                    <span class="fb-adv-equals" style="margin-right:6px;">ƒ =</span>
                    <input type="text" class="fb-adv-input" id="fbFixedInput${id}"
                        placeholder="e.g. W*H*450 (reference only)"
                        oninput="onFixedFormulaInput(${id}, this.value)"
                        autocomplete="off" spellcheck="false" style="flex:1;">
                    <span id="fbFixedStatus${id}" style="font-size:12px;margin-left:8px;">&nbsp;</span>
                </div>
                <div>
                    <div class="multiplier-tags" id="fbFixedMults${id}"></div>
                    <button type="button" class="btn-add-outsource-mult" onclick="fbAddFixedMult(${id})">× Add Multiplier</button>
                    <div class="outsource-formula" id="fbFixedFormula${id}">Unit Price = manual input</div>
                </div>
            </div>

            <div class="fb-formula-summary" id="fbSummary${id}">—</div>`;
        }

        /* Sync DOM inputs from itemState (used after restoring a snapshot) */
        function syncPanelFromState(id) {
            const s = itemState[id];
            renderCompList(id);
            const outerInp = document.getElementById('fbOuter' + id);
            if (outerInp) outerInp.value = s.outerMult;
            const advInp = document.getElementById('fbAdvInput' + id);
            if (advInp) advInp.value = s.advFormula;
            const fixedInp = document.getElementById('fbFixedInput' + id);
            if (fixedInp) fixedInp.value = s.fixedFormula || '';
            fbRenderFixedMults(id);
            fbSwitchMode(id, s.mode, /* skipStateUpdate */ true);
        }

        /* Render component rows from itemState[id].components */
        function renderCompList(id) {
            const s    = itemState[id];
            const list = document.getElementById('fbCompList' + id);
            if (!list) return;

            // Read current W,H for the inline preview
            const wrapper = document.getElementById('item' + id);
            const W = wrapper ? (parseFloat(wrapper.querySelector('input.sizeW')?.value) || 0) : 0;
            const H = wrapper ? (parseFloat(wrapper.querySelector('input.sizeH')?.value) || 0) : 0;

            list.innerHTML = s.components.map((c, ci) => {
                const sub = W * H * (c.price || 0);
                return `
                <div class="fb-comp-row" id="fbComp_${id}_${ci}">
                    <span class="fb-comp-prefix">W × H ×</span>
                    <input type="number" step="any" min="0" placeholder="price/sqm"
                        class="fb-price-input"
                        value="${c.price || ''}"
                        title="Price per sqm"
                        oninput="fbUpdateComp(${id},${ci},'price',this.value)">
                    <span class="fb-comp-sub" id="fbCompSub_${id}_${ci}">= ₱${sub.toFixed(2)}</span>
                    <button type="button" class="fb-btn-remove-comp"
                        onclick="fbRemoveComp(${id},${ci})" title="Remove component"
                        ${s.components.length <= 1 ? 'disabled' : ''}>✕</button>
                </div>`;
            }).join('');
        }

        /* Update one component field without re-rendering the whole list */
        function fbUpdateComp(id, ci, field, rawVal) {
            itemState[id].components[ci][field] = parseFloat(rawVal) || 0;
            calculateTotals();
        }

        function fbAddComp(id) {
            itemState[id].components.push({ price: 0 });
            renderCompList(id);
            calculateTotals();
        }

        function fbRemoveComp(id, ci) {
            if (itemState[id].components.length <= 1) return;
            itemState[id].components.splice(ci, 1);
            renderCompList(id);
            calculateTotals();
        }

        // Called on every keystroke in the Unit Price field
        // In fixed mode: allows manual entry and triggers recalc
        // In auto modes: field is read-only style but input is still prevented via CSS cursor
        window.onPriceInput = function(id, field) {
            const s = itemState[id];
            if (!s) return;
            if (s.mode === 'fixed') {
                s.fixedManualPrice = parseFloat(field.value) || 0;
                calculateTotals();
            } else {
                field.value = field.dataset.lastAuto || '';
            }
        };

        window.onFixedFormulaInput = function(id, value) {
            if (!itemState[id]) return;
            itemState[id].fixedFormula = value;
            calculateTotals();
        };

        function fbSwitchMode(id, mode, skipStateUpdate) {
            if (!skipStateUpdate) itemState[id].mode = mode;

            const simpleEl = document.getElementById('fbSimple' + id);
            const advEl    = document.getElementById('fbAdv'    + id);
            const fixedEl  = document.getElementById('fbFixed'  + id);
            const tabS     = document.getElementById('fbTabSimple' + id);
            const tabA     = document.getElementById('fbTabAdv'   + id);
            const tabF     = document.getElementById('fbTabFixed' + id);
            if (!simpleEl || !advEl) return;

            // Hide all panels
            simpleEl.style.display = 'none';
            advEl.style.display    = 'none';
            if (fixedEl) fixedEl.style.display = 'none';
            tabS?.classList.remove('active');
            tabA?.classList.remove('active');
            tabF?.classList.remove('active');

            if (mode === 'adv') {
                advEl.style.display = '';
                tabA?.classList.add('active');
                // Pre-fill adv formula from current simple state if blank
                const advInp = document.getElementById('fbAdvInput' + id);
                if (advInp && !advInp.value.trim()) {
                    advInp.value = buildSimpleFormula(id, true);
                    itemState[id].advFormula = advInp.value;
                }
                // Unit Price: computed — actually locked (readOnly), not just
                // styled to look locked, so a click-then-type can't silently
                // get overwritten by the next calculateTotals() recompute.
                const priceField = document.querySelector('#item' + id + ' input.price');
                if (priceField) {
                    priceField.style.background = '#f0f4ff'; priceField.style.color = '#2c3e50';
                    priceField.style.cursor = 'default'; priceField.placeholder = '0.00';
                    priceField.readOnly = true;
                }
            } else if (mode === 'fixed') {
                if (fixedEl) fixedEl.style.display = '';
                tabF?.classList.add('active');
                // Restore fixed formula input value
                const fixedInp = document.getElementById('fbFixedInput' + id);
                if (fixedInp) fixedInp.value = itemState[id].fixedFormula || '';
                // Render multipliers
                fbRenderFixedMults(id);
                // Unit Price: manual — make editable and visually distinct
                const priceField = document.querySelector('#item' + id + ' input.price');
                if (priceField) {
                    priceField.style.background = '#fffbea';
                    priceField.style.color = '#7c5a00';
                    priceField.style.cursor = 'text';
                    priceField.style.border = '1px solid #f0c09a';
                    priceField.readOnly = false;
                    // Restore previously entered value from state
                    const prev = itemState[id].fixedManualPrice;
                    priceField.value = prev ? prev.toString() : '';
                    priceField.placeholder = 'Enter price';
                }
            } else {
                // Simple
                simpleEl.style.display = '';
                tabS?.classList.add('active');
                const priceField = document.querySelector('#item' + id + ' input.price');
                if (priceField) {
                    priceField.style.background = '#f0f4ff'; priceField.style.color = '#2c3e50';
                    priceField.style.cursor = 'default'; priceField.placeholder = '0.00';
                    priceField.readOnly = true;
                }
            }
            calculateTotals();
        }

        /* Fixed Price multiplier management */
        function fbAddFixedMult(id) {
            itemState[id].fixedMults = itemState[id].fixedMults || [];
            itemState[id].fixedMults.push(1);
            fbRenderFixedMults(id);
            calculateTotals();
        }
        function fbRemoveFixedMult(id, mi) {
            itemState[id].fixedMults.splice(mi, 1);
            fbRenderFixedMults(id);
            calculateTotals();
        }
        window.fbAddFixedMult    = fbAddFixedMult;
        window.fbRemoveFixedMult = fbRemoveFixedMult;
        function fbRenderFixedMults(id) {
            const container = document.getElementById('fbFixedMults' + id);
            if (!container) return;
            const mults = itemState[id].fixedMults || [];
            container.innerHTML = mults.map((m, mi) => `
                <div class="multiplier-tag" id="fbFixedMult_${id}_${mi}">
                    <label>×${mi + 1}</label>
                    <input type="number" step="any" min="0" value="${m}" class="outMultVal"
                        oninput="itemState[${id}].fixedMults[${mi}]=parseFloat(this.value)||1; fbUpdateFixedFormula(${id}); calculateTotals()">
                    <button type="button" class="remove-mult" onclick="fbRemoveFixedMult(${id},${mi})" title="Remove">×</button>
                </div>`).join('');
            fbUpdateFixedFormula(id);
        }

        function fbUpdateFixedFormula(id) {
            const el    = document.getElementById('fbFixedFormula' + id);
            const mults = itemState[id].fixedMults || [];
            if (el) el.textContent = mults.length > 0
                ? 'Formula result × ' + mults.join(' × ') + ' = reference total'
                : 'Formula result = reference only';
        }

        /* Build a formula string from Simple state (withVars=true → uses W,H; false → substitutes values) */
        function buildSimpleFormula(id, withVars) {
            const s     = itemState[id];
            const W     = 1; // placeholder for string only
            const H     = 1;
            const parts = s.components.map(c => {
                return withVars ? `(W*H*${c.price || 0})` : `(W*H*${c.price || 0})`;
            });
            const inner = parts.join('+');
            const outer = s.outerMult || 1;
            return outer !== 1 ? `(${inner})*${outer}` : inner;
        }

        /* Evaluate formula string with given W, H */
        function evalFormula(formula, W, H) {
            const safe = String(formula).replace(/\s/g, '');
            if (!/^[0-9WHwh+\-*/().]+$/.test(safe)) return null;
            try {
                const expr = safe.replace(/[Ww]/g, '(' + W + ')').replace(/[Hh]/g, '(' + H + ')');
                const result = Function('"use strict"; return (' + expr + ')')();
                if (!isFinite(result) || isNaN(result)) return null;
                return result;
            } catch { return null; }
        }

        function removeItem(id) {
            document.getElementById('item' + id)?.remove();
            delete itemState[id];
            calculateTotals();
        }

        /* ─── Add-on materials (unchanged API) ─── */
        function addAddon(itemId) {
            if (!addonCounters[itemId]) addonCounters[itemId] = 0;
            addonCounters[itemId]++;
            const aNum = addonCounters[itemId];
            const container = document.getElementById('addonTags' + itemId);
            const tag = document.createElement('div');
            tag.className = 'addon-tag';
            tag.id = `addon_${itemId}_${aNum}`;
            tag.innerHTML = `
                <span class="addon-label">#${aNum}</span>
                <input type="text" class="addon-desc" placeholder="e.g. Bolts" oninput="calculateTotals()">
                <span class="addon-label">Price</span>
                <input type="number" step="0.01" min="0" value="0" class="addon-price" oninput="calculateTotals()">
                <span class="addon-label">× Qty</span>
                <input type="number" min="1" value="1" class="addon-qty" oninput="calculateTotals()">
                <span class="addon-subtotal" id="addonSub_${itemId}_${aNum}">= 0.00</span>
                <button type="button" class="remove-addon" onclick="removeAddon(${itemId}, ${aNum})" title="Remove">×</button>`;
            container.appendChild(tag);
            calculateTotals();
        }

        function removeAddon(itemId, aNum) {
            document.getElementById(`addon_${itemId}_${aNum}`)?.remove();
            document.getElementById('addonTags' + itemId)
                ?.querySelectorAll('.addon-tag')
                .forEach((t, i) => { t.querySelector('.addon-label').textContent = '#' + (i + 1); });
            calculateTotals();
        }

        /* ════════════════════════════════════════
           CALCULATE TOTALS
        ════════════════════════════════════════ */
        let _calculatingTotals = false;
        function calculateTotals() {
            if (_calculatingTotals) return;
            _calculatingTotals = true;
            try {
            let grandTotal = 0;

            /* ── In-house items ── */
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const idMatch = wrapper.id.match(/^item(\d+)$/);
                if (!idMatch) return;
                const id  = parseInt(idMatch[1]);
                const s   = itemState[id];
                const row = wrapper.querySelector('.item-row');
                const qty = parseFloat(row.querySelector('input.qty').value) || 0;
                const W   = parseFloat(row.querySelector('input.sizeW').value) || 0;
                const H   = parseFloat(row.querySelector('input.sizeH').value) || 0;

                let basePrice = 0;
                const summaryEl  = document.getElementById('fbSummary' + id);
                const advStatusEl = document.getElementById('fbAdvStatus' + id);

                if (s && s.mode === 'fixed') {
                    // Formula bar + multipliers = REFERENCE ONLY (like a calculator)
                    // They do NOT affect Unit Price or Subtotal at all
                    const formula = (s.fixedFormula || '').trim();
                    const formulaResult = formula ? evalFormula(formula, W, H) : null;

                    // Show formula result inline
                    const fixedStatusEl = document.getElementById('fbFixedStatus' + id);
                    if (fixedStatusEl) {
                        if (!formula) {
                            fixedStatusEl.innerHTML = '&nbsp;';
                            fixedStatusEl.style.color = '';
                        } else if (formulaResult !== null) {
                            fixedStatusEl.style.color = '#27ae60';
                            fixedStatusEl.textContent = '✓ ₱' + formulaResult.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        } else {
                            fixedStatusEl.style.color = '#c0392b';
                            fixedStatusEl.textContent = '✗ Invalid formula';
                        }
                    }

                    // Multipliers applied to formula result (reference only)
                    const mults = s.fixedMults || [];
                    if (summaryEl) {
                        if (formulaResult !== null && mults.length > 0) {
                            const refTotal = mults.reduce((acc, m) => acc * (m || 1), formulaResult);
                            const fmtN = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            summaryEl.textContent = '₱' + fmtN(formulaResult) + ' × ' + mults.join(' × ') + ' = ₱' + fmtN(refTotal) + ' (reference)';
                        } else {
                            summaryEl.textContent = formula || '—';
                        }
                    }

                    // Unit Price = purely manual — read from fixedManualPrice in state
                    const manualVal = s.fixedManualPrice || 0;
                    let addonTotal2 = 0;
                    wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                        const ap = parseFloat(tag.querySelector('.addon-price').value) || 0;
                        const aq = parseFloat(tag.querySelector('.addon-qty').value) || 0;
                        addonTotal2 += ap * aq;
                        const subEl = tag.querySelector('.addon-subtotal');
                        if (subEl) subEl.textContent = '= ' + (ap * aq).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    });
                    const unitPriceFixed = manualVal + addonTotal2;
                    const subtotalFixed  = unitPriceFixed * qty;
                    row.querySelector('.rowTotalAmount').value =
                        subtotalFixed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    grandTotal += subtotalFixed;
                    return;

                } else if (s && s.mode === 'adv') {
                    const formula = (s.advFormula || '').trim();
                    const result  = formula ? evalFormula(formula, W, H) : null;
                    basePrice     = result !== null ? result : 0;

                    if (advStatusEl) {
                        if (!formula) {
                            advStatusEl.innerHTML = '&nbsp;';
                        } else if (result !== null) {
                            advStatusEl.className   = 'fb-adv-status fb-adv-ok';
                            advStatusEl.textContent = `✓  ₱ ${result.toFixed(2)}`;
                        } else {
                            advStatusEl.className   = 'fb-adv-status fb-adv-err';
                            advStatusEl.textContent = '✗  Invalid formula';
                        }
                    }
                    if (summaryEl) summaryEl.textContent = formula || '—';

                } else if (s) {
                    // Simple mode
                    const sum = s.components.reduce((acc, c) =>
                        acc + W * H * (c.price || 0), 0);
                    const outer = s.outerMult || 1;
                    basePrice   = sum * outer;

                    // Update only subtotal labels (avoid re-rendering which breaks focus)
                    s.components.forEach((c, ci) => {
                        const subEl = document.getElementById('fbCompSub_' + id + '_' + ci);
                        if (subEl) {
                            const sub = W * H * (c.price || 0);
                            subEl.textContent = '= ₱' + sub.toFixed(2);
                        }
                    });

                    // Outer hint
                    const outerHint = document.getElementById('fbOuterHint' + id);
                    if (outerHint) outerHint.textContent = outer !== 1 ? `× ${outer} finishing/markup` : '';

                    // Summary
                    if (summaryEl) {
                        const formula = buildSimpleFormula(id, true);
                        const parts = s.components.map(c =>
                            `(${W}×${H}×${c.price || 0})`
                        ).join('+');
                        const result = `₱ ${basePrice.toFixed(2)}`;
                        summaryEl.textContent = `${parts}${outer !== 1 ? ` × ${outer}` : ''} = ${result}`;
                    }
                }

                // Add-ons
                let addonTotal = 0;
                wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                    const ap  = parseFloat(tag.querySelector('.addon-price').value) || 0;
                    const aq  = parseFloat(tag.querySelector('.addon-qty').value)   || 0;
                    const sub = ap * aq;
                    addonTotal += sub;
                    const subEl = tag.querySelector('.addon-subtotal');
                    if (subEl) subEl.textContent = '= ' + sub.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                });

                const unitPrice = basePrice + addonTotal;
                const subtotal  = unitPrice * qty;

                const priceField = row.querySelector('input.price');
                const priceStr = unitPrice > 0
                    ? unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
                priceField.value = priceStr;
                priceField.dataset.lastAuto = priceStr;

                const addonHint = document.getElementById('addonHint' + id);
                if (addonHint) {
                    addonHint.textContent = addonTotal > 0
                        ? `Add-on total: +${addonTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → Unit Price = ${unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '';
                }

                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                grandTotal += subtotal;
            });

            /* ── Outsource items (unchanged) ── */
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row       = wrapper.querySelector('.item-row');
                const basePrice = parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0;
                const qty       = parseFloat(row.querySelector('input.qty').value) || 0;
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                const unitPrice = mults.length > 0 ? mults.reduce((acc, m) => acc * m, basePrice) : basePrice;
                const unitPriceRounded = Math.round(unitPrice * 100) / 100;
                const subtotal  = unitPriceRounded * qty;

                row.querySelector('input.price').value = unitPriceRounded > 0
                    ? unitPriceRounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';

                const formulaEl = wrapper.querySelector('[id^="outFormula"]');
                if (formulaEl) {
                    if (mults.length > 0) {
                        formulaEl.textContent = `${[basePrice, ...mults].join(' × ')} = ${unitPriceRounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    } else {
                        formulaEl.textContent = 'Base Price = Unit Price';
                    }
                }

                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                grandTotal += subtotal;
            });

            /* ── Flat rate items (unchanged) ── */
            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                const price    = parseFloat(row.querySelector('input.flatPrice').value) || 0;
                const qty      = parseFloat(row.querySelector('input.qty').value) || 0;
                const subtotal = price * qty;
                row.querySelector('.rowTotalAmount').value =
                    subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                grandTotal += subtotal;
            });

            /* ── Grouped mode items ── */
            if (_isGroupedMode) {
                // In-house items in groups (item-wrapper with id="itemN")
                document.querySelectorAll('.qg-items .item-wrapper[id^="item"]').forEach(wrapper => {
                    const idMatch = wrapper.id.match(/^item(\d+)$/);
                    if (!idMatch) return;
                    const id  = parseInt(idMatch[1]);
                    const s   = itemState[id];
                    const row = wrapper.querySelector('.item-row');
                    if (!row || !s) return;
                    const qty = parseFloat(row.querySelector('input.qty')?.value) || 0;
                    const W   = parseFloat(row.querySelector('input.sizeW')?.value) || 0;
                    const H   = parseFloat(row.querySelector('input.sizeH')?.value) || 0;

                    let basePrice = 0;
                    if (s.mode === 'adv') {
                        const result = s.advFormula ? evalFormula(s.advFormula, W, H) : null;
                        basePrice = result !== null ? result : 0;
                        const advStatusEl = document.getElementById('fbAdvStatus' + id);
                        if (advStatusEl) {
                            if (!s.advFormula) { advStatusEl.innerHTML = '&nbsp;'; }
                            else if (result !== null) { advStatusEl.className = 'fb-adv-status fb-adv-ok'; advStatusEl.textContent = `✓  ₱ ${result.toFixed(2)}`; }
                            else { advStatusEl.className = 'fb-adv-status fb-adv-err'; advStatusEl.textContent = '✗  Invalid formula'; }
                        }
                        const summaryEl = document.getElementById('fbSummary' + id);
                        if (summaryEl) summaryEl.textContent = s.advFormula || '—';
                    } else {
                        const sum = s.components.reduce((acc, c) => acc + W * H * (c.price || 0), 0);
                        basePrice = sum * (s.outerMult || 1);
                        s.components.forEach((c, ci) => {
                            const subEl = document.getElementById('fbCompSub_' + id + '_' + ci);
                            if (subEl) subEl.textContent = '= ₱' + (W * H * (c.price || 0)).toFixed(2);
                        });
                        const summaryEl = document.getElementById('fbSummary' + id);
                        if (summaryEl) {
                            const parts = s.components.map(c => `(${W}×${H}×${c.price||0})`).join('+');
                            summaryEl.textContent = `${parts}${s.outerMult!==1?` × ${s.outerMult}`:''} = ₱ ${basePrice.toFixed(2)}`;
                        }
                    }

                    let addonTotal = 0;
                    wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                        const ap = parseFloat(tag.querySelector('.addon-price')?.value) || 0;
                        const aq = parseFloat(tag.querySelector('.addon-qty')?.value)   || 0;
                        addonTotal += ap * aq;
                    });

                    const unitPrice = basePrice + addonTotal;
                    const subtotal  = unitPrice * qty;
                    const priceField = row.querySelector('input.price');
                    if (priceField) priceField.value = unitPrice > 0 ? unitPrice.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2}) : '';
                    const totalField = row.querySelector('.rowTotalAmount');
                    if (totalField) totalField.value = subtotal.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
                    grandTotal += subtotal;
                });

                // Fixed price items in groups
                document.querySelectorAll('.qg-items .item-wrapper[id^="outsource"]').forEach(wrapper => {
                    const row = wrapper.querySelector('.item-row');
                    if (!row) return;
                    const basePrice = parseFloat(wrapper.querySelector('input.outsourceBase')?.value) || 0;
                    const qty = parseFloat(row.querySelector('input.qty')?.value) || 0;
                    const mults = [];
                    wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value)||1));
                    const unitPrice = mults.length > 0 ? mults.reduce((acc,m)=>acc*m, basePrice) : basePrice;
                    const unitPriceRounded = Math.round(unitPrice*100)/100;
                    const subtotal = unitPriceRounded * qty;
                    const priceEl = row.querySelector('input.price');
                    if (priceEl) priceEl.value = unitPriceRounded > 0 ? unitPriceRounded.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '';
                    const totalEl = row.querySelector('.rowTotalAmount');
                    if (totalEl) totalEl.value = subtotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
                    grandTotal += subtotal;
                });

                // Flat rate items in groups
                document.querySelectorAll('.qg-items .flat-item-row').forEach(row => {
                    const price    = parseFloat(row.querySelector('input.flatPrice')?.value) || 0;
                    const subtotal = price; // qty is always 1 for grouped flat rate
                    grandTotal += subtotal;
                });
            }

            document.getElementById('total').textContent =
                '₱ ' + grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            /* ── Discount ── */
            const discType    = document.getElementById('discountType')?.value || 'none';
            const discValEl   = document.getElementById('discountValue');
            const discSuffix  = document.getElementById('discountValueSuffix');
            if (discValEl)  discValEl.style.display  = (discType !== 'none') ? '' : 'none';
            if (discSuffix) {
                discSuffix.style.display = (discType !== 'none') ? '' : 'none';
                discSuffix.textContent   = discType === 'percent' ? '%' : '';
            }
            let discountAmt = 0;
            if (discType !== 'none' && discValEl) {
                const raw = parseFloat(discValEl.value) || 0;
                discountAmt = discType === 'percent'
                    ? grandTotal * Math.min(raw, 100) / 100
                    : Math.min(raw, grandTotal);
            }
            discountAmt      = Math.round(discountAmt * 100) / 100;
            const hasDiscount = discountAmt > 0;
            const vatChecked  = document.getElementById('includeVatCheck')?.checked;
            const finalTotal  = Math.round(Math.max(grandTotal - discountAmt, 0) * 100) / 100;
            const fmt = n => '₱ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // Subtotal (pre-discount) — show when discount or VAT active
            const subtotalRow  = document.getElementById('subtotalRow');
            const subtotalDisp = document.getElementById('subtotalDisplay');
            if (subtotalRow)  subtotalRow.style.display  = (hasDiscount || vatChecked) ? '' : 'none';
            if (subtotalDisp) subtotalDisp.textContent   = fmt(grandTotal);

            // Less Discount
            const discRow     = document.getElementById('discountRow');
            const discDisplay = document.getElementById('discountDisplay');
            if (discRow)     discRow.style.display     = hasDiscount ? '' : 'none';
            if (discDisplay) discDisplay.textContent   = '− ₱ ' + discountAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            // Discounted Price — show when discount active
            const discPriceRow  = document.getElementById('discountedPriceRow');
            const discPriceDisp = document.getElementById('discountedPriceDisplay');
            if (discPriceRow)  discPriceRow.style.display  = hasDiscount ? '' : 'none';
            if (discPriceDisp) discPriceDisp.textContent   = fmt(finalTotal);

            // VAT (12% incl.) — extracted from finalTotal, shown when VAT checked
            const vatRow  = document.getElementById('vatBreakdownRow');
            const vatAmt  = document.getElementById('vatAmount');
            const vatBase = document.getElementById('vatBaseAmount');
            if (vatRow) vatRow.style.display = vatChecked ? '' : 'none';
            if (vatChecked) {
                const vat = Math.round((finalTotal - finalTotal / 1.12) * 100) / 100;
                if (vatAmt)  vatAmt.textContent  = fmt(vat);
                // Was previously stuck at the static "₱ 0.00" placeholder —
                // never actually got wired up. Amount before VAT = finalTotal
                // minus the VAT just extracted above (same figure the PDF's
                // "Sub Total Vat Ex" row shows).
                if (vatBase) vatBase.textContent = fmt(finalTotal - vat);
            }

            /* ── Grand Total ── */
            document.getElementById('total').textContent = fmt(finalTotal);

            const vatExChecked = document.getElementById('vatExclusiveCheck')?.checked;
            const gtLabel = document.getElementById('grandTotalLabel');
            if (gtLabel) gtLabel.textContent = vatExChecked ? 'Grand Total (VAT Ex):' : 'Grand Total:';
            } finally {
                _calculatingTotals = false;
            }
        }

        /* ════════════════════════════════════════
           SNAPSHOT: captureSnapshot / restoreSnapshot
           Updated to persist visual builder state.
        ════════════════════════════════════════ */
        function _captureSnapshotV2() {
            const items = [];
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const idMatch = wrapper.id.match(/^item(\d+)$/);
                if (!idMatch) return;
                const id  = parseInt(idMatch[1]);
                const s   = itemState[id] || {};
                const row = wrapper.querySelector('.item-row');

                // Capture add-ons
                const addons = [];
                wrapper.querySelectorAll('.addon-tag').forEach(tag => {
                    addons.push({
                        desc:  tag.querySelector('.addon-desc').value,
                        price: parseFloat(tag.querySelector('.addon-price').value) || 0,
                        qty:   parseFloat(tag.querySelector('.addon-qty').value)   || 1
                    });
                });

                items.push({
                    material:           row.querySelector('.material').value,
                    sizeW:              row.querySelector('input.sizeW').value,
                    sizeH:              row.querySelector('input.sizeH').value,
                    sizeUnit:           row.querySelector('.sizeUnit').value,
                    qty:                row.querySelector('input.qty').value,
                    computedUnitPrice:  row.querySelector('input.price').value,
                    addons,
                    // Visual builder state
                    fbMode:       s.mode       || 'simple',
                    fbComponents: s.components || [{ price: 0, mult: 1 }],
                    fbOuterMult:  s.outerMult  || 1,
                    fbAdvFormula: s.advFormula || '',
                    // Fixed Price tab state
                    fixedFormula:     s.fixedFormula     || '',
                    fixedMults:       s.fixedMults       || [],
                    fixedManualPrice: s.fixedManualPrice || 0,
                    // Reference images — server resolves any {token} entries to
                    // a permanent {path} on Save; {path} entries are passed
                    // through unchanged (see resolveItemImages in server.js).
                    images: (s.images || []).map(img => ({ token: img.token, path: img.path, filename: img.filename, mimeType: img.mimeType })),
                    // Legacy compat fields
                    multipliers:  [],
                    isManual:     s.mode === 'adv',
                    manualFormula: s.mode === 'adv' ? (s.advFormula || '') : ''
                });
            });

            const flatRateItems = [];
            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                flatRateItems.push({
                    material:  row.querySelector('.material').value,
                    flatPrice: row.querySelector('input.flatPrice').value,
                    qty:       row.querySelector('input.qty').value,
                    computedUnitPrice: row.querySelector('input.flatPrice').value
                });
            });

            const outsourceItems = [];
            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row  = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                outsourceItems.push({
                    material:   row.querySelector('.material').value,
                    sizeW:      row.querySelector('input.sizeW').value,
                    sizeH:      row.querySelector('input.sizeH').value,
                    sizeUnit:   row.querySelector('.sizeUnit').value,
                    basePrice:  wrapper.querySelector('input.outsourceBase').value,
                    multipliers: mults,
                    computedUnitPrice: row.querySelector('input.price').value,
                    qty:        row.querySelector('input.qty').value
                });
            });

            const now = new Date().toISOString();
            return {
                controlNumber: currentControlNumber,
                revisions:     currentRevision,
                createdAt:     now,
                lastSaved:     now,
                isGrouped:     _isGroupedMode,
                quoteGroups:   _isGroupedMode ? collectQuoteGroups() : [],
                company:       document.getElementById('company').value,
                address:       document.getElementById('address').value,
                tin:           document.getElementById('tin').value,
                attentionTo:   document.getElementById('attentionTo').value,
                date:          document.getElementById('date').value,
                tel:           document.getElementById('tel').value,
                leadTime:      document.getElementById('leadTime').value,
                projectName:   document.getElementById('projectName').value,
                paymentTerms:  getPaymentTerms(),
                salesName:     document.getElementById('salesName').value,
                salesContact:  document.getElementById('salesContact').value,
                salesEmail:    document.getElementById('salesEmail').value,
                salesPosition: document.getElementById('salesPosition').value,
                bankDetails:   document.getElementById('bankDetailsSelect')?.value || '',
                includeVat:    document.getElementById('includeVatCheck')?.checked || false,
                vatExclusive:  document.getElementById('vatExclusiveCheck')?.checked || false,
                vatExAuto:     document.getElementById('vatExAutoCheck')?.checked || false,
                includeImageRef: hasAnyReferenceImages(),
                discountType:  document.getElementById('discountType')?.value || 'none',
                discountValue: parseFloat(document.getElementById('discountValue')?.value) || 0,
                items,
                flatRateItems,
                outsourceItems
            };
        }


                /* ═══════════════════════════════════════════════════════
           FIXED PRICE ITEM BUILDER
        ═══════════════════════════════════════════════════════ */

        function addOutsourceItem() {
            outsourceCount++;
            const id = outsourceCount;

            const wrapper = document.createElement('div');
            wrapper.className = 'item-wrapper';
            wrapper.id = 'outsource' + id;

            // Main row (same columns as regular items)
            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = `
                <textarea placeholder="Description" class="material" rows="1" style="resize:none;overflow:hidden;"></textarea>
                <div class="size-cell">
                    <div class="size-split">
                        <input type="number" step="any" min="0" placeholder="W" class="sizeW">
                        <span>×</span>
                        <input type="number" step="any" min="0" placeholder="H" class="sizeH">
                    </div>
                </div>
                ${uomSelectHtml('in')}
                <input type="text" class="price" readonly value="" style="text-align:right;background:#fff8f3;color:#c0392b;font-weight:bold;border:1px solid #f0c09a;cursor:default;">
                <input type="number" min="1" value="1" class="qty" style="text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00" style="background:#f8f9fa;font-weight:bold;border:1px solid #ccd1d1;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeOutsourceItem(${id})">✕</button>
            `;

            // Controls row: base price + multipliers
            const ctrlRow = document.createElement('div');
            ctrlRow.className = 'multiplier-row';
            ctrlRow.innerHTML = `
                <div class="outsource-base-row">
                    <label><span class="fixedprice-badge">FIXED PRICE</span> Base Price:</label>
                    <input type="number" step="any" min="0" placeholder="e.g. 500" class="outsourceBase">
                    <span style="font-size:12px;color:#999;">then add multipliers →</span>
                </div>
                <div>
                    <div class="multiplier-tags" id="outMultTags${id}"></div>
                    <button type="button" class="btn-add-outsource-mult" onclick="addOutsourceMult(${id})">× Add Multiplier</button>
                    <div class="outsource-formula" id="outFormula${id}">Base Price = Unit Price</div>
                </div>
            `;

            wrapper.appendChild(row);
            wrapper.appendChild(ctrlRow);
            document.getElementById('outsourceItems').appendChild(wrapper);
            calculateTotals();
        }

        function addOutsourceMult(itemId) {
            if (!outMultCounters[itemId]) outMultCounters[itemId] = 0;
            outMultCounters[itemId]++;
            const mNum = outMultCounters[itemId];
            const container = document.getElementById('outMultTags' + itemId);
            const tag = document.createElement('div');
            tag.className = 'multiplier-tag';
            tag.id = `outMult_${itemId}_${mNum}`;
            tag.innerHTML = `
                <label>×${mNum}</label>
                <input type="number" step="any" min="0" value="1" class="outMultVal" oninput="calculateTotals()">
                <button type="button" class="remove-mult" onclick="removeOutsourceMult(${itemId}, ${mNum})" title="Remove">×</button>
            `;
            container.appendChild(tag);
            calculateTotals();
        }

        function removeOutsourceMult(itemId, mNum) {
            const tag = document.getElementById(`outMult_${itemId}_${mNum}`);
            if (tag) tag.remove();
            document.getElementById('outMultTags' + itemId)
                .querySelectorAll('.multiplier-tag')
                .forEach((t, i) => { t.querySelector('label').textContent = '×' + (i + 1); });
            calculateTotals();
        }

        function removeOutsourceItem(id) {
            document.getElementById('outsource' + id).remove();
            calculateTotals();
        }

        /* ═══════════════════════════════════════════════════════
           FLAT RATE ITEM BUILDER
        ═══════════════════════════════════════════════════════ */
        let flatRateCount = 0;

        document.getElementById('flatRateItems').addEventListener('input', function(e) {
            if (
                e.target.classList.contains('flatPrice') ||
                e.target.classList.contains('qty')
            ) { calculateTotals(); }
        });

        function addFlatRateItem() {
            flatRateCount++;
            const id = flatRateCount;
            const row = document.createElement('div');
            row.className = 'flat-item-row';
            row.id = 'flatRate' + id;
            row.innerHTML = `
                <textarea placeholder="e.g. Installation, Delivery" class="material" rows="1"
                    style="width:100%;min-height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;resize:none;overflow:hidden;"></textarea>
                <input type="number" step="any" min="0" placeholder="0.00" class="flatPrice"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;text-align:right;">
                <input type="number" min="1" value="1" class="qty"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;text-align:center;">
                <input type="text" class="rowTotalAmount" readonly value="0.00"
                    style="width:100%;height:38px;padding:8px 10px;border:1px solid #ccd1d1;border-radius:4px;font-size:14px;background:#f8f9fa;font-weight:bold;text-align:right;">
                <button type="button" class="btn-remove" onclick="removeFlatRateItem(${id})">✕</button>
            `;
            document.getElementById('flatRateItems').appendChild(row);
            calculateTotals();
        }

        function removeFlatRateItem(id) {
            document.getElementById('flatRate' + id).remove();
            calculateTotals();
        }

        async function devResetSerials() {
            if (!confirm('Reset ALL serial counters back to zero?\nNext quote will start from Q26_0001 again.')) return;
            try {
                const r = await fetch(`${API}/api/serials`, { method: 'DELETE' });
                if (r.ok) {
                    await initControlNumber();
                    alert('Serials reset! Next quote will be Q26_0001.');
                } else {
                    alert('Error resetting serials.');
                }
            } catch {
                alert('Server error.');
            }
        }


        /* Block Enter key from submitting — only allow if submit button is focused (via Tab) */
        document.getElementById('form').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const active = document.activeElement;
                const isSubmitBtn = active && active.type === 'submit';
                if (!isSubmitBtn) e.preventDefault();
            }
        });

        /* ── Dev: select-to-delete helpers ── */
        function updateDeleteCount() {
            const checked = document.querySelectorAll('.history-checkbox:checked');
            const btn = document.getElementById('btnDeleteSelected');
            const countEl = document.getElementById('deleteSelCount');
            const n = checked.length;
            if (btn) btn.disabled = n === 0;
            if (countEl) countEl.textContent = n > 0 ? `${n} selected` : '';
            const all = document.querySelectorAll('.history-checkbox');
            const selAll = document.getElementById('selectAllCheck');
            if (selAll) selAll.checked = all.length > 0 && checked.length === all.length;
            document.querySelectorAll('.history-item').forEach(item => {
                const cb = item.querySelector('.history-checkbox');
                item.classList.toggle('selected', cb ? cb.checked : false);
            });
        }

        function toggleSelectAll(masterCb) {
            document.querySelectorAll('.history-checkbox').forEach(cb => cb.checked = masterCb.checked);
            updateDeleteCount();
        }

        async function deleteSelected() {
            const checked = Array.from(document.querySelectorAll('.history-checkbox:checked'));
            if (!checked.length) return;
            if (!confirm(`Delete ${checked.length} quote${checked.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
            for (const cb of checked) await deleteQuoteFromServer(cb.dataset.key);
            // Reset serials for any company that now has no quotes left
            await syncSerialsAfterDelete();
            // Also refresh peekNext so the control number display updates
            const companyVal = document.getElementById('company').value;
            if (companyVal) {
                const serial = await peekNextSerial(companyVal);
                currentControlNumber = buildControlNumber(serial);
                currentRevision = 0;
                refreshCtrlDisplay();
            }
            const selAll = document.getElementById('selectAllCheck');
            if (selAll) selAll.checked = false;
            const countEl = document.getElementById('deleteSelCount');
            if (countEl) countEl.textContent = '';
            const btn = document.getElementById('btnDeleteSelected');
            if (btn) btn.disabled = true;
            renderHistory(_historyViewMode);
        }


        /* ── Ctrl+Enter adds line break in description textareas; auto-resize ── */
        document.getElementById('form').addEventListener('keydown', function(e) {
            if (e.target.classList.contains('material') && e.target.tagName === 'TEXTAREA') {
                if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    const ta = e.target;
                    const start = ta.selectionStart;
                    const end   = ta.selectionEnd;
                    ta.value = ta.value.slice(0, start) + '\n' + ta.value.slice(end);
                    ta.selectionStart = ta.selectionEnd = start + 1;
                    autoResizeTextarea(ta);
                } else if (e.key === 'Enter' && !e.ctrlKey) {
                    e.preventDefault();
                }
            }
        });

        function autoResizeTextarea(ta) {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
        }

        document.getElementById('form').addEventListener('input', function(e) {
            if (e.target.classList.contains('material') && e.target.tagName === 'TEXTAREA') {
                autoResizeTextarea(e.target);
            }
        });

        // ── Dirty-tracking for loaded quotes ──────────────────────────────────
        // Any real keystroke/selection change, or clicking an add/remove-item
        // button, means the loaded quote no longer matches its saved PDF.
        document.getElementById('form').addEventListener('input',  markLoadedQuoteDirty);
        document.getElementById('form').addEventListener('change', markLoadedQuoteDirty);
        document.getElementById('form').addEventListener('click', function(e) {
            if (e.target.closest(
                '.btn-add, .btn-add-outsource, .btn-add-flat, .btn-remove, ' +
                '.btn-add-mult, .btn-add-outsource-mult, .btn-add-refimg, ' +
                '.btn-add-addon, .btn-clear-section, .btn-toggle-manual'
            )) {
                markLoadedQuoteDirty();
            }
        });

        document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btnGen = document.getElementById('btnGenerateQuote');
            // Button is already showing "Open PDF" from a previous generate in
            // this same session — a re-click means "open it", not "regenerate".
            if (btnGen && btnGen.dataset.state === 'done' && _lastGeneratedPdfInfo) {
                await openGeneratedPdf(_lastGeneratedPdfInfo);
                return;
            }
            document.getElementById('loading').classList.add('show');
            await _submitQuote({ switchBtn: btnGen });
            document.getElementById('loading').classList.remove('show');
        });

        async function _submitQuote(opts = {}) {
            const switchBtn = opts.switchBtn || null;
            const companyVal = document.getElementById('company').value;

            const bankSel = document.getElementById('bankDetailsSelect');
            if (!bankSel || !bankSel.value) {
                alert('Please select at least one payment detail to include in the PDF.');
                document.getElementById('bankDropdownBtn') && (document.getElementById('bankDropdownBtn').style.borderColor = '#e74c3c');
                return;
            }

            const inHouseCount = document.querySelectorAll('#items .item-wrapper').length;
            if (!_isGroupedMode && inHouseCount === 0) {
                const proceed = confirm('No In-House Items added to this quote.\n\nProceed and generate the PDF with Outsource Items only?');
                if (!proceed) return;
            }

            let useStoreKey, useRevision;
            if (opts.forceStoreKey !== undefined) {
                useStoreKey = opts.forceStoreKey;
                useRevision = opts.forceRevision;
                currentRevision = useRevision;
            } else {
                const db = await loadDB(true);
                const currentCompanyKey = companyKey(companyVal);
                let baseKey;
                let companyChanged = false;

                if (_loadedStoreKey) {
                    const parts = _loadedStoreKey.split('|');
                    const loadedCompanyKey = parts[1];
                    if (loadedCompanyKey !== currentCompanyKey) {
                        // User edited the Company field after loading a previous quote.
                        // This is now effectively a DIFFERENT company — must get its own
                        // control number, not silently continue the old company's revision chain.
                        companyChanged = true;
                    } else {
                        baseKey = parts[0] + '|' + parts[1];
                    }
                }

                if (!_loadedStoreKey || companyChanged) {
                    baseKey = currentControlNumber + '|' + currentCompanyKey;
                }

                const existingRevs = Object.keys(db).filter(k => k.startsWith(baseKey + '|rev'));
                // Only continue an existing revision chain if we did NOT just detect a company change.
                if (existingRevs.length > 0 && !companyChanged) {
                    const maxRev = Math.max(...existingRevs.map(k => { const m = k.match(/\|rev(\d+)$/); return m ? parseInt(m[1]) : 0; }));
                    currentRevision = maxRev + 1;
                } else {
                    // Fresh company (or company changed) — always COMMIT a real serial,
                    // never reuse a stale peeked value.
                    try {
                        const serial = await commitSerial(companyVal);
                        currentControlNumber = buildControlNumber(serial);
                    } catch (err) {
                        alert('Could not generate a control number: ' + err.message);
                        return;
                    }
                    currentRevision = 0;
                    baseKey = currentControlNumber + '|' + currentCompanyKey;
                }
                useStoreKey = baseKey + '|rev' + currentRevision;
                useRevision = currentRevision;
                _loadedStoreKey = useStoreKey;
            }

            const snap = _captureSnapshotV2();
            snap.revisions = useRevision;
            snap.lastSaved = new Date().toISOString();
            await saveQuote(useStoreKey, snap);
            refreshCtrlDisplay();

            const data = {
                controlNumber:  currentControlNumber,
                revisionNumber: currentRevision,
                company:    companyVal,
                address:    document.getElementById('address').value,
                tin:        document.getElementById('tin').value,
                attentionTo:document.getElementById('attentionTo').value,
                date:       document.getElementById('date').value,
                tel:        document.getElementById('tel').value,
                leadTime:   document.getElementById('leadTime').value,
                projectName:document.getElementById('projectName').value,
                paymentTerms: getPaymentTerms(),
                salesName:    document.getElementById('salesName').value,
                salesContact: document.getElementById('salesContact').value,
                salesEmail:   document.getElementById('salesEmail').value,
                salesPosition: document.getElementById('salesPosition').value,
                salesSignature: (_currentProfile && _currentProfile.signature) || null,
                storeKey:     _loadedStoreKey,
                isGrouped:    _isGroupedMode,
                quoteGroups:  _isGroupedMode ? collectQuoteGroups() : [],
                items: [],
                outsourceItems: [],
                flatRateItems: [],
                includeVat: document.getElementById('includeVatCheck')?.checked || false,
                vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false,
                vatExAuto: document.getElementById('vatExAutoCheck')?.checked || false,
                discountType:  document.getElementById('discountType')?.value || 'none',
                discountValue: parseFloat(document.getElementById('discountValue')?.value) || 0,
                bankDetails: document.getElementById('bankDetailsSelect')?.value || 'all',
                includeImageRef: hasAnyReferenceImages()
            };

            if (!_isGroupedMode) {
            document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                const row    = wrapper.querySelector('.item-row');
                const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                const idMatch = wrapper.id.match(/^item(\d+)$/);
                const images  = (idMatch && itemState[idMatch[1]] && itemState[idMatch[1]].images) || [];
                data.items.push({
                    material:  row.querySelector('.material').value,
                    sizeW:     row.querySelector('input.sizeW').value || '',
                    sizeH:     row.querySelector('input.sizeH').value || '',
                    sizeUnit:  row.querySelector('.sizeUnit').value,
                    unitPrice: computedUnitPrice,
                    quantity:  row.querySelector('input.qty').value || 0,
                    images
                });
            });

            document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                const row  = wrapper.querySelector('.item-row');
                const mults = [];
                wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                const basePrice = parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0;
                const computedUnitPrice = row.querySelector('input.price').value.replace(/,/g, '') || 0;
                data.outsourceItems.push({
                    material:    row.querySelector('.material').value,
                    sizeW:       row.querySelector('input.sizeW').value || '',
                    sizeH:       row.querySelector('input.sizeH').value || '',
                    sizeUnit:    row.querySelector('.sizeUnit').value,
                    basePrice,
                    multipliers: mults,
                    unitPrice:   computedUnitPrice,
                    quantity:    row.querySelector('input.qty').value || 0
                });
            });

            document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                const price = row.querySelector('input.flatPrice').value || 0;
                data.flatRateItems.push({
                    material:  row.querySelector('.material').value,
                    unitPrice: String(price).replace(/,/g, ''),
                    quantity:  row.querySelector('input.qty').value || 0
                });
            });
            } // end !_isGroupedMode

            if (switchBtn) setGenSwitchState(switchBtn, 'loading');
            try {
                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(errText || 'Failed to generate PDF');
                }

                // Get filename from header
                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `${data.controlNumber}_${data.company}.pdf`;

                const blob = await response.blob();

                // Get saved PDF path from server header
                const pdfPath = response.headers.get('X-PDF-Path') || null;
                // Server only sets this when the Drive write actually failed — see
                // server.js. Previously X-PDF-Path was set unconditionally, so this
                // failure was invisible: the UI said "saved to Drive" even when it
                // wasn't, and the quote silently ended up with no pdfPath in history.
                const rawWarning = response.headers.get('X-PDF-Save-Warning');
                const driveWarning = rawWarning ? decodeURIComponent(rawWarning) : null;
                const saveFailed = !pdfPath && driveWarning;

                if (switchBtn) {
                    _lastGeneratedPdfInfo = { pdfPath, blob, filename };
                    setGenSwitchState(switchBtn, 'done');
                }

                const notice = document.createElement('div');
                notice.style.cssText = `position:fixed;bottom:24px;right:24px;background:${saveFailed ? '#e74c3c' : '#2ecc71'};color:white;padding:14px 20px;border-radius:8px;font-size:14px;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:9999;max-width:360px;`;
                notice.innerHTML = saveFailed ? `
                    ⚠️ PDF generated, but NOT saved to Drive!<br>
                    <span style="font-size:12px;font-weight:normal;opacity:0.95;">${filename}<br>It won't show up in History or the Admin dashboard. Download it now.</span>
                    <div style="display:flex;gap:8px;margin-top:10px;">
                        <button id="noticeOpenBtn" style="flex:1;background:white;color:#c0392b;border:none;border-radius:6px;padding:7px 10px;font-size:13px;font-weight:bold;cursor:pointer;">📄 Open File</button>
                    </div>` : `
                    PDF saved to Drive!<br>
                    <span style="font-size:12px;font-weight:normal;opacity:0.9;">${filename}</span>
                    <div style="display:flex;gap:8px;margin-top:10px;">
                        <button id="noticeOpenBtn" style="flex:1;background:white;color:#2c3e50;border:none;border-radius:6px;padding:7px 10px;font-size:13px;font-weight:bold;cursor:pointer;">📄 Open File</button>
                        <button id="noticePrintBtn" style="flex:1;background:white;color:#27ae60;border:none;border-radius:6px;padding:7px 10px;font-size:13px;font-weight:bold;cursor:pointer;">🖨️ Print Direct</button>
                    </div>`;
                document.body.appendChild(notice);

                // Open File — streams the actual saved Drive file to browser
                notice.querySelector('#noticeOpenBtn').addEventListener('click', async function() {
                    if (pdfPath) {
                        await openViewFile(pdfPath);
                    } else {
                        const url = window.URL.createObjectURL(new File([blob], filename, { type: 'application/pdf' }));
                        window.open(url, '_blank');
                        setTimeout(() => window.URL.revokeObjectURL(url), 30000);
                    }
                });

                // Print Direct (only offered when the Drive copy actually exists).
                // handleHistoryPrint() now opens the Print Options modal itself
                // (copies/pages) instead of a plain confirm() -- same modal the
                // History list's 🖨️ button uses.
                if (!saveFailed) {
                    notice.querySelector('#noticePrintBtn').addEventListener('click', function() {
                        if (pdfPath) {
                            const fakeBtn = document.createElement('button');
                            fakeBtn.dataset.pdfPath = pdfPath;
                            fakeBtn.dataset.filename = filename;
                            handleHistoryPrint(fakeBtn);
                        } else {
                            alert('PDF path not available. Try printing from History instead.');
                        }
                    });
                }
                setTimeout(() => notice.remove(), saveFailed ? 30000 : 15000);

                return { pdfPath, blob, filename };
            } catch (err) {
                if (switchBtn) setGenSwitchState(switchBtn, 'idle');
                alert(err.message);
                return null;
            }
        }

        /* ═══════════════════════════════════════════════════════
           DEV TOOLS — only visible with ?dev=1 in the URL.
           Lets you skip manually filling the form and preview a
           PDF without burning a serial number, saving to history,
           or writing a file into the shared Drive folder.
        ═══════════════════════════════════════════════════════ */
        function isDevMode() {
            // Never treat real logged-in users as dev mode
            try {
                const s = sessionStorage.getItem('lp_session');
                if (s) { const p = JSON.parse(s); if (p && p.id) return false; }
            } catch {}
            return new URLSearchParams(window.location.search).get('dev') === '1'
                || sessionStorage.getItem('lp_dev_mode') === '1';
        }

        if (isDevMode()) {
            document.getElementById('devTools').classList.add('show');
        }

        function fillSampleData() {
            document.getElementById('salesName').value     = 'Juan Dela Cruz';
            document.getElementById('salesContact').value  = '+63912-345-6789';
            document.getElementById('salesEmail').value    = 'juan.delacruz@launchpadph.com';
            document.getElementById('salesPosition').value = 'Account Manager';
            document.getElementById('company').value       = 'Sample Company Inc.';
            document.getElementById('address').value       = '123 Sample St., Quezon City';
            document.getElementById('tin').value            = '000-000-000-000';
            document.getElementById('attentionTo').value    = 'Jane Doe';
            document.getElementById('tel').value            = '8123-4567';
            document.getElementById('projectName').value    = 'Sample Project';
            if (!document.getElementById('leadTime').value) document.getElementById('leadTime').value = '0';

            // Items section starts empty, so always add a fresh row
            addItem();
            const wrapper = document.querySelector('#items .item-wrapper:last-child');
            const row = wrapper.querySelector('.item-row');
            row.querySelector('.material').value  = 'Tarpaulin Print';
            row.querySelector('input.sizeW').value     = '4';
            row.querySelector('input.sizeH').value     = '6';
            row.querySelector('.sizeUnit').value  = 'ft';
            row.querySelector('input.qty').value       = '2';

            calculateTotals();
        }

        /* ── Preview Quote (no save) — available to all users ── */
        async function previewCurrentQuote() {
            // Open synchronously first (still inside the click's user-gesture window),
            // then redirect once the PDF blob is ready — window.open() called AFTER an
            // await gets silently blocked by popup blockers in most browsers.
            const newWin = window.open('', '_blank');
            document.getElementById('loading').classList.add('show');
            try {
                const data = {
                    controlNumber:  currentControlNumber,
                    revisionNumber: currentRevision,
                    company:      document.getElementById('company').value,
                    address:      document.getElementById('address').value,
                    tin:          document.getElementById('tin').value,
                    attentionTo:  document.getElementById('attentionTo').value,
                    date:         document.getElementById('date').value,
                    tel:          document.getElementById('tel').value,
                    leadTime:     document.getElementById('leadTime').value,
                    projectName:  document.getElementById('projectName').value,
                    paymentTerms: getPaymentTerms(),
                    salesName:    document.getElementById('salesName').value,
                    salesContact: document.getElementById('salesContact').value,
                    salesEmail:   document.getElementById('salesEmail').value,
                    salesPosition: document.getElementById('salesPosition').value,
                    salesSignature: (_currentProfile && _currentProfile.signature) || null,
                    skipDriveSave: true,
                    isGrouped:     _isGroupedMode,
                    quoteGroups:   _isGroupedMode ? collectQuoteGroups() : [],
                    items: [],
                    outsourceItems: [],
                    flatRateItems: [],
                    includeVat: document.getElementById('includeVatCheck')?.checked || false,
                    vatExclusive: document.getElementById('vatExclusiveCheck')?.checked || false,
                    vatExAuto: document.getElementById('vatExAutoCheck')?.checked || false,
                    discountType:  document.getElementById('discountType')?.value || 'none',
                    discountValue: parseFloat(document.getElementById('discountValue')?.value) || 0,
                    bankDetails: document.getElementById('bankDetailsSelect')?.value || 'all',
                    includeImageRef: hasAnyReferenceImages()
                };

                if (!_isGroupedMode) {
                document.querySelectorAll('#items .item-wrapper').forEach(wrapper => {
                    const row = wrapper.querySelector('.item-row');
                    const idMatch = wrapper.id.match(/^item(\d+)$/);
                    const images  = (idMatch && itemState[idMatch[1]] && itemState[idMatch[1]].images) || [];
                    data.items.push({
                        material:  row.querySelector('.material').value,
                        sizeW:     row.querySelector('input.sizeW').value || '',
                        sizeH:     row.querySelector('input.sizeH').value || '',
                        sizeUnit:  row.querySelector('.sizeUnit').value,
                        unitPrice: row.querySelector('input.price').value.replace(/,/g, '') || 0,
                        quantity:  row.querySelector('input.qty').value || 0,
                        images
                    });
                });

                document.querySelectorAll('#outsourceItems .item-wrapper').forEach(wrapper => {
                    const row = wrapper.querySelector('.item-row');
                    const mults = [];
                    wrapper.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value) || 1));
                    data.outsourceItems.push({
                        material:    row.querySelector('.material').value,
                        sizeW:       row.querySelector('input.sizeW').value || '',
                        sizeH:       row.querySelector('input.sizeH').value || '',
                        sizeUnit:    row.querySelector('.sizeUnit').value,
                        basePrice:   parseFloat(wrapper.querySelector('input.outsourceBase').value) || 0,
                        multipliers: mults,
                        unitPrice:   row.querySelector('input.price').value.replace(/,/g, '') || 0,
                        quantity:    row.querySelector('input.qty').value || 0
                    });
                });

                document.querySelectorAll('#flatRateItems .flat-item-row').forEach(row => {
                    data.flatRateItems.push({
                        material:  row.querySelector('.material').value,
                        unitPrice: String(row.querySelector('input.flatPrice').value || 0).replace(/,/g, ''),
                        quantity:  row.querySelector('input.qty').value || 0
                    });
                });
                } // end !_isGroupedMode

                const hasGroupedItems = _isGroupedMode && data.quoteGroups.some(g => g.items && g.items.length > 0);
                if (!hasGroupedItems && !data.items.length && !data.outsourceItems.length && !data.flatRateItems.length) {
                    alert('Add at least one item before previewing.');
                    return;
                }

                const response = await fetch(`${API}/api/generate-quotation`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                if (!response.ok) throw new Error(await response.text().catch(() => 'Failed to generate preview'));

                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/);
                const filename = match ? match[1] : `PREVIEW_${data.controlNumber}.pdf`;
                const blob = await response.blob();
                const url  = window.URL.createObjectURL(new File([blob], filename, { type: 'application/pdf' }));
                if (newWin) newWin.location.href = url; else window.open(url, '_blank');
                setTimeout(() => window.URL.revokeObjectURL(url), 30000);
            } catch (err) {
                if (newWin) newWin.close();
                alert(err.message);
            } finally {
                document.getElementById('loading').classList.remove('show');
            }
        }

        async function devGeneratePreview() { await previewCurrentQuote(); }

        /* ═══════════════════════════════════════════════════════
           GROUPED QUOTE MODE
        ═══════════════════════════════════════════════════════ */

        let _isGroupedMode = false;
        let _groupIdCounter = 0;

        function hasAnyItems() {
            const inhouse   = document.querySelectorAll('#items .item-row, #items .item-wrapper').length;
            const outsource = document.querySelectorAll('#outsourceItems .item-wrapper').length;
            const flatrate  = document.querySelectorAll('#flatRateItems .flat-item-row').length;
            const grouped   = document.querySelectorAll('#quoteGroups .quote-group-card').length;
            return inhouse > 0 || outsource > 0 || flatrate > 0 || grouped > 0;
        }

        function toggleGroupedMode() {
            if (hasAnyItems()) {
                document.getElementById('modeWarningModal').style.display = 'flex';
            } else {
                doModeSwitch();
            }
        }

        function cancelModeSwitch() {
            document.getElementById('modeWarningModal').style.display = 'none';
        }

        function confirmModeSwitch() {
            document.getElementById('modeWarningModal').style.display = 'none';
            doModeSwitch();
        }

        function doModeSwitch() {
            _isGroupedMode = !_isGroupedMode;

            // Clear all items
            document.getElementById('items').innerHTML = '';
            document.getElementById('outsourceItems').innerHTML = '';
            const _oSec = document.getElementById('outsourceSection'); if (_oSec) _oSec.style.display = 'none';
            document.getElementById('flatRateItems').innerHTML = '';
            document.getElementById('quoteGroups').innerHTML = '';
            _groupIdCounter = 0;
            calculateTotals();

            const stdMode  = document.getElementById('standardMode');
            const grpMode  = document.getElementById('groupedMode');
            const label    = document.getElementById('quoteModeLabel');
            const btn      = document.getElementById('btnToggleGrouped');

            if (_isGroupedMode) {
                stdMode.style.display = 'none';
                grpMode.style.display = '';
                label.textContent = 'Grouped Quote';
                label.style.color = '#4A90E2';
                label.style.fontWeight = 'bold';
                btn.textContent = 'Switch to Standard Quote';
                btn.style.background = '#636e72';
                addQuoteGroup(); // start with one group
            } else {
                stdMode.style.display = '';
                grpMode.style.display = 'none';
                label.textContent = 'Standard Quote';
                label.style.color = '#555';
                label.style.fontWeight = 'normal';
                btn.textContent = 'Switch to Grouped Quote';
                btn.style.background = '#4A90E2';
            }
        }

        function addQuoteGroup(opts = {}) {
            const gid  = ++_groupIdCounter;
            const name = opts.name || '';
            const card = document.createElement('div');
            card.className = 'quote-group-card';
            card.id = `qgcard-${gid}`;
            card.style.cssText = 'background:#f8f9fa;border:1px solid #dce3ed;border-radius:12px;margin-bottom:16px;overflow:hidden;';

            card.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#4A90E2;">
                    <input type="text" class="qg-name-input" value="${name.replace(/"/g,'&quot;')}"
                        placeholder="Group name (e.g. OPTION 1)"
                        oninput="calculateTotals()"
                        style="flex:1;border:none;background:rgba(255,255,255,0.2);color:white;font-size:15px;font-weight:bold;border-radius:6px;padding:6px 10px;outline:none;placeholder-color:rgba(255,255,255,0.7);">
                    <button type="button" onclick="removeQuoteGroup(${gid})"
                        style="background:rgba(255,255,255,0.2);border:none;color:white;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:18px;line-height:1;">✕</button>
                </div>
                <div style="padding:10px 14px 4px;">
                    <div class="item-header">
                        <span>Description</span><span>Size (W × H)</span><span>UOM</span>
                        <span style="text-align:right;">Unit Price</span>
                        <span style="text-align:center;">Qty</span>
                        <span style="text-align:right;">Subtotal</span>
                        <span></span>
                    </div>
                    <div class="item-container qg-items" id="qgitems-${gid}"></div>
                </div>
                <div style="display:flex;gap:8px;padding:8px 14px 12px;flex-wrap:wrap;">
                    <button type="button" class="btn btn-add" style="margin:0;" onclick="addGroupItem(${gid},'inhouse')">+ In-House Item</button>
                    <button type="button" class="btn btn-add-outsource" style="margin:0;" onclick="addGroupItem(${gid},'fixed')">+ Fixed Price Item</button>
                    <button type="button" class="btn btn-add-flat" style="margin:0;" onclick="addGroupItem(${gid},'flat')">+ Flat Rate Item</button>
                </div>`;

            document.getElementById('quoteGroups').appendChild(card);

            // Restore saved items if provided
            if (opts.items) {
                opts.items.forEach(it => {
                    if (it._type === 'fixed')  addGroupItem(gid, 'fixed', it);
                    else if (it._type === 'flat') addGroupItem(gid, 'flat', it);
                    else addGroupItem(gid, 'inhouse', it);
                });
            }
            return gid;
        }

        function removeQuoteGroup(gid) {
            const card = document.getElementById(`qgcard-${gid}`);
            if (card) card.remove();
            calculateTotals();
        }

        function addGroupItem(gid, type, saved = null) {
            const container = document.getElementById(`qgitems-${gid}`);
            if (!container) return;

            if (type === 'inhouse') {
                // addItem(opts) only understands its OWN unprefixed field
                // names (mode/components/outerMult/advFormula/.../images) —
                // it never reads material/sizeW/sizeH/qty/price from opts
                // (the standalone restoreSnapshot() loop fills those in
                // manually afterward, same as here). Grouped items are
                // stored with "fb"-prefixed names instead (fbMode/
                // fbComponents/fbOuterMult/fbAdvFormula — see
                // collectQuoteGroups()), to avoid colliding with the group's
                // own material/size/etc fields on the same object. Passing
                // `saved` straight through used to silently drop the Simple/
                // Advanced formula state entirely (opts.mode/opts.components
                // were always undefined since the real data sat under
                // opts.fbMode/opts.fbComponents instead) — items built with
                // the Fixed Price tab looked fine (those field names happen
                // to match unprefixed), but any Simple/Advanced-mode grouped
                // item came back as a blank "0.00, Simple mode" row on
                // reload. Remap the field names the same way restoreSnapshot()
                // already does for standalone items. Fixed 2026-07.
                addItem(saved ? {
                    mode:             saved.fbMode,
                    components:       saved.fbComponents,
                    outerMult:        saved.fbOuterMult,
                    advFormula:       saved.fbAdvFormula,
                    fixedFormula:     saved.fixedFormula,
                    fixedMults:       saved.fixedMults,
                    fixedManualPrice: saved.fixedManualPrice,
                    images:           saved.images,
                } : null);
                const id      = itemCount;
                const wrapper = document.getElementById('item' + id);
                if (wrapper) {
                    wrapper.dataset.gtype = 'inhouse';
                    if (saved) {
                        const row = wrapper.querySelector('.item-row');
                        row.querySelector('.material').value  = saved.material  || '';
                        row.querySelector('input.sizeW').value     = saved.sizeW     || '';
                        row.querySelector('input.sizeH').value     = saved.sizeH     || '';
                        row.querySelector('.sizeUnit').value  = normalizeUom(saved.sizeUnit);
                        row.querySelector('input.qty').value       = saved.qty       || 1;

                        // Legacy grouped items saved before formula-builder
                        // state was captured for groups (formula_json was
                        // hardcoded to '{}') have no fbMode/fbComponents to
                        // restore — addItem() above left itemState[id] at its
                        // default (Simple mode, 0 price), which
                        // calculateTotals() then uses to recompute price as
                        // 0, wiping the number that used to display. Fall
                        // back to Fixed Price mode using the last-known
                        // price, same as restoreSnapshot()'s standalone-item
                        // legacy handling — re-saving will capture real
                        // formula state going forward. Fixed 2026-07.
                        const isLegacy = !saved.fbMode && !saved.fbComponents;
                        const storedPrice = parseFloat(String(saved.unitPrice || saved.computedUnitPrice || 0).replace(/,/g,'')) || 0;
                        if (isLegacy && storedPrice > 0) {
                            itemState[id].mode             = 'fixed';
                            itemState[id].fixedManualPrice = storedPrice;
                            syncPanelFromState(id);
                            const pf = row.querySelector('input.price');
                            if (pf) { pf.value = storedPrice.toString(); pf.style.background='#fffbea'; pf.style.color='#7c5a00'; pf.style.cursor='text'; pf.oninput=function(){onPriceInput(id,this);}; }
                        }
                    }
                    container.appendChild(wrapper); // move from #items to group
                }
            } else if (type === 'fixed') {
                // addOutsourceItem() takes no parameters and never reads
                // `saved` — every restored grouped Fixed Price item lost its
                // material/size/base price/multipliers entirely (fixed
                // 2026-07). Mirrors the manual restore app.js's standalone
                // restoreSnapshot() already does for #outsourceItems.
                addOutsourceItem();
                const id      = outsourceCount;
                const wrapper = document.getElementById('outsource' + id);
                if (wrapper) {
                    wrapper.dataset.gtype = 'fixed';
                    if (saved) {
                        const row = wrapper.querySelector('.item-row');
                        row.querySelector('.material').value  = saved.material || '';
                        row.querySelector('input.sizeW').value     = saved.sizeW    || '';
                        row.querySelector('input.sizeH').value     = saved.sizeH    || '';
                        row.querySelector('.sizeUnit').value  = normalizeUom(saved.sizeUnit);
                        row.querySelector('input.qty').value       = saved.qty      || 1;
                        wrapper.querySelector('input.outsourceBase').value = saved.basePrice || '';
                        (saved.multipliers || []).forEach(v => {
                            addOutsourceMult(id);
                            const mNum = outMultCounters[id];
                            document.getElementById(`outMult_${id}_${mNum}`).querySelector('.outMultVal').value = v;
                        });
                    }
                    container.appendChild(wrapper); // move from #outsourceItems to group
                }
            } else if (type === 'flat') {
                flatRateCount++;
                const id  = flatRateCount;
                const row = document.createElement('div');
                row.className = 'flat-item-row';
                row.id = 'flatRate' + id;
                row.dataset.gtype = 'flat';
                const savedMaterial = saved?.material || '';
                const savedPrice    = saved?.flatPrice || saved?.unitPrice || 0;
                row.innerHTML = `
                    <textarea placeholder="e.g. Installation, Delivery" class="material" rows="1"
                        style="flex:1;min-height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;resize:none;overflow:hidden;"
                        oninput="calculateTotals()">${savedMaterial}</textarea>
                    <input type="number" step="any" min="0" placeholder="0.00" class="flatPrice"
                        value="${savedPrice}"
                        oninput="calculateTotals()"
                        style="width:140px;height:38px;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;text-align:right;">
                    <input type="hidden" class="qty" value="1">
                    <button type="button" onclick="this.closest('.flat-item-row').remove();calculateTotals();"
                        style="background:#e74c3c;border:none;color:white;border-radius:6px;width:34px;height:34px;font-size:16px;cursor:pointer;flex-shrink:0;">✕</button>
                `;
                row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
                container.appendChild(row);
            }
            calculateTotals();
        }

        /* Collect grouped items for snapshot/submit */
        function collectQuoteGroups() {
            const stripCommas = v => String(v || 0).replace(/,/g, '');
            const groups = [];
            document.querySelectorAll('.quote-group-card').forEach(card => {
                const gid  = card.id.replace('qgcard-', '');
                const name = card.querySelector('.qg-name-input')?.value || '';
                const items = [];

                card.querySelectorAll('.qg-items .item-row').forEach(row => {
                    // Skip rows that belong to fixed-price item-wrappers (handled below)
                    if (row.closest('.item-wrapper[id^="outsource"]')) return;
                    // Grouped In-House items render the SAME Simple/Advanced/
                    // Fixed Price formula-builder panel as standalone items
                    // (addItem() doesn't know it's inside a group), but this
                    // used to never capture that state — only the final
                    // computed unitPrice was saved, and formula_json was
                    // hardcoded to '{}' in db.js. On reload, addItem(saved)
                    // rebuilds the panel with default/empty formula state,
                    // then calculateTotals() recomputes the price FROM that
                    // empty state and overwrites whatever price was restored
                    // — the exact "0.00 + blank formula bar" symptom this
                    // fixes. Pull the live formula-builder state out of
                    // itemState by the row's own item{N} id, same fields
                    // _captureSnapshotV2() already captures for standalone
                    // items. Fixed 2026-07.
                    const wrapperEl = row.closest('.item-wrapper');
                    const idMatch = wrapperEl ? wrapperEl.id.match(/^item(\d+)$/) : null;
                    const st = idMatch ? itemState[idMatch[1]] : null;
                    items.push({
                        _type:    'inhouse',
                        material: row.querySelector('.material')?.value || '',
                        sizeW:    row.querySelector('.sizeW')?.value || '',
                        sizeH:    row.querySelector('.sizeH')?.value || '',
                        sizeUnit: row.querySelector('.sizeUnit')?.value || '',
                        unitPrice: stripCommas(row.querySelector('input.price')?.value),
                        qty:      row.querySelector('input.qty')?.value || 1,
                        fbMode:            st?.mode,
                        fbComponents:      st?.components,
                        fbOuterMult:       st?.outerMult,
                        fbAdvFormula:      st?.advFormula,
                        fixedFormula:      st?.fixedFormula,
                        fixedMults:        st?.fixedMults,
                        fixedManualPrice:  st?.fixedManualPrice,
                        images:            st?.images || [],
                    });
                });
                card.querySelectorAll('.qg-items .item-wrapper[id^="outsource"]').forEach(wrap => {
                    const row  = wrap.querySelector('.item-row');
                    const mults = [];
                    wrap.querySelectorAll('.outMultVal').forEach(inp => mults.push(parseFloat(inp.value)||1));
                    items.push({
                        _type:    'fixed',
                        material: row?.querySelector('.material')?.value || '',
                        sizeW:    row?.querySelector('.sizeW')?.value || '',
                        sizeH:    row?.querySelector('.sizeH')?.value || '',
                        sizeUnit: row?.querySelector('.sizeUnit')?.value || '',
                        basePrice: stripCommas(wrap.querySelector('input.outsourceBase')?.value),
                        multipliers: mults,
                        unitPrice: stripCommas(row?.querySelector('input.price')?.value),
                        qty:      row?.querySelector('input.qty')?.value || 1,
                    });
                });
                card.querySelectorAll('.qg-items .flat-item-row').forEach(row => {
                    const price = stripCommas(row.querySelector('.flatPrice')?.value);
                    items.push({
                        _type:    'flat',
                        material: row.querySelector('.material')?.value || '',
                        flatPrice: price,
                        unitPrice: price,
                        qty:      1,
                    });
                });

                groups.push({ name, items });
            });
            return groups;
        }


        // ══════════════════════════════════════════════════════════════
        // PARK QUOTE
        // Saves current form state to localStorage so the user can
        // start a new quote and come back to it later.
        // ══════════════════════════════════════════════════════════════

        const PARK_KEY = 'lp_parked_quotes';

        function getParkedQuotes() {
            try {
                const d = localStorage.getItem(PARK_KEY);
                return d ? JSON.parse(d) : [];
            } catch { return []; }
        }

        function saveParkedQuotes(list) {
            try { localStorage.setItem(PARK_KEY, JSON.stringify(list)); } catch(e) { console.warn('Park save failed', e); }
        }

        window.parkCurrentQuote = function() {
            const snap = _captureSnapshotV2();  // full snapshot with formula builder state
            if (!snap) { alert('Nothing to park.'); return; }

            // Use control number or client name as label
            const ctrl    = String(currentControlNumber || '').trim();
            const client  = document.getElementById('company')?.value?.trim();
            const label   = ctrl || client || 'Unnamed Quote';

            const list = getParkedQuotes();

            // Prevent duplicate park of same control number
            if (ctrl && list.find(p => p.ctrl === ctrl)) {
                if (!confirm(`"${label}" is already parked. Replace it?`)) return;
                const idx = list.findIndex(p => p.ctrl === ctrl);
                list.splice(idx, 1);
            }

            list.unshift({
                id:      Date.now(),
                ctrl:    ctrl || null,
                client:  client || '',
                label,
                parkedAt: new Date().toLocaleString(),
                snap
            });

            // Keep max 20 parked quotes
            if (list.length > 20) list.length = 20;

            saveParkedQuotes(list);
            renderParkedList();

            // Open the tray briefly to confirm
            const panel = document.getElementById('parkedPanel');
            if (panel && !panel.classList.contains('open')) toggleParkedTray();

            // Flash the park button
            const btn = document.getElementById('btnParkQuote');
            if (btn) {
                btn.textContent = '✓ Parked!';
                btn.style.background = '#d1fae5';
                setTimeout(() => { btn.textContent = '🅿 Park Quote'; btn.style.background = ''; }, 1800);
            }
        };

        window.toggleParkedTray = function() {
            const panel = document.getElementById('parkedPanel');
            if (panel) panel.classList.toggle('open');
        };

        window.loadParkedQuote = function(id) {
            const list = getParkedQuotes();
            const entry = list.find(p => p.id === id);
            if (!entry) {
                // Try string/number coercion
                const entryAlt = list.find(p => String(p.id) === String(id));
                if (!entryAlt) { alert('Parked quote not found. id=' + id); return; }
                if (!confirm('Load "' + entryAlt.label + '"? Current form will be cleared.')) return;
                try {
                    restoreSnapshot(entryAlt.snap, { isParked: true });
                    const updatedList = getParkedQuotes().filter(p => String(p.id) !== String(id));
                    saveParkedQuotes(updatedList);
                    renderParkedList();
                    const panel = document.getElementById('parkedPanel');
                    if (panel) panel.classList.remove('open');
                } catch(e) { console.error('[Park] restore failed:', e); alert('Load failed: ' + e.message); }
                return;
            }

            if (!confirm('Load "' + entry.label + '"? Current form will be cleared.')) return;

            try {
                restoreSnapshot(entry.snap, { isParked: true });
                // Remove from parked list after loading (it's now the active quote)
                const updatedList = getParkedQuotes().filter(p => String(p.id) !== String(id));
                saveParkedQuotes(updatedList);
                renderParkedList();
                const panel = document.getElementById('parkedPanel');
                if (panel) panel.classList.remove('open');
            } catch(e) {
                console.error('[Park] restoreSnapshot failed:', e);
                alert('Failed to load parked quote: ' + e.message);
            }
        };

        window.removeParkedQuote = function(id) {
            const list = getParkedQuotes();
            const idx  = list.findIndex(p => p.id === id);
            if (idx === -1) return;
            list.splice(idx, 1);
            saveParkedQuotes(list);
            renderParkedList();
        };

        function renderParkedList() {
            const listEl   = document.getElementById('parkedList');
            const countEl  = document.getElementById('parkedCount');
            const list     = getParkedQuotes();

            if (countEl) {
                countEl.textContent = list.length;
                countEl.classList.toggle('visible', list.length > 0);
            }

            if (!listEl) return;

            if (list.length === 0) {
                listEl.innerHTML = '<div class="parked-empty">No parked quotes yet.</div>';
                return;
            }

            listEl.innerHTML = list.map(p => `
                <div class="parked-card">
                    <div class="parked-card-ctrl">${p.ctrl || '—'}</div>
                    <div class="parked-card-company">${p.client || 'No client'}</div>
                    <div class="parked-card-meta">Parked: ${p.parkedAt}</div>
                    <div class="parked-card-actions">
                        <button class="btn-parked-load" onclick="loadParkedQuote(${p.id})">Load</button>
                        <button class="btn-parked-remove" onclick="removeParkedQuote(${p.id})">✕</button>
                    </div>
                </div>
            `).join('');
        }

        // Close tray when clicking outside
        document.addEventListener('click', function(e) {
            const tray  = document.getElementById('parkedTray');
            const panel = document.getElementById('parkedPanel');
            if (panel && panel.classList.contains('open') && tray && !tray.contains(e.target)) {
                panel.classList.remove('open');
            }
        });

        // Init: render parked list on load
        renderParkedList();

