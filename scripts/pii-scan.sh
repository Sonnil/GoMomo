#!/bin/zsh
# pii-scan.sh — Release Captain Gate 5: PII Scan
# Checks logs and source output for raw email addresses, API keys, or tokens.
# Only email_hash values are acceptable.
# Usage: bash scripts/pii-scan.sh
# Exit code: 0 = clean, 1 = PII found

set -uo pipefail

PROJ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIOLATIONS=0

echo "═══════════════════════════════════════════════════"
echo "  Release Captain — PII Scan (Gate 5)"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Check 1: Raw email addresses in log files ──────

echo "▸ Check 1: Raw email addresses in logs"

LOG_DIRS=("$PROJ_ROOT/logs" "$PROJ_ROOT/.logs")
EMAIL_REGEX='[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
EMAIL_HITS=0

for dir in "${LOG_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    # Search for email patterns, excluding known safe patterns
    HITS=$(grep -rEnl "$EMAIL_REGEX" "$dir" \
      --include="*.log" --include="*.txt" --include="*.json" \
      2>/dev/null | head -20)
    if [[ -n "$HITS" ]]; then
      echo "  ⚠️  Potential raw emails found in:"
      echo "$HITS" | while read -r f; do
        # Show context, masking the actual emails
        COUNT=$(grep -cE "$EMAIL_REGEX" "$f" 2>/dev/null || echo 0)
        echo "    $f ($COUNT occurrences)"
      done
      EMAIL_HITS=1
    fi
  fi
done

if [[ $EMAIL_HITS -eq 0 ]]; then
  echo "  ✅ No raw email addresses found in logs"
else
  echo "  ❌ Raw email addresses detected in log files"
  ((VIOLATIONS++))
fi
echo ""

# ─── Check 2: API keys / secrets in source output ───

echo "▸ Check 2: API keys or secrets in tracked source"

# Patterns that indicate leaked secrets (not in .env files, which are gitignored)
SECRET_PATTERNS=(
  'sk-[a-zA-Z0-9]{20,}'           # OpenAI API keys
  'sk_live_[a-zA-Z0-9]{20,}'      # Stripe live keys
  'AKIA[0-9A-Z]{16}'              # AWS access keys
  'ghp_[a-zA-Z0-9]{36}'           # GitHub personal access tokens
  'gho_[a-zA-Z0-9]{36}'           # GitHub OAuth tokens
  'xoxb-[0-9]{10,}'               # Slack bot tokens
  'ya29\.[a-zA-Z0-9_-]{50,}'      # Google OAuth tokens
)

SECRET_HITS=0
for pattern in "${SECRET_PATTERNS[@]}"; do
  FOUND=$(grep -rEnl "$pattern" "$PROJ_ROOT/src" \
    --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
    --include="*.json" \
    --exclude-dir=node_modules \
    2>/dev/null | head -5)
  if [[ -n "$FOUND" ]]; then
    echo "  ⚠️  Pattern '$pattern' matched in:"
    echo "$FOUND" | sed 's/^/    /'
    SECRET_HITS=1
  fi
done

if [[ $SECRET_HITS -eq 0 ]]; then
  echo "  ✅ No API keys or secrets found in source"
else
  echo "  ❌ Potential secrets detected in source files"
  ((VIOLATIONS++))
fi
echo ""

# ─── Check 3: email_hash compliance ─────────────────

echo "▸ Check 3: email_hash compliance in backend source"

# Verify that email references in agent/tool code use email_hash, not raw email
RAW_EMAIL_IN_SRC=$(grep -rEn 'email["\s]*:.*@.*\.' "$PROJ_ROOT/src/backend/src" \
  --include="*.ts" \
  --exclude-dir=node_modules \
  --exclude="*.test.ts" \
  --exclude="*.spec.ts" \
  2>/dev/null | grep -v 'email_hash' | grep -v '\.env' | grep -v 'example' | grep -v 'template' | grep -v '//' | head -10)

if [[ -z "$RAW_EMAIL_IN_SRC" ]]; then
  echo "  ✅ Backend source uses email_hash pattern correctly"
else
  echo "  ⚠️  Potential raw email references in backend source:"
  echo "$RAW_EMAIL_IN_SRC" | sed 's/^/    /'
  # This is a warning, not an auto-fail — may be false positives
  echo "  ⚡ Manual review recommended (may be false positives)"
fi
echo ""

# ─── Check 4: .env not committed ────────────────────

echo "▸ Check 4: .env files not in git"

ENV_IN_GIT=$(cd "$PROJ_ROOT" && git ls-files '*.env' '.env*' '**/.env' '**/.env.*' 2>/dev/null | grep -v '.env.example' | grep -v '.env.template' | head -5)

if [[ -z "$ENV_IN_GIT" ]]; then
  echo "  ✅ No .env files tracked in git"
else
  echo "  ❌ .env files found in git:"
  echo "$ENV_IN_GIT" | sed 's/^/    /'
  ((VIOLATIONS++))
fi
echo ""

# ─── Summary ─────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  PII SCAN SUMMARY"
echo "═══════════════════════════════════════════════════"

if [[ $VIOLATIONS -eq 0 ]]; then
  echo "  ✅ Gate 5 PASSED — No PII violations detected"
  echo ""
  echo "  All 5 gates complete. Ready for Release Report."
  echo "═══════════════════════════════════════════════════"
  exit 0
else
  echo "  ❌ Gate 5 FAILED — $VIOLATIONS violation(s) found"
  echo ""
  echo "  ⛔ RELEASE BLOCKED — Fix PII issues before proceeding"
  echo "═══════════════════════════════════════════════════"
  exit 1
fi
