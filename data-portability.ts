import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  clientsTable,
  projectsTable,
  projectTasksTable,
  invoicesTable,
  expensesTable,
  proposalsTable,
  contractsTable,
  estimatesTable,
  timeEntriesTable,
  deliverablesTable,
  vendorsTable,
  crmLeadsTable,
  deadlinesTable,
  contactsTable,
  grantProposalsTable,
  employeeAccounts,
  clientAccounts,
} from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const EXPORT_VERSION = 1;

// ─── EXPORT ────────────────────────────────────────────────────────────────

router.get("/data-portability/export", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);

  try {
    const [
      clients,
      projects,
      projectTasks,
      invoices,
      expenses,
      proposals,
      contracts,
      estimates,
      timeEntries,
      deliverables,
      vendors,
      crmLeads,
      deadlines,
      contacts,
      grantProposals,
      employees,
      clientAccts,
    ] = await Promise.all([
      db.select().from(clientsTable).where(eq(clientsTable.tenantId, tid)),
      db.select().from(projectsTable).where(eq(projectsTable.tenantId, tid)),
      db.select().from(projectTasksTable).where(eq(projectTasksTable.tenantId, tid)),
      db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)),
      db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)),
      db.select().from(proposalsTable).where(eq(proposalsTable.tenantId, tid)),
      db.select().from(contractsTable).where(eq(contractsTable.tenantId, tid)),
      db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)),
      db.select().from(timeEntriesTable).where(eq(timeEntriesTable.tenantId, tid)),
      db.select().from(deliverablesTable).where(eq(deliverablesTable.tenantId, tid)),
      db.select().from(vendorsTable).where(eq(vendorsTable.tenantId, tid)),
      db.select().from(crmLeadsTable).where(eq(crmLeadsTable.tenantId, tid)),
      db.select().from(deadlinesTable).where(eq(deadlinesTable.tenantId, tid)),
      db.select().from(contactsTable).where(eq(contactsTable.tenantId, tid)),
      db.select().from(grantProposalsTable).where(eq(grantProposalsTable.tenantId, tid)),
      db.select().from(employeeAccounts).where(eq(employeeAccounts.tenantId, tid)),
      db.select().from(clientAccounts).where(eq(clientAccounts.tenantId, tid)),
    ]);

    const exportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      counts: {
        clients: clients.length,
        projects: projects.length,
        projectTasks: projectTasks.length,
        invoices: invoices.length,
        expenses: expenses.length,
        proposals: proposals.length,
        contracts: contracts.length,
        estimates: estimates.length,
        timeEntries: timeEntries.length,
        deliverables: deliverables.length,
        vendors: vendors.length,
        crmLeads: crmLeads.length,
        deadlines: deadlines.length,
        contacts: contacts.length,
        grantProposals: grantProposals.length,
        employees: employees.length,
        clientAccounts: clientAccts.length,
      },
      data: {
        clients,
        projects,
        projectTasks,
        invoices,
        expenses,
        proposals,
        contracts,
        estimates,
        timeEntries,
        deliverables,
        vendors,
        crmLeads,
        deadlines,
        contacts,
        grantProposals,
        employees,
        clientAccounts: clientAccts,
      },
    };

    const filename = `aehub-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(exportData);
  } catch (err) {
    req.log.error({ err }, "Export failed");
    res.status(500).json({ error: "Export failed" });
  }
});

// ─── IMPORT ────────────────────────────────────────────────────────────────

router.post("/data-portability/import", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const dryRun = req.query.dryRun === "true";
  const body = req.body as any;

  if (!body || typeof body !== "object" || !body.data) {
    res.status(400).json({ error: "Invalid export file — missing data field" });
    return;
  }

  if (body.version !== EXPORT_VERSION) {
    res.status(400).json({
      error: `Unsupported export version ${body.version}. Expected version ${EXPORT_VERSION}.`,
    });
    return;
  }

  const data = body.data as Record<string, any[]>;

  const summary: Record<string, { inserted: number; skipped: number }> = {};

  const tryInsert = async <T extends { id: number }>(
    table: any,
    tableName: string,
    rows: T[] | undefined,
  ) => {
    if (!rows || rows.length === 0) {
      summary[tableName] = { inserted: 0, skipped: 0 };
      return;
    }

    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
      const { id, createdAt, updatedAt, ...rest } = row as any;
      const payload = { ...rest, tenantId: tid };

      if (dryRun) {
        inserted++;
        continue;
      }

      try {
        await db.insert(table).values(payload).onConflictDoNothing();
        inserted++;
      } catch {
        skipped++;
      }
    }

    summary[tableName] = { inserted, skipped };
  };

  try {
    // Order matters: parents before children
    await tryInsert(clientsTable, "clients", data.clients);
    await tryInsert(projectsTable, "projects", data.projects);
    await tryInsert(projectTasksTable, "projectTasks", data.projectTasks);
    await tryInsert(invoicesTable, "invoices", data.invoices);
    await tryInsert(expensesTable, "expenses", data.expenses);
    await tryInsert(proposalsTable, "proposals", data.proposals);
    await tryInsert(contractsTable, "contracts", data.contracts);
    await tryInsert(estimatesTable, "estimates", data.estimates);
    await tryInsert(timeEntriesTable, "timeEntries", data.timeEntries);
    await tryInsert(deliverablesTable, "deliverables", data.deliverables);
    await tryInsert(vendorsTable, "vendors", data.vendors);
    await tryInsert(crmLeadsTable, "crmLeads", data.crmLeads);
    await tryInsert(deadlinesTable, "deadlines", data.deadlines);
    await tryInsert(contactsTable, "contacts", data.contacts);
    await tryInsert(grantProposalsTable, "grantProposals", data.grantProposals);
    await tryInsert(employeeAccounts, "employees", data.employees);
    await tryInsert(clientAccounts, "clientAccounts", data.clientAccounts);

    const totalInserted = Object.values(summary).reduce((a, b) => a + b.inserted, 0);
    const totalSkipped = Object.values(summary).reduce((a, b) => a + b.skipped, 0);

    res.json({
      dryRun,
      totalInserted,
      totalSkipped,
      summary,
      message: dryRun
        ? `Dry run complete — ${totalInserted} records would be imported.`
        : `Import complete — ${totalInserted} records imported, ${totalSkipped} skipped.`,
    });
  } catch (err) {
    req.log.error({ err }, "Import failed");
    res.status(500).json({ error: "Import failed" });
  }
});

export default router;
