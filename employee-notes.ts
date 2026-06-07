import { Router, type IRouter } from "express";
import { db, employeeNotes } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireEmployeeAuth, getSession } from "../middlewares/authMiddleware";

const router: IRouter = Router();

router.use("/my-notes", requireEmployeeAuth);

function ownerOr401(req: any, res: any): string | null {
  const s = getSession(req);
  if (!s.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return s.employeeId;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

router.get("/my-notes", async (req, res) => {
  const owner = ownerOr401(req, res); if (!owner) return;
  const rows = await db.select().from(employeeNotes)
    .where(eq(employeeNotes.ownerId, owner))
    .orderBy(desc(employeeNotes.pinned), desc(employeeNotes.updatedAt));
  res.json(rows);
});

router.post("/my-notes", async (req, res) => {
  const owner = ownerOr401(req, res); if (!owner) return;
  const title = typeof req.body?.title === "string" && req.body.title.trim()
    ? req.body.title.trim().slice(0, 200)
    : "Untitled";
  const [row] = await db.insert(employeeNotes).values({
    ownerId: owner,
    title,
    contentHtml: "",
    contentText: "",
  }).returning();
  res.status(201).json(row);
});

router.get("/my-notes/:id", async (req, res) => {
  const owner = ownerOr401(req, res); if (!owner) return;
  const [row] = await db.select().from(employeeNotes)
    .where(and(eq(employeeNotes.id, req.params.id), eq(employeeNotes.ownerId, owner)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.patch("/my-notes/:id", async (req, res) => {
  const owner = ownerOr401(req, res); if (!owner) return;
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.title === "string") {
    patch.title = req.body.title.trim().slice(0, 200) || "Untitled";
  }
  if (typeof req.body?.contentHtml === "string") {
    const html = req.body.contentHtml.slice(0, 500_000);
    patch.contentHtml = html;
    patch.contentText = stripHtml(html).slice(0, 500_000);
  }
  if (typeof req.body?.pinned === "boolean") {
    patch.pinned = req.body.pinned;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No editable fields supplied" });
    return;
  }
  const [row] = await db.update(employeeNotes)
    .set(patch)
    .where(and(eq(employeeNotes.id, req.params.id), eq(employeeNotes.ownerId, owner)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/my-notes/:id", async (req, res) => {
  const owner = ownerOr401(req, res); if (!owner) return;
  const [row] = await db.delete(employeeNotes)
    .where(and(eq(employeeNotes.id, req.params.id), eq(employeeNotes.ownerId, owner)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

export default router;
