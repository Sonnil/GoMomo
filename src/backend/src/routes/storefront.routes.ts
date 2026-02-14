// ============================================================
// Storefront Routes — public facts + admin FAQ management
// ============================================================

import { FastifyInstance } from 'fastify';
import { markPublic, requireAdminKey } from '../auth/middleware.js';
import { GOMOMO_FACTS } from '../storefront/gomomo-facts.js';
import {
  listUnansweredFaqs,
  getUnansweredFaq,
  proposeAnswer,
  approveAnswer,
  dismissFaq,
  listApprovedFaqs,
} from '../storefront/faq-repo.js';
import { retrieveStorefrontContext } from '../storefront/retrieval.js';

export async function storefrontRoutes(app: FastifyInstance): Promise<void> {
  // ══════════════════════════════════════════════════════════
  // PUBLIC ENDPOINTS
  // ══════════════════════════════════════════════════════════

  /**
   * GET /api/public/storefront/facts
   * Returns the canonical facts about Gomomo + last_updated timestamp.
   * Public — no auth required.
   */
  app.get('/api/public/storefront/facts', { preHandler: markPublic }, async () => {
    return {
      ...GOMOMO_FACTS,
      _meta: {
        source: 'gomomo-facts.ts',
        note: 'Canonical source of truth. Edit src/backend/src/storefront/gomomo-facts.ts to update.',
      },
    };
  });

  // ══════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS (requireAdminKey)
  // ══════════════════════════════════════════════════════════

  /**
   * GET /api/admin/storefront/unanswered-faqs
   * Lists unanswered FAQs, optionally filtered by status.
   */
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/admin/storefront/unanswered-faqs',
    { preHandler: requireAdminKey },
    async (req) => {
      const status = req.query.status;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      const faqs = await listUnansweredFaqs(status, limit);
      return { faqs, count: faqs.length };
    },
  );

  /**
   * POST /api/admin/storefront/unanswered-faqs/:id/propose
   * Uses LLM to draft an answer using facts + retrieved corpus.
   * Stores the proposed answer; sets status to 'proposed'.
   */
  app.post<{ Params: { id: string } }>(
    '/api/admin/storefront/unanswered-faqs/:id/propose',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const faq = await getUnansweredFaq(req.params.id);
      if (!faq) return reply.code(404).send({ error: 'FAQ not found' });
      if (faq.status === 'approved') {
        return reply.code(400).send({ error: 'FAQ already approved' });
      }

      // Retrieve relevant passages from corpus
      const retrieval = retrieveStorefrontContext(faq.question, 3);
      const passageContext = retrieval.results.length > 0
        ? retrieval.results.map((r) => r.passage).join('\n\n')
        : '(no relevant passages found)';

      // Build a draft answer using facts + passages
      // In production, this would call the LLM. For now, we compose a template.
      const factsContext = `Brand: ${GOMOMO_FACTS.brand_name}\nDescription: ${GOMOMO_FACTS.short_description}\nContact: ${GOMOMO_FACTS.contact.general}`;
      const draft = `Based on our documentation:\n\n${passageContext}\n\nKey facts: ${factsContext}\n\n(This is an auto-generated draft. Please review and edit before approving.)`;

      const updated = await proposeAnswer(faq.id, draft);
      if (!updated) return reply.code(500).send({ error: 'Failed to propose answer' });

      return {
        faq: updated,
        retrieval_sources: retrieval.results.map((r) => r.source),
        note: 'Draft stored. Review and edit the proposed_answer, then POST /approve to make it live.',
      };
    },
  );

  /**
   * POST /api/admin/storefront/unanswered-faqs/:id/approve
   * Moves the proposed answer into the approved_faqs table.
   * The approved answer will be served deterministically by the router.
   */
  app.post<{ Params: { id: string } }>(
    '/api/admin/storefront/unanswered-faqs/:id/approve',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const faq = await getUnansweredFaq(req.params.id);
      if (!faq) return reply.code(404).send({ error: 'FAQ not found' });
      if (!faq.proposed_answer) {
        return reply.code(400).send({ error: 'No proposed answer to approve. Call /propose first.' });
      }

      const approved = await approveAnswer(faq.id);
      if (!approved) return reply.code(500).send({ error: 'Failed to approve answer' });

      return {
        approved_faq: approved,
        note: 'Answer is now live. The agent will serve this answer for matching questions.',
      };
    },
  );

  /**
   * POST /api/admin/storefront/unanswered-faqs/:id/dismiss
   * Marks an unanswered FAQ as dismissed (not worth answering).
   */
  app.post<{ Params: { id: string } }>(
    '/api/admin/storefront/unanswered-faqs/:id/dismiss',
    { preHandler: requireAdminKey },
    async (req, reply) => {
      const updated = await dismissFaq(req.params.id);
      if (!updated) return reply.code(404).send({ error: 'FAQ not found' });
      return { faq: updated };
    },
  );

  /**
   * GET /api/admin/storefront/approved-faqs
   * Lists all approved FAQs.
   */
  app.get(
    '/api/admin/storefront/approved-faqs',
    { preHandler: requireAdminKey },
    async () => {
      const faqs = await listApprovedFaqs();
      return { faqs, count: faqs.length };
    },
  );
}
