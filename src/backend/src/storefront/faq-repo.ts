// ============================================================
// Storefront FAQ Repository — DB access for unanswered + approved FAQs
// ============================================================

import { pool } from '../db/client.js';

// ── Types ───────────────────────────────────────────────────

export interface UnansweredFaq {
  id: string;
  question: string;
  first_seen_at: string;
  last_seen_at: string;
  count: number;
  status: 'new' | 'proposed' | 'approved' | 'dismissed';
  proposed_answer: string | null;
  approved_at: string | null;
}

export interface ApprovedFaq {
  id: string;
  question: string;
  answer: string;
  source_faq_id: string | null;
  approved_at: string;
}

// ── Unanswered FAQs ─────────────────────────────────────────

/**
 * Log an unanswered question. If the same question (case-insensitive)
 * already exists, increment the count and update last_seen_at.
 */
export async function logUnansweredFaq(question: string): Promise<UnansweredFaq> {
  const normalized = question.trim();

  // Try to find an existing entry (case-insensitive, fuzzy-ish)
  const { rows: existing } = await pool.query<UnansweredFaq>(
    `SELECT * FROM unanswered_faqs WHERE lower(question) = lower($1) LIMIT 1`,
    [normalized],
  );

  if (existing.length > 0) {
    const { rows } = await pool.query<UnansweredFaq>(
      `UPDATE unanswered_faqs
       SET count = count + 1, last_seen_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [existing[0].id],
    );
    return rows[0];
  }

  const { rows } = await pool.query<UnansweredFaq>(
    `INSERT INTO unanswered_faqs (question)
     VALUES ($1)
     RETURNING *`,
    [normalized],
  );
  return rows[0];
}

/**
 * List unanswered FAQs, optionally filtered by status.
 */
export async function listUnansweredFaqs(
  status?: string,
  limit = 50,
): Promise<UnansweredFaq[]> {
  if (status) {
    const { rows } = await pool.query<UnansweredFaq>(
      `SELECT * FROM unanswered_faqs WHERE status = $1 ORDER BY count DESC, last_seen_at DESC LIMIT $2`,
      [status, limit],
    );
    return rows;
  }
  const { rows } = await pool.query<UnansweredFaq>(
    `SELECT * FROM unanswered_faqs ORDER BY count DESC, last_seen_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Get a single unanswered FAQ by ID.
 */
export async function getUnansweredFaq(id: string): Promise<UnansweredFaq | null> {
  const { rows } = await pool.query<UnansweredFaq>(
    `SELECT * FROM unanswered_faqs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Store a proposed answer for an unanswered FAQ (drafted by LLM).
 */
export async function proposeAnswer(id: string, proposedAnswer: string): Promise<UnansweredFaq | null> {
  const { rows } = await pool.query<UnansweredFaq>(
    `UPDATE unanswered_faqs
     SET proposed_answer = $2, status = 'proposed'
     WHERE id = $1
     RETURNING *`,
    [id, proposedAnswer],
  );
  return rows[0] ?? null;
}

/**
 * Approve a proposed answer — moves it to the approved_faqs table.
 * Marks the unanswered FAQ as 'approved'.
 */
export async function approveAnswer(id: string): Promise<ApprovedFaq | null> {
  const faq = await getUnansweredFaq(id);
  if (!faq || !faq.proposed_answer) return null;

  // Insert into approved_faqs
  const { rows } = await pool.query<ApprovedFaq>(
    `INSERT INTO approved_faqs (question, answer, source_faq_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [faq.question, faq.proposed_answer, faq.id],
  );

  // Mark original as approved
  await pool.query(
    `UPDATE unanswered_faqs SET status = 'approved', approved_at = NOW() WHERE id = $1`,
    [id],
  );

  return rows[0];
}

/**
 * Dismiss an unanswered FAQ (not worth answering).
 */
export async function dismissFaq(id: string): Promise<UnansweredFaq | null> {
  const { rows } = await pool.query<UnansweredFaq>(
    `UPDATE unanswered_faqs SET status = 'dismissed' WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

// ── Approved FAQs ───────────────────────────────────────────

/**
 * Search approved FAQs for a matching answer (case-insensitive substring match).
 * Returns the best match or null.
 */
export async function findApprovedAnswer(question: string): Promise<ApprovedFaq | null> {
  const normalized = question.trim().toLowerCase();

  // First try exact match
  const { rows: exact } = await pool.query<ApprovedFaq>(
    `SELECT * FROM approved_faqs WHERE lower(question) = $1 LIMIT 1`,
    [normalized],
  );
  if (exact.length > 0) return exact[0];

  // Then try substring containment (question contains key terms from the query)
  // Split query into significant words (>3 chars) and find FAQs containing them
  const keywords = normalized.split(/\s+/).filter((w) => w.length > 3);
  if (keywords.length === 0) return null;

  // Build a LIKE query that matches any keyword
  const likeConditions = keywords.map((_, i) => `lower(question) LIKE $${i + 1}`).join(' OR ');
  const likeParams = keywords.map((kw) => `%${kw}%`);

  const { rows } = await pool.query<ApprovedFaq>(
    `SELECT * FROM approved_faqs WHERE ${likeConditions} ORDER BY approved_at DESC LIMIT 1`,
    likeParams,
  );
  return rows[0] ?? null;
}

/**
 * List all approved FAQs.
 */
export async function listApprovedFaqs(limit = 100): Promise<ApprovedFaq[]> {
  const { rows } = await pool.query<ApprovedFaq>(
    `SELECT * FROM approved_faqs ORDER BY approved_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
