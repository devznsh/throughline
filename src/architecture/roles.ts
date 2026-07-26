import { SymbolRole, type SymbolKind } from '../core/model/index.js';

/**
 * Architectural inference.
 *
 * "Which files implement payments?" and "explain the request lifecycle" both
 * need something no parser produces: a notion of what a symbol *is for*. There
 * is no annotation to read, so this file infers it from the three signals that
 * exist in every real codebase — where the file lives, what the symbol is called,
 * and which framework decorated it.
 *
 * The rules are ordered most-specific-first and every one is a table entry. This
 * is unapologetically heuristic; the value is that it is *inspectable* heuristic.
 * A wrong classification is a visible row someone can fix, not an opaque score.
 */

export interface RoleInput {
  readonly relPath: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly docComment: string | null;
  readonly isTest: boolean;
}

interface RoleRule {
  readonly role: SymbolRole;
  readonly path?: RegExp;
  readonly name?: RegExp;
  readonly signature?: RegExp;
}

const ROLE_RULES: readonly RoleRule[] = [
  { role: SymbolRole.Migration, path: /(^|\/)(migrations?|alembic|flyway)\// },
  { role: SymbolRole.Migration, name: /^(up|down)$/ },

  // Framework route decorators and registrations are the strongest signal there
  // is: they are unambiguous, machine-written markers of an HTTP entry point.
  {
    role: SymbolRole.Controller,
    signature:
      /@(Get|Post|Put|Patch|Delete|All|Controller|RequestMapping|GetMapping|PostMapping|HttpGet|HttpPost|api_route|route|app\.(get|post|put|patch|delete))\b/i,
  },
  { role: SymbolRole.Controller, path: /(^|\/)(controllers?|routes?|handlers?|api|endpoints?|views?)\// },
  { role: SymbolRole.Controller, name: /(Controller|Router|Route|Endpoint|Resource)$/ },

  { role: SymbolRole.Middleware, path: /(^|\/)(middlewares?|interceptors?|guards?|filters?)\// },
  { role: SymbolRole.Middleware, name: /(Middleware|Interceptor|Guard|Filter)$/ },

  { role: SymbolRole.Repository, path: /(^|\/)(repositor(y|ies)|daos?|stores?|persistence)\// },
  { role: SymbolRole.Repository, name: /(Repository|Repo|Dao|Store|Mapper)$/ },

  { role: SymbolRole.Service, path: /(^|\/)(services?|usecases?|use_cases?|domain|application)\// },
  { role: SymbolRole.Service, name: /(Service|Manager|Provider|UseCase|Interactor|Facade)$/ },

  { role: SymbolRole.Model, path: /(^|\/)(models?|entities|schemas?|domain\/model)\// },
  { role: SymbolRole.Model, name: /(Model|Entity|Schema|Dto|Record)$/ },

  { role: SymbolRole.Worker, path: /(^|\/)(workers?|consumers?|listeners?|subscribers?)\// },
  { role: SymbolRole.Worker, name: /(Worker|Consumer|Listener|Subscriber|Processor)$/ },
  { role: SymbolRole.Worker, signature: /@(Processor|EventPattern|MessagePattern|shared_task|task)\b/ },

  { role: SymbolRole.Job, path: /(^|\/)(jobs?|tasks?|cron|schedulers?)\// },
  { role: SymbolRole.Job, name: /(Job|Task|Cron|Scheduler)$/ },
  { role: SymbolRole.Job, signature: /@(Cron|Interval|Scheduled|scheduled_job)\b/ },

  { role: SymbolRole.Handler, name: /^(handle|on)[A-Z]/ },
  { role: SymbolRole.Handler, name: /Handler$/ },

  { role: SymbolRole.Config, path: /(^|\/)(config|configuration|settings)(\/|\.)/ },
  { role: SymbolRole.Config, name: /(Config|Settings|Options)$/ },

  { role: SymbolRole.Entrypoint, path: /(^|\/)(main|index|server|app|cmd\/[^/]+\/main)\.[a-z]+$/ },
  { role: SymbolRole.Entrypoint, name: /^(main|bootstrap|start|serve)$/ },
];

export function inferRole(input: RoleInput): SymbolRole {
  if (input.isTest) return SymbolRole.Test;

  for (const rule of ROLE_RULES) {
    if (rule.signature?.test(input.signature) === true) return rule.role;
    if (rule.path?.test(input.relPath) === true) return rule.role;
    if (rule.name?.test(input.name) === true) return rule.role;
  }
  return SymbolRole.Unknown;
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

export interface FrameworkSignature {
  readonly id: string;
  readonly label: string;
  readonly category: 'web' | 'orm' | 'queue' | 'test' | 'build' | 'cloud' | 'frontend';
  /** External package names that indicate the framework is in use. */
  readonly packages: readonly string[];
  /** Files whose presence corroborates it. */
  readonly files?: readonly RegExp[];
}

export const FRAMEWORK_SIGNATURES: readonly FrameworkSignature[] = [
  { id: 'express', label: 'Express', category: 'web', packages: ['express'] },
  { id: 'fastify', label: 'Fastify', category: 'web', packages: ['fastify'] },
  { id: 'nestjs', label: 'NestJS', category: 'web', packages: ['@nestjs/core', '@nestjs/common'] },
  { id: 'koa', label: 'Koa', category: 'web', packages: ['koa'] },
  { id: 'hono', label: 'Hono', category: 'web', packages: ['hono'] },
  { id: 'nextjs', label: 'Next.js', category: 'frontend', packages: ['next'], files: [/^next\.config\./] },
  { id: 'react', label: 'React', category: 'frontend', packages: ['react'] },
  { id: 'vue', label: 'Vue', category: 'frontend', packages: ['vue'] },
  { id: 'svelte', label: 'Svelte', category: 'frontend', packages: ['svelte'] },
  { id: 'django', label: 'Django', category: 'web', packages: ['django', 'Django'], files: [/(^|\/)manage\.py$/, /(^|\/)settings\.py$/] },
  { id: 'fastapi', label: 'FastAPI', category: 'web', packages: ['fastapi'] },
  { id: 'flask', label: 'Flask', category: 'web', packages: ['flask', 'Flask'] },
  { id: 'gin', label: 'Gin', category: 'web', packages: ['github.com/gin-gonic/gin'] },
  { id: 'echo', label: 'Echo', category: 'web', packages: ['github.com/labstack/echo'] },
  { id: 'spring', label: 'Spring', category: 'web', packages: ['org.springframework', 'spring-boot-starter'] },
  { id: 'aspnet', label: 'ASP.NET', category: 'web', packages: ['Microsoft.AspNetCore'] },
  { id: 'axum', label: 'Axum', category: 'web', packages: ['axum'] },
  { id: 'actix', label: 'Actix', category: 'web', packages: ['actix-web'] },

  { id: 'prisma', label: 'Prisma', category: 'orm', packages: ['@prisma/client', 'prisma'], files: [/schema\.prisma$/] },
  { id: 'typeorm', label: 'TypeORM', category: 'orm', packages: ['typeorm'] },
  { id: 'sequelize', label: 'Sequelize', category: 'orm', packages: ['sequelize'] },
  { id: 'drizzle', label: 'Drizzle', category: 'orm', packages: ['drizzle-orm'] },
  { id: 'sqlalchemy', label: 'SQLAlchemy', category: 'orm', packages: ['sqlalchemy', 'SQLAlchemy'] },
  { id: 'gorm', label: 'GORM', category: 'orm', packages: ['gorm.io/gorm'] },
  { id: 'hibernate', label: 'Hibernate', category: 'orm', packages: ['org.hibernate'] },

  { id: 'bullmq', label: 'BullMQ', category: 'queue', packages: ['bullmq', 'bull'] },
  { id: 'celery', label: 'Celery', category: 'queue', packages: ['celery'] },
  { id: 'kafka', label: 'Kafka', category: 'queue', packages: ['kafkajs', 'confluent-kafka', 'github.com/segmentio/kafka-go'] },
  { id: 'rabbitmq', label: 'RabbitMQ', category: 'queue', packages: ['amqplib', 'pika'] },
  { id: 'sqs', label: 'AWS SQS', category: 'queue', packages: ['@aws-sdk/client-sqs'] },
  { id: 'redis', label: 'Redis', category: 'queue', packages: ['redis', 'ioredis', 'github.com/redis/go-redis'] },

  { id: 'jest', label: 'Jest', category: 'test', packages: ['jest'] },
  { id: 'vitest', label: 'Vitest', category: 'test', packages: ['vitest'] },
  { id: 'pytest', label: 'pytest', category: 'test', packages: ['pytest'] },
  { id: 'junit', label: 'JUnit', category: 'test', packages: ['junit', 'org.junit'] },

  { id: 'docker', label: 'Docker', category: 'build', packages: [], files: [/(^|\/)Dockerfile/, /docker-compose\.ya?ml$/] },
  { id: 'kubernetes', label: 'Kubernetes', category: 'cloud', packages: [], files: [/(^|\/)k8s\//, /(^|\/)helm\//, /(^|\/)charts\//] },
  { id: 'terraform', label: 'Terraform', category: 'cloud', packages: [], files: [/\.tf$/] },
  { id: 'githubactions', label: 'GitHub Actions', category: 'build', packages: [], files: [/^\.github\/workflows\//] },
];

export interface DetectedFramework {
  readonly id: string;
  readonly label: string;
  readonly category: FrameworkSignature['category'];
  readonly evidence: readonly string[];
}

export function detectFrameworks(
  externalPackages: ReadonlyMap<string, number>,
  relPaths: readonly string[],
): DetectedFramework[] {
  const detected: DetectedFramework[] = [];

  for (const signature of FRAMEWORK_SIGNATURES) {
    const evidence: string[] = [];

    for (const pkg of signature.packages) {
      const usage = externalPackages.get(pkg);
      if (usage !== undefined) {
        evidence.push(`imported by ${String(usage)} file${usage === 1 ? '' : 's'}: ${pkg}`);
      }
    }
    for (const pattern of signature.files ?? []) {
      const match = relPaths.find((relPath) => pattern.test(relPath));
      if (match !== undefined) evidence.push(match);
    }

    if (evidence.length > 0) {
      detected.push({
        id: signature.id,
        label: signature.label,
        category: signature.category,
        evidence: evidence.slice(0, 4),
      });
    }
  }

  return detected;
}
