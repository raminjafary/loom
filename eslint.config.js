import tseslint from 'typescript-eslint'

/**
 * Architectural boundaries.
 *
 * The dependency rule — outer layers depend on inner, never the reverse — is
 * enforced here rather than left to discipline. A vendor type crossing a port
 * boundary is what silently makes a layer unswappable, and it always happens
 * under deadline pressure, so the lint rule is the load-bearing part.
 */

const INFRA_PACKAGES = [
  'drizzle-orm',
  'drizzle-orm/*',
  'postgres',
  'pg',
  'ioredis',
  'bullmq',
  'fastify',
  'fastify/*',
  '@fastify/*',
  '@orpc/*',
  'better-auth',
  'better-auth/*',
  'vue',
  'pinia',
  '@vue/*',
  'vite',
]

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...INFRA_PACKAGES, '@loom/*'],
              message:
                'Domain is the innermost layer: zero dependencies. It may not import infrastructure or any other @loom package.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/application/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: INFRA_PACKAGES,
              message:
                'Application depends on ports (interfaces), never on infrastructure. Define a port and implement it in an adapter instead.',
            },
            {
              group: ['@loom/db', '@loom/api-contract', '@loom/client-core'],
              message:
                'Application may only import @loom/domain. Anything else is an outer layer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/api-contract/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'postgres', 'pg', 'ioredis', '@loom/db'],
              message:
                'The contract is the wire boundary: no persistence types may cross it. Define the shape in Zod.',
            },
          ],
        },
      ],
    },
  },
)
