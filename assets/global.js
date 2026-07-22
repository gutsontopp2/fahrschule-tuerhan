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
})();
