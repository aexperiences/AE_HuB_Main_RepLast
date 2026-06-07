import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAdminAuth } from "../middlewares/authMiddleware";
import { SQL as CONTACTS_SQL } from "../data/seed-prod-contacts";
import { SQL as REST_SQL } from "../data/seed-prod-rest";
import { SQL as CRM_VERTICALS_SQL } from "../data/seed-prod-crm-verticals";

const router: IRouter = Router();

/**
 * POST /api/admin/seed-import
 *
 * One-shot bootstrap that copies dev seed data into whichever database the
 * server is currently connected to. Admin-only. Idempotent: if either target
 * already has rows, that group is skipped.
 *
 * Body: { groups?: ("contacts" | "rest" | "crm-verticals")[] }  (default: all)
 *
 * The SQL was exported from dev once and bundled into the API server so it
 * ships with the published build — there is no file IO at runtime.
 */
router.post("/admin/seed-import", requireAdminAuth, async (req, res): Promise<void> => {
  const groups: string[] = Array.isArray(req.body?.groups) && req.body.groups.length > 0
    ? req.body.groups
    : ["contacts", "rest", "crm-verticals"];

  const client = await pool.connect();
  const report: Record<string, { ran: boolean; rowsBefore: number; rowsAfter: number; error?: string }> = {};
  try {
    if (groups.includes("contacts")) {
      const before = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM contacts");
      const rowsBefore = Number(before.rows[0]?.count ?? 0);
      if (rowsBefore > 0) {
        report.contacts = { ran: false, rowsBefore, rowsAfter: rowsBefore };
      } else {
        try {
          await client.query(CONTACTS_SQL);
          const after = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM contacts");
          report.contacts = { ran: true, rowsBefore, rowsAfter: Number(after.rows[0]?.count ?? 0) };
        } catch (err: any) {
          req.log.error({ err }, "Contacts seed failed");
          report.contacts = { ran: false, rowsBefore, rowsAfter: rowsBefore, error: err?.message ?? "unknown" };
        }
      }
    }

    if (groups.includes("rest")) {
      const before = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM grant_proposals");
      const rowsBefore = Number(before.rows[0]?.count ?? 0);
      if (rowsBefore > 0) {
        report.rest = { ran: false, rowsBefore, rowsAfter: rowsBefore };
      } else {
        try {
          await client.query(REST_SQL);
          const after = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM grant_proposals");
          report.rest = { ran: true, rowsBefore, rowsAfter: Number(after.rows[0]?.count ?? 0) };
        } catch (err: any) {
          req.log.error({ err }, "Rest seed failed");
          report.rest = { ran: false, rowsBefore, rowsAfter: rowsBefore, error: err?.message ?? "unknown" };
        }
      }
    }

    if (groups.includes("crm-verticals")) {
      const before = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM crm_leads
         WHERE campaign_type IN ('senior_living','k12','homeschool','creative_agency','healthcare','church','wedding','municipal','real_estate','daycare')`
      );
      const rowsBefore = Number(before.rows[0]?.count ?? 0);
      if (rowsBefore > 0) {
        report["crm-verticals"] = { ran: false, rowsBefore, rowsAfter: rowsBefore };
      } else {
        try {
          await client.query(CRM_VERTICALS_SQL);
          const after = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM crm_leads
             WHERE campaign_type IN ('senior_living','k12','homeschool','creative_agency','healthcare','church','wedding','municipal','real_estate','daycare')`
          );
          report["crm-verticals"] = { ran: true, rowsBefore, rowsAfter: Number(after.rows[0]?.count ?? 0) };
        } catch (err: any) {
          req.log.error({ err }, "CRM verticals seed failed");
          report["crm-verticals"] = { ran: false, rowsBefore, rowsAfter: rowsBefore, error: err?.message ?? "unknown" };
        }
      }
    }

    res.json({ success: true, report });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/fix-tenant-ids
 *
 * One-shot data patch: stamps the correct tenant_id on every row that has a
 * NULL or blank tenant_id across tables that are scoped by tenant.  Safe to
 * run multiple times — only rows with missing tenant_id are touched.
 */
router.post("/admin/fix-tenant-ids", requireAdminAuth, async (req, res): Promise<void> => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";

  const tables = [
    "crm_leads",
    "crm_activities",
    "contacts",
    "clients",
    "projects",
    "invoices",
    "proposals",
    "contracts",
    "deliverables",
    "estimates",
    "expenses",
    "deadlines",
    "time_entries",
    "email_drafts",
  ];

  const client = await pool.connect();
  const report: Record<string, { fixed: number; error?: string }> = {};

  try {
    for (const table of tables) {
      try {
        const result = await client.query<{ count: string }>(
          `UPDATE ${table}
             SET tenant_id = $1
           WHERE tenant_id IS NULL OR tenant_id = ''
           RETURNING (SELECT COUNT(*) FROM ${table})::text`,
          [TENANT_ID],
        );
        report[table] = { fixed: result.rowCount ?? 0 };
      } catch (err: any) {
        report[table] = { fixed: 0, error: err?.message ?? "unknown" };
      }
    }
    res.json({ success: true, tenantId: TENANT_ID, report });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/seed-import/status — quick read of how many rows each
 * target table currently has, so the admin button can show before/after.
 */
router.get("/admin/seed-import/status", requireAdminAuth, async (_req, res): Promise<void> => {
  const c = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM contacts");
  const g = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM grant_proposals");
  const v = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM crm_leads
     WHERE campaign_type IN ('senior_living','k12','homeschool','creative_agency','healthcare','church','wedding','municipal','real_estate','daycare')`
  );
  res.json({
    contacts: Number(c.rows[0]?.count ?? 0),
    grant_proposals: Number(g.rows[0]?.count ?? 0),
    crm_verticals: Number(v.rows[0]?.count ?? 0),
  });
});

export default router;
