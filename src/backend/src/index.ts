import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { env } from './config/env.js';
import { getCorsOptions, getSocketIoCorsOptions, logCorsPolicy } from './config/cors.js';
import { registerHttpsEnforcement, logHttpsPolicy } from './config/https.js';
import { runMigrations } from './db/migrate.js';
import { tenantRoutes } from './routes/tenant.routes.js';
import { availabilityRoutes } from './routes/availability.routes.js';
import { appointmentRoutes } from './routes/appointment.routes.js';
import { oauthRoutes } from './routes/oauth.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { voiceRoutes } from './voice/voice.routes.js';
import { handoffRoutes } from './voice/handoff.routes.js';
import { inboundSmsRoutes } from './voice/inbound-sms.routes.js';
import { smsStatusCallbackRoutes } from './voice/sms-status-callback.routes.js';
import { tenantRepo } from './repos/tenant.repo.js';
import { holdRepo } from './repos/hold.repo.js';
import { routeChat } from './agent/chat-router.js';
import { startSyncWorker, stopSyncWorker } from './integrations/excel-sync-worker.js';
import { startReconciliationJob, stopReconciliationJob } from './jobs/excel-reconciliation.js';
import { isDemoAvailabilityActive } from './services/availability.service.js';
import { initOrchestrator, shutdownOrchestrator, eventBus, getAutonomyStatus } from './orchestrator/orchestrator.js';
import { autonomyRoutes } from './routes/autonomy.routes.js';
import { pushRoutes } from './routes/push.routes.js';
import { customerRoutes } from './routes/customer.routes.js';
import { authRoutes } from './auth/auth.routes.js';
import { emailVerificationRoutes } from './auth/email-verification.routes.js';
import { checkDefaultTenantDrift } from './db/default-tenant-drift-guard.js';
import { capabilitiesSnapshot } from './config/capabilities.js';
import { calendarDebugRoutes } from './routes/calendar-debug.routes.js';
import { ceoTestRoutes } from './routes/ceo-test.routes.js';
import { adminOnboardingRoutes } from './routes/admin-onboarding.routes.js';
import { storefrontRoutes } from './routes/storefront.routes.js';
import { sttRoutes } from './routes/stt.routes.js';
import { ttsRoutes } from './routes/tts.routes.js';
import { validateSocketToken, tokenMatchesTenant, isAuthEnforced } from './auth/middleware.js';
import {
  AUTH_TAG_KEY,
  markPublic,
  requireSessionToken,
  requireSessionTokenTenantScoped,
  requireAdminKey,
  requireSessionOrAdmin,
  optionalSessionToken,
} from './auth/middleware.js';
import { pushService } from './services/push-service.js';
import type { HoldExpiredEvent } from './domain/events.js';

