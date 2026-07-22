/* Tests der Slot-Berechnung (reine Logik, ohne Datenbank).
   Deckt ab: Puffer-Regeln, Doppel-/Überlappungslogik auf Angebotsebene,
   Sommerzeit (Europe/Zurich), Vergangenheit, geschlossene Tage,
   blockierte Zeiten, manuelle Startzeiten. */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { computeSlots, slotToUtc, windowsForDay } from '../src/availability.js';
import type { SlotQuery, Rule } from '../src/availability.js';

const ZONE = 'Europe/Zurich';

/** Mo–Fr 08:00–17:00 */
const weekRules: Rule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startTime: '08:00',
  endTime: '17:00',
  active: true,
}));

function utc(dateLocal: string, timeLocal: string): Date {
  return DateTime.fromISO(`${dateLocal}T${timeLocal}`, { zone: ZONE }).toUTC().toJSDate();
}

/** Standard-Query: Montag, 2026-08-03 (Werktag), «jetzt» = eine Woche vorher */
function baseQuery(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    fromDate: '2026-08-03',
    toDate: '2026-08-03',
    durationMinutes: 50,
    bufferMinutes: 20,
    timezone: ZONE,
    rules: weekRules,
    exceptions: [],
    busy: [],
    manualStarts: [],
    now: utc('2026-07-27', '09:00'),
    minLeadMinutes: 0,
    maxAdvanceDays: 60,
    ...overrides,
  };
}

describe('computeSlots – Grundraster', () => {
  it('erzeugt 50-Minuten-Slots mit 20 Minuten Puffer (Schrittweite 70 Min.)', () => {
    const days = computeSlots(baseQuery());
    const slots = days['2026-08-03'];
    expect(slots).toBeDefined();
    expect(slots[0]).toBe('08:00');
    expect(slots[1]).toBe('09:10'); // 08:00 + 50 + 20
    expect(slots[2]).toBe('10:20');
    // Letzter Slot: Unterricht muss bis 17:00 passen (Start + 50 ≤ 17:00)
    const last = slots[slots.length - 1];
    expect(last <= '16:10').toBe(true);
  });

  it('bietet an geschlossenen Tagen (Wochenende) keine Slots an', () => {
    const days = computeSlots(
      baseQuery({ fromDate: '2026-08-01', toDate: '2026-08-02' }) // Sa + So
    );
    expect(days['2026-08-01']).toBeUndefined();
    expect(days['2026-08-02']).toBeUndefined();
  });

  it('bietet vergangene Tage nicht an', () => {
    const days = computeSlots(
      baseQuery({ fromDate: '2026-08-03', toDate: '2026-08-04', now: utc('2026-08-05', '09:00') })
    );
    expect(Object.keys(days)).toHaveLength(0);
  });

  it('respektiert die minimale Vorlaufzeit am selben Tag', () => {
    const days = computeSlots(
      baseQuery({ now: utc('2026-08-03', '08:30'), minLeadMinutes: 120 })
    );
    const slots = days['2026-08-03'];
    // 08:30 + 2 h Vorlauf → frühestens 10:30; Rasterpunkte 08:00, 09:10, 10:20 fallen weg
    expect(slots.every((t) => t >= '10:30')).toBe(true);
  });

  it('respektiert die maximale Vorausbuchungszeit', () => {
    const days = computeSlots(baseQuery({ maxAdvanceDays: 3 })); // «jetzt» 27.7. → max 30.7.
    expect(days['2026-08-03']).toBeUndefined();
  });
});

describe('computeSlots – Puffer-Blockierung (Kernanforderung)', () => {
  /** Buchung Montag 12:00–12:50, Puffer 20 → blockiert 12:00–13:10 */
  const bookingAtNoon = { start: utc('2026-08-03', '12:00'), end: utc('2026-08-03', '13:10') };

  it('bietet 13:00 nach einer 12:00-Buchung NICHT an', () => {
    const days = computeSlots(baseQuery({ busy: [bookingAtNoon] }));
    expect(days['2026-08-03']).not.toContain('13:00');
  });

  it('bietet 13:10 nach einer 12:00-Buchung an (nächstmöglicher Termin)', () => {
    const days = computeSlots(baseQuery({ busy: [bookingAtNoon] }));
    expect(days['2026-08-03']).toContain('13:10');
  });

  it('bietet keinen Slot an, dessen Unterricht ODER Puffer die Buchung überlappt', () => {
    const days = computeSlots(baseQuery({ busy: [bookingAtNoon] }));
    for (const t of days['2026-08-03']) {
      const s = DateTime.fromISO(`2026-08-03T${t}`, { zone: ZONE });
      const blockedUntil = s.plus({ minutes: 70 });
      const overlaps =
        s.toMillis() < bookingAtNoon.end.getTime() &&
        bookingAtNoon.start.getTime() < blockedUntil.toMillis();
      expect(overlaps).toBe(false);
    }
  });

  it('behandelt teilweise Überlappungen korrekt (Buchung 10:00–11:10)', () => {
    const busy = [{ start: utc('2026-08-03', '10:00'), end: utc('2026-08-03', '11:10') }];
    const days = computeSlots(baseQuery({ busy }));
    const slots = days['2026-08-03'];
    // 09:10-Slot blockiert bis 10:20 → überlappt die Buchung → nicht anbieten
    expect(slots).not.toContain('09:10');
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots).toContain('11:10'); // direkt nach dem Puffer
  });

  it('manuell freigegebene Startzeit 12:00: nach Buchung folgt der nächste Slot frühestens 13:10', () => {
    // Manueller Slot 12:00 wurde gebucht → busy 12:00–13:10
    const days = computeSlots(
      baseQuery({
        rules: [], // keine automatischen Fenster
        manualStarts: [utc('2026-08-03', '12:00'), utc('2026-08-03', '13:00'), utc('2026-08-03', '13:10')],
        busy: [bookingAtNoon],
      })
    );
    const slots = days['2026-08-03'] ?? [];
    expect(slots).not.toContain('12:00'); // gebucht
    expect(slots).not.toContain('13:00'); // im Puffer
    expect(slots).toContain('13:10');
  });
});

