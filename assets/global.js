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
})();
