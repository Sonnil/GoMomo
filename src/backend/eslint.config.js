// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Global ignores ────────────────────────────────────────
  { ignores: ['dist/', 'node_modules/', 'tests/', 'scripts/'] },

  // ── Base JS recommended ───────────────────────────────────
  eslint.configs.recommended,

  // ── TypeScript recommended (type-aware OFF to stay fast) ──
  ...tseslint.configs.recommended,

  // ── Project overrides — pragmatic, don't reformat the repo ─
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Allow unused vars prefixed with _ (common pattern in codebase)
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Allow explicit `any` with a warning (tighten later)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow non-null assertions (common in Fastify route handlers)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Allow empty functions (common for no-op callbacks)
      '@typescript-eslint/no-empty-function': 'off',
      // Prefer const — already used throughout
      'prefer-const': 'warn',
      // No console — OFF (pino migration is a separate PR)
      'no-console': 'off',
    },
  },
);
