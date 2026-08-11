import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'src/generated/prisma/**',
      'test/architecture/fixtures/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: [
      'prisma.config.ts',
      'src/**/*.ts',
      'scripts/**/*.ts',
      'test/**/*.ts',
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@test/**'],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/platform/config/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='@nestjs/config'] ImportSpecifier[imported.name='ConfigService']",
          message:
            'Runtime code must use RuntimeConfigService instead of raw ConfigService.',
        },
        {
          selector:
            "MemberExpression[object.name='process'][computed=false][property.name='env']",
          message:
            'Runtime environment access is owned by src/platform/config.',
        },
        {
          selector:
            "MemberExpression[object.name='process'][computed=true][property.value='env']",
          message:
            'Runtime environment access is owned by src/platform/config.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/modules/*/domain/**/*.ts', 'src/shared/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@test/**'] },
            {
              group: [
                '@nestjs/**',
                '@prisma/**',
                '@opentelemetry/**',
                'express',
                'ioredis',
                'pino',
                'redis',
              ],
              message: 'Domain code must remain framework-free.',
            },
            {
              group: [
                '@/bootstrap',
                '@/bootstrap/**',
                '@/platform',
                '@/platform/**',
                '@/modules/**',
              ],
              message:
                'Domain code uses relative imports inside its own domain and cannot depend on another module or outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              allowImportNames: ['Inject', 'Injectable'],
              message:
                'Module application code may use only Inject and Injectable as Nest DI metadata.',
            },
          ],
          patterns: [
            { group: ['@test/**'] },
            {
              regex:
                '^@nestjs/(?!common$)|^@prisma/|^@opentelemetry/|^express$|^ioredis$|^pino$|^redis$',
              message:
                'Application code depends on ports; only Nest DI metadata is allowed.',
            },
            {
              group: [
                '@/bootstrap',
                '@/bootstrap/**',
                '@/platform',
                '@/platform/**',
                '@/modules/*/composition',
                '@/modules/*/composition/**',
                '@/modules/*/infrastructure',
                '@/modules/*/infrastructure/**',
                '@/modules/*/presentation',
                '@/modules/*/presentation/**',
              ],
              message: 'Application code cannot depend on outer adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@test/**'] },
            {
              group: [
                '@nestjs/**',
                '@prisma/**',
                '@opentelemetry/**',
                'express',
                'ioredis',
                'pino',
                'redis',
              ],
              message: 'Shared application code must remain framework-free.',
            },
            {
              group: [
                '@/bootstrap',
                '@/bootstrap/**',
                '@/platform',
                '@/platform/**',
                '@/modules/*/composition',
                '@/modules/*/composition/**',
                '@/modules/*/infrastructure',
                '@/modules/*/infrastructure/**',
                '@/modules/*/presentation',
                '@/modules/*/presentation/**',
              ],
              message:
                'Shared application code cannot depend on modules or outer adapters.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@test/**'] },
            {
              group: [
                '@prisma/**',
                'ioredis',
                'redis',
                '@/bootstrap',
                '@/bootstrap/**',
                '@/modules/*/composition',
                '@/modules/*/composition/**',
                '@/modules/*/infrastructure',
                '@/modules/*/infrastructure/**',
              ],
              message:
                'Presentation calls application contracts and cannot depend on persistence, composition or bootstrap.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@test/**'] },
            {
              group: [
                '@/bootstrap',
                '@/bootstrap/**',
                '@/modules/*/composition',
                '@/modules/*/composition/**',
                '@/modules/*/presentation',
                '@/modules/*/presentation/**',
              ],
              message:
                'Infrastructure implements ports and cannot depend on presentation, composition or bootstrap.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/composition/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@test/**'] },
            {
              group: ['@/bootstrap', '@/bootstrap/**'],
              message:
                'Composition is wired by bootstrap and never imports it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
)
