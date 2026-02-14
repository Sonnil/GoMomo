/**
 * Add-to-Calendar .ics Generator — unit tests.
 *
 * Tests:
 *  1. buildIcsContent produces valid RFC 5545 iCalendar content
 *  2. Content contains correct dates in YYYYMMDDTHHmmssZ format
 *  3. Content includes title/summary
 *  4. Content includes description when provided
 *  5. Content includes location when provided
 *  6. Content omits location when not provided
 *  7. buildIcsDataUrl produces a valid data: URI
 *  8. Handles special characters (escaping)
 */

import { describe, it, expect } from 'vitest';
import { buildIcsContent, buildIcsDataUrl } from '../src/utils/add-to-calendar.js';

describe('buildIcsContent', () => {
  const baseInput = {
    title: 'Deep Tissue Massage',
    startUtc: new Date('2026-02-15T14:00:00.000Z'),
    endUtc: new Date('2026-02-15T15:00:00.000Z'),
    description: 'Ref: APT-ABC123\nPhone: +15551234567\nBooked via gomomo.ai',
  };

  it('produces valid iCalendar content', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:-//Gomomo//AI Receptionist//EN');
  });

  it('contains correct UTC dates in YYYYMMDDTHHmmssZ format', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).toContain('DTSTART:20260215T140000Z');
    expect(ics).toContain('DTEND:20260215T150000Z');
  });

  it('includes title as SUMMARY', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).toContain('SUMMARY:Deep Tissue Massage');
  });

  it('includes description in DESCRIPTION field', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).toContain('DESCRIPTION:');
    expect(ics).toContain('Ref');
    expect(ics).toContain('Phone');
  });

  it('includes location when provided', () => {
    const ics = buildIcsContent({
      ...baseInput,
      location: '123 Main St, Suite 4',
    });
    expect(ics).toContain('LOCATION:123 Main St\\, Suite 4');
  });

  it('omits location when not provided', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).not.toContain('LOCATION:');
  });

  it('escapes special characters in title', () => {
    const ics = buildIcsContent({
      ...baseInput,
      title: 'Massage & Spa; "Deluxe"',
    });
    expect(ics).toContain('SUMMARY:Massage & Spa\\; "Deluxe"');
  });

  it('includes STATUS:CONFIRMED', () => {
    const ics = buildIcsContent(baseInput);
    expect(ics).toContain('STATUS:CONFIRMED');
  });
});

describe('buildIcsDataUrl', () => {
  const baseInput = {
    title: 'Deep Tissue Massage',
    startUtc: new Date('2026-02-15T14:00:00.000Z'),
    endUtc: new Date('2026-02-15T15:00:00.000Z'),
  };

  it('produces a valid data: URI with text/calendar MIME type', () => {
    const url = buildIcsDataUrl(baseInput);
    expect(url).toMatch(/^data:text\/calendar;charset=utf-8,/);
  });

  it('contains encoded iCalendar content', () => {
    const url = buildIcsDataUrl(baseInput);
    const decoded = decodeURIComponent(url.replace('data:text/calendar;charset=utf-8,', ''));
    expect(decoded).toContain('BEGIN:VCALENDAR');
    expect(decoded).toContain('SUMMARY:Deep Tissue Massage');
  });
});
