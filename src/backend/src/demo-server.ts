/**
 * ═══════════════════════════════════════════════════════════════
 *  gomomo.ai — DEMO MODE SERVER
 * ═══════════════════════════════════════════════════════════════
 *
 *  A visually impressive, human-like AI agent demo server
 *  designed for investor / stakeholder presentations.
 *
 *  Features:
 *  • NLU-lite fuzzy intent detection (no LLM needed)
 *  • Dynamic slot generation based on real calendar math
 *  • Personality: warm, professional, subtly witty
 *  • Realistic typing delays proportional to response length
 *  • Markdown-rich responses with emoji
 *  • Multi-turn conversational memory
 *  • Compatible with the real MVP architecture (same API surface)
 *
 *  Run:
 *    npx tsx src/demo-server.ts
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = Number(process.env.PORT ?? 3000);

// ─── Business Configuration ──────────────────────────────────────
const BUSINESS = {
  id: 'demo-tenant-001',
  name: 'Gomomo',
  slug: 'gomomo',
  timezone: 'America/New_York',
  slot_duration: 30,
  tagline: 'AI receptionists for every business',
  address: '247 Park Avenue, Suite 400, New York, NY 10167',
  phone: '(212) 555-0147',
  business_hours: {
    monday:    { start: '09:00', end: '18:00' },
    tuesday:   { start: '09:00', end: '18:00' },
    wednesday: { start: '09:00', end: '18:00' },
    thursday:  { start: '09:00', end: '20:00' },
    friday:    { start: '09:00', end: '17:00' },
    saturday:  { start: '10:00', end: '14:00' },
    sunday:    null,
  },
  services: [
    { name: 'Demo Consultation',     duration: 30, price: '$80',  description: 'Standard appointment — demonstrates the booking flow' },
    { name: 'Follow-up Appointment', duration: 20, price: '$50',  description: 'Progress check — demonstrates rescheduling' },
    { name: 'Extended Session',      duration: 60, price: '$150', description: 'Longer appointment — demonstrates multi-slot booking' },
  ],
  practitioners: [
    { name: 'Dr. Sarah Chen',     title: 'Lead Practitioner',  specialties: ['demo', 'general'] },
    { name: 'Dr. James Martinez', title: 'Specialist',         specialties: ['extended', 'follow-up'] },
    { name: 'Dr. Aisha Patel',    title: 'Consultant',         specialties: ['general', 'demo'] },
  ],
};

// ─── Natural Date Parsing ────────────────────────────────────────
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseNaturalDate(text: string): Date | null {
  const lower = text.toLowerCase().trim();
  const now = new Date();

  if (lower.includes('today')) return now;
  if (lower.includes('tomorrow')) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return d;
  }
  if (lower.includes('day after tomorrow')) {
    const d = new Date(now); d.setDate(d.getDate() + 2); return d;
  }

  // "next monday", "this friday", etc.
  const dayMatch = lower.match(/(?:next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (dayMatch) {
    const targetDay = DAYS.indexOf(dayMatch[1].toLowerCase());
    const d = new Date(now);
    const currentDay = d.getDay();
    let diff = targetDay - currentDay;
    if (diff <= 0) diff += 7;
    if (lower.includes('next') && diff <= 7) diff += (diff === 0 ? 7 : 0);
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Just day name: "Monday", "Friday"
  const justDay = lower.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (justDay) {
    const targetDay = DAYS.indexOf(justDay[1].toLowerCase());
    const d = new Date(now);
    let diff = targetDay - d.getDay();
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // "in X days"
  const inDays = lower.match(/in\s+(\d+)\s+days?/i);
  if (inDays) {
    const d = new Date(now); d.setDate(d.getDate() + parseInt(inDays[1])); return d;
  }

  // "next week"
  if (lower.includes('next week')) {
    const d = new Date(now); d.setDate(d.getDate() + 7); return d;
  }

  // "Feb 10", "February 10", "2/10", "02/10"
  const monthDayMatch = lower.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/);
  if (monthDayMatch) {
    const monthIdx = MONTHS.indexOf(monthDayMatch[1].toLowerCase().slice(0, 3).padEnd(3, monthDayMatch[1].toLowerCase().slice(3)));
    const fullMonthIdx = MONTHS.findIndex(m => m.startsWith(monthDayMatch[1].toLowerCase().slice(0, 3)));
    if (fullMonthIdx !== -1) {
      const d = new Date(now.getFullYear(), fullMonthIdx, parseInt(monthDayMatch[2]));
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  const slashDate = lower.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slashDate) {
    const month = parseInt(slashDate[1]) - 1;
    const day = parseInt(slashDate[2]);
    const year = slashDate[3] ? (parseInt(slashDate[3]) < 100 ? 2000 + parseInt(slashDate[3]) : parseInt(slashDate[3])) : now.getFullYear();
    return new Date(year, month, day);
  }

  return null;
}

// ─── Mock Availability Engine ────────────────────────────────────
function generateSlots(date: Date): { time: string; display: string; available: boolean }[] {
  const dayName = DAYS[date.getDay()] as keyof typeof BUSINESS.business_hours;
  const hours = BUSINESS.business_hours[dayName];
  if (!hours) return [];

  const [startH] = hours.start.split(':').map(Number);
  const [endH] = hours.end.split(':').map(Number);

  const slots: { time: string; display: string; available: boolean }[] = [];
  // Seed pseudo-random from date to keep consistent per-date
  const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();

  for (let h = startH; h < endH; h++) {
    for (const m of [0, 30]) {
      if (h === endH - 1 && m === 30) continue; // don't offer last half hour
      const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const display = `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`;

      // ~35% of slots are "taken" — deterministic per slot
      const hash = (seed * 31 + h * 7 + m) % 100;
      const available = hash > 35;

      slots.push({ time: timeStr, display, available });
    }
  }
  return slots;
}

function formatDateNice(date: Date): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function generateRefCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'BW-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Intent Detection ────────────────────────────────────────────
type Intent = 'greet' | 'book' | 'reschedule' | 'cancel' | 'hours' | 'services' | 'location' | 'thanks' | 'bye' | 'help' | 'unknown';

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|sup|yo)\b/.test(t)) return 'greet';
  if (/\b(book|schedule|appointment|reserve|make|set\s*up|new\s*appointment)\b/.test(t)) return 'book';
  if (/\b(reschedule|move|change|different\s*time|switch)\b/.test(t)) return 'reschedule';
  if (/\b(cancel|delete|remove|void|withdraw)\b/.test(t)) return 'cancel';
  if (/\b(hours|open|close|when|operating|available\s*hours)\b/.test(t)) return 'hours';
  if (/\b(services?|offer|treatments?|what\s*do\s*you|menu|options|pricing|prices?|how\s*much)\b/.test(t)) return 'services';
  if (/\b(where|address|location|directions?|find\s*you|located)\b/.test(t)) return 'location';
  if (/\b(thanks?|thank\s*you|thx|appreciate|perfect|great|awesome|wonderful)\b/.test(t)) return 'thanks';
  if (/\b(bye|goodbye|see\s*ya|later|have\s*a\s*good|take\s*care|that'?s?\s*all)\b/.test(t)) return 'bye';
  if (/\b(help|assist|support|what\s*can\s*you)\b/.test(t)) return 'help';
  return 'unknown';
}

function detectServiceFromText(text: string): typeof BUSINESS.services[0] | null {
  const t = text.toLowerCase();
  if (/\b(initial|first|new\s*patient|comprehensive|general|consult)\b/.test(t)) return BUSINESS.services[0];
  if (/\b(follow[- ]?up|check[- ]?up|revisit|progress)\b/.test(t)) return BUSINESS.services[1];
  if (/\b(extended|in[- ]?depth|complex|long)\b/.test(t)) return BUSINESS.services[2];
  // Check by number selection
  const numMatch = text.match(/^\s*(\d)\s*$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (idx >= 0 && idx < BUSINESS.services.length) return BUSINESS.services[idx];
  }
  return null;
}

function detectTimeFromText(text: string): string | null {
  const t = text.toLowerCase();
  // "2pm", "2:30pm", "14:00", "2:30 pm", "2 pm"
  const match = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (match) {
    let hour = parseInt(match[1]);
    const min = parseInt(match[2] ?? '0');
    const ampm = match[3]?.replace('.', '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour >= 7 && hour <= 20) {
      return `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
    }
  }
  return null;
}

function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function looksLikeName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 5 && words.every(w => /^[a-zA-Z'-]+$/.test(w));
}

// ─── Conversation Engine ─────────────────────────────────────────
type Stage =
  | 'idle'
  | 'ask_service'
  | 'ask_date'
  | 'show_slots'
  | 'ask_time'
  | 'ask_name'
  | 'ask_email'
  | 'confirm_details'
  | 'confirmed'
  | 'ask_ref_for_cancel'
  | 'confirm_cancel'
  | 'ask_ref_for_reschedule'
  | 'ask_new_date'
  | 'ask_new_time';

interface Session {
  stage: Stage;
  service: typeof BUSINESS.services[0] | null;
  date: Date | null;
  time: string | null;
  timeDisplay: string | null;
  name: string | null;
  email: string | null;
  refCode: string | null;
  slots: ReturnType<typeof generateSlots>;
  appointmentRef: string | null;
  messageCount: number;
}

function newSession(): Session {
  return {
    stage: 'idle', service: null, date: null, time: null, timeDisplay: null,
    name: null, email: null, refCode: null, slots: [], appointmentRef: null, messageCount: 0,
  };
}

const sessions = new Map<string, Session>();

function getSession(id: string): Session {
  if (!sessions.has(id)) sessions.set(id, newSession());
  return sessions.get(id)!;
}

// ─── Response Generator ─────────────────────────────────────────
function respond(sessionId: string, userMsg: string): string {
  // Handle auto-greet on first connection
  if (userMsg === '__auto_greet__') {
    const s = getSession(sessionId);
    if (s.messageCount === 0) {
      s.messageCount = 1;
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      return `${greeting}! 👋 Welcome to **${BUSINESS.name}**.\n\n_${BUSINESS.tagline}_\n\nI'm Gomomo, and I'd love to help you today. You can:\n\n• 📅 **Book** an appointment\n• 🔄 **Reschedule** an existing one\n• ❌ **Cancel** a booking\n• 📋 View our **services & pricing**\n• 🕐 Check our **hours**\n\nWhat can I do for you?`;
    }
    return '';
  }

  const s = getSession(sessionId);
  s.messageCount++;
  const intent = detectIntent(userMsg);

  // ── Global handlers (work from any stage) ──
  if (intent === 'hours') {
    const lines = Object.entries(BUSINESS.business_hours).map(([day, h]) => {
      const dayTitle = day.charAt(0).toUpperCase() + day.slice(1);
      return h ? `  ${dayTitle}: ${h.start} – ${h.end}` : `  ${dayTitle}: Closed`;
    });
    return `Here are our hours at **${BUSINESS.name}** 🕐\n\n${lines.join('\n')}\n\n*All times are Eastern (ET).* Would you like to book an appointment?`;
  }

  if (intent === 'services') {
    const lines = BUSINESS.services.map((svc, i) =>
      `**${i + 1}. ${svc.name}** (${svc.duration} min · ${svc.price})\n   _${svc.description}_`
    );
    return `We'd love to help you find the right fit! Here's what we offer:\n\n${lines.join('\n\n')}\n\nWhich service interests you? You can say the name or number.`;
  }

  if (intent === 'location') {
    return `📍 **${BUSINESS.name}**\n${BUSINESS.address}\n📞 ${BUSINESS.phone}\n\nWe're right across from Grand Central — easy to get to by subway or cab! Is there anything else I can help with?`;
  }

  if (intent === 'thanks') {
    const responses = [
      `You're so welcome! 😊 Is there anything else I can help you with?`,
      `Happy to help! Let me know if you need anything else.`,
      `My pleasure! Don't hesitate to reach out anytime.`,
      `Of course! Is there anything else on your mind?`,
    ];
    return responses[s.messageCount % responses.length];
  }

  if (intent === 'bye') {
    sessions.delete(sessionId);
    return `Have a wonderful day! 🌟 We look forward to seeing you at **${BUSINESS.name}**. Take care!`;
  }

  if (intent === 'help') {
    return `I'm here to make things easy! I can help you with:\n\n• 📅 **Book** a new appointment\n• 🔄 **Reschedule** an existing one\n• ❌ **Cancel** a booking\n• 🕐 Check our **hours**\n• 📋 View our **services & pricing**\n• 📍 Get our **location**\n\nWhat would you like to do?`;
  }

  // ── Cancel flow ──
  if (intent === 'cancel' && s.stage === 'idle') {
    s.stage = 'ask_ref_for_cancel';
    return `I can help with that. Could you please share your **booking reference code**? It starts with "BW-" and was included in your confirmation.`;
  }

  if (s.stage === 'ask_ref_for_cancel') {
    const ref = userMsg.trim().toUpperCase();
    if (/^BW-[A-Z0-9]{6}$/.test(ref)) {
      s.appointmentRef = ref;
      s.stage = 'confirm_cancel';
      return `I found the booking **${ref}**.\n\n> **General Consultation**\n> Thursday, February 12, 2026 at 2:00 PM\n> Dr. Sarah Chen\n\nAre you sure you'd like to cancel this appointment? (yes/no)`;
    }
    return `Hmm, that doesn't look like a valid reference code. It should look like **BW-ABC123**. Could you double-check?`;
  }

  if (s.stage === 'confirm_cancel') {
    if (/\b(yes|yeah|yep|sure|confirm|do it)\b/i.test(userMsg)) {
      const ref = s.appointmentRef;
      sessions.delete(sessionId);
      return `✅ **Appointment Cancelled**\n\nYour booking **${ref}** has been cancelled. You'll receive a confirmation email shortly.\n\nIf you change your mind, we're always here to help you rebook. Take care! 💙`;
    }
    s.stage = 'idle';
    return `No problem — your appointment stays as is! Is there anything else I can help with?`;
  }

  // ── Reschedule flow ──
  if (intent === 'reschedule' && s.stage === 'idle') {
    s.stage = 'ask_ref_for_reschedule';
    return `Sure! I'll help you find a new time. Could you please share your **booking reference code** (starts with "BW-")?`;
  }

  if (s.stage === 'ask_ref_for_reschedule') {
    const ref = userMsg.trim().toUpperCase();
    if (/^BW-[A-Z0-9]{6}$/.test(ref)) {
      s.appointmentRef = ref;
      s.stage = 'ask_new_date';
      return `Found it! ✅ Your current appointment:\n\n> **Follow-up Appointment** — Thursday, February 12 at 10:00 AM\n\nWhat date would you like to move it to?`;
    }
    return `That doesn't look quite right. Reference codes look like **BW-ABC123**. Could you check again?`;
  }

  if (s.stage === 'ask_new_date') {
    const date = parseNaturalDate(userMsg);
    if (date) {
      s.date = date;
      const dayName = DAYS[date.getDay()] as keyof typeof BUSINESS.business_hours;
      if (!BUSINESS.business_hours[dayName]) {
        return `We're closed on ${DAYS[date.getDay()].charAt(0).toUpperCase() + DAYS[date.getDay()].slice(1)}s. How about a weekday or Saturday?`;
      }
      s.slots = generateSlots(date);
      const available = s.slots.filter(sl => sl.available);
      if (available.length === 0) return `Unfortunately, ${formatDateNice(date)} is fully booked. Would you like to try a different day?`;

      const display = available.slice(0, 8).map(sl => `  🟢 ${sl.display}`).join('\n');
      s.stage = 'ask_new_time';
      return `Here's what's open on **${formatDateNice(date)}**:\n\n${display}${available.length > 8 ? `\n  _…and ${available.length - 8} more_` : ''}\n\nWhich time works for you?`;
    }
    return `I didn't catch that date. You can say things like **"next Thursday"**, **"Feb 15"**, or **"tomorrow"**.`;
  }

  if (s.stage === 'ask_new_time') {
    const time = detectTimeFromText(userMsg);
    if (time) {
      const slot = s.slots.find(sl => sl.time === time && sl.available);
      if (slot) {
        const newRef = generateRefCode();
        const dateStr = formatDateNice(s.date!);
        sessions.delete(sessionId);
        return `🔄 **Appointment Rescheduled!**\n\n` +
          `📋 **New Reference:** ${newRef}\n` +
          `📅 **Date:** ${dateStr}\n` +
          `🕐 **Time:** ${slot.display} ET\n` +
          `_Old booking ${s.appointmentRef} has been cancelled._\n\n` +
          `You'll receive updated confirmation details by email. See you then! ✨`;
      }
      return `That time isn't available. Could you pick one of the green slots listed above?`;
    }
    return `Just tell me the time — for example, **"2:30 PM"** or **"10 AM"**.`;
  }

  // ── Booking flow ──
  if ((intent === 'book' || intent === 'greet') && s.stage === 'idle') {
    if (intent === 'greet' && s.messageCount <= 1) {
      s.stage = 'idle';
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      return `${greeting}! 👋 Welcome to **${BUSINESS.name}** — ${BUSINESS.tagline}.\n\nI'm here to help you with anything you need:\n\n• 📅 **Book** an appointment\n• 🔄 **Reschedule** an existing one\n• ❌ **Cancel** a booking\n• 📋 View **services & pricing**\n\nWhat can I do for you today?`;
    }

    s.stage = 'ask_service';
    const lines = BUSINESS.services.map((svc, i) =>
      `**${i + 1}. ${svc.name}** — ${svc.duration} min · ${svc.price}`
    );
    return `Wonderful! Let's get you booked. 📅\n\nWhich service are you looking for?\n\n${lines.join('\n')}\n\n_You can say the name, number, or describe what you need._`;
  }

  if (s.stage === 'idle' && intent === 'greet') {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `${greeting}! 👋 Welcome to **${BUSINESS.name}** — ${BUSINESS.tagline}.\n\nI can help you:\n\n• 📅 **Book** an appointment\n• 🔄 **Reschedule** an existing one\n• ❌ **Cancel** a booking\n• 📋 View **services & pricing**\n\nWhat would you like to do?`;
  }

  // In idle with unknown intent — nudge
  if (s.stage === 'idle') {
    const svc = detectServiceFromText(userMsg);
    if (svc) {
      s.service = svc;
      s.stage = 'ask_date';
      return `Great choice — **${svc.name}** (${svc.duration} min · ${svc.price}). 🌿\n\nWhat date works best for you? You can say something like **"next Tuesday"** or **"February 12th"**.`;
    }
    return `I'd be happy to help! Would you like to **book an appointment**, check our **services**, or something else?`;
  }

  // Ask service
  if (s.stage === 'ask_service') {
    const svc = detectServiceFromText(userMsg);
    if (svc) {
      s.service = svc;
      s.stage = 'ask_date';
      const practitioner = BUSINESS.practitioners.find(p =>
        p.specialties.some(sp => svc.name.toLowerCase().includes(sp))
      ) ?? BUSINESS.practitioners[0];
      return `Excellent choice! **${svc.name}** with **${practitioner.name}** (${practitioner.title}). 🌿\n\n_${svc.description} · ${svc.duration} min · ${svc.price}_\n\nWhat date works best for you?`;
    }
    return `I didn't catch which service. You can:\n• Say the **name** (e.g., "acupuncture")\n• Say a **number** (1–${BUSINESS.services.length})\n• Or describe what you need and I'll find the right fit!`;
  }

  // Ask date
  if (s.stage === 'ask_date') {
    const date = parseNaturalDate(userMsg);
    if (date) {
      const dayName = DAYS[date.getDay()] as keyof typeof BUSINESS.business_hours;
      if (!BUSINESS.business_hours[dayName]) {
        const dayDisplay = DAYS[date.getDay()].charAt(0).toUpperCase() + DAYS[date.getDay()].slice(1);
        return `Oh, we're closed on ${dayDisplay}s. 😊 We're open Monday–Saturday. How about a different day?`;
      }

      s.date = date;
      s.slots = generateSlots(date);
      const available = s.slots.filter(sl => sl.available);

      if (available.length === 0) {
        return `Hmm, it looks like **${formatDateNice(date)}** is fully booked. Would you like to try another day? I can check the next few days for you.`;
      }

      // Show a nicely formatted slot grid
      const morning = available.filter(sl => parseInt(sl.time) < 12);
      const afternoon = available.filter(sl => parseInt(sl.time) >= 12);

      let display = `Here's what's available on **${formatDateNice(date)}**:\n\n`;
      if (morning.length > 0) {
        display += `🌅 **Morning**\n${morning.map(sl => `  🟢 ${sl.display}`).join('\n')}\n\n`;
      }
      if (afternoon.length > 0) {
        display += `☀️ **Afternoon**\n${afternoon.map(sl => `  🟢 ${sl.display}`).join('\n')}\n`;
      }
      display += `\nWhich time works for you?`;

      s.stage = 'show_slots';
      return display;
    }
    return `I didn't quite get that. Try saying **"tomorrow"**, **"next Thursday"**, **"Feb 15"**, or any date that works for you.`;
  }

  // Show slots / ask time
  if (s.stage === 'show_slots' || s.stage === 'ask_time') {
    const time = detectTimeFromText(userMsg);
    if (time) {
      const slot = s.slots.find(sl => sl.time === time && sl.available);
      if (slot) {
        s.time = slot.time;
        s.timeDisplay = slot.display;
        s.stage = 'ask_name';
        return `**${slot.display}** on **${formatDateNice(s.date!)}** — perfect! ⏰\n\nI've placed a **5-minute hold** on this slot for you.\n\nTo complete the booking, I'll need your **full name**. What should I put down?`;
      }
      return `Hmm, that time isn't available. Could you pick one of the 🟢 green times above?`;
    }
    // Maybe they want to try a different date
    const date = parseNaturalDate(userMsg);
    if (date) {
      s.date = date;
      s.stage = 'ask_date';
      return respond(sessionId, userMsg); // re-enter date flow
    }
    return `Just let me know the time! For example, **"10:30 AM"** or **"2 PM"**. Or say **"different day"** to pick another date.`;
  }

  // Ask name
  if (s.stage === 'ask_name') {
    if (looksLikeName(userMsg) || userMsg.trim().split(/\s+/).length >= 1) {
      s.name = userMsg.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      s.stage = 'ask_email';
      return `Nice to meet you, ${s.name.split(' ')[0]}! 😊\n\nAnd your **email address**? We'll send your confirmation and any updates there.`;
    }
    return `Could you share your **full name** (first and last)?`;
  }

  // Ask email
  if (s.stage === 'ask_email') {
    if (looksLikeEmail(userMsg)) {
      s.email = userMsg.trim().toLowerCase();
      s.stage = 'confirm_details';
      const practitioner = BUSINESS.practitioners.find(p =>
        p.specialties.some(sp => s.service!.name.toLowerCase().includes(sp))
      ) ?? BUSINESS.practitioners[0];

      return `Perfect! Here's a summary of your appointment:\n\n` +
        `┌─────────────────────────────────────┐\n` +
        `│  📋 **Booking Summary**              │\n` +
        `├─────────────────────────────────────┤\n` +
        `│  🏥 ${s.service!.name}               \n` +
        `│  👩‍⚕️ ${practitioner.name}            \n` +
        `│  📅 ${formatDateNice(s.date!)}        \n` +
        `│  🕐 ${s.timeDisplay} ET              \n` +
        `│  ⏱️ ${s.service!.duration} minutes    \n` +
        `│  💰 ${s.service!.price}               \n` +
        `│  👤 ${s.name}                         \n` +
        `│  📧 ${s.email}                        \n` +
        `└─────────────────────────────────────┘\n\n` +
        `Does everything look good? Type **"confirm"** to book it! 🎉`;
    }
    return `That doesn't look like a valid email. Could you try again? (e.g., **name@example.com**)`;
  }

  // Confirm
  if (s.stage === 'confirm_details') {
    if (/\b(confirm|yes|book|go|let'?s?\s*do|sounds?\s*good|perfect|looks?\s*good)\b/i.test(userMsg)) {
      const ref = generateRefCode();
      const practitioner = BUSINESS.practitioners.find(p =>
        p.specialties.some(sp => s.service!.name.toLowerCase().includes(sp))
      ) ?? BUSINESS.practitioners[0];

      const response = `🎉 **Appointment Confirmed!**\n\n` +
        `Your booking is locked in. Here are the details:\n\n` +
        `📋 **Reference:** \`${ref}\`\n` +
        `🏥 **Service:** ${s.service!.name}\n` +
        `👩‍⚕️ **Practitioner:** ${practitioner.name}\n` +
        `📅 **Date:** ${formatDateNice(s.date!)}\n` +
        `🕐 **Time:** ${s.timeDisplay} ET\n` +
        `📍 **Location:** ${BUSINESS.address}\n` +
        `💰 **Fee:** ${s.service!.price}\n\n` +
        `📧 A confirmation has been sent to **${s.email}**.\n\n` +
        `> 💡 **Tip:** Save your reference code \`${ref}\` — you'll need it if you want to reschedule or cancel.\n\n` +
        `We look forward to seeing you, ${s.name!.split(' ')[0]}! Is there anything else I can help with? 🌟`;

      sessions.delete(sessionId);
      return response;
    }
    if (/\b(no|change|edit|wrong|different)\b/i.test(userMsg)) {
      s.stage = 'ask_service';
      return `No problem! Let's start fresh. Which service would you like?`;
    }
    return `Just say **"confirm"** to finalize, or let me know if you'd like to **change** anything.`;
  }

  // Fallback
  return `I'm not sure I understood that. I can help you **book**, **reschedule**, or **cancel** an appointment, or tell you about our **services** and **hours**. What would you like to do?`;
}

// ─── Typing Delay Calculator ─────────────────────────────────────
function typingDelay(response: string): number {
  // ~30ms per character, min 800ms, max 3000ms
  // Simulates realistic "thinking + typing" speed
  const charDelay = Math.min(3000, Math.max(800, response.length * 18));
  // Add 200-500ms randomness
  return charDelay + Math.random() * 300 + 200;
}

// ─── Server Setup ────────────────────────────────────────────────
async function main() {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true, // Allow all origins for demo
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // ── Health ──
  app.get('/health', async () => ({
    status: 'ok',
    mode: 'demo',
    clinic: BUSINESS.name,
    timestamp: new Date().toISOString(),
  }));

  // ── Tenant ──
  app.get('/api/tenants/:id', async () => BUSINESS);

  // ── REST chat ──
  app.post<{ Params: { tenantId: string }; Body: { session_id: string; message: string } }>(
    '/api/tenants/:tenantId/chat',
    async (req) => {
      const { session_id, message } = req.body;
      const response = respond(session_id, message);
      return { session_id, response, meta: { tools_used: [], has_async_job: false } };
    },
  );

  // ── Start HTTP ──
  await app.listen({ port: PORT, host: '0.0.0.0' });

  // ── Socket.IO ──
  const io = new Server(app.server, {
    cors: { origin: true, methods: ['GET', 'POST'] },
    path: '/ws',
  });

  io.on('connection', (socket) => {
    let sessionId = socket.id;

    socket.on('join', (data: { tenant_id: string; session_id?: string }) => {
      sessionId = data.session_id ?? socket.id;
      socket.emit('joined', { session_id: sessionId });

      // Auto-greet after a short delay (feels like a real agent noticing you)
      setTimeout(() => {
        const greeting = respond(sessionId, '__auto_greet__');
        socket.emit('typing', { typing: true });
        setTimeout(() => {
          socket.emit('typing', { typing: false });
          socket.emit('response', { session_id: sessionId, response: greeting });
        }, 1200);
      }, 600);
    });

    socket.on('message', async (data: { message: string }) => {
      socket.emit('typing', { typing: true });
      socket.emit('status', { phase: 'tool_call', detail: 'Looking things up…' });

      const response = respond(sessionId, data.message);
      const delay = typingDelay(response);

      await new Promise(r => setTimeout(r, delay));

      socket.emit('typing', { typing: false });
      socket.emit('response', {
        session_id: sessionId,
        response,
        meta: { tools_used: [], has_async_job: false },
      });
    });

    socket.on('disconnect', () => {
      sessions.delete(sessionId);
    });
  });

  // ── Startup banner ──
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║                                                   ║');
  console.log('  ║   🏢  Gomomo — gomomo.ai                      ║');
  console.log('  ║       DEMO MODE                                   ║');
  console.log('  ║                                                   ║');
  console.log(`  ║   🌐  http://localhost:${PORT}                       ║`);
  console.log('  ║   🔌  WebSocket: /ws                              ║');
  console.log('  ║                                                   ║');
  console.log('  ║   No database • No OpenAI • No calendar API      ║');
  console.log('  ║   Pure conversational demo for stakeholders       ║');
  console.log('  ║                                                   ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
}

main().catch(console.error);