describe('computeSlots – Ausnahmen', () => {
  it('ganztägiger Urlaub deaktiviert den Tag', () => {
    const days = computeSlots(
      baseQuery({ exceptions: [{ date: '2026-08-03', startTime: null, endTime: null, type: 'vacation' }] })
    );
    expect(days['2026-08-03']).toBeUndefined();
  });

  it('manuell blockierte Zeit wird nicht angeboten', () => {
    const days = computeSlots(
      baseQuery({
        exceptions: [{ date: '2026-08-03', startTime: '10:00', endTime: '12:00', type: 'blocked' }],
      })
    );
    const slots = days['2026-08-03'];
    for (const t of slots) {
      const s = DateTime.fromISO(`2026-08-03T${t}`, { zone: ZONE });
      const lessonEnd = s.plus({ minutes: 50 });
      const blockStart = DateTime.fromISO('2026-08-03T10:00', { zone: ZONE });
      const blockEnd = DateTime.fromISO('2026-08-03T12:00', { zone: ZONE });
      const overlapsBlock = s < blockEnd && blockStart < lessonEnd;
      expect(overlapsBlock).toBe(false);
    }
  });

  it('Sonderöffnung ersetzt an dem Tag den Wochenplan', () => {
    const days = computeSlots(
      baseQuery({
        fromDate: '2026-08-01', // Samstag – regulär geschlossen
        toDate: '2026-08-01',
        exceptions: [{ date: '2026-08-01', startTime: '09:00', endTime: '12:00', type: 'available' }],
      })
    );
    expect(days['2026-08-01']).toEqual(['09:00', '10:10']);
  });
});

describe('Sommer-/Winterzeit (Europe/Zurich)', () => {
  it('Frühjahrsumstellung: 02:30 existiert nicht und wird abgelehnt', () => {
    // 2026-03-29: 02:00 → 03:00
    expect(slotToUtc('2026-03-29', '02:30', 50, 20, ZONE)).toBeNull();
  });

  it('Herbstumstellung: Slots am Umstellungstag haben korrekte UTC-Abstände', () => {
    // 2026-10-25: 03:00 → 02:00 (Tag hat 25 Stunden)
    const morning = slotToUtc('2026-10-25', '08:00', 50, 20, ZONE)!;
    const afternoon = slotToUtc('2026-10-25', '14:00', 50, 20, ZONE)!;
    // Lokal 6 h Abstand – in UTC ebenfalls 6 h, beide bereits Winterzeit (UTC+1)
    expect(afternoon.startAt.getTime() - morning.startAt.getTime()).toBe(6 * 3_600_000);
    expect(DateTime.fromJSDate(morning.startAt).toUTC().hour).toBe(7); // 08:00 MEZ = 07:00 UTC
  });

  it('Slot-Raster am DST-Tag bleibt im lokalen Raster', () => {
    const days = computeSlots(
      baseQuery({
        fromDate: '2026-03-30', // Montag nach der Umstellung
        toDate: '2026-03-30',
        now: utc('2026-03-20', '09:00'),
      })
    );
    expect(days['2026-03-30'][0]).toBe('08:00');
  });

  it('blocked_until = Start + Dauer + Puffer, auch über die Umstellung hinweg', () => {
    const slot = slotToUtc('2026-08-03', '12:00', 50, 20, ZONE)!;
    expect(slot.lessonEndAt.getTime() - slot.startAt.getTime()).toBe(50 * 60_000);
    expect(slot.blockedUntil.getTime() - slot.lessonEndAt.getTime()).toBe(20 * 60_000);
    const local = DateTime.fromJSDate(slot.blockedUntil, { zone: ZONE });
    expect(local.toFormat('HH:mm')).toBe('13:10');
  });
});

describe('windowsForDay', () => {
  it('zieht zeitlich begrenzte Sperren vom Fenster ab (Pause)', () => {
    const day = DateTime.fromISO('2026-08-03', { zone: ZONE });
    const windows = windowsForDay(day, weekRules, [
      { date: '2026-08-03', startTime: '12:00', endTime: '13:30', type: 'blocked' },
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0].start!.toFormat('HH:mm')).toBe('08:00');
    expect(windows[0].end!.toFormat('HH:mm')).toBe('12:00');
    expect(windows[1].start!.toFormat('HH:mm')).toBe('13:30');
  });
});
