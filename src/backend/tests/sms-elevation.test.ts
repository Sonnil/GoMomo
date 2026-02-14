// ============================================================
// SMS Channel Elevation Tests
//
// Verifies the fixes/improvements for pilot-ready SMS:
//  1. formatForSms strips markdown, converts bullets to numbers
//  2. System prompt changes when channel='sms' vs default
//  3. Rate limit repo: checkInbound separate from check (outbound)
//  4. Rate limit repo: record accepts direction parameter
//  5. PostProcessorContext accepts channel
// ============================================================

import { describe, it, expect } from 'vitest';

// ── 1. SMS Formatting ─────────────────────────────────────

describe('formatForSms', () => {
  let formatForSms: (text: string) => string;

  beforeAll(async () => {
    const mod = await import('../src/agent/response-post-processor.js');
    formatForSms = mod.formatForSms;
  });

  it('strips markdown bold', () => {
    expect(formatForSms('Here are your **options**:')).toBe('Here are your options:');
  });

  it('strips markdown double underscore bold', () => {
    expect(formatForSms('__Important:__ Book now')).toBe('Important: Book now');
  });

  it('converts markdown bullet lists to numbered lists', () => {
    const input = '- 9:00 AM\n- 10:00 AM\n- 11:00 AM';
    const result = formatForSms(input);
    expect(result).toContain('1) 9:00 AM');
    expect(result).toContain('2) 10:00 AM');
    expect(result).toContain('3) 11:00 AM');
    expect(result).not.toContain('- 9:00');
  });

  it('converts markdown headers to uppercase', () => {
    expect(formatForSms('## Available Times')).toBe('AVAILABLE TIMES');
    expect(formatForSms('### Booking Details')).toBe('BOOKING DETAILS');
  });

  it('collapses excessive newlines', () => {
    expect(formatForSms('Hello\n\n\n\n\nWorld')).toBe('Hello\n\nWorld');
  });

  it('preserves normal text unchanged', () => {
    expect(formatForSms('Hi! How can I help you today?')).toBe('Hi! How can I help you today?');
  });

  it('handles mixed formatting in a realistic response', () => {
    const input = `**Available Times:**
- 9:00 AM
- 10:00 AM
- 11:00 AM

Which time works best?`;
    const result = formatForSms(input);
    expect(result).toContain('Available Times:');
    expect(result).not.toContain('**');
    expect(result).toContain('1) 9:00 AM');
    expect(result).toContain('Which time works best?');
  });
});

// ── 2. postProcessResponse with SMS channel ───────────────

describe('postProcessResponse with channel=sms', () => {
  it('applies formatForSms when channel is sms', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = '**Your booking:** confirmed\n- Date: Feb 10\n- Time: 9:00 AM';
    const result = postProcessResponse(input, { toolsUsed: ['confirm_booking'], channel: 'sms' });
    expect(result).not.toContain('**');
    expect(result).toContain('1) Date: Feb 10');
  });

  it('does NOT apply SMS formatting for web channel', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = '**Your options:**\n- 9:00 AM\n- 10:00 AM';
    const result = postProcessResponse(input, { toolsUsed: [], channel: 'web' });
    // Web channel should preserve markdown
    expect(result).toContain('**');
    expect(result).toContain('- 9:00 AM');
  });

  it('does NOT apply SMS formatting when channel is undefined', async () => {
    const { postProcessResponse } = await import('../src/agent/response-post-processor.js');
    const input = '**Hello world**';
    const result = postProcessResponse(input, { toolsUsed: [] });
    expect(result).toContain('**');
  });
});

// ── 3. System prompt SMS section ──────────────────────────

describe('System prompt channel awareness', () => {
  const mockTenant = {
    id: 'test-tenant',
    name: 'Test Biz',
    timezone: 'America/New_York',
    business_hours: {
      monday: { start: '09:00', end: '17:00' },
      tuesday: { start: '09:00', end: '17:00' },
      wednesday: { start: '09:00', end: '17:00' },
      thursday: { start: '09:00', end: '17:00' },
      friday: { start: '09:00', end: '17:00' },
      saturday: null,
      sunday: null,
    },
    services: [{ name: 'Consultation', duration: 30 }],
  } as any;

  it('uses STRONGER SMS rules when channel=sms', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant, { channel: 'sms' });

    expect(prompt).toContain('THIS CONVERSATION IS HAPPENING VIA SMS');
    expect(prompt).toContain('MAXIMUM 3 short sentences');
    expect(prompt).toContain('numbered list');
    expect(prompt).toContain('Reply with the number');
    expect(prompt).toContain('Do NOT ask for name and email in separate messages');
  });

  it('uses WEAKER SMS rules when channel is undefined (web)', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const prompt = buildSystemPrompt(mockTenant);

    expect(prompt).not.toContain('THIS CONVERSATION IS HAPPENING VIA SMS');
    expect(prompt).toContain('This conversation may arrive via SMS');
  });

  it('still includes STOP/START guidance in both modes', async () => {
    const { buildSystemPrompt } = await import('../src/agent/system-prompt.js');
    const webPrompt = buildSystemPrompt(mockTenant);
    const smsPrompt = buildSystemPrompt(mockTenant, { channel: 'sms' });

    expect(webPrompt).toContain('STOP');
    expect(smsPrompt).toContain('STOP');
    expect(webPrompt).toContain('START');
    expect(smsPrompt).toContain('START');
  });
});

