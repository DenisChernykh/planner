/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'progress-must-be-self-contained-policy',
      severity: 'error',
      from: { path: '(^|/)modules/progress(/|$)' },
      to: {
        pathNot: '(^|/)modules/progress(/|$)',
      },
    },
    {
      name: 'bootstrap-must-not-import-database-drivers',
      severity: 'error',
      from: { path: '(^|/)bootstrap(/|$)' },
      to: {
        path: '(^|/)(node_modules/)?(@prisma/|pg(/|$))|(^|/)generated/prisma(/|$)',
      },
    },
    {
      name: 'bootstrap-must-import-modules-through-composition',
      severity: 'error',
      from: { path: '(^|/)bootstrap(/|$)' },
      to: {
        path: '(^|/)modules/[^/]+/(domain|application|infrastructure|presentation)(/|$)',
      },
    },
    {
      name: 'module-public-api-must-not-export-domain',
      severity: 'error',
      from: { path: '(^|/)modules/[^/]+/index\\.ts$' },
      to: { path: '(^|/)modules/[^/]+/domain(/|$)' },
    },
    {
      name: 'application-must-not-import-generated-prisma',
      severity: 'error',
      from: { path: '(^|/)application(/|$)' },
      to: { path: '(^|/)generated/prisma(/|$)' },
    },
    {
      name: 'platform-non-database-must-not-import-database-drivers',
      severity: 'error',
      from: {
        path: '(^|/)platform/(?!database(/|$))',
      },
      to: {
        path: '(^|/)(node_modules/)?(@prisma/|pg(/|$))|(^|/)generated/prisma(/|$)',
      },
    },
    {
      name: 'shared-application-must-not-import-platform-database',
      severity: 'error',
      from: { path: '(^|/)shared/application(/|$)' },
      to: { path: '(^|/)platform/database(/|$)' },
    },
    {
      name: 'no-unresolvable-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: { pathNot: '(^|/)generated/prisma(/|$)' },
      to: { circular: true },
    },
    {
      name: 'domain-must-not-import-frameworks',
      severity: 'error',
      from: { path: '(^|/)domain(/|$)' },
      to: {
        path: '(^|/)(node_modules/)?(@nestjs/|@prisma/|@opentelemetry/|bullmq(/|$)|express(/|$)|ioredis(/|$)|pino(/|$)|redis(/|$))',
      },
    },
    {
      name: 'domain-must-not-import-outer-layers',
      severity: 'error',
      from: { path: '(^|/)domain(/|$)' },
      to: {
        path: '(^|/)(application|infrastructure|presentation|composition|platform|bootstrap)(/|$)',
      },
    },
    {
      name: 'application-must-not-import-non-di-frameworks',
      severity: 'error',
      from: { path: '(^|/)application(/|$)' },
      to: {
        path: '(^|/)(node_modules/)?(@nestjs/(?!common(/|$))|@prisma/|@opentelemetry/|bullmq(/|$)|express(/|$)|ioredis(/|$)|pino(/|$)|redis(/|$))',
      },
    },
    {
      name: 'shared-application-must-not-import-nest',
      severity: 'error',
      from: { path: '(^|/)shared/application(/|$)' },
      to: {
        path: '(^|/)(node_modules/)?@nestjs/',
      },
    },
    {
      name: 'application-must-not-import-adapters',
      severity: 'error',
      from: { path: '(^|/)application(/|$)' },
      to: {
        path: '(^|/)(infrastructure|presentation|composition|platform|bootstrap)(/|$)',
      },
    },
    {
      name: 'presentation-must-not-import-infrastructure',
      severity: 'error',
      from: { path: '(^|/)presentation(/|$)' },
      to: {
        path: '(^|/)infrastructure(/|$)|(^|/)(node_modules/)?(@nestjs/bullmq(/|$)|@prisma/|bullmq(/|$)|ioredis(/|$)|redis(/|$))',
      },
    },
    {
      name: 'presentation-must-not-import-composition',
      severity: 'error',
      from: { path: '(^|/)presentation(/|$)' },
      to: { path: '(^|/)composition(/|$)' },
    },
    {
      name: 'infrastructure-must-not-import-presentation',
      severity: 'error',
      from: { path: '(^|/)infrastructure(/|$)' },
      to: { path: '(^|/)presentation(/|$)' },
    },
    {
      name: 'infrastructure-must-not-import-composition',
      severity: 'error',
      from: { path: '(^|/)infrastructure(/|$)' },
      to: { path: '(^|/)composition(/|$)' },
    },
    {
      name: 'modules-must-not-import-bootstrap',
      severity: 'error',
      from: { path: '(^|/)modules(/|$)' },
      to: { path: '(^|/)bootstrap(/|$)' },
    },
    {
      name: 'platform-must-not-import-modules',
      severity: 'error',
      from: { path: '(^|/)platform(/|$)' },
      to: { path: '(^|/)modules(/|$)' },
    },
    {
      name: 'shared-must-not-import-modules-or-platform',
      severity: 'error',
      from: { path: '(^|/)shared(/|$)' },
      to: { path: '(^|/)(modules|platform|bootstrap)(/|$)' },
    },
    {
      name: 'src-must-not-import-test-scripts-or-templates',
      severity: 'error',
      from: { path: '(^|/)src(/|$)' },
      to: { path: '(^|/)(test|scripts|templates)(/|$)' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    enhancedResolveOptions: {
      conditionNames: ['node', 'require', 'types', 'default'],
      exportsFields: ['exports'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
}
