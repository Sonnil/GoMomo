/**
 * Mock server for demo purposes.
 * Simulates the real backend API without requiring PostgreSQL or OpenAI.
 * Run: npx tsx src/mock-server.ts
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';

const PORT = 3000;

const DEMO_TENANT = {
  id: 'demo-tenant-001',
  name: 'Gomomo',
  slug: 'gomomo',
  timezone: 'America/New_York',
  slot_duration: 30,
  business_hours: {
    monday: { start: '09:00', end: '17:00' },
    tuesday: { start: '09:00', end: '17:00' },
    wednesday: { start: '09:00', end: '17:00' },
    thursday: { start: '09:00', end: '17:00' },
    friday: { start: '09:00', end: '16:00' },
    saturday: null,
    sunday: null,
  },
  services: [
    { name: 'Demo Consultation', duration: 30, description: 'Standard demo appointment' },
    { name: 'Follow-up Appointment', duration: 15, description: 'Quick follow-up' },
    { name: 'Extended Session', duration: 60, description: 'Longer demo appointment' },
  ],
};

// Simple state machine for the mock AI conversation
type ConvoState = 'greeting' | 'asked_service' | 'asked_date' | 'offered_times' | 'asked_name' | 'asked_email' | 'confirmed';

const sessions = new Map<string, { state: ConvoState; data: Record<string, string> }>();

function getOrCreateSession(id: string) {
  if (!sessions.has(id)) {
    sessions.set(id, { state: 'greeting', data: {} });
  }
  return sessions.get(id)!;
}

function generateMockResponse(sessionId: string, message: string): string {
  const session = getOrCreateSession(sessionId);
  const msg = message.toLowerCase();

  switch (session.state) {
    case 'greeting': {
      if (msg.includes('book') || msg.includes('appointment') || msg.includes('schedule')) {
        session.state = 'asked_service';
        return `Great! I'd be happy to help you book an appointment. 😊\n\nHere are the demo services:\n\n• **Demo Consultation** (30 min)\n• **Follow-up Appointment** (15 min)\n• **Extended Session** (60 min)\n\nWhich service would you like?`;
      }
      if (msg.includes('cancel')) {
        return `I can help you cancel an appointment. Could you please provide your booking reference code (e.g., APT-XXXXXX) or the email address you used when booking?`;
      }
      if (msg.includes('reschedule')) {
        return `I can help you reschedule. Could you please provide your booking reference code or email address?`;
      }
      session.state = 'asked_service';
      return `Hi there! 👋 Welcome to Gomomo.\n\nI can help you:\n• **Book** a new appointment\n• **Reschedule** an existing one\n• **Cancel** a booking\n\nWhat would you like to do?`;
    }

    case 'asked_service': {
      let service = 'Demo Consultation';
      if (msg.includes('follow')) service = 'Follow-up Appointment';
      else if (msg.includes('extended') || msg.includes('in-depth')) service = 'Extended Session';
      session.data.service = service;
      session.state = 'asked_date';
      return `Perfect — **${service}** it is!\n\nWhat date works best for you? For example, you can say "tomorrow", "next Monday", or a specific date.`;
    }

    case 'asked_date': {
      session.data.date = message;
      session.state = 'offered_times';
      // Generate some fake available times
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      return `Let me check availability… ⏳\n\nHere are the available slots for **${dateStr}**:\n\n🟢 9:00 AM\n🟢 10:00 AM\n🟢 11:30 AM\n🟢 2:00 PM\n🟢 3:30 PM\n\nWhich time would you prefer?`;
    }

    case 'offered_times': {
      session.data.time = message;
      session.state = 'asked_name';
      return `Great choice! I'll hold that slot for you for 5 minutes. ⏰\n\n✅ **Slot held** — now I just need a few details.\n\nWhat is your **full name**?`;
    }

    case 'asked_name': {
      session.data.name = message;
      session.state = 'asked_email';
      return `Thanks, ${message.split(' ')[0]}! And your **email address**?`;
    }

    case 'asked_email': {
      session.data.email = message;
      session.state = 'confirmed';
      const refCode = `APT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

      return `🎉 **Appointment Confirmed!**\n\n` +
        `📋 **Reference:** ${refCode}\n` +
        `👤 **Name:** ${session.data.name}\n` +
        `📧 **Email:** ${session.data.email}\n` +
        `🏥 **Service:** ${session.data.service}\n` +
        `📅 **Date:** ${dateStr}\n` +
        `🕐 **Time:** ${session.data.time}\n` +
        `📍 **Location:** Gomomo\n\n` +
        `You'll receive a confirmation email shortly. Is there anything else I can help with?`;
    }

    case 'confirmed': {
      if (msg.includes('thank') || msg.includes('bye') || msg.includes('no')) {
        session.state = 'greeting';
        return `You're welcome! Have a wonderful day. 😊 Don't hesitate to reach out if you need anything!`;
      }
      session.state = 'greeting';
      return getOrCreateSession(sessionId) && generateMockResponse(sessionId, message);
    }

    default:
      return `I'm here to help! Would you like to book, reschedule, or cancel an appointment?`;
  }
}

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', mode: 'mock', timestamp: new Date().toISOString() }));

  // Tenant endpoint
  app.get('/api/tenants/:id', async () => DEMO_TENANT);

  // REST chat endpoint
  app.post<{ Params: { tenantId: string }; Body: { session_id: string; message: string } }>(
    '/api/tenants/:tenantId/chat',
    async (req) => {
      const { session_id, message } = req.body;
      // Simulate thinking delay
      await new Promise((r) => setTimeout(r, 800));
      const response = generateMockResponse(session_id, message);
      return { session_id, response, meta: { tools_used: [], has_async_job: false } };
    },
  );

  // Start HTTP
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n🚀 Mock gomomo.ai server running on http://localhost:${PORT}`);
  console.log(`   Mode: MOCK (no database or OpenAI required)\n`);

  // Attach Socket.IO
  const io = new Server(app.server, {
    cors: {
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      methods: ['GET', 'POST'],
    },
    path: '/ws',
  });

  io.on('connection', (socket) => {
    console.log(`WebSocket connected: ${socket.id}`);
    let sessionId: string = socket.id;

    socket.on('join', (data: { tenant_id: string; session_id?: string }) => {
      sessionId = data.session_id ?? socket.id;
      socket.emit('joined', { session_id: sessionId });
      console.log(`Session joined: ${sessionId} → tenant ${data.tenant_id}`);
    });

    socket.on('message', async (data: { message: string }) => {
      socket.emit('typing', { typing: true });
      // Emit a status chip so the frontend shows "Agent is working on it…"
      socket.emit('status', { phase: 'tool_call', detail: 'Looking things up…' });

      // Simulate AI thinking time
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1500));

      const response = generateMockResponse(sessionId, data.message);
      socket.emit('typing', { typing: false });
      socket.emit('response', {
        session_id: sessionId,
        response,
        meta: { tools_used: [], has_async_job: false },
      });
    });

    socket.on('disconnect', () => {
      console.log(`WebSocket disconnected: ${socket.id}`);
    });
  });
}

main().catch(console.error);
