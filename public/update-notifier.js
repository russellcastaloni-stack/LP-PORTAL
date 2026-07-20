// ── Announcement banner (manual) ─────────────────────────────────────────────
// Polls /api/announcement. An admin posts/clears the message from the
// announcement button on menu.html (see menu.html's postAnnouncement()/
// clearAnnouncement()) — this script just watches for it and shows it as a
// persistent top banner on every active session, same look as the old
// automatic deploy-detector banner it replaced.
(function () {
    var POLL_MS = 15000; // check every 15s — manual announcements should propagate quickly
    var FORCE_RELOAD_SECS = 15; // grace period before an auto-reload announcement fires
    var DISMISS_KEY = 'lp_announcement_dismissed';
    var shownId = null;
    var countdownTimer = null; // setInterval (ticks the visible countdown text)
    var reloadTimer = null;    // setTimeout (fires the actual reload)

    // Self-contained auth — reads the same sessionStorage session every page
    // already uses, rather than relying on any one page's own fetch wrapper
    // (admin.html doesn't have one, so this has to work standalone).
    function authHeaders() {
        try {
            var s = sessionStorage.getItem('lp_session');
            if (!s) return {};
            var p = JSON.parse(s);
            if (p && p.token) return { 'Authorization': 'Bearer ' + p.token };
            if (p && p.id) return { 'X-Session-Id': p.id };
        } catch (e) {}
        return {};
    }

    function clearTimers() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    }

    function hideBanner() {
        clearTimers();
        var el = document.getElementById('_updateBanner');
        if (el) el.remove();
        shownId = null;
    }

    function doReload(annId) {
        try { sessionStorage.setItem(DISMISS_KEY, annId); } catch (e) {}
        window.location.reload();
    }

    function showBanner(ann) {
        if (shownId === ann.id && document.getElementById('_updateBanner')) return;
        hideBanner();
        shownId = ann.id;

        var b = document.createElement('div');
        b.id = '_updateBanner';
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;background:#1565c0;color:white;' +
            'padding:10px 16px;font-size:13px;font-weight:bold;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

        var textSpan = document.createElement('span');
        textSpan.textContent = '📢 ' + ann.message;

        var countdownSpan = document.createElement('span');
        countdownSpan.style.cssText = 'margin-left:10px; opacity:0.85; font-weight:normal;';

        var reloadBtn = document.createElement('button');
        reloadBtn.textContent = 'Reload now';
        reloadBtn.style.cssText = 'background:rgba(255,255,255,0.25);border:none;color:white;' +
            'border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;font-weight:bold;margin-left:10px;';
        reloadBtn.addEventListener('click', function () {
            clearTimers();
            doReload(ann.id);
        });

        b.appendChild(textSpan);

        if (ann.forceReload) {
            // Forced: no dismiss (x) — just a live countdown, plus the option
            // to skip the wait and reload right away. Force always implies
            // the reload button, regardless of showReload.
            var secsLeft = FORCE_RELOAD_SECS;
            countdownSpan.textContent = '— auto-reloading in ' + secsLeft + 's';
            b.appendChild(countdownSpan);
            b.appendChild(reloadBtn);
            countdownTimer = setInterval(function () {
                secsLeft -= 1;
                if (secsLeft > 0) {
                    countdownSpan.textContent = '— auto-reloading in ' + secsLeft + 's';
                } else {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                }
            }, 1000);
            reloadTimer = setTimeout(function () { doReload(ann.id); }, FORCE_RELOAD_SECS * 1000);
        } else {
            // Not forced: only show "Reload now" if the admin actually asked
            // for it (ann.showReload) — a general announcement (e.g. "team
            // meeting at 3pm") has no reason to offer a reload button.
            if (ann.showReload) b.appendChild(reloadBtn);

            var closeBtn = document.createElement('button');
            closeBtn.textContent = '✕';
            closeBtn.setAttribute('aria-label', 'Dismiss announcement');
            closeBtn.style.cssText = 'background:transparent;border:none;color:white;' +
                'cursor:pointer;font-size:13px;font-weight:bold;margin-left:8px;padding:3px 6px;';
            closeBtn.addEventListener('click', function () {
                try { sessionStorage.setItem(DISMISS_KEY, ann.id); } catch (e) {}
                hideBanner();
            });
            b.appendChild(closeBtn);
        }

        document.body ? document.body.prepend(b) : document.addEventListener('DOMContentLoaded', function () { document.body.prepend(b); });
    }

    function poll() {
        fetch(window.location.origin + '/api/announcement', {
            cache: 'no-store',
            headers: authHeaders()
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (ann) {
                if (!ann || !ann.id) { hideBanner(); return; }
                var dismissed = null;
                try { dismissed = sessionStorage.getItem(DISMISS_KEY); } catch (e) {}
                if (ann.id === dismissed) { hideBanner(); return; }
                showBanner(ann);
            })
            .catch(function () { /* transient network blip — ignore, try again next tick */ });
    }

    poll();
    setInterval(poll, POLL_MS);
    // Also check right away whenever the tab regains focus/visibility — the
    // person most likely to miss a background poll is exactly the one who
    // just tabbed back in after an admin posted something while they were away.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') poll();
    });

    // Let the announcement compose modal (menu.html) force an immediate
    // check right after posting/clearing, so the admin's own screen updates
    // right away instead of waiting for the next poll tick.
    window.__lpCheckAnnouncement = poll;
})();
