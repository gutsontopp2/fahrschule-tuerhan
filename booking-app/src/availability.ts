/* ============================================================
   Slot-Berechnung – reine Logik, ohne Datenbankzugriff.
   Alle Berechnungen laufen in der Zeitzone Europe/Zurich
   (Luxon behandelt Sommer-/Winterzeit korrekt); Ergebnisse
   sind UTC-Zeitpunkte (JS Date).
   ============================================================ */
import { DateTime, Interval } from 'luxon';

export interface Rule {
  weekday: number; // 1 = Montag … 7 = Sonntag (ISO)
  startTime: string; // 'HH:MM'
  endTime: string;
  active: boolean;
}

export interface ExceptionRow {
  date: string; // 'YYYY-MM-DD'
  startTime: string | null;
  endTime: string | null;
  type: 'available' | 'blocked' | 'holiday' | 'vacation';
}

export interface BusyInterval {
  /** Beginn der Sperre (Unterrichtsbeginn bzw. Blockbeginn) */
  start: Date;
  /** Ende der Sperre inklusive Puffer */
  end: Date;
}

export interface SlotQuery {
  /** Erster Tag (inklusive), 'YYYY-MM-DD' in lokaler Zeit */
  fromDate: string;
  /** Letzter Tag (inklusive) */
  toDate: string;
  durationMinutes: number;
  bufferMinutes: number;
  timezone: string;
  rules: Rule[];
  exceptions: ExceptionRow[];
  /** Aktive Buchungen/Blöcke (held, confirmed, blocked) inkl. Puffer */
  busy: BusyInterval[];
  /** Manuell freigegebene Startzeiten (UTC) */
  manualStarts: Date[];
  /** «Jetzt» für Vorlauf-Berechnung (Test-Injektion) */
  now: Date;
  minLeadMinutes: number;
  maxAdvanceDays: number;
}

export interface DaySlots {
  [isoDate: string]: string[]; // ['08:00', '09:10', …] lokale Zeit
}

