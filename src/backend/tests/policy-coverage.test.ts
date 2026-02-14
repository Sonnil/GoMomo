// ============================================================
// Policy Coverage Test
//
// Prevents new policyEngine.evaluate() action names from shipping
// without a corresponding policy rule in seed.ts or migrations.
//
// How it works:
//   1. Scans all *.ts files under src/ for policyEngine.evaluate('action_name', ...)
//   2. Extracts the unique set of action names used in production code
//   3. Reads seed.ts and extracts every action name seeded into policy_rules
//   4. Asserts that every production action has ≥1 seed rule
//
// Why:
//   The policy engine uses DEFAULT DENY. If an action has no matching
//   rule in policy_rules, it will be silently blocked at runtime.
//   (See: Migration 015 — send_sms_confirmation was missing for weeks.)
//
// Non-PII, deterministic, no database, no network.
// Run:  npx vitest run tests/policy-coverage.test.ts
// ============================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BACKEND_SRC = path.resolve(__dirname, '..', 'src');
const SEED_FILE = path.join(BACKEND_SRC, 'db', 'seed.ts');
const MIGRATIONS_DIR = path.join(BACKEND_SRC, 'db', 'migrations');

// ── Helpers ─────────────────────────────────────────────────

/** Recursively find all .ts files under a directory */
function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract all action names from policyEngine.evaluate('action_name', ...)
 * calls in a source file. Only matches string literal first arguments.
 */
function extractPolicyActions(filePath: string): { action: string; file: string; line: number }[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const results: { action: string; file: string; line: number }[] = [];
  const regex = /policyEngine\.evaluate\(\s*['"]([a-z_]+)['"]/g;

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(lines[i])) !== null) {
      results.push({
        action: match[1],
        file: path.relative(BACKEND_SRC, filePath),
        line: i + 1,
      });
    }
  }
  return results;
}

/**
 * Extract all action names from the seed.ts defaultRules array.
 * Looks for `action: 'action_name'` patterns.
 */
function extractSeededActions(): Set<string> {
  const content = fs.readFileSync(SEED_FILE, 'utf-8');
  const actions = new Set<string>();
  const regex = /action:\s*['"]([a-z_]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    actions.add(match[1]);
  }
  return actions;
}

/**
 * Extract action names from migration SQL files.
 * Looks for INSERT INTO policy_rules ... VALUES (NULL, 'action_name', ...)
 */
function extractMigrationActions(): Set<string> {
  const actions = new Set<string>();
  if (!fs.existsSync(MIGRATIONS_DIR)) return actions;

  for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    // Match: VALUES (NULL, 'action_name', ...) or VALUES (NULL, 'action_name',
    const regex = /INSERT\s+INTO\s+policy_rules[\s\S]*?VALUES\s*\([^,]*,\s*'([a-z_]+)'/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      actions.add(match[1]);
    }
  }
  return actions;
}

// ── Tests ───────────────────────────────────────────────────

describe('Policy Coverage — every gated action must have a seed rule', () => {
  // Collect all policyEngine.evaluate() calls from production source
  const allSourceFiles = walkTs(BACKEND_SRC);
  const allUsages = allSourceFiles.flatMap(extractPolicyActions);

  // Deduplicate: unique action names only
  const productionActions = [...new Set(allUsages.map((u) => u.action))].sort();

  // Collect all seeded/migrated actions
  const seededActions = extractSeededActions();
  const migratedActions = extractMigrationActions();
  const allRuledActions = new Set([...seededActions, ...migratedActions]);

  it('finds at least one policy-gated action in production code', () => {
    expect(productionActions.length).toBeGreaterThan(0);
  });

  it('every production action has a matching rule in seed.ts or migrations', () => {
    const missing = productionActions.filter((a) => !allRuledActions.has(a));

    if (missing.length > 0) {
      // Build a helpful error message showing where each missing action is used
      const details = missing.map((action) => {
        const usages = allUsages
          .filter((u) => u.action === action)
          .map((u) => `    → ${u.file}:${u.line}`)
          .join('\n');
        return `  ❌ "${action}" — no policy rule found\n${usages}`;
      });

      throw new Error(
        `\n\nPOLICY COVERAGE FAILURE — ${missing.length} action(s) have NO rule in seed.ts or migrations.\n` +
          `The policy engine uses DEFAULT DENY, so these actions will be silently blocked at runtime.\n\n` +
          details.join('\n\n') +
          `\n\nFix: Add an allow/deny rule to seed.ts (defaultRules array) and create a migration.\n` +
          `See Migration 015 (send_sms_confirmation) for a template.\n`,
      );
    }
  });

  it('reports all production actions for audit', () => {
    // This test always passes — it's a diagnostic snapshot.
    // If it changes, the diff shows what actions were added/removed.
    const snapshot = productionActions.map((action) => {
      const usages = allUsages.filter((u) => u.action === action);
      const files = [...new Set(usages.map((u) => u.file))].join(', ');
      const hasRule = allRuledActions.has(action) ? '✅' : '❌';
      return `${hasRule} ${action} (${files})`;
    });

    expect(snapshot).toMatchInlineSnapshot(`
      [
        "✅ escalate_calendar_failure (orchestrator/handlers/on-calendar-retry-exhausted.ts)",
        "✅ hold_followup (orchestrator/handlers/on-hold-expired.ts)",
        "✅ retry_calendar_sync (orchestrator/handlers/on-calendar-write-failed.ts)",
        "✅ send_cancellation (orchestrator/handlers/on-booking-cancelled.ts)",
        "✅ send_confirmation (orchestrator/handlers/on-booking-created.ts)",
        "✅ send_contact_followup (agent/tool-executor.ts)",
        "✅ send_reminder (orchestrator/handlers/on-booking-created.ts)",
        "✅ send_sms_confirmation (orchestrator/handlers/on-booking-created.ts)",
        "✅ waitlist_notify (orchestrator/handlers/on-slot-opened.ts)",
      ]
    `);
  });

  it('seed.ts rules are a superset of production actions (no orphan gaps)', () => {
    // Inverse check: warn if seed has rules for actions not used in code
    // (not a failure — deny rules like auto_cancel_no_show are intentional)
    const extraRules = [...allRuledActions].filter(
      (a) => !productionActions.includes(a),
    );

    // auto_cancel_no_show is a deliberate deny-only rule (no production evaluate call)
    // It's fine for seed to have rules that aren't called yet (forward planning)
    // This test just documents the state.
    for (const action of extraRules) {
      // Not a failure — just a note
      expect(typeof action).toBe('string');
    }
  });
});