async function main(): Promise<void> {
  // 1. Run database migrations
  console.log('Running database migrations…');
  await runMigrations();
  console.log('Migrations complete.');

  // 1-seed. Ensure the default demo tenant exists (idempotent — safe to re-run).
  // The full seed.ts script adds sample appointments and policy rules but requires
  // manual invocation.  This lightweight upsert ensures the chat widget can always
  // resolve the hard-coded DEFAULT_TENANT_ID so the demo is never broken on first deploy.
  {
    const { pool: seedPool } = await import('./db/client.js');
    const DEMO_ID = '00000000-0000-4000-a000-000000000001';
    const result = await seedPool.query(
      `INSERT INTO tenants (id, name, slug, timezone, slot_duration, business_hours, services, service_catalog_mode)
       VALUES ($1, 'Gomomo', 'gomomo', 'America/New_York', 30,
         '{"monday":{"start":"09:00","end":"18:00"},"tuesday":{"start":"09:00","end":"18:00"},"wednesday":{"start":"09:00","end":"18:00"},"thursday":{"start":"09:00","end":"20:00"},"friday":{"start":"09:00","end":"17:00"},"saturday":{"start":"10:00","end":"14:00"},"sunday":null}',
         '[{"name":"Demo Consultation","duration":30,"price":"$80","description":"Standard appointment"},{"name":"Follow-up Appointment","duration":20,"price":"$50","description":"Progress check"},{"name":"Extended Session","duration":60,"price":"$150","description":"Longer appointment"}]',
         'free_text')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_ID],
    );
    if (result.rowCount === 1) {
      console.log('🌱 Demo tenant created (Gomomo — 00000000-…-000000000001)');
    }
  }

  // 1a. Dev-only: ensure the default tenant row matches expected defaults
  await checkDefaultTenantDrift();

  // 1b. Initialize the autonomous agent runtime (event bus + policy engine + job runner)
  await initOrchestrator();

  // 1c. Validate Twilio SMS config at startup (non-fatal — log + audit only)
  //     Skip entirely when both FEATURE_SMS and FEATURE_VOICE are disabled
  //     (booking-only mode — no Twilio credentials needed).
  if (env.FEATURE_SMS === 'false' && env.FEATURE_VOICE === 'false') {
    console.log('ℹ️  FEATURE_SMS=false, FEATURE_VOICE=false — Twilio validation skipped (booking-only mode).');
  } else {
    const hasSid = !!env.TWILIO_ACCOUNT_SID;
    const hasToken = !!env.TWILIO_AUTH_TOKEN;
    const hasPhone = !!env.TWILIO_PHONE_NUMBER;
    const hasMsgSvc = !!env.TWILIO_MESSAGING_SERVICE_SID;
    const hasAuth = hasSid && hasToken;
    const hasSender = hasPhone || hasMsgSvc;
    const anySet = hasSid || hasToken || hasPhone || hasMsgSvc;

    if (anySet && (!hasAuth || !hasSender)) {
      const missing: string[] = [];
      if (!hasSid) missing.push('TWILIO_ACCOUNT_SID');
      if (!hasToken) missing.push('TWILIO_AUTH_TOKEN');
      if (!hasPhone && !hasMsgSvc) missing.push('TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
      console.warn(`⚠️  Twilio SMS config incomplete — missing: ${missing.join(', ')}. SMS will NOT be delivered.`);
      try {
        const { auditRepo } = await import('./repos/audit.repo.js');
        await auditRepo.log({
          tenant_id: null,
          event_type: 'sms.config_invalid',
          entity_type: 'system',
          entity_id: 'startup',
          actor: 'system',
          payload: {
            missing,
            has_account_sid: hasSid,
            has_auth_token: hasToken,
            has_phone_number: hasPhone,
            has_messaging_service_sid: hasMsgSvc,
          },
        });
      } catch { /* best-effort — DB might not be ready yet */ }
    } else if (!anySet) {
      console.log('ℹ️  Twilio not configured — SMS in simulator mode (dev/demo).');
    } else {
      console.log('✅ Twilio SMS config OK' +
        (hasMsgSvc ? ' (using Messaging Service)' : ` (using From: ${env.TWILIO_PHONE_NUMBER.slice(0, 6)}…)`));
    }

    // 1d. Live Twilio credential verification (API call — non-fatal)
    if (anySet && hasAuth && hasSender) {
      try {
        const { verifyTwilioCredentials, setTwilioVerifyResult } = await import('./voice/sms-sender.js');
        const verifyResult = await verifyTwilioCredentials();
        setTwilioVerifyResult(verifyResult);

        if (verifyResult.verified) {
          const modeLabel = verifyResult.credentialMode.toUpperCase();
          const sendLabel = verifyResult.sendMode === 'messaging_service_sid'
            ? 'Messaging Service' : `From: ${env.TWILIO_PHONE_NUMBER.slice(0, 6)}…`;
          console.log(`✅ Twilio credentials verified: ${modeLabel} account (${sendLabel})`);
          if (verifyResult.friendlyName) {
            console.log(`   Account: ${verifyResult.friendlyName}`);
          }
          console.log(`   Sender type: ${verifyResult.senderType}, A2P status: ${verifyResult.a2pStatus}`);
          if (verifyResult.senderType === 'toll_free') {
            console.warn(`   ⚠️  TOLL-FREE sender — requires Twilio verification (blocked since 2024-01-31)`);
          }
          if (verifyResult.a2pStatus === 'pending') {
            console.warn(`   ⚠️  A2P 10DLC registration PENDING — carriers may filter messages`);
          } else if (verifyResult.a2pStatus === 'rejected') {
            console.warn(`   🚫 A2P 10DLC registration REJECTED — outbound SMS will likely be blocked`);
          }
          try {
            const { auditRepo } = await import('./repos/audit.repo.js');
            await auditRepo.log({
              tenant_id: null,
              event_type: 'sms.twilio_live_verified',
              entity_type: 'system',
              entity_id: 'startup',
              actor: 'system',
              payload: {
                credential_mode: verifyResult.credentialMode,
                send_mode: verifyResult.sendMode,
                account_status: verifyResult.accountStatus,
                is_live: verifyResult.isLive,
                sender_type: verifyResult.senderType,
                a2p_status: verifyResult.a2pStatus,
              },
            });
          } catch { /* best-effort */ }
        } else {
          console.warn(`⚠️  Twilio credential verification FAILED: ${verifyResult.error}`);
          try {
            const { auditRepo } = await import('./repos/audit.repo.js');
            await auditRepo.log({
              tenant_id: null,
              event_type: 'sms.twilio_auth_failed',
              entity_type: 'system',
              entity_id: 'startup',
              actor: 'system',
              payload: {
                credential_mode: verifyResult.credentialMode,
                error: verifyResult.error,
              },
            });
          } catch { /* best-effort */ }
        }
      } catch (err) {
        console.warn('⚠️  Twilio verification check failed (non-fatal):', err);
      }
    }
  } // end FEATURE_SMS/FEATURE_VOICE Twilio validation

  // 2. Create Fastify instance
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    // Trust X-Forwarded-Proto / X-Forwarded-For from a reverse proxy.
    // Required for HTTPS enforcement + accurate client IP logging.
    trustProxy: env.REQUIRE_HTTPS === 'true',
  });

  // 3. Register CORS (dynamic origin callback — see config/cors.ts)
  await app.register(cors, getCorsOptions());
  logCorsPolicy();

  // 3b. Register form body parser (Twilio sends application/x-www-form-urlencoded)
  await app.register(formbody);

  // 3c. HTTP security headers (helmet)
  //     - CSP kept loose for dev (Vite HMR via ws:) and Socket.IO
  //     - frame-ancestors: allow CORS_ORIGIN to embed /widget in an iframe
  //     - X-Content-Type-Options nosniff
  //     - Referrer-Policy no-referrer
  const frameAncestors = ["'self'", ...env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)];
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // Allow blob: URLs for TTS audio playback (new Audio(blobUrl))
        // and MediaRecorder audio capture (STT)
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        frameAncestors,
      },
    },
    // CSP frame-ancestors supersedes X-Frame-Options; disable the
    // legacy header so the two don't conflict.
    frameguard: false,
    // Allow cross-origin requests (CORS handles this)
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // 3d. HTTPS enforcement (must run before route handlers)
  registerHttpsEnforcement(app);
  logHttpsPolicy();

  // 3e. Serve the widget SPA as static files at /widget/*
  //     The built Vite output lives in <rootDir>/widget/ inside the
  //     Docker image (COPY'd during build).  In local dev the path
  //     resolves to dist/widget/ relative to the compiled JS.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const widgetRoot = join(__dirname, '..', 'widget');
  await app.register(fastifyStatic, {
    root: widgetRoot,
    prefix: '/widget/',
    decorateReply: false,          // avoid conflict if registered elsewhere
    wildcard: false,               // we handle SPA fallback below
    // Vite hashed assets (assets/*) are safe to cache forever.
    // index.html must not be cached so deploys take effect immediately.
    setHeaders(res, filePath) {
      if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
  // SPA fallback: any /widget/* path that doesn't match a real file
  // returns /widget/index.html so client-side routing works.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/widget')) {
      return reply.sendFile('index.html', widgetRoot);
    }
    reply.code(404).send({ error: 'Not Found' });
  });
  console.log(`📦 Widget SPA served at /widget/ from ${widgetRoot}`);

  // 4. Health check (public) — includes capability snapshot
  app.get('/health', { preHandler: markPublic }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    capabilities: capabilitiesSnapshot(),
  }));

  // 4a. SMS health endpoint — operational telemetry (no PII)
  //     When FEATURE_SMS=false, returns a minimal "disabled" response.
  if (env.FEATURE_SMS === 'false') {
    app.get('/health/sms', { preHandler: markPublic }, async () => ({
      status: 'disabled',
      timestamp: new Date().toISOString(),
      message: 'SMS feature is disabled (FEATURE_SMS=false). Set FEATURE_SMS=true to enable.',
    }));
  } else {
  function getTwilioConfigStatus(): {
    status: 'ok' | 'simulator' | 'config_error';
    has_account_sid: boolean;
    has_auth_token: boolean;
    has_phone_number: boolean;
    has_messaging_service_sid: boolean;
    error?: string;
  } {
    const hasSid = !!env.TWILIO_ACCOUNT_SID;
    const hasToken = !!env.TWILIO_AUTH_TOKEN;
    const hasPhone = !!env.TWILIO_PHONE_NUMBER;
    const hasMsgSvc = !!env.TWILIO_MESSAGING_SERVICE_SID;

    // Determine send capability: need SID + token + (phone OR messaging service)
    const hasAuth = hasSid && hasToken;
    const hasSender = hasPhone || hasMsgSvc;

    let status: 'ok' | 'simulator' | 'config_error';
    let error: string | undefined;

    if (!hasSid && !hasToken && !hasPhone && !hasMsgSvc) {
      // Nothing configured — simulator mode (dev/demo)
      status = 'simulator';
    } else if (!hasAuth) {
      // Partial config — SID or token missing
      status = 'config_error';
      error = 'missing_twilio_config: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are both required';
    } else if (!hasSender) {
      // Auth present but no sender identity
      status = 'config_error';
      error = 'missing_twilio_config: either TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required';
    } else {
      status = 'ok';
    }

    return {
      status,
      has_account_sid: hasSid,
      has_auth_token: hasToken,
      has_phone_number: hasPhone,
      has_messaging_service_sid: hasMsgSvc,
      ...(error && { error }),
    };
  }

  app.get('/health/sms', { preHandler: markPublic }, async () => {
    const { smsOutboxRepo } = await import('./repos/sms-outbox.repo.js');
    const { smsMetricsSnapshot } = await import('./voice/sms-metrics.js');
    const { getAutonomyStatus } = await import('./orchestrator/orchestrator.js');
    const { getTwilioVerifyResult } = await import('./voice/sms-sender.js');

    const [outboxHealth, metrics, autonomy] = await Promise.all([
      smsOutboxRepo.healthStats().catch(() => ({
        queue_depth: -1,
        oldest_pending_age_seconds: null,
        last_error_category: null,
      })),
      Promise.resolve(smsMetricsSnapshot()),
      Promise.resolve(getAutonomyStatus()),
    ]);

    const twilioConfig = getTwilioConfigStatus();
    const verifyResult = getTwilioVerifyResult();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      twilio_config: {
        ...twilioConfig,
        // Live verification fields (populated after startup probe)
        credential_mode: verifyResult?.credentialMode ?? (twilioConfig.status === 'simulator' ? 'simulator' : twilioConfig.status === 'ok' ? 'unknown' : 'invalid'),
        send_mode: verifyResult?.sendMode ?? null,
        auth_verified: verifyResult?.verified ?? false,
        account_status: verifyResult?.accountStatus ?? null,
        is_live: verifyResult?.isLive ?? null,
        // Sender classification + A2P registration status
        sender_type: verifyResult?.senderType ?? env.TWILIO_SENDER_TYPE,
        a2p_status: verifyResult?.a2pStatus ?? env.TWILIO_A2P_STATUS,
      },
      outbox_poller: {
        running: autonomy.enabled && !!autonomy.runner?.running,
      },
      outbox: outboxHealth,
      metrics,
    };
  });
  } // end FEATURE_SMS health/sms gate

  // 4b. Email health endpoint — email gate operational telemetry (no secrets)
  app.get('/health/email', { preHandler: markPublic }, async () => {
    const devMode = env.EMAIL_DEV_MODE === 'true';
    const provider = env.EMAIL_PROVIDER;
    const effectiveProvider = devMode ? 'console' : provider;
    const credentialsPresent =
      provider === 'resend'   ? !!env.RESEND_API_KEY :
      provider === 'postmark' ? !!env.POSTMARK_API_TOKEN :
      true; // console needs no credentials

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      provider,
      dev_mode: devMode,
      effective_provider: effectiveProvider,
      credentials_present: credentialsPresent,
      email_gate_enabled: env.REQUIRE_EMAIL_AFTER_FIRST_MESSAGE === 'true',
      ttl_minutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
      rate_limit: env.EMAIL_VERIFICATION_RATE_LIMIT,
    };
  });

  // 4c. Config endpoint — tells frontend about demo mode + autonomy (public)
  app.get('/api/config', { preHandler: markPublic }, async () => ({
    demo_availability: isDemoAvailabilityActive(),
    calendar_mode: env.CALENDAR_MODE,
    autonomy: getAutonomyStatus(),
  }));

  // 4d. Capabilities endpoint — canonical view of enabled features (public)
  app.get('/api/capabilities', { preHandler: markPublic }, async () => capabilitiesSnapshot());

  // 5. Register REST routes
  await app.register(tenantRoutes);
  await app.register(availabilityRoutes);
  await app.register(appointmentRoutes);
  await app.register(oauthRoutes);
  await app.register(chatRoutes);

  // 5b-autonomy. Register autonomy API routes
  await app.register(autonomyRoutes);

  // 5b-push. Register push event polling routes (Feature 3)
  await app.register(pushRoutes);

  // 5b-customer. Register customer identity/privacy routes
  await app.register(customerRoutes);

  // 5b-auth. Register SDK auth routes (session token issuance)
  await app.register(authRoutes);

  // 5b-email-gate. Email verification routes (lead capture)
  await app.register(emailVerificationRoutes);

  // 5b-onboarding. Admin SMB onboarding routes (tenant setup, widget snippet)
  await app.register(adminOnboardingRoutes);

  // 5b-storefront. Storefront knowledge routes (public facts + admin FAQ management)
  await app.register(storefrontRoutes);
  console.log('📚 Storefront knowledge routes registered — GET /api/public/storefront/facts');

  // 5b-debug. Calendar debug endpoints (dev-only, admin-key protected)
  if (env.CALENDAR_DEBUG === 'true') {
    await app.register(calendarDebugRoutes);
    console.log('🔍 Calendar debug endpoints enabled — GET /api/dev/calendar-debug/:tenantId');
  }

  // 5b-ceo-test. CEO pilot test endpoints (dev-only, token-protected)
  if (env.CEO_TEST_MODE === 'true' || env.NODE_ENV === 'development') {
    await app.register(ceoTestRoutes);
    console.log('🧪 CEO test endpoints enabled — GET /debug/ceo-test/last-booking');
  }

  // 5b. Register Voice/Twilio routes
  //     Gated by FEATURE_VOICE master flag → VOICE_ENABLED per-feature flag.
  if (env.FEATURE_VOICE === 'true' && env.VOICE_ENABLED === 'true') {
    await app.register(voiceRoutes);
    await app.register(handoffRoutes);
    console.log('Voice channel enabled — Twilio webhook routes registered');
    console.log('SMS handoff enabled —', env.SMS_HANDOFF_ENABLED === 'true' ? 'active' : 'disabled');
  } else if (env.FEATURE_VOICE === 'false') {
    console.log('ℹ️  FEATURE_VOICE=false — voice routes not registered (booking-only mode).');
  }

  // 5b-stt. Register browser push-to-talk STT route
  //     Gated by FEATURE_VOICE_WEB — uses OpenAI Whisper for transcription.
  if (env.FEATURE_VOICE_WEB === 'true') {
    await app.register(sttRoutes);
    await app.register(ttsRoutes);
    console.log('🎤 Web voice mode enabled — POST /api/stt + POST /api/tts registered');
  } else {
    console.log('ℹ️  FEATURE_VOICE_WEB=false — browser STT/TTS not registered.');
  }

  // 5b-sms. Register Inbound SMS routes (two-way conversational SMS)
  //     Gated by FEATURE_SMS master flag → SMS_INBOUND_ENABLED per-feature flag.
  if (env.FEATURE_SMS === 'true' && env.SMS_INBOUND_ENABLED === 'true') {
    await app.register(inboundSmsRoutes);
    console.log('Inbound SMS channel enabled — POST /twilio/sms/incoming registered');
  } else if (env.FEATURE_SMS === 'false') {
    console.log('ℹ️  FEATURE_SMS=false — inbound SMS routes not registered (booking-only mode).');
  }

  // 5b-sms-status. Register Twilio SMS Status Callback webhook
  // Only register when SMS feature is enabled. When disabled, Twilio
  // has no callbacks to send (no webhooks are configured).
  if (env.FEATURE_SMS === 'true') {
    await app.register(smsStatusCallbackRoutes);
    console.log('SMS status callback webhook registered — POST /webhooks/twilio/status');
  } else {
    console.log('ℹ️  FEATURE_SMS=false — SMS status callback not registered.');
  }

  // 5c. Start Excel sync worker + reconciliation (if enabled)
  if (env.EXCEL_ENABLED === 'true') {
    startSyncWorker();
    startReconciliationJob(env.EXCEL_RECONCILIATION_INTERVAL_MS);
    console.log('Excel integration enabled — sync worker + reconciliation job started');
  }

  // ══ DEFAULT-DENY — STATIC ROUTE CHECK ════════════════════
  // Verify at registration time that every route has an auth
  // preHandler.  If a developer forgets to tag a new route the
  // server refuses to start (fail-closed).
  //
  // At runtime we also add a lightweight preSerialization guard:
  // if a response is about to be sent but the request was never
  // tagged, block it (belt & suspenders).
  // ──────────────────────────────────────────────────────────

  // Track which route-level preHandlers are auth-aware
  const AUTH_MIDDLEWARES = new Set([
    requireSessionToken,
    requireSessionTokenTenantScoped,
    requireAdminKey,
    requireSessionOrAdmin,
    markPublic,
    optionalSessionToken,
  ]);

  app.addHook('onRoute', (routeOptions) => {
    // Skip Fastify-internal routes (e.g. 404 handler)
    if (routeOptions.url === '*') return;

    const preHandlers = Array.isArray(routeOptions.preHandler)
      ? routeOptions.preHandler
      : routeOptions.preHandler
        ? [routeOptions.preHandler]
        : [];

    const hasAuthTag = preHandlers.some((h: any) => AUTH_MIDDLEWARES.has(h));
    if (!hasAuthTag) {
      console.warn(
        `⚠️  Route ${String(routeOptions.method)} ${routeOptions.url} has no auth preHandler — it will be blocked when SDK_AUTH_REQUIRED=true`,
      );
    }
  });

  // Runtime safety net — blocks responses from untagged routes.
  // Uses onSend (after serialization) so it doesn't interfere
  // with error responses from auth preHandlers that correctly
  // send 401/403.  The onRoute hook above already warns at
  // startup about untagged routes.
  app.addHook('onSend', async (request, reply, payload) => {
    // Route was tagged by an auth preHandler — allow through
    if ((request as any)[AUTH_TAG_KEY]) return payload;
    // Widget static assets are public (served by @fastify/static)
    if (request.url.startsWith('/widget')) return payload;
    // Auth enforcement not on — allow through
    if (!isAuthEnforced()) return payload;

    // Untagged route under enforcement — override with 401.
    // This covers Fastify-generated 404s (hides route structure
    // from unauthenticated callers) and any dev-forgotten routes.
    reply.code(401);
    return JSON.stringify({
      error: 'Unauthorized — this endpoint requires authentication.',
    });
  });

  // 6. Start the HTTP server
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`Server listening on http://0.0.0.0:${env.PORT}`);

  // 6b. Log demo availability mode
  if (isDemoAvailabilityActive()) {
    console.log('🧪 Demo Availability Mode: ACTIVE — Mon–Fri 9 AM – 5 PM ET (set DEMO_AVAILABILITY=false to disable)');
  }

  // 7. Attach Socket.IO to the underlying http.Server
  const io = new Server(app.server, {
    cors: getSocketIoCorsOptions(),
    path: '/ws',
  });

  // 7b. Initialize push service with Socket.IO (Feature 3 — proactive UI push)
  pushService.init(io);

  io.on('connection', (socket) => {
    console.log(`WebSocket connected: ${socket.id}`);

    let tenantId: string | null = null;
    let sessionId: string | null = null;
    let customerReturningContext: import('./domain/types.js').ReturningCustomerContext | null = null;

    // Client sends { tenant_id, session_id?, token?, customer_email?, customer_phone? } on join
    socket.on('join', async (data: {
      tenant_id: string;
      session_id?: string;
      token?: string;
      customer_email?: string;
      customer_phone?: string;
    }) => {
      console.log(`[ws-join] ${socket.id} → tenant=${data.tenant_id} session=${data.session_id?.slice(0, 8) ?? '—'} token=${data.token ? data.token.slice(0, 12) + '…' : 'NONE'}`);

      // ── Token-based auth (SDK clients) ────────────────────
      const tokenPayload = validateSocketToken(data.token);
      const tenantMatch = tokenMatchesTenant(tokenPayload, data.tenant_id);
      console.log(`[ws-join] ${socket.id} → tokenValid=${!!tokenPayload} tenantMatch=${tenantMatch} authEnforced=${isAuthEnforced()}`);

      if (!tenantMatch) {
        console.warn(`[ws-join] ${socket.id} ❌ REJECTED — token/tenant mismatch`);
        socket.emit('error', { error: 'Invalid or expired session token.' });
        return;
      }

      // If auth is enforced and no valid token, reject
      if (isAuthEnforced() && !tokenPayload) {
        console.warn(`[ws-join] ${socket.id} ❌ REJECTED — no token (auth enforced)`);
        socket.emit('error', { error: 'Session token required. Use POST /api/auth/session first.' });
        return;
      }

      tenantId = data.tenant_id;
      // Token session takes precedence over client-provided session_id
      sessionId = tokenPayload?.sid ?? data.session_id ?? socket.id;
      socket.join(`tenant:${tenantId}`);
      socket.join(`session:${sessionId}`);   // Feature 3: session room for targeted push delivery
      console.log(`[ws-join] ${socket.id} ✅ JOINED — tenant=${tenantId} session=${sessionId.slice(0, 8)}…`);

      // Resolve customer identity if email or phone provided
      if (data.customer_email || data.customer_phone) {
        try {
          const { customerService } = await import('./services/customer.service.js');
          const { sessionRepo } = await import('./repos/session.repo.js');

          if (data.customer_email) {
            const { customer } = await customerService.resolveByEmail(
              data.customer_email,
              tenantId,
            );
            await sessionRepo.linkCustomer(sessionId, customer.id);
            customerReturningContext = await customerService.getReturningContext(customer.id);
          } else if (data.customer_phone) {
            const { customer } = await customerService.resolveByPhone(
              data.customer_phone,
              tenantId,
            );
            await sessionRepo.linkCustomer(sessionId, customer.id);
            customerReturningContext = await customerService.getReturningContext(customer.id);
          }
        } catch (err) {
          console.warn('[ws-join] Customer resolution failed (non-fatal):', err);
        }
      }

      socket.emit('joined', {
        session_id: sessionId,
        returning_customer: customerReturningContext
          ? { display_name: customerReturningContext.display_name, booking_count: customerReturningContext.booking_count }
          : null,
      });

      // Deliver any pending push events from before the client connected
      try {
        await pushService.deliverPending(sessionId);
      } catch (err) {
        console.error('[push-service] Error delivering pending pushes:', err);
      }
    });

    // Client sends { message, client_meta? }
    socket.on('message', async (data: { message: string; client_meta?: { client_now_iso?: string; client_tz?: string; client_utc_offset_minutes?: number; locale?: string } }) => {
      if (!tenantId || !sessionId) {
        console.warn(`[ws-msg] ${socket.id} ❌ Message rejected — tenantId=${tenantId} sessionId=${sessionId}`);
        socket.emit('error', { error: 'Must join a tenant first.' });
        return;
      }

      try {
        // ── Hybrid FSM + LLM Router ─────────────────────────
        // The chat router handles intent classification, FSM state,
        // deterministic templates, and OTP flows WITHOUT the LLM.
        // Only non-deterministic intents fall through to the LLM.

        socket.emit('typing', { typing: true });

        const tenant = await tenantRepo.findById(tenantId);
        if (!tenant) {
          socket.emit('error', { error: 'Tenant not found.' });
          return;
        }

        const result = await routeChat(sessionId, tenantId, data.message, tenant, {
          customerContext: customerReturningContext,
          clientMeta: data.client_meta,
          onToken: (token: string) => {
            // Only stream tokens when the LLM is called (not for deterministic responses)
            socket.emit('token', { token });
          },
          onStatus: (phase: string, detail: string) => {
            socket.emit('status', { phase, detail });
          },
        });

        // If async jobs were triggered, briefly show a follow-up status chip
        if (result.meta.has_async_job) {
          socket.emit('status', { phase: 'async_job', detail: 'Scheduling follow-up in progress…' });
        }

        // Send final response (client replaces streamed tokens with this)
        socket.emit('response', {
          session_id: sessionId,
          response: result.response,
          meta: { ...result.meta, deterministic: result.deterministic },
        });
      } catch (err: any) {
        console.error('Chat error:', err);
        socket.emit('error', {
          error: 'Something went wrong. Please try again.',
        });
      } finally {
        socket.emit('typing', { typing: false });
      }
    });

    socket.on('disconnect', () => {
      console.log(`WebSocket disconnected: ${socket.id}`);
    });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down…`);
    clearInterval(holdCleanupTimer);
    await shutdownOrchestrator();
    stopSyncWorker();
    stopReconciliationJob();
    io.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ── Expired-hold cleanup job ──────────────────────────────────
  const holdCleanupTimer = setInterval(async () => {
    try {
      const expired = await holdRepo.deleteExpired();
      if (expired.length > 0) {
        console.log(`[hold-cleanup] Purged ${expired.length} expired hold(s)`);
        // Emit HoldExpired events for each purged hold
        for (const hold of expired) {
          eventBus.emit<HoldExpiredEvent>({
            name: 'HoldExpired',
            tenant_id: hold.tenant_id,
            hold_id: hold.id,
            session_id: hold.session_id,
            slot_start: hold.start_time instanceof Date ? hold.start_time.toISOString() : String(hold.start_time),
            slot_end: hold.end_time instanceof Date ? hold.end_time.toISOString() : String(hold.end_time),
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[hold-cleanup] Error purging expired holds:', err);
    }
  }, env.HOLD_CLEANUP_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
