/* E-Mail-Benachrichtigungen. Ohne SMTP-Konfiguration wird nur geloggt
   (ohne unnötige personenbezogene Daten). Die Kundenbestätigung kommt
   primär von Shopify (Bestellbestätigung); diese Mail ergänzt die
   Termindetails und informiert die Betreiberin. */
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { config } from './config.js';

const transporter =
  config.smtp.host && config.smtp.from
    ? nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      })
    : null;

export interface BookingMailData {
  bookingId: number;
  serviceName: string;
  startAt: Date;
  lessonEndAt: Date;
  timezone: string;
  vehicleType: string | null;
  meetingPoint: string | null;
  customerFirstName: string | null;
  customerEmail: string | null;
  orderNumber: string | null;
  manageToken: string;
  contactPhone?: string;
}

function fmt(d: Date, zone: string): { date: string; time: string } {
  const dt = DateTime.fromJSDate(d, { zone }).setLocale('de-CH');
  return { date: dt.toFormat("cccc, d. LLLL yyyy"), time: dt.toFormat('HH:mm') };
}

export async function sendConfirmationMails(data: BookingMailData): Promise<void> {
  const start = fmt(data.startAt, data.timezone);
  const end = fmt(data.lessonEndAt, data.timezone);
  const manageUrl = `${config.publicShopUrl}/apps/booking/manage?token=${data.manageToken}`;
  const icsUrl = `${config.publicShopUrl}/apps/booking/bookings/${data.manageToken}/ics`;

  const detailLines = [
    `Leistung: ${data.serviceName}`,
    `Datum: ${start.date}`,
    `Zeit: ${start.time} – ${end.time} Uhr (${data.timezone})`,
    data.vehicleType ? `Getriebe: ${data.vehicleType === 'automat' ? 'Automat' : 'Handschaltung'}` : null,
    data.meetingPoint ? `Treffpunkt: ${data.meetingPoint}` : null,
    data.orderNumber ? `Bestellnummer: ${data.orderNumber}` : null,
  ].filter(Boolean);

  const customerText = [
    `Hallo ${data.customerFirstName ?? ''}`.trim(),
    '',
    'Dein Termin bei der Fahrschule Türhan ist bestätigt:',
    '',
    ...detailLines,
    '',
    `Termin verwalten (verschieben/stornieren): ${manageUrl}`,
    `Kalendereintrag (.ics): ${icsUrl}`,
    '',
    'Bitte bring deinen gültigen Lernfahrausweis mit.',
    'Verschieben oder stornieren ist bis zur angegebenen Frist online möglich, danach bitte telefonisch.',
    '',
    'Fahrschule Türhan – Mit mir zum Führerschein',
  ].join('\n');

  const operatorText = [
    'Neue bestätigte Buchung:',
    '',
    ...detailLines,
    `Buchungs-ID: ${data.bookingId}`,
    '',
    'Details im Admin-Kalender der Buchungs-App.',
  ].join('\n');

  if (!transporter) {
    // Kein SMTP konfiguriert – nur Ereignis loggen (ohne Kundendaten)
    console.info(`[mail] Buchung ${data.bookingId} bestätigt – SMTP nicht konfiguriert, keine Mail versandt.`);
    return;
  }

  const jobs: Promise<unknown>[] = [];
  if (data.customerEmail) {
    jobs.push(
      transporter.sendMail({
        from: config.smtp.from,
        to: data.customerEmail,
        subject: `Terminbestätigung Fahrstunde – ${start.date}, ${start.time} Uhr`,
        text: customerText,
      })
    );
  }
  if (config.smtp.operator) {
    jobs.push(
      transporter.sendMail({
        from: config.smtp.from,
        to: config.smtp.operator,
        subject: `Neue Buchung ${start.date} ${start.time} – ${data.serviceName}`,
        text: operatorText,
      })
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.error('[mail] Versand fehlgeschlagen:', (r.reason as Error).message);
  }
}

export async function notifyOperator(subject: string, text: string): Promise<void> {
  if (!transporter || !config.smtp.operator) {
    console.info(`[mail] Hinweis an Betreiberin (nicht versandt): ${subject}`);
    return;
  }
  await transporter
    .sendMail({ from: config.smtp.from, to: config.smtp.operator, subject, text })
    .catch((err) => console.error('[mail] Versand fehlgeschlagen:', err.message));
}
