import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const applicationElements = [
  { type: 'contracts', pattern: 'packages/contracts/**' },
  { type: 'core', pattern: 'packages/core/**' },
  { type: 'infrastructure', pattern: 'packages/infrastructure/**' },
  { type: 'web', pattern: 'apps/web/**' },
  { type: 'api', pattern: 'apps/api/**' },
  { type: 'worker', pattern: 'apps/worker/**' }
];

const element = (type) => ({ element: { type } });
const allow = (...types) => ({ to: { element: { types: { anyOf: types } } } });
const disallowModules = (...sources) => ({ to: { module: sources.map((source) => ({ origin: ['external', 'core'], source })) } });

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/web/src/components/ui/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': applicationElements,
      'boundaries/files': [
        { category: 'api-composition', pattern: 'apps/api/src/main.ts' },
        { category: 'worker-composition', pattern: 'apps/worker/src/main.ts' }
      ]
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          { from: element('contracts'), allow: allow('contracts') },
          { from: element('core'), allow: allow('core', 'contracts') },
          { from: element('infrastructure'), allow: allow('infrastructure', 'core', 'contracts') },
          { from: element('web'), allow: allow('web', 'core', 'contracts') },
          { from: element('api'), allow: allow('api', 'core', 'contracts') },
          { from: element('worker'), allow: allow('worker', 'core', 'contracts') },
          { from: { file: { categories: 'api-composition' } }, allow: allow('api', 'core', 'contracts', 'infrastructure') },
          { from: { file: { categories: 'worker-composition' } }, allow: allow('worker', 'core', 'contracts', 'infrastructure') },
          { from: element('core'), disallow: disallowModules('@slacato/infrastructure', '@nestjs/**', 'bullmq', 'react', 'react-dom') },
          { from: element('infrastructure'), disallow: disallowModules('@slacato/api', '@slacato/web', '@slacato/worker') },
          { from: element('web'), disallow: disallowModules('@slacato/infrastructure', '@slacato/api', '@slacato/worker') },
          { from: element('api'), disallow: disallowModules('@slacato/infrastructure', '@slacato/web', '@slacato/worker') },
          { from: element('worker'), disallow: disallowModules('@slacato/infrastructure', '@slacato/web', '@slacato/api') }
        ]
      }]
    }
  },
  { files: ['packages/core/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['@slacato/infrastructure', '@nestjs/**', 'bullmq', 'react', 'react-dom'] }] } },
  {
    files: ['packages/core/src/application/agents/{conversation,stakeholder,commercial,strategy}.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '@slacato/infrastructure', '@nestjs/**', 'bullmq', 'react', 'react-dom',
              './conversation.js', './stakeholder.js', './commercial.js', './strategy.js'
            ],
            message: 'Specialist agents must not import infrastructure, tools, or one another.'
          }
        ]
      }]
    }
  },
  { files: ['packages/infrastructure/**/*.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['@slacato/api', '@slacato/web', '@slacato/worker'] }] } },
  { files: ['apps/web/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: ['@slacato/infrastructure', '@slacato/api', '@slacato/worker'] }] } },
  { files: ['apps/api/src/**/*.ts'], ignores: ['apps/api/src/main.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['@slacato/infrastructure', '@slacato/web', '@slacato/worker'] }] } },
  { files: ['apps/worker/src/**/*.ts'], ignores: ['apps/worker/src/main.ts'], rules: { 'no-restricted-imports': ['error', { patterns: ['@slacato/infrastructure', '@slacato/web', '@slacato/api'] }] } }
);
