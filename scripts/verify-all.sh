#!/bin/zsh
# verify-all.sh — Release Captain validation pack
# Runs Gates 1-4: service health, full test suite, e2e tests, Next.js build
# Usage: bash scripts/verify-all.sh
# Exit code: 0 = all gates passed, non-zero = at least one gate failed

set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v20.19.4/bin:$PATH"

PROJ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
GATE_RESULTS=()

report_gate() {
  local gate="$1" result="$2" detail="$3"
  if [[ "$result" == "PASS" ]]; then
    GATE_RESULTS+=("  ✅ Gate $gate: $detail")
    ((PASS++))
  else
    GATE_RESULTS+=("  ❌ Gate $gate: $detail")
    ((FAIL++))
  fi
}

echo "═══════════════════════════════════════════════════"
echo "  Release Captain — Validation Pack"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Gate 1: Service Health ──────────────────────────

echo "▸ Gate 1: Service Health"
G1_OK=true

BACKEND_HTTP=$(curl -4 --max-time 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health 2>/dev/null || echo "000")
WIDGET_HTTP=$(curl -4 --max-time 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null || echo "000")
WEBAPP_HTTP=$(curl -4 --max-time 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/ 2>/dev/null || echo "000")

echo "  Backend  :3000 → HTTP $BACKEND_HTTP"
echo "  Widget   :5173 → HTTP $WIDGET_HTTP"
echo "  Web App  :3001 → HTTP $WEBAPP_HTTP"

[[ "$BACKEND_HTTP" == "200" ]] || G1_OK=false
[[ "$WIDGET_HTTP" == "200" ]] || G1_OK=false
[[ "$WEBAPP_HTTP" == "200" ]] || G1_OK=false

if $G1_OK; then
  report_gate "1" "PASS" "All 3 services healthy (200/200/200)"
else
  report_gate "1" "FAIL" "Service(s) unhealthy — Backend:$BACKEND_HTTP Widget:$WIDGET_HTTP WebApp:$WEBAPP_HTTP"
fi
echo ""

# ─── Gate 2: Full Test Suite ─────────────────────────

echo "▸ Gate 2: Full Test Suite"
G2_OK=true

echo "  Running backend tests..."
if (cd "$PROJ_ROOT/src/backend" && npx vitest run --reporter=verbose 2>&1 | tail -5); then
  echo "  ✓ Backend tests passed"
else
  echo "  ✗ Backend tests FAILED"
  G2_OK=false
fi

echo "  Running frontend tests..."
if (cd "$PROJ_ROOT/src/frontend" && npx vitest run --reporter=verbose 2>&1 | tail -5); then
  echo "  ✓ Frontend tests passed"
else
  echo "  ✗ Frontend tests FAILED"
  G2_OK=false
fi

if $G2_OK; then
  report_gate "2" "PASS" "All tests passed (backend + frontend)"
else
  report_gate "2" "FAIL" "Test failures detected"
fi
echo ""

# ─── Gate 3: Deterministic E2E Tests ─────────────────

echo "▸ Gate 3: Deterministic E2E Tests"
G3_OK=true

echo "  Running e2e-error-verification..."
if (cd "$PROJ_ROOT/src/backend" && npx vitest run tests/e2e-error-verification.test.ts 2>&1 | tail -3); then
  echo "  ✓ e2e-error-verification passed"
else
  echo "  ✗ e2e-error-verification FAILED"
  G3_OK=false
fi

echo "  Running error-mapping..."
if (cd "$PROJ_ROOT/src/backend" && npx vitest run tests/error-mapping.test.ts 2>&1 | tail -3); then
  echo "  ✓ error-mapping passed"
else
  echo "  ✗ error-mapping FAILED"
  G3_OK=false
fi

if $G3_OK; then
  report_gate "3" "PASS" "All deterministic E2E tests passed"
else
  report_gate "3" "FAIL" "E2E test failures detected"
fi
echo ""

# ─── Gate 4: Next.js Production Build ────────────────

echo "▸ Gate 4: Next.js Production Build"

echo "  Running next build..."
if (cd "$PROJ_ROOT/src/web" && npm run build 2>&1 | tail -10); then
  report_gate "4" "PASS" "Next.js build succeeded"
else
  report_gate "4" "FAIL" "Next.js build failed"
fi
echo ""

# ─── Summary ─────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  VALIDATION SUMMARY"
echo "═══════════════════════════════════════════════════"
for line in "${GATE_RESULTS[@]}"; do
  echo "$line"
done
echo ""
echo "  Gates passed: $PASS / $((PASS + FAIL))"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "  ⛔ RELEASE BLOCKED — $FAIL gate(s) failed"
  echo "═══════════════════════════════════════════════════"
  exit 1
else
  echo ""
  echo "  ✅ ALL GATES PASSED — Ready for PII scan (Gate 5)"
  echo "  Next step: bash scripts/pii-scan.sh"
  echo "═══════════════════════════════════════════════════"
  exit 0
fi