// ── 4. Rate limit repo API ────────────────────────────────

describe('smsRateLimitRepo API shape', () => {
  it('exports check, checkInbound, record, and cleanup', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/repos/sms-rate-limit.repo.ts'),
      'utf-8',
    );
    expect(src).toContain('async check(');
    expect(src).toContain('async checkInbound(');
    expect(src).toContain('async record(');
    expect(src).toContain('async cleanup(');
  });

  it('checkInbound uses SMS_INBOUND_RATE_LIMIT_MAX', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/repos/sms-rate-limit.repo.ts'),
      'utf-8',
    );
    expect(src).toContain('SMS_INBOUND_RATE_LIMIT_MAX');
    expect(src).toContain('SMS_INBOUND_RATE_LIMIT_WINDOW_MINUTES');
  });

  it('check (outbound) filters by direction=outbound', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/repos/sms-rate-limit.repo.ts'),
      'utf-8',
    );
    // The outbound check should filter on direction
    const checkBlock = src.split('async check(')[1].split('async checkInbound')[0];
    expect(checkBlock).toContain("direction = 'outbound'");
  });

  it('checkInbound filters by direction=inbound', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/repos/sms-rate-limit.repo.ts'),
      'utf-8',
    );
    const checkBlock = src.split('async checkInbound(')[1].split('async record')[0];
    expect(checkBlock).toContain("direction = 'inbound'");
  });

  it('record accepts direction parameter with default outbound', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/repos/sms-rate-limit.repo.ts'),
      'utf-8',
    );
    expect(src).toContain("direction: 'inbound' | 'outbound' = 'outbound'");
  });
});

// ── 5. Inbound SMS route uses checkInbound ────────────────

describe('Inbound SMS route rate limit integration', () => {
  it('uses checkInbound (not check) for inbound rate limiting', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/voice/inbound-sms.routes.ts'),
      'utf-8',
    );
    expect(src).toContain('smsRateLimitRepo.checkInbound(');
    expect(src).toContain("record(fromPhone, tenant.id, 'inbound')");
  });

  it('passes channel=sms to handleChatMessage', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/voice/inbound-sms.routes.ts'),
      'utf-8',
    );
    expect(src).toContain("channel: 'sms'");
  });

  it('has SMS debug logging gated by SMS_DEBUG', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/voice/inbound-sms.routes.ts'),
      'utf-8',
    );
    expect(src).toContain("SMS_DEBUG === 'true'");
    expect(src).toContain('[sms-debug]');
    // PII-safe: uses phone prefix, not full number
    expect(src).toContain('fromPhone.slice(0, 6)');
  });
});

// ── 6. env.ts has new SMS config ──────────────────────────

describe('env.ts SMS configuration', () => {
  it('has SMS_INBOUND_RATE_LIMIT_MAX with default 20', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/config/env.ts'),
      'utf-8',
    );
    expect(src).toContain('SMS_INBOUND_RATE_LIMIT_MAX');
    expect(src).toContain('.default(20)');
  });

  it('has SMS_DEBUG toggle', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/config/env.ts'),
      'utf-8',
    );
    expect(src).toContain('SMS_DEBUG');
  });
});

// ── 7. Migration 011 ─────────────────────────────────────

describe('Migration 011 schema', () => {
  it('adds direction column to sms_rate_limits', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sql = await fs.readFile(
      path.resolve(import.meta.dirname ?? '.', '../src/db/migrations/011_sms_channel_elevation.sql'),
      'utf-8',
    );
    expect(sql).toContain('direction');
    expect(sql).toContain('sms_rate_limits');
    expect(sql).toContain('idx_sms_rate_limits_phone_dir_sent');
  });
});

// ── Imports ───────────────────────────────────────────────
import { beforeAll } from 'vitest';
