import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdminAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const TABLES = [
  "contacts",
  "grant_proposals",
  "clients",
  "client_accounts",
  "employee_accounts",
  "projects",
  "project_tasks",
  "invoices",
  "expenses",
  "proposals",
  "contracts",
  "estimates",
  "time_entries",
  "deliverables",
  "vendors",
  "crm_leads",
  "deadlines",
] as const;

const IDENT = /^[a-z_][a-z0-9_]*$/;

router.get("/admin/health", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tableList = TABLES.filter(t => IDENT.test(t)).map(t => `'${t}'`).join(",");
    const tablesResult = await db.execute<{ table_name: string }>(
      sql.raw(`SELECT table_name FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name IN (${tableList})`)
    );
    const existing = new Set(tablesResult.rows.map(r => r.table_name));

    const byTable: Record<string, { total: number; tenants: { tenantId: string | null; count: number }[] }> = {};

    for (const t of TABLES) {
      if (!existing.has(t) || !IDENT.test(t)) {
        byTable[t] = { total: 0, tenants: [] };
        continue;
      }
      const rows = await db.execute<{ tenant_id: string | null; count: string }>(
        sql.raw(`SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS count FROM ${t} GROUP BY tenant_id ORDER BY COUNT(*) DESC`)
      );
      const tenants = rows.rows.map(r => ({ tenantId: r.tenant_id, count: Number(r.count) }));
      const total = tenants.reduce((a, b) => a + b.count, 0);
      byTable[t] = { total, tenants };
    }

    const tenantRows = await db.execute<{ id: string; name: string | null }>(sql`SELECT id::text, name FROM tenants ORDER BY name`);
    const adminRows = await db.execute<{ tenant_id: string; email: string; name: string; role: string }>(
      sql`SELECT tenant_id::text, email, name, role FROM employee_accounts WHERE role = 'admin' ORDER BY email`
    );

    res.json({
      generatedAt: new Date().toISOString(),
      database: { url: process.env.DATABASE_URL ? "configured" : "missing" },
      tenants: tenantRows.rows,
      admins: adminRows.rows.map(r => ({ tenantId: r.tenant_id, email: r.email, name: r.name, role: r.role })),
      byTable,
    });
  } catch (err) {
    req.log.error({ err }, "admin health check failed");
    res.status(500).json({ error: "Health check failed" });
  }
});

export default router;
