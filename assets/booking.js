/* ============================================================
   Fahrschule Türhan – Buchungs-Widget
   Ablauf:
   1) Fahrstundenart wählen  2) Fahrlehrer wählen (optional)
   3) Tag im Kalender wählen 4) Uhrzeit wählen
   5) Daten eingeben         6) Reservieren -> Warenkorb -> Checkout
   Die Verfügbarkeit kommt live vom Backend (Custom App).
   Der Termin wird serverseitig atomar reserviert; erst danach
   wird das Produkt mit Line-Item-Properties in den Warenkorb
   gelegt und zum Shopify-Checkout weitergeleitet.
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
    console.error('Buchung: Konfiguration konnte nicht gelesen werden.', e);
    return;
  }

  if (!cfg.backendUrl) {
    var offline = root.querySelector('[data-booking-offline]');
    if (offline) offline.hidden = false;
    var app = root.querySelector('[data-booking-app]');
    if (app) app.hidden = true;
    return;
  }

  var API = cfg.backendUrl.replace(/\/+$/, '');
  var WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  var dateFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var monthFmt = new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric' });

  /* ---------- Zustand ---------- */
  var state = {
    product: null,           // gewählte Fahrstundenart (aus cfg.products)
    instructor: null,        // { id, name }
    instructors: [],
    date: null,              // 'YYYY-MM-DD'
    time: null,              // 'HH:MM'
    monthCursor: startOfMonth(new Date()),
    availability: {},        // { 'YYYY-MM-DD': ['08:00', ...] }
    availabilityKey: '',     // Cache-Schlüssel (Monat+Lehrer+Dauer)
    reservation: null,       // { id, expiresAt }
    timerInterval: null,
    submitting: false
  };

  /* ---------- Elemente ---------- */
  var els = {
    steps: root.querySelectorAll('[data-step-indicator] li'),
    panelLesson: root.querySelector('[data-panel="lesson"]'),
    panelInstructor: root.querySelector('[data-panel="instructor"]'),
    panelDate: root.querySelector('[data-panel="date"]'),
    panelDetails: root.querySelector('[data-panel="details"]'),
    lessonGrid: root.querySelector('[data-lesson-grid]'),
    instructorGrid: root.querySelector('[data-instructor-grid]'),
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
    timer: root.querySelector('[data-reservation-timer]'),
    timerValue: root.querySelector('[data-reservation-timer] b')
  };

  /* ---------- Hilfsfunktionen ---------- */
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.classList.add('is-visible');
    els.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    els.error.classList.remove('is-visible');
    els.error.textContent = '';
  }

  function setStep(n) {
    els.steps.forEach(function (li, i) {
      li.classList.toggle('is-done', i < n - 1);
      li.classList.toggle('is-active', i === n - 1);
    });
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
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

  /* ---------- Schritt 1: Fahrstundenart ---------- */
  function renderLessons() {
    els.lessonGrid.innerHTML = '';
    cfg.products.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-card';
      btn.setAttribute('data-product-id', p.id);
      btn.innerHTML =
        '<b>' + escapeHtml(p.title) + '</b>' +
        '<small>' + p.durationMinutes + ' Minuten' + (p.description ? ' · ' + escapeHtml(p.description) : '') + '</small>' +
        '<span class="option-card__price">' + escapeHtml(p.priceFormatted) + '</span>';
      btn.addEventListener('click', function () { selectLesson(p, btn); });
      els.lessonGrid.appendChild(btn);
    });

    /* Vorauswahl über ?leistung=handle (Link von der Produktseite) */
    var params = new URLSearchParams(location.search);
    var pre = params.get('leistung');
    if (pre) {
      var match = cfg.products.find(function (p) { return p.handle === pre; });
      if (match) {
        var el = els.lessonGrid.querySelector('[data-product-id="' + match.id + '"]');
        if (el) selectLesson(match, el);
      }
    }
  }

  function selectLesson(p, btn) {
    if (state.product && state.product.id === p.id) return;
    state.product = p;
    resetFrom('lesson');
    markSelected(els.lessonGrid, btn);
    els.panelInstructor.hidden = !cfg.showInstructor;
    if (cfg.showInstructor) {
      loadInstructors();
      setStep(2);
    } else {
      state.instructor = state.instructors[0] || null;
      els.panelDate.hidden = false;
      setStep(2);
      loadAvailability();
    }
    updateSummary();
  }

  /* ---------- Schritt 2: Fahrlehrer ---------- */
  function loadInstructors() {
    if (state.instructors.length) { renderInstructors(); return; }
    els.instructorGrid.innerHTML = '<p class="booking-loading">Fahrlehrer werden geladen …</p>';
    api('/api/instructors')
      .then(function (data) {
        state.instructors = data.instructors || [];
        if (state.instructors.length === 1) {
          state.instructor = state.instructors[0];
          els.panelInstructor.hidden = true;
          els.panelDate.hidden = false;
          setStep(3);
          loadAvailability();
          updateSummary();
        } else {
          renderInstructors();
        }
      })
      .catch(function () {
        els.instructorGrid.innerHTML = '<p class="booking-loading">Fahrlehrer konnten nicht geladen werden. Bitte lade die Seite neu.</p>';
      });
  }

  function renderInstructors() {
    els.instructorGrid.innerHTML = '';
    state.instructors.forEach(function (ins) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option-card';
      btn.innerHTML = '<b>' + escapeHtml(ins.name) + '</b>' +
        (ins.vehicle ? '<small>' + escapeHtml(ins.vehicle) + '</small>' : '');
      btn.addEventListener('click', function () {
        state.instructor = ins;
        resetFrom('instructor');
        markSelected(els.instructorGrid, btn);
        els.panelDate.hidden = false;
        setStep(3);
        loadAvailability();
        updateSummary();
      });
      els.instructorGrid.appendChild(btn);
    });
  }

  /* ---------- Schritt 3: Kalender ---------- */
  function loadAvailability(force) {
    if (!state.product) return;
    var from = iso(state.monthCursor);
    var last = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + 1, 0);
    var to = iso(last);
    var key = from + '|' + (state.instructor ? state.instructor.id : 'any') + '|' + state.product.durationMinutes;
    if (!force && key === state.availabilityKey) { renderCalendar(); return; }

    els.calLoading.hidden = false;
    els.calGrid.setAttribute('aria-busy', 'true');

    var q = '?from=' + from + '&to=' + to + '&duration=' + state.product.durationMinutes;
    if (state.instructor) q += '&instructorId=' + encodeURIComponent(state.instructor.id);

    api('/api/availability' + q)
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

    /* Zurück-Pfeil sperren, wenn aktueller Monat erreicht ist */
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
    setStep(cfg.showInstructor ? 4 : 3);
    updateSummary();
    validate();
  }

  /* ---------- Schritt 4: Uhrzeit ---------- */
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
        setStep(cfg.showInstructor ? 5 : 4);
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

  function updateSummary() {
    if (!state.product) { els.summary.hidden = true; return; }
    els.summary.hidden = false;
    var rows = [
      ['Fahrstundenart', state.product.title],
      ['Dauer', state.product.durationMinutes + ' Minuten']
    ];
    if (state.instructor) rows.push(['Fahrlehrer', state.instructor.name]);
    if (state.date) rows.push(['Datum', dateFmt.format(parseISO(state.date))]);
    if (state.time) rows.push(['Uhrzeit', state.time + ' – ' + endTime(state.time, state.product.durationMinutes) + ' Uhr']);
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
      name: f.name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      meetingPoint: f.meetingPoint.value,
      note: f.note.value.trim()
    };
  }

  function validate() {
    var v = formValues();
    var ok = !!(state.product && state.date && state.time &&
      (!cfg.showInstructor || state.instructor) &&
      v.name.length >= 2 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) &&
      v.phone.replace(/\D/g, '').length >= 7 &&
      v.meetingPoint);
    els.submit.disabled = !ok || state.submitting;
    return ok;
  }

  /* ---------- Reservierung + Warenkorb ---------- */
  function releaseReservation() {
    stopTimer();
    if (state.reservation) {
      /* Freigabe ist Best-Effort – das Backend räumt abgelaufene Holds ohnehin auf. */
      fetch(API + '/api/reservations/' + state.reservation.id, { method: 'DELETE' }).catch(function () {});
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

  function submitBooking() {
    if (!validate() || state.submitting) return;
    clearError();
    state.submitting = true;
    els.submit.disabled = true;
    els.submit.textContent = 'Termin wird reserviert …';

    var v = formValues();
    var payload = {
      productId: state.product.id,
      variantId: state.product.variantId,
      lessonTitle: state.product.title,
      durationMinutes: state.product.durationMinutes,
      instructorId: state.instructor ? state.instructor.id : null,
      date: state.date,
      time: state.time,
      customer: { name: v.name, email: v.email, phone: v.phone },
      meetingPoint: v.meetingPoint,
      note: v.note
    };

    /* 1) Serverseitig atomar reservieren (Backend prüft Verfügbarkeit erneut) */
    api('/api/reservations', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (res) {
        state.reservation = { id: res.reservationId, expiresAt: res.expiresAt };
        startTimer(res.expiresAt);
        els.submit.textContent = 'Weiter zur Kasse …';

        /* 2) Produkt mit Termindaten in den Shopify-Warenkorb legen */
        var properties = {
          'Datum': dateFmt.format(parseISO(state.date)),
          'Uhrzeit': state.time + ' – ' + endTime(state.time, state.product.durationMinutes) + ' Uhr',
          'Dauer': state.product.durationMinutes + ' Minuten',
          'Treffpunkt': v.meetingPoint,
          'Reservierungs-ID': res.reservationId
        };
        if (state.instructor) properties['Fahrlehrer'] = state.instructor.name;
        if (v.note) properties['Bemerkung'] = v.note;

        return fetch(window.themeSettings.cartAddUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: [{ id: state.product.variantId, quantity: 1, properties: properties }] })
        });
      })
      .then(function (cartRes) {
        if (!cartRes.ok) throw new Error('CART');
        document.dispatchEvent(new Event('cart:updated'));
        /* 3) Direkt zum Shopify-Checkout */
        window.location.href = '/checkout';
      })
      .catch(function (err) {
        state.submitting = false;
        els.submit.textContent = 'Verbindlich buchen';
        if (err && (err.code === 'SLOT_TAKEN' || err.code === 409)) {
          showError('Dieser Termin wurde soeben von jemand anderem gebucht. Bitte wähle eine andere Uhrzeit.');
          state.time = null;
          state.availabilityKey = '';
          loadAvailability(true);
          els.timeslotsWrap.hidden = true;
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
    if (step === 'lesson') {
      state.instructor = cfg.showInstructor ? null : state.instructor;
      clearSelected(els.instructorGrid);
    }
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
  els.form.addEventListener('submit', function (e) { e.preventDefault(); submitBooking(); });
  window.addEventListener('pagehide', function () {
    /* Verlässt der Kunde die Seite vor dem Checkout nicht – Hold läuft serverseitig ab. */
  });

  /* ---------- Start ---------- */
  renderLessons();
  setStep(1);
  validate();
})();
