# Threat Model

## Project Overview

AEHub is a pnpm-workspace business management suite for Accelerated Experiences LLC. Its production-facing surfaces are an Express 5 API (`artifacts/api-server`), a React web app (`artifacts/web-app`), and an Expo mobile app (`artifacts/mobile`) backed by PostgreSQL through Drizzle ORM. The application handles internal business operations and client-facing portal workflows including projects, invoices, proposals, contracts, deliverables, CRM, and staff/client account authentication.

Per deployment assumptions for this scan, production runs with `NODE_ENV=production`, platform-managed TLS, and the mockup sandbox is not deployed to production unless proven otherwise.

## Assets

- **Employee accounts and admin privileges** — employee and admin sessions can access internal financial, CRM, and project-management functions. Compromise would expose the full operational dataset and enable destructive changes.
- **Client portal accounts** — client sessions grant access to contracts, invoices, proposals, and deliverables tied to a customer relationship. Compromise exposes sensitive business and contractual data.
- **Business records** — projects, invoices, estimates, proposals, contracts, CRM leads, deadlines, expenses, reports, and task boards contain commercially sensitive information and often client-identifying details.
- **Session secrets and session records** — the session signing secret and persisted Postgres-backed sessions determine whether users can be impersonated.
- **Application secrets and database connectivity** — `DATABASE_URL`, privileged setup pins, preview codes, and any bootstrap credentials can be used to gain durable access to the system.

## Trust Boundaries

- **Browser/mobile to API** — all web and mobile traffic crosses into the Express server. The client is untrusted; every state-changing or data-bearing route must authenticate, authorize, and validate server-side.
- **API to PostgreSQL** — the API has direct database access through Drizzle. Any injection, broken access control, or unsafe bootstrap logic at the API layer directly impacts stored business and client data.
- **Unauthenticated to employee/client/admin surfaces** — public routes must remain narrowly scoped. Employee, project-manager, accounting, admin, and client capabilities must be enforced server-side rather than implied by the frontend.
- **Internal staff to client-tenant boundary** — client-visible records must be scoped to the correct client account and not be exposed based on guessable IDs or mutable/shared attributes.
- **Development-only to production boundary** — the mockup sandbox and local build scripts are out of scope unless they are reachable from deployed production artifacts.

## Scan Anchors

- Production API entry point: `artifacts/api-server/src/index.ts` and `artifacts/api-server/src/app.ts`.
- Route surface: `artifacts/api-server/src/routes/` with auth/session logic in `routes/auth.ts` and `middlewares/authMiddleware.ts`.
- Highest-risk route families from this scan: `dashboard.ts`, `project-tasks.ts`, `contracts.ts`, `crm.ts`, and client-facing record scoping in `invoices.ts`.
- Shared database schema and trust-critical tables: `lib/db/src/schema/`.
- Usually ignore `artifacts/mockup-sandbox` and local mobile build scripts unless production reachability is demonstrated.

## Threat Categories

### Spoofing

The application relies on server-side sessions for both employees and clients. The API must only accept sessions created with a strong secret, must not expose privileged fallback credentials or bootstrap paths, and must not allow preview or setup flows to impersonate normal users in production. Any privileged maintenance or preview mechanism must be explicitly disabled or strongly authenticated in production.

### Tampering

Employees and clients can create or update business records through many JSON endpoints. The server must validate request bodies, restrict which fields can be changed, and enforce role-appropriate authorization on every mutation. Public or weakly protected endpoints must not be able to alter contracts, tasks, CRM history, or account state.

### Information Disclosure

This application stores sensitive commercial and client data, including invoices, CRM records, contracts, proposals, revenue metrics, and internal task boards. Responses must be scoped to the authenticated principal, public endpoints must not leak business data, and logs/errors must avoid exposing secrets or internals. Client-visible data should be bound to a stable account relationship rather than mutable identifiers like names or emails when possible.

### Denial of Service

The API exposes several unauthenticated and authenticated endpoints that query broad tables or generate PDFs. Public endpoints must not allow trivial high-cost abuse, and authentication flows should resist credential stuffing and brute-force attempts. Expensive document-generation or reporting endpoints should not be anonymously reachable if they meaningfully consume server resources.

### Elevation of Privilege

The highest-risk failure mode is broken access control: unauthenticated access to internal routes, employee routes reachable through preview/setup shortcuts, or client routes that allow access to another customer's records. Admin, accounting, project-manager, employee, and client privileges must be enforced server-side on every route and on every record lookup or mutation. Startup code must never silently grant or reset privileged access in production.
