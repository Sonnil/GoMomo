// ============================================================
// gomomo.ai — Tool Definitions
// OpenAI function-calling format
// ============================================================

export const agentTools = [
  {
    type: 'function' as const,
    function: {
      name: 'check_availability',
      description: 'Check available appointment time slots for a given date range. Always call this BEFORE offering times to the user. If the business offers multiple services, you MUST specify which service.',
      parameters: {
        type: 'object',
        properties: {
          start_date: {
            type: 'string',
            description: 'Start date in ISO-8601 format (e.g., 2026-02-10T00:00:00-05:00). Use the start of the day the user is interested in.',
          },
          end_date: {
            type: 'string',
            description: 'End date in ISO-8601 format (e.g., 2026-02-10T23:59:59-05:00). Use the end of the day, or end of range for multi-day queries.',
          },
          service_name: {
            type: 'string',
            description: 'The name of the service to check availability for. Required when the business offers more than one service.',
          },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'hold_slot',
      description: 'Place a temporary hold (5 minutes) on a time slot. Call this after the user selects a specific time, before collecting their details. For dates far in the future, set far_date_confirmed=true only after the user has explicitly confirmed they want that date.',
      parameters: {
        type: 'object',
        properties: {
          start_time: {
            type: 'string',
            description: 'Slot start time in ISO-8601 format',
          },
          end_time: {
            type: 'string',
            description: 'Slot end time in ISO-8601 format',
          },
          far_date_confirmed: {
            type: 'boolean',
            description: 'Set to true ONLY when the user has explicitly confirmed they want a date that is far in the future. If omitted, far-future dates will be rejected with a confirmation prompt.',
          },
        },
        required: ['start_time', 'end_time'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'confirm_booking',
      description: 'Confirm and finalize a booking. Only call this after successfully holding a slot AND collecting client details (name, email, AND phone number).',
      parameters: {
        type: 'object',
        properties: {
          hold_id: {
            type: 'string',
            description: 'The ID of the active hold to convert into a booking',
          },
          client_name: {
            type: 'string',
            description: 'Full name of the client',
          },
          client_email: {
            type: 'string',
            description: 'Email address of the client',
          },
          client_phone: {
            type: 'string',
            description: 'Phone number of the client. Will be normalized to E.164 format. REQUIRED for all new bookings — enables SMS confirmations and secure cancellation.',
          },
          client_notes: {
            type: 'string',
            description: 'Any additional notes from the client (optional)',
          },
          service: {
            type: 'string',
            description: 'The service being booked (optional)',
          },
        },
        required: ['hold_id', 'client_name', 'client_email', 'client_phone'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lookup_booking',
      description: 'Look up an existing appointment by reference code or email address. Use this for reschedule/cancel flows.',
      parameters: {
        type: 'object',
        properties: {
          reference_code: {
            type: 'string',
            description: 'The appointment reference code (e.g., APT-XXXXXX)',
          },
          email: {
            type: 'string',
            description: 'The email address used when booking',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'reschedule_booking',
      description: 'Reschedule an existing appointment to a new held time slot.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'The ID of the existing appointment to reschedule',
          },
          new_hold_id: {
            type: 'string',
            description: 'The ID of the hold for the new time slot',
          },
        },
        required: ['appointment_id', 'new_hold_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_booking',
      description:
        'Cancel an existing appointment. REQUIRES reference_code. ' +
        'Identity verification happens automatically via the session when the customer is email-verified. ' +
        'If auto-verification fails, the system will ask you to collect phone_last4 (last 4 digits of the phone on the booking) ' +
        'and call this tool again. Do NOT call with only an appointment_id — always collect the confirmation number first.',
      parameters: {
        type: 'object',
        properties: {
          reference_code: {
            type: 'string',
            description: 'The appointment confirmation number / reference code (e.g. APT-XXXXXX). Required for cancellation.',
          },
          phone_last4: {
            type: 'string',
            description: 'Last 4 digits of the phone number on the booking. Only needed when the system explicitly asks for it via CANCELLATION_NEEDS_IDENTITY.',
          },
        },
        required: ['reference_code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_inquiry',
      description: 'Create a waitlist inquiry when no availability matches the user\'s request. Captures their preferences so they can be notified when a matching slot opens. Use this when all slots are taken or the user\'s preferred times are unavailable.',
      parameters: {
        type: 'object',
        properties: {
          client_name: {
            type: 'string',
            description: 'Full name of the client',
          },
          client_email: {
            type: 'string',
            description: 'Email address to notify when a slot opens',
          },
          preferred_service: {
            type: 'string',
            description: 'The service the client wants (optional — null means any service)',
          },
          preferred_days: {
            type: 'array',
            items: { type: 'string' },
            description: 'Preferred days of the week, e.g. ["monday","wednesday"]. Empty array means any day.',
          },
          preferred_time_start: {
            type: 'string',
            description: 'Earliest preferred time in HH:MM format (e.g. "09:00"). Optional.',
          },
          preferred_time_end: {
            type: 'string',
            description: 'Latest preferred time in HH:MM format (e.g. "14:00"). Optional.',
          },
        },
        required: ['client_name', 'client_email'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_contact_followup',
      description:
        'Schedule an async follow-up contact when: (1) no availability slots match, (2) a calendar retry is queued, or (3) the user explicitly asks to be contacted later. ' +
        'Enqueues a background job that will text or email the user with options. NEVER promise an exact delivery time — say "shortly" or "within a few hours".',
      parameters: {
        type: 'object',
        properties: {
          client_name: {
            type: 'string',
            description: 'Full name of the client',
          },
          client_email: {
            type: 'string',
            description: 'Email address of the client',
          },
          client_phone: {
            type: 'string',
            description: 'Phone number of the client (E.164 format preferred). Required if preferred_contact is "sms".',
          },
          preferred_contact: {
            type: 'string',
            enum: ['email', 'sms', 'either'],
            description: 'How the client prefers to be contacted: "email", "sms", or "either" (default: email)',
          },
          reason: {
            type: 'string',
            description: 'Why the follow-up is needed, e.g. "no_availability", "calendar_retry_queued", "user_requested"',
          },
          preferred_service: {
            type: 'string',
            description: 'Service the client is interested in (optional)',
          },
          notes: {
            type: 'string',
            description: 'Any additional context for the follow-up (optional)',
          },
        },
        required: ['client_name', 'client_email', 'preferred_contact', 'reason'],
      },
    },
  },
] as const;

// ── Debug tool (only injected when CALENDAR_DEBUG=true) ─────────
export const debugAvailabilityTool = {
  type: 'function' as const,
  function: {
    name: 'debug_availability' as const,
    description:
      'DEV-ONLY debug tool. Returns a structured availability report showing generated slots, ' +
      'Google Calendar busy ranges, and per-slot exclusion reasons. Use this when the user ' +
      'types "debug availability" followed by a date and optional time range. ' +
      'PII-safe: no event names, no emails, no calendar IDs.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format',
        },
        start: {
          type: 'string',
          description: 'Start time as HH:mm (24h). Default: 00:00',
        },
        end: {
          type: 'string',
          description: 'End time as HH:mm (24h). Default: 23:59',
        },
      },
      required: ['date'],
    },
  },
};

export type ToolName = typeof agentTools[number]['function']['name'] | 'debug_availability';
