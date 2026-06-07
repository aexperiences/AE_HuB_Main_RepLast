# AEHub

Business management platform for Accelerated Experiences LLC — handles projects, invoices, CRM, contracts, proposals, client portal, and creative studio tools.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- AE brand palette: deep navy `#0a1e3d`, vibrant cyan `#0ea5e9` (sky-500), gradient `from-sky-500 to-blue-700`. Zero purple/violet/indigo anywhere.
- When the user reports an issue on the published site (`accelerated-experiences-1.replit.app`, opened in Safari or any browser), they are looking at the **production** database. Default to `executeSql({ environment: "production", ... })` for diagnosis. Do not assume dev mirrors prod — they are separate. Dev should only be queried when the user explicitly says they are testing in the preview pane.
- Checkpoint between discrete steps within a single task. When working through a multi-step task (e.g. "fix A, B, and C"), finish each piece and hand control back to the user (which auto-creates a checkpoint) before starting the next, instead of bundling everything into one giant turn. This gives the user safe rollback points between sub-tasks.

## Production schema changes

Schema changes flow dev → prod automatically through Replit's Publish flow.
When you click Publish, Replit diffs the dev schema against prod, asks you
to confirm any renames in the Publish UI, and applies the diff. Do NOT run
DDL by hand against prod, and do NOT add startup-time or deploy-time DDL
to the app. Just push the schema in dev (`pnpm --filter @workspace/db run push`)
and re-publish.

## Pending: Go Live with Stripe Payments

Stripe invoice payments are fully built and working in **test mode**. To accept real money, the following one-time setup is needed:

1. Sign up / log in at [stripe.com](https://stripe.com)
2. Complete business identity verification (EIN, business info)
3. Add bank account for payouts
4. In the Replit Publish settings, swap in the **live** Stripe keys (`pk_live_...` and `sk_live_...`)
5. Redeploy

Until this is done, the Pay Now button works end-to-end but no real charges are made. Stripe fee: 2.9% + 30¢ per transaction, 2-day rolling payout to bank.

## Repeated Requests (asked 2+ times — track here)

| # | Feature / Fix | Times Asked | Status | Notes |
|---|---|---|---|---|
| 1 | Bobert voice sounds robotic — make it calming | 16 | Fixed 2026-05-24 (v2) | **Root cause was the model, not the settings.** `eleven_turbo_v2_5` is speed-optimized and inherently robotic. Fix: Bobert now uses `eleven_multilingual_v2` (ElevenLabs highest-quality model). Settings also retuned: stability→0.42 (natural variation), style→0.08 (no artificial exaggeration), similarity_boost→0.82. All other agents kept on turbo for speed. Text cleaning also improved: bullet/list prefixes stripped so they aren't read aloud. **Do not revert to turbo for Bobert — it will sound robotic again.** |
| 2 | Calendar page broken / not loading | 3 | Fixed 2026-05-24 | Routes were double-prefixed `/api/api/calendar/...` — stripped the extra `/api` |
| 3 | Mobile app: blank screen / login / brand colors | 3 | Fixed 2026-05-24 | Null→navy during font load; splash color; web.baseUrl added |
| 4 | CRM vertical/architect seed data never appears in production | 6 | Fixed 2026-05-24 | Moved from manual `/api/admin/seed-import` (requires admin session — never fired) to auto-seed on startup: `seedCrmVerticals()` in `index.ts` runs at boot, checks if crm_leads is empty for the verticals, inserts all 200 leads if so. Idempotent — skips if data already present. |
| 5 | Agents create deadlines/tasks with wrong year (2025 instead of 2026) | 2 | Fixed 2026-05-24 | Root cause: `SYSTEM_PROMPT` and `AGENT_PERSONAS` are module-level consts — `rosterBlock()` date was frozen at server start. When user said "May 30" with no year, models defaulted to 2025. Fix: per-request `nowBlock()` + explicit "CURRENT YEAR IS 2026" message injected into every Bobert and Agent Hub conversation. Also strengthened `create_deadline` tool description to warn about past years. Do NOT remove this per-request date injection. |
| 6 | Agents suggest building things AEHub already has | 2 | Fixed 2026-05-24 | Added comprehensive NO-DUPLICATE RULE to Bobert (full mapping table: "if asked to build X → point to Y"), Anetta, Elena, Spark, and Bolt. Covers all 30+ AEHub modules + all 23 AI agents + 4 AE internal products. |
| 7 | Production server crash after publish — team/products/deadlines show empty or "permission denied" | 3 | Fixed 2026-05-24 | **Root cause: OpenRouter client (`lib/integrations-openrouter-ai/src/client.ts`) threw a hard `Error` at module-load time if `AI_INTEGRATIONS_OPENROUTER_BASE_URL` or `AI_INTEGRATIONS_OPENROUTER_API_KEY` env vars were absent in production.** Because those route files are statically imported at startup, one missing key crashed the entire API server. Every route (deadlines, team, products, etc.) returned 502. Fix: changed `throw new Error(...)` → `console.warn(...)` so the server starts clean and only OpenRouter-specific AI calls fail at request time. **Do NOT revert the client.ts to throwing at startup — it kills everything.** Flagged to Replit: integration env vars should be guaranteed available in production when an integration is installed in dev. |
| 8 | Approval queue missing preview/proofread for invoices, proposals, contracts, deliverables | 1 | Fixed 2026-05-25 | ⚠️ DUPLICATE WORK — user was charged for this in a prior session where it was claimed to be complete but wasn't. Only email and grant had preview panels. Fix: added `GET /api/approvals/:type/:id/detail` backend endpoint for all 4 missing types; added inline preview panels for invoice (line items, totals, due date, notes), proposal (scope, line item table, totals, client message), contract (full terms text, client info), and deliverable (description, file link, PM/client notes). Eye button now shows on all item types. Inline Approve/Request Changes/Reject buttons in every panel. |
| 9 | Creative suite session plan (T001–T007) — prior session claimed complete but user reported none went through | 1 | Verified 2026-05-25 | ⚠️ POTENTIAL DUPLICATE — code audit on 2026-05-25 confirmed T001–T006 ARE present in code: image-gen route exists, HD mode in creative-studio, ae_creative_import in photo-editor and design-studio, Export MP4 button in video-editor, importSample in audio-mixer. T007 sidebar creative sub-items were NOT found — may still be missing. User said "nevermind" before T007 could be addressed. Flag for follow-up. |

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
