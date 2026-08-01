/* Fahrschule Türhan – globales Verhalten (Navigation, Warenkorb-Badge) */
(function () {
  'use strict';

  /* Mobile-Menü */
  var toggle = document.querySelector('[data-menu-toggle]');
  var mobileNav = document.querySelector('[data-mobile-nav]');
  if (toggle && mobileNav) {
    toggle.addEventListener('click', function () {
      var open = mobileNav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Menü schliessen' : 'Menü öffnen');
    });
  }

  /* Warenkorb-Anzahl laden und Badge aktualisieren */
  function updateCartCount() {
    if (!window.themeSettings || !window.themeSettings.cartCountUrl) return;
    fetch(window.themeSettings.cartCountUrl, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cart) {
        if (!cart) return;
        document.querySelectorAll('[data-cart-count]').forEach(function (el) {
          el.textContent = cart.item_count;
          el.classList.toggle('is-visible', cart.item_count > 0);
        });
      })
      .catch(function () { /* still ok – Badge bleibt leer */ });
  }
  updateCartCount();
  document.addEventListener('cart:updated', updateCartCount);

  /* Warenkorb: Beim Entfernen eines Termins die serverseitige Reservierung
     freigeben (Best-Effort – abgelaufene Holds räumt das Backend ohnehin auf). */
  document.querySelectorAll('[data-cart-remove]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var holdId = link.getAttribute('data-hold-id');
      var token = link.getAttribute('data-booking-token');
      if (!holdId || !token) return; // normale Position – Standardverhalten
      e.preventDefault();
      link.setAttribute('aria-disabled', 'true');
      var bookingApi = (window.themeSettings && window.themeSettings.bookingApi) || '/apps/booking';
      fetch(bookingApi + '/holds/' + encodeURIComponent(holdId) + '?bookingToken=' + encodeURIComponent(token), {
        method: 'DELETE'
      })
        .catch(function () { /* Freigabe scheitert -> Hold läuft serverseitig ab */ })
        .finally(function () { window.location.href = link.getAttribute('href'); });
    });
  });

  /* ---------- Cookie-Consent ----------
     Speichert die Wahl lokal. Aktuell werden nur technisch notwendige Cookies
     (Shopify) geladen; optionale Kategorien sind vorbereitet. Ergänzt du später
     z. B. Analytics, lade den Dienst nur, wenn window.ftConsent.analytics true ist. */
  var CONSENT_KEY = 'ft_cookie_consent_v1';
  var banner = document.querySelector('[data-cookie-banner]');

  function readConsent() {
    try { return JSON.parse(localStorage.getItem(CONSENT_KEY)); } catch (e) { return null; }
  }
  function saveConsent(consent) {
    consent.ts = new Date().toISOString();
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(consent)); } catch (e) {}
    window.ftConsent = consent;
    document.dispatchEvent(new CustomEvent('cookie:consent', { detail: consent }));
    hideBanner();
  }
  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    document.body.classList.remove('cookie-open');
  }
  function showBanner() {
    if (!banner) return;
    banner.hidden = false;
    document.body.classList.add('cookie-open');
  }

  if (banner) {
    var existing = readConsent();
    window.ftConsent = existing || { necessary: true, analytics: false, marketing: false };
    if (!existing) showBanner();

    var settingsPanel = banner.querySelector('[data-cookie-settings]');
    banner.addEventListener('click', function (e) {
      var action = e.target && e.target.getAttribute && e.target.getAttribute('data-cookie');
      if (!action) return;
      if (action === 'all') {
        saveConsent({ necessary: true, analytics: true, marketing: true });
      } else if (action === 'necessary') {
        saveConsent({ necessary: true, analytics: false, marketing: false });
      } else if (action === 'settings') {
        if (settingsPanel) settingsPanel.hidden = !settingsPanel.hidden;
      } else if (action === 'save') {
        var cats = { necessary: true, analytics: false, marketing: false };
        banner.querySelectorAll('[data-cookie-cat]').forEach(function (el) {
          cats[el.getAttribute('data-cookie-cat')] = el.checked;
        });
        saveConsent(cats);
      }
    });

    /* Footer-Link „Cookie-Einstellungen" öffnet den Banner erneut */
    document.querySelectorAll('[data-cookie-reopen]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        if (settingsPanel) settingsPanel.hidden = false;
        showBanner();
      });
    });
  }
})();
