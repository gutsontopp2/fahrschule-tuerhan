/* ============================================================
   Fahrschule Türhan – Buchungs-Widget
   Ablauf:
   1) Fahrstundenart wählen   2) Tag im Kalender wählen
   3) Uhrzeit wählen          4) Daten eingeben + Bedingungen
   5) Reservieren -> Warenkorb -> Shopify-Checkout

   Die Verfügbarkeit kommt live vom Backend über den Shopify
   App Proxy (/apps/booking/*). Der Termin wird serverseitig
   atomar reserviert (Datenbank-Constraint gegen Doppelbuchung);
   erst danach wird das Produkt mit Line-Item-Properties in den
   Warenkorb gelegt und zum Shopify-Checkout weitergeleitet.
   Es werden keine Kundendaten im Browser gespeichert.
   ============================================================ */
(function () {
  'use strict';

  var root = document.querySelector('[data-booking]');
  if (!root) return;

  var configEl = root.querySelector('[data-booking-config]');
  if (!configEl) return;

  var cfg;
  try {
    cfg = JSON.parse(configEl.textContent);
  } catch (e) {
    return;
  }

  /* Direkter Backend-Aufruf (CORS) wenn eine Backend-URL hinterlegt ist,
     sonst Fallback auf den Shopify App Proxy. */
  var API = cfg.backendUrl
    ? cfg.backendUrl.replace(/\/+$/, '') + '/proxy'
    : (cfg.proxyPath || '/apps/booking').replace(/\/+$/, '');
  var WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  var dateFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var monthFmt = new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric' });

  /* ---------- Zustand ---------- */
  var state = {
    product: null,           // gewählte Fahrstundenart (aus cfg.products)
    service: null,           // zugehörige Backend-Leistung { id, vehicleType }
    services: null,          // Liste vom Backend (variantId -> Leistung)
    date: null,              // 'YYYY-MM-DD'
    time: null,              // 'HH:MM'
    monthCursor: startOfMonth(new Date()),
    availability: {},        // { 'YYYY-MM-DD': ['08:00', ...] }
    availabilityKey: '',
    reservation: null,       // { id, bookingToken, expiresAt }
    timerInterval: null,
    submitting: false,
    backendDown: false
  };

  /* ---------- Elemente ---------- */
  var els = {
    steps: root.querySelectorAll('[data-step-indicator] li'),
    panelDate: root.querySelector('[data-panel="date"]'),
    panelDetails: root.querySelector('[data-panel="details"]'),
    lessonGrid: root.querySelector('[data-lesson-grid]'),
    vehicleField: root.querySelector('[data-vehicle-field]'),
    calMonth: root.querySelector('[data-cal-month]'),
    calGrid: root.querySelector('[data-cal-grid]'),
    calPrev: root.querySelector('[data-cal-prev]'),
    calNext: root.querySelector('[data-cal-next]'),
    calLoading: root.querySelector('[data-cal-loading]'),
    timeslotsWrap: root.querySelector('[data-timeslots-wrap]'),
    timeslots: root.querySelector('[data-timeslots]'),
    timeslotsDate: root.querySelector('[data-timeslots-date]'),
    form: root.querySelector('[data-booking-form]'),
    summary: root.querySelector('[data-summary]'),
    summaryRows: root.querySelector('[data-summary-rows]'),
    summaryTotal: root.querySelector('[data-summary-total]'),
    submit: root.querySelector('[data-booking-submit]'),
    error: root.querySelector('[data-booking-error]'),
    offline: root.querySelector('[data-booking-offline]'),
    app: root.querySelector('[data-booking-app]'),
    timer: root.querySelector('[data-reservation-timer]'),
    timerValue: root.querySelector('[data-reservation-timer] b')
  };

  /* ---------- Hilfsfunktionen ---------- */
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.add('is-visible');
    els.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    els.error.classList.remove('is-visible');
    els.error.textContent = '';
  }
  function showOffline() {
    state.backendDown = true;
    if (els.offline) els.offline.hidden = false;
    if (els.app) els.app.hidden = true;
  }

  function setStep(n) {
    els.steps.forEach(function (li, i) {
      li.classList.toggle('is-done', i < n - 1);
      li.classList.toggle('is-active', i === n - 1);
    });
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      options.headers || {}
    );
    return fetch(API + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.message || 'Anfrage fehlgeschlagen');
          err.code = body.code || res.status;
          throw err;
        }
        return body;
      });
    });
  }

  /* ---------- Leistungen vom Backend laden ---------- */
  function loadServices() {
    return api('/services').then(function (data) {
      state.services = {};
      (data.services || []).forEach(function (s) {
        state.services[String(s.variantId)] = s;
      });
    });
  }

  /* ---------- Schritt 1: Fahrstundenart ---------- */
  function renderLessons() {
    els.lessonGrid.innerHTML = '';
    var anyBookable = false;
    cfg.products.forEach(function (p) {
      var service = state.services[String(p.variantId)];
      if (!service) return; // Produkt ist keiner Kalenderleistung zugeordnet -> nicht anbieten
      anyBookable = true;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-card';
      btn.setAttribute('data-product-id', p.id);
      btn.innerHTML =
        '<b>' + escapeHtml(p.title) + '</b>' +
        '<small>' + service.durationMinutes + ' Minuten' + (p.description ? ' · ' + escapeHtml(p.description) : '') + '</small>' +
        '<span class="option-card__price">' + escapeHtml(p.priceFormatted) + '</span>';
      btn.addEventListener('click', function () { selectLesson(p, service, btn); });
      els.lessonGrid.appendChild(btn);
    });

    if (!anyBookable) {
      showOffline();
      return;
    }

    /* Vorauswahl über ?leistung=handle (Link von der Produktseite) */
    var params = new URLSearchParams(location.search);
    var pre = params.get('leistung');
    if (pre) {
      var match = cfg.products.find(function (p) { return p.handle === pre; });
      if (match && state.services[String(match.variantId)]) {
        var el = els.lessonGrid.querySelector('[data-product-id="' + match.id + '"]');
        if (el) selectLesson(match, state.services[String(match.variantId)], el);
      }
    }
  }

  function selectLesson(p, service, btn) {
    if (state.product && state.product.id === p.id) return;
    state.product = p;
    state.service = service;
    resetFrom('lesson');
    markSelected(els.lessonGrid, btn);

    /* Getriebe-Auswahl nur zeigen, wenn die Leistung beides erlaubt */
    if (els.vehicleField) {
      var needsChoice = service.vehicleType === 'beide';
      els.vehicleField.hidden = !needsChoice;
      els.form.elements.vehicleType.required = needsChoice;
      if (!needsChoice) els.form.elements.vehicleType.value = service.vehicleType;
      else els.form.elements.vehicleType.value = '';
    }

    els.panelDate.hidden = false;
    setStep(2);
    loadAvailability();
    updateSummary();
  }

  /* ---------- Schritt 2: Kalender ---------- */
  function loadAvailability(force) {
    if (!state.service) return;
    var from = iso(state.monthCursor);
    var last = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + 1, 0);
    var to = iso(last);
    var key = from + '|' + state.service.id;
    if (!force && key === state.availabilityKey) { renderCalendar(); return; }

    els.calLoading.hidden = false;
    els.calGrid.setAttribute('aria-busy', 'true');

    api('/availability?from=' + from + '&to=' + to + '&serviceId=' + state.service.id)
      .then(function (data) {
        state.availability = data.days || {};
        state.availabilityKey = key;
        renderCalendar();
      })
      .catch(function () {
        showError('Verfügbarkeiten konnten nicht geladen werden. Bitte versuche es in einem Moment erneut.');
      })
      .finally(function () {
        els.calLoading.hidden = true;
        els.calGrid.removeAttribute('aria-busy');
      });
  }

  function renderCalendar() {
    var y = state.monthCursor.getFullYear();
    var m = state.monthCursor.getMonth();
    els.calMonth.textContent = monthFmt.format(state.monthCursor);

    var now = new Date();
    els.calPrev.disabled = (y === now.getFullYear() && m === now.getMonth()) || state.monthCursor < startOfMonth(now);

    els.calGrid.innerHTML = '';
    WEEKDAYS.forEach(function (w) {
      var el = document.createElement('div');
      el.className = 'calendar__weekday';
      el.textContent = w;
      els.calGrid.appendChild(el);
    });

    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7; /* Montag = 0 */
    for (var i = 0; i < lead; i++) {
      var empty = document.createElement('div');
      empty.className = 'calendar__day calendar__day--empty';
      els.calGrid.appendChild(empty);
    }

    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayIso = iso(new Date());

    for (var d = 1; d <= daysInMonth; d++) {
      var dayIso = y + '-' + pad(m + 1) + '-' + pad(d);
      var slots = state.availability[dayIso] || [];
      var isPast = dayIso < todayIso;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calendar__day';
      btn.textContent = d;
      btn.setAttribute('aria-label', dateFmt.format(parseISO(dayIso)) + (slots.length ? ', ' + slots.length + ' freie Termine' : ', keine freien Termine'));

      if (isPast || !slots.length) {
        btn.disabled = true;
      } else {
        btn.classList.add('calendar__day--available');
        if (state.date === dayIso) btn.classList.add('calendar__day--selected');
        (function (dIso) {
          btn.addEventListener('click', function () { selectDate(dIso); });
        })(dayIso);
      }
      els.calGrid.appendChild(btn);
    }
  }

  function selectDate(dayIso) {
    state.date = dayIso;
    state.time = null;
    releaseReservation();
    renderCalendar();
    renderTimeslots();
    setStep(3);
    updateSummary();
    validate();
  }

  /* ---------- Schritt 3: Uhrzeit ---------- */
  function renderTimeslots() {
    var slots = state.availability[state.date] || [];
    els.timeslotsWrap.hidden = false;
    els.timeslotsDate.textContent = dateFmt.format(parseISO(state.date));
    els.timeslots.innerHTML = '';

    if (!slots.length) {
      els.timeslots.innerHTML = '<p class="timeslots-empty">An diesem Tag sind keine Termine mehr frei.</p>';
      return;
    }
    slots.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'timeslot' + (state.time === t ? ' is-selected' : '');
      btn.textContent = t + ' Uhr';
      btn.addEventListener('click', function () {
        state.time = t;
        releaseReservation();
        renderTimeslots();
        els.panelDetails.hidden = false;
        setStep(4);
        updateSummary();
        validate();
        els.panelDetails.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      els.timeslots.appendChild(btn);
    });
  }

  /* ---------- Zusammenfassung ---------- */
  function endTime(startHHMM, minutes) {
    var p = startHHMM.split(':');
    var total = (+p[0]) * 60 + (+p[1]) + minutes;
    return pad(Math.floor(total / 60) % 24) + ':' + pad(total % 60);
  }

  function vehicleLabel(v) {
    return v === 'automat' ? 'Automat' : v === 'handschaltung' ? 'Handschaltung' : '';
  }

  function updateSummary() {
    if (!state.product) { els.summary.hidden = true; return; }
    els.summary.hidden = false;
    var rows = [
      ['Fahrstundenart', state.product.title],
      ['Dauer', state.service.durationMinutes + ' Minuten']
    ];
    var veh = els.form.elements.vehicleType.value;
    if (veh) rows.push(['Getriebe', vehicleLabel(veh)]);
    if (state.date) rows.push(['Datum', dateFmt.format(parseISO(state.date))]);
    if (state.time) rows.push(['Uhrzeit', state.time + ' – ' + endTime(state.time, state.service.durationMinutes) + ' Uhr']);
    var mp = els.form.elements.meetingPoint.value;
    if (mp) rows.push(['Treffpunkt', mp]);

    els.summaryRows.innerHTML = rows.map(function (r) {
      return '<dt>' + r[0] + '</dt><dd>' + escapeHtml(r[1]) + '</dd>';
    }).join('');
    els.summaryTotal.textContent = state.product.priceFormatted;
  }

  /* ---------- Validierung ---------- */
  function formValues() {
    var f = els.form.elements;
    return {
      firstName: f.firstName.value.trim(),
      lastName: f.lastName.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      meetingPoint: f.meetingPoint.value,
      vehicleType: f.vehicleType.value,
      note: f.note.value.trim(),
      isFirstLesson: f.isFirstLesson.checked,
      termsAccepted: f.termsAccepted.checked,
      website: f.website ? f.website.value : '' // Honeypot
    };
  }

  function validate() {
    var v = formValues();
    var ok = !!(state.product && state.date && state.time &&
      v.firstName.length >= 2 &&
      v.lastName.length >= 2 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) &&
      v.phone.replace(/\D/g, '').length >= 7 &&
      v.meetingPoint &&
      v.vehicleType &&
      v.termsAccepted);
    els.submit.disabled = !ok || state.submitting;
    return ok;
  }

  /* ---------- Reservierung + Warenkorb ---------- */
  function releaseReservation() {
    stopTimer();
    if (state.reservation) {
      /* Freigabe ist Best-Effort – das Backend räumt abgelaufene Holds ohnehin auf. */
      fetch(API + '/holds/' + state.reservation.id + '?bookingToken=' + encodeURIComponent(state.reservation.bookingToken), {
        method: 'DELETE'
      }).catch(function () {});
      state.reservation = null;
    }
    els.timer.classList.remove('is-visible');
  }

  function startTimer(expiresAt) {
    stopTimer();
    els.timer.classList.add('is-visible');
    state.timerInterval = setInterval(function () {
      var remaining = Math.floor((new Date(expiresAt) - new Date()) / 1000);
      if (remaining <= 0) {
        stopTimer();
        state.reservation = null;
        els.timer.classList.remove('is-visible');
        showError('Deine Reservierung ist abgelaufen. Bitte wähle den Termin erneut – er wurde wieder freigegeben.');
        state.availabilityKey = '';
        loadAvailability(true);
        state.time = null;
        validate();
        return;
      }
      els.timerValue.textContent = pad(Math.floor(remaining / 60)) + ':' + pad(remaining % 60);
    }, 500);
  }

  function stopTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  /* Bestehende Buchungs-Positionen aus dem Warenkorb entfernen und deren
     Reservierung freigeben – ein Kunde kann immer nur einen Termin
     gleichzeitig buchen (Menge ist damit fest 1). */
  function clearCartBookings() {
    return fetch(window.themeSettings.cartCountUrl, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var updates = {};
        var hasBooking = false;
        (cart.items || []).forEach(function (item) {
          var props = item.properties || {};
          if (props._booking_token) {
            hasBooking = true;
            updates[item.key] = 0;
            var holdId = props._hold_id;
            if (holdId) {
              fetch(API + '/holds/' + holdId + '?bookingToken=' + encodeURIComponent(props._booking_token), {
                method: 'DELETE'
              }).catch(function () {});
            }
          }
        });
        if (!hasBooking) return null;
        return fetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ updates: updates })
        });
      })
      .catch(function () { return null; });
  }

  function submitBooking() {
    if (!validate() || state.submitting) return;
    var v = formValues();
    if (v.website) return; // Honeypot: still verwerfen
    clearError();
    state.submitting = true;
    els.submit.disabled = true;
    els.submit.textContent = 'Termin wird reserviert …';

    var payload = {
      variantId: String(state.product.variantId),
      date: state.date,
      time: state.time,
      customer: { firstName: v.firstName, lastName: v.lastName, email: v.email, phone: v.phone },
      meetingPoint: v.meetingPoint,
      vehicleType: v.vehicleType || undefined,
      note: v.note || undefined,
      isFirstLesson: v.isFirstLesson,
      termsAccepted: true,
      idempotencyKey: uuid()
    };

    /* 1) Alte Buchungs-Position entfernen, 2) serverseitig atomar reservieren */
    clearCartBookings()
      .then(function () {
        return api('/holds', { method: 'POST', body: JSON.stringify(payload) });
      })
      .then(function (res) {
        state.reservation = { id: res.reservationId, bookingToken: res.bookingToken, expiresAt: res.expiresAt };
        startTimer(res.expiresAt);
        els.submit.textContent = 'Weiter zur Kasse …';

        /* 3) Produkt mit Termindaten in den Shopify-Warenkorb legen */
        var properties = {
          'Termin': dateFmt.format(parseISO(state.date)),
          'Uhrzeit': state.time + ' – ' + endTime(state.time, state.service.durationMinutes) + ' Uhr',
          'Fahrstundenart': state.product.title,
          'Dauer': state.service.durationMinutes + ' Minuten',
          'Treffpunkt': v.meetingPoint,
          'Getriebe': vehicleLabel(v.vehicleType),
          '_booking_token': res.bookingToken,
          '_hold_id': String(res.reservationId)
        };
        if (v.note) properties['Bemerkung'] = v.note;
        if (v.isFirstLesson) properties['Erste Fahrstunde'] = 'Ja';

        return fetch(window.themeSettings.cartAddUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: [{ id: Number(state.product.variantId), quantity: 1, properties: properties }] })
        });
      })
      .then(function (cartRes) {
        if (!cartRes.ok) throw new Error('CART');
        document.dispatchEvent(new Event('cart:updated'));
        /* 4) Direkt zum Shopify-Checkout */
        window.location.href = '/checkout';
      })
      .catch(function (err) {
        state.submitting = false;
        els.submit.textContent = 'Verbindlich buchen';
        if (err && (err.code === 'SLOT_TAKEN' || err.code === 409)) {
          showError('Dieser Termin wurde gerade vergeben. Bitte wähle einen anderen Termin.');
          state.time = null;
          state.availabilityKey = '';
          loadAvailability(true);
          els.timeslotsWrap.hidden = true;
        } else if (err && err.code === 'INVALID') {
          showError(err.message || 'Bitte überprüfe deine Angaben.');
        } else if (err && err.message === 'CART') {
          releaseReservation();
          showError('Der Warenkorb konnte nicht aktualisiert werden. Bitte versuche es erneut.');
        } else {
          showError('Die Reservierung hat nicht geklappt. Bitte versuche es erneut oder melde dich telefonisch.');
        }
        validate();
      });
  }

  /* ---------- Sonstiges ---------- */
  function resetFrom(step) {
    state.date = null;
    state.time = null;
    state.availabilityKey = '';
    releaseReservation();
    els.timeslotsWrap.hidden = true;
    els.panelDetails.hidden = true;
    if (step === 'lesson') els.panelDate.hidden = true;
    clearError();
  }

  function markSelected(container, btn) {
    clearSelected(container);
    btn.classList.add('is-selected');
  }
  function clearSelected(container) {
    if (!container) return;
    container.querySelectorAll('.is-selected').forEach(function (el) { el.classList.remove('is-selected'); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- Events ---------- */
  els.calPrev.addEventListener('click', function () {
    state.monthCursor = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() - 1, 1);
    loadAvailability();
  });
  els.calNext.addEventListener('click', function () {
    state.monthCursor = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + 1, 1);
    loadAvailability();
  });
  els.form.addEventListener('input', function () { validate(); updateSummary(); });
  els.form.addEventListener('change', function () { validate(); updateSummary(); });
  els.form.addEventListener('submit', function (e) { e.preventDefault(); submitBooking(); });

  /* ---------- Start ---------- */
  setStep(1);
  loadServices()
    .then(function () {
      renderLessons();
      validate();
    })
    .catch(function () {
      /* Backend nicht erreichbar oder App Proxy nicht eingerichtet */
      showOffline();
    });
})();
