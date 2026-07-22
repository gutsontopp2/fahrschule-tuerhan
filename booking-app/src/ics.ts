/* Erzeugt eine .ics-Kalenderdatei für einen bestätigten Termin. */
import { DateTime } from 'luxon';

export function buildIcs(opts: {
  uid: string;
  startAt: Date;
  endAt: Date;
  summary: string;
  description: string;
  location?: string | null;
}): string {
  const toIcsUtc = (d: Date) => DateTime.fromJSDate(d).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fahrschule Tuerhan//Buchung//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}@fahrschule-tuerhan`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(opts.startAt)}`,
    `DTEND:${toIcsUtc(opts.endAt)}`,
    `SUMMARY:${escape(opts.summary)}`,
    `DESCRIPTION:${escape(opts.description)}`,
    opts.location ? `LOCATION:${escape(opts.location)}` : null,
    'BEGIN:VALARM',
    'TRIGGER:-PT24H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Fahrstunde morgen',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean) as string[];
  return lines.join('\r\n') + '\r\n';
}