function parseTime(dt: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/** Arbeitsfenster eines Tages unter Berücksichtigung der Ausnahmen. */
export function windowsForDay(
  day: DateTime,
  rules: Rule[],
  exceptions: ExceptionRow[]
): Interval[] {
  const isoDate = day.toISODate()!;
  const dayExceptions = exceptions.filter((e) => e.date === isoDate);

  // Ganztägige Sperre (Urlaub/Feiertag/Block ohne Uhrzeit) → Tag geschlossen
  const fullDayBlock = dayExceptions.some(
    (e) => e.type !== 'available' && e.startTime === null
  );
  if (fullDayBlock) return [];

  // 'available'-Ausnahmen ersetzen an diesem Tag die Wochenregeln
  const availableExceptions = dayExceptions.filter(
    (e) => e.type === 'available' && e.startTime && e.endTime
  );

  let windows: Interval[];
  if (availableExceptions.length > 0) {
    windows = availableExceptions.map((e) =>
      Interval.fromDateTimes(parseTime(day, e.startTime!), parseTime(day, e.endTime!))
    );
  } else {
    windows = rules
      .filter((r) => r.active && r.weekday === day.weekday)
      .map((r) => Interval.fromDateTimes(parseTime(day, r.startTime), parseTime(day, r.endTime)));
  }

  // Zeitlich begrenzte Sperren vom Fenster abziehen
  const blocks = dayExceptions
    .filter((e) => e.type !== 'available' && e.startTime && e.endTime)
    .map((e) => Interval.fromDateTimes(parseTime(day, e.startTime!), parseTime(day, e.endTime!)));

  for (const block of blocks) {
    windows = windows.flatMap((w) => w.difference(block));
  }

  return windows
    .filter((w): w is Interval => w !== null && w.isValid && !w.isEmpty())
    .sort((a, b) => a.start!.toMillis() - b.start!.toMillis());
}

function overlapsBusy(startMs: number, endMs: number, busy: BusyInterval[]): BusyInterval | null {
  for (const b of busy) {
    if (startMs < b.end.getTime() && b.start.getTime() < endMs) return b;
  }
  return null;
}

/**
 * Berechnet buchbare Startzeiten pro Tag.
 *
 * Automatische Slots werden gierig erzeugt: Beginn am Fensteranfang,
 * Schrittweite = Dauer + Puffer. Kollidiert ein Kandidat mit einer
 * bestehenden Buchung (inkl. deren Puffer), springt die Erzeugung auf
 * deren Sperr-Ende (blocked_until). Nach einer Buchung 12:00–12:50 mit
 * 20 Min Puffer ist der nächste angebotene Termin somit 13:10.
 *
 * Ein Slot wird nur angeboten, wenn Unterricht UND vollständiger Puffer
 * frei sind; der Unterricht muss vollständig im Arbeitsfenster liegen.
 */
export function computeSlots(q: SlotQuery): DaySlots {
  const zone = q.timezone;
  const now = DateTime.fromJSDate(q.now, { zone });
  const earliestStart = now.plus({ minutes: q.minLeadMinutes });
  const latestStart = now.plus({ days: q.maxAdvanceDays }).endOf('day');

  const from = DateTime.fromISO(q.fromDate, { zone }).startOf('day');
  const to = DateTime.fromISO(q.toDate, { zone }).startOf('day');
  const result: DaySlots = {};
  if (!from.isValid || !to.isValid || to < from) return result;

  const stepMs = (q.durationMinutes + q.bufferMinutes) * 60_000;
  const durationMs = q.durationMinutes * 60_000;

  // Manuelle Startzeiten nach lokalem Datum gruppieren
  const manualByDay = new Map<string, DateTime[]>();
  for (const m of q.manualStarts) {
    const local = DateTime.fromJSDate(m, { zone });
    const key = local.toISODate()!;
    if (!manualByDay.has(key)) manualByDay.set(key, []);
    manualByDay.get(key)!.push(local);
  }

  for (let day = from; day <= to; day = day.plus({ days: 1 })) {
    const isoDate = day.toISODate()!;
    // Vergangene Tage überspringen
    if (day.endOf('day') < now) continue;

    const slots = new Set<number>(); // Start als epoch ms

    const acceptCandidate = (start: DateTime): boolean => {
      const startMs = start.toMillis();
      const blockEndMs = startMs + durationMs + q.bufferMinutes * 60_000;
      if (start < earliestStart || start > latestStart) return false;
      if (overlapsBusy(startMs, blockEndMs, q.busy)) return false;
      return true;
    };

    // 1) Automatische Slots aus den Arbeitsfenstern
    for (const window of windowsForDay(day, q.rules, q.exceptions)) {
      let t: DateTime = window.start!;
      const windowEnd = window.end!;
      // Schutz vor Endlosschleifen bei degenerierten Daten
      let guard = 0;
      while (t.plus({ milliseconds: durationMs }) <= windowEnd && guard++ < 200) {
        const startMs = t.toMillis();
        const blockEnd = startMs + durationMs + q.bufferMinutes * 60_000;
        const conflict = overlapsBusy(startMs, blockEnd, q.busy);
        if (conflict) {
          // Auf das Sperr-Ende der Kollision springen (z. B. 13:10)
          const next = DateTime.fromJSDate(conflict.end, { zone });
          t = next > t ? next : t.plus({ milliseconds: stepMs });
          continue;
        }
        if (acceptCandidate(t)) slots.add(startMs);
        t = t.plus({ milliseconds: stepMs });
      }
    }

    // 2) Manuell freigegebene Startzeiten (unterliegen denselben Prüfungen
    //    gegen Buchungen/Vorlauf, aber nicht den Arbeitsfenstern)
    for (const manual of manualByDay.get(isoDate) ?? []) {
      if (acceptCandidate(manual)) slots.add(manual.toMillis());
    }

    if (slots.size > 0) {
      result[isoDate] = [...slots]
        .sort((a, b) => a - b)
        .map((ms) => DateTime.fromMillis(ms, { zone }).toFormat('HH:mm'));
    }
  }

  return result;
}

/**
 * Rechnet eine lokale Terminwahl (Datum + Uhrzeit, Europe/Zurich) in
 * UTC-Zeitpunkte um. Ungültige lokale Zeiten (Sommerzeit-Lücke) werden
 * abgelehnt.
 */
export function slotToUtc(
  date: string,
  time: string,
  durationMinutes: number,
  bufferMinutes: number,
  zone: string
): { startAt: Date; lessonEndAt: Date; blockedUntil: Date } | null {
  const start = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!start.isValid) return null;
  // DST-Lücke: Luxon verschiebt ungültige Zeiten; wir verlangen exakte Übereinstimmung
  if (start.toFormat('HH:mm') !== time) return null;
  const lessonEnd = start.plus({ minutes: durationMinutes });
  const blockedUntil = lessonEnd.plus({ minutes: bufferMinutes });
  return {
    startAt: start.toUTC().toJSDate(),
    lessonEndAt: lessonEnd.toUTC().toJSDate(),
    blockedUntil: blockedUntil.toUTC().toJSDate(),
  };
}
