# LinkedIn Post Scheduler — Full-Stack Migration Tasks

Living task checklist tracking all milestones (`M1`–`M4`) and feature IDs (`F1.1`–`F6.2`).

## Milestone 1: Git Backup, Tasks, PG Schema & NestJS Core
- [x] `F5.2` Pre-migration Git backup (`backup/pre-migration` branch and `pre-migration-backup` tag at `09ac2e1`)
- [x] `F5.1` Create living task checklist (`TASKS.md`)
- [x] `F1.1` Configure `pnpm` workspace (`pnpm-workspace.yaml`), NestJS v12 dependencies, TypeScript `~6.0.2` with `emitDecoratorMetadata`, `nest-cli.json`, and Vitest + SWC (`vitest.config.ts`)
- [x] `F1.1` Remove legacy Express 5 / SQLite / 1.5s DB poller files and decouple `src/linkedin/*` from deleted singletons
- [x] `F2.1` Migrate `prisma/schema.prisma` to PostgreSQL multi-tenant schema (`User`, `OAuthCredential`, `OAuthState`, `LinkedinAccount`, `Post`), update `.env.example`/`.env`, validate & generate Prisma client
- [x] `F1.1` Implement Zod v4 environment validation (`src/config/env.schema.ts`), `AppConfigService`, `ConfigModule`, and `ZodValidationPipe`
- [x] `F2.3` Implement AES-256-GCM `TokenEncryption` (`src/common/crypto/token-encryption.ts`) with strict 64-hex key, 24-hex IV, and 32-hex authTag validation
- [x] `F2.4` Implement `PinoLoggerService` with secret/header redaction and `PrismaModule` / `PrismaService`
- [x] `F2.2` Implement `TenantSessionMiddleware` (`li_scheduler_sid` HMAC-SHA256 `httpOnly` cookie, `timingSafeEqual`) & `@CurrentTenant()` decorator
- [x] `F1.1` Wire `AppModule`, `HealthModule` (`GET /api/health` baseline), and `src/main.ts`
- [x] `M1-UT` Add Vitest unit & NestJS DI HTTP smoke tests under `tests/unit/*.test.ts`

## Milestone 2: BullMQ Worker, LinkedIn `/rest/posts` & OAuth, Health Recovery
- [x] `F3.2` Configure `@nestjs/bullmq` and `ioredis` for `redis://` and Upstash `rediss://` TLS (`maxRetriesPerRequest: null`, `enableReadyCheck: false`)
- [x] `F4.5` Upgrade `RealLinkedInClient` to `POST https://api.linkedin.com/rest/posts` with `LinkedIn-Version`, `X-Restli-Protocol-Version: 2.0.0`, `x-restli-id`, and `429 Retry-After` parsing
- [x] `F4.6` Wire `MockLinkedInClient` with 503 transient failure simulation toggle (`POST /api/test/toggle-simulate-failure`)
- [x] `F4.1` Implement LinkedIn OAuth 2.0 CSRF `state` persistence & single-use verification (`OAuthState`)
- [x] `F4.2` Handle LinkedIn OAuth `?error=` & `?error_description=` redirects cleanly (`/?auth=error&message=...`)
- [x] `F4.3` Support optional per-tenant encrypted OAuth Client ID/Secret (`POST/DELETE /api/account/credentials`) with server env fallback
- [x] `F4.4` Implement `GET /api/account`, `POST /api/account/disconnect`, expiry surfacing (`isExpired`), and expired token rejection
- [x] `F2.5` Implement `POST /api/posts/schedule` with SHA-256 `idempotencyKey` deduplication (`409 Conflict` on `P2002`)
- [x] `F3.1` Implement `PostsProcessor` (`@Processor('linkedin-posts')`) using native BullMQ delayed jobs (`attempts: 5`, exponential backoff, zero DB polling)
- [x] `F3.3` Implement atomic `prisma.post.updateMany` compare-and-swap claim (`scheduled` -> `processing`)
- [x] `F3.4` Classify permanent failures with BullMQ `UnrecoverableError` (`failed`) vs transient retryable errors (`429`/`500`–`504`)
- [x] `F3.5` Implement `POST /api/posts/:id/cancel` with tenant ownership check & BullMQ job removal
- [x] `F3.6` Expand `GET /api/health` (DB + Redis PING + overdue post recovery sweep) and `OnModuleInit` recovery
- [x] `M2-IT` Add automated tests for deduplication, CAS claim, BullMQ retries/`UnrecoverableError`, OAuth CSRF/error, and `/api/health` recovery

## Milestone 3: Next.js Frontend, Smoke Debugger, Configs & Docs
- [x] `F1.2` Scaffold `web/` Next.js + TypeScript app (`output: 'export'`, `images: { unoptimized: true }`) outputting to `dist/public`
- [x] `F1.3` Wire `@nestjs/serve-static` in `AppModule` serving `dist/public` (excluding `/api/*`) on a single Render Web Service
- [x] `F1.4` Build UI for OAuth connection, mode badge (`Mock`/`Live`), expiry warning, optional credentials form, disconnect, and `?auth=` alerts
- [x] `F1.5` Build UI for post composer (3000-char counter, datetime picker, `+15s`/`+1m` presets), queue monitor, cancel, and 503 bench toggle
- [x] `F5.3` Create deployment debugger / smoke-test suite (`scripts/deployment-debugger.ts`, `pnpm smoke`)
- [x] `F5.4` Provision Supabase PostgreSQL (if MCP/tools permit) and document manual setup for Supabase, Upstash Redis, Render, LinkedIn App, and cron pings
- [x] `F6.1` Add/update `render.yaml`, `Dockerfile`, `docker-compose.yml`, `README.md` (with Mermaid architecture diagram, schema docs, deploy instructions)

## Milestone 4: Final Verification, E2E Pass, Tier 5 Hardening & Pre-Ship Gate
- [x] `F6.2` Run final `pnpm typecheck`, Next.js export, `pnpm build`, `pnpm test` (8 files, 35 tests pass), and `scripts/deployment-debugger.ts` typecheck (`pnpm smoke` ready for live/Docker target)
- [x] `F5.2` Create `backup/pre-ship` branch and `pre-ship-backup` tag on verified clean repository state
