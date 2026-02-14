/**
 * Generates calendar data so customers can add bookings to their
 * personal calendars even if the Google Calendar invitation email
 * doesn't arrive (spam filter, wrong inbox, etc.).
 *
 * Generates RFC 5545 .ics content (works with Apple Calendar, Outlook,
 * Google Calendar, and any other iCalendar-compatible app).
 */

export interface AddToCalendarInput {
  title: string;
  startUtc: Date;
  endUtc: Date;
  description?: string;
  location?: string;
}

/**
 * Format a Date as an iCalendar UTC timestamp: YYYYMMDDTHHmmssZ
 */
function toICalDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escape special characters for iCalendar text fields (RFC 5545 §3.3.11).
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Build RFC 5545 .ics file content for a calendar event.
 *
 * The returned string can be served as `text/calendar` or embedded
 * in a `data:text/calendar` URI for client-side download.
 */
export function buildIcsContent(input: AddToCalendarInput): string {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}@gomomo.ai`;
  const now = toICalDate(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gomomo//AI Receptionist//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${toICalDate(input.startUtc)}`,
    `DTEND:${toICalDate(input.endUtc)}`,
    `SUMMARY:${escapeICalText(input.title)}`,
  ];

  if (input.description) {
    lines.push(`DESCRIPTION:${escapeICalText(input.description)}`);
  }
  if (input.location) {
    lines.push(`LOCATION:${escapeICalText(input.location)}`);
  }

  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.join('\r\n');
}

/**
 * Build a data URI containing the .ics content for client-side download.
 * The frontend can use this directly as an <a href="..."> download link.
 */
export function buildIcsDataUrl(input: AddToCalendarInput): string {
  const icsContent = buildIcsContent(input);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
}
