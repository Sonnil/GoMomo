// ============================================================
// Policy Engine — Evaluates whether an autonomous action
// is allowed or denied based on the policy_rules table.
//
// Design principles:
//   - DEFAULT DENY: if no matching rule exists, action is denied
//   - Tenant-specific rules override global rules
//   - Higher priority wins within the same scope
//   - Conditions are evaluated as simple key-value predicates
//   - Every decision is audit-logged
// ============================================================

import type { PolicyDecision } from '../domain/types.js';
import { policyRepo } from '../repos/policy.repo.js';
import { auditRepo } from '../repos/audit.repo.js';

export const policyEngine = {
  /**
   * Evaluate whether an action is allowed for a given tenant.
   *
   * @param action - The action to evaluate (e.g. 'send_confirmation')
   * @param tenantId - The tenant requesting the action
   * @param context - Runtime context for condition evaluation
   * @returns PolicyDecision with effect, rule_id, and reason
   */
  async evaluate(
    action: string,
    tenantId: string,
    context: Record<string, unknown> = {},
  ): Promise<PolicyDecision> {
    const rules = await policyRepo.findByAction(action, tenantId);

    // Find the first matching rule (highest priority, tenant-specific first)
    for (const rule of rules) {
      if (matchesConditions(rule.conditions as Record<string, unknown>, context)) {
        const decision: PolicyDecision = {
          effect: rule.effect,
          rule_id: rule.id,
          action,
          reason: rule.effect === 'allow'
            ? `Allowed by rule ${rule.id} (priority ${rule.priority})`
            : `Denied by rule ${rule.id} (priority ${rule.priority})`,
          evaluated_at: new Date().toISOString(),
        };

        // Audit the decision
        await logDecision(tenantId, decision);
        return decision;
      }
    }

    // DEFAULT DENY — no matching rule found
    const decision: PolicyDecision = {
      effect: 'deny',
      rule_id: null,
      action,
      reason: 'Default deny: no matching policy rule found',
      evaluated_at: new Date().toISOString(),
    };

    await logDecision(tenantId, decision);
    return decision;
  },
};

/**
 * Check if a rule's conditions match the runtime context.
 * Empty conditions always match (unconditional rule).
 *
 * Supported condition types:
 *   - Simple equality: { "key": "value" }
 *   - Minimum: { "min_lead_time_minutes": 60 } (context must have >= value)
 *   - Maximum: { "max_daily_notifications": 10 } (context must have <= value)
 */
function matchesConditions(
  conditions: Record<string, unknown>,
  context: Record<string, unknown>,
): boolean {
  const entries = Object.entries(conditions);
  if (entries.length === 0) return true; // No conditions = always matches

  for (const [key, expected] of entries) {
    const actual = context[key];

    // min_ prefix: context value must be >= expected
    if (key.startsWith('min_') && typeof expected === 'number') {
      if (typeof actual !== 'number' || actual < expected) return false;
      continue;
    }

    // max_ prefix: context value must be <= expected
    if (key.startsWith('max_') && typeof expected === 'number') {
      if (typeof actual !== 'number' || actual > expected) return false;
      continue;
    }

    // Simple equality
    if (actual !== expected) return false;
  }

  return true;
}

async function logDecision(tenantId: string, decision: PolicyDecision): Promise<void> {
  try {
    await auditRepo.log({
      tenant_id: tenantId,
      event_type: `policy.${decision.effect}`,
      entity_type: 'policy_decision',
      entity_id: decision.rule_id,
      actor: 'policy_engine',
      payload: {
        action: decision.action,
        effect: decision.effect,
        reason: decision.reason,
        evaluated_at: decision.evaluated_at,
      },
    });
  } catch (err) {
    console.error('[policy-engine] Audit log failed:', err);
  }
}
