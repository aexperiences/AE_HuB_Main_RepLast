import { Router, type IRouter } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { db, creativeSavesTable, creativeProjectsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/testing-lab/products", requireEmployeeAuth, async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select({
        id:              creativeSavesTable.id,
        title:           creativeSavesTable.title,
        toolType:        creativeSavesTable.toolType,
        contentText:     creativeSavesTable.contentText,
        contentJson:     creativeSavesTable.contentJson,
        contentUrl:      creativeSavesTable.contentUrl,
        fileName:        creativeSavesTable.fileName,
        createdAt:       creativeSavesTable.createdAt,
        projectName:     creativeProjectsTable.name,
        projectColor:    creativeProjectsTable.color,
        createdBy:       creativeProjectsTable.createdBy,
      })
      .from(creativeSavesTable)
      .innerJoin(creativeProjectsTable, eq(creativeSavesTable.creativeProjectId, creativeProjectsTable.id))
      .orderBy(desc(creativeSavesTable.createdAt));

    res.json(
      rows.map(r => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        contentText: undefined,
        contentJson: undefined,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "testing-lab: list products failed");
    res.status(500).json({ error: "Failed to load testing lab" });
  }
});

router.get("/testing-lab/products/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const rows = await db
      .select({
        id:           creativeSavesTable.id,
        title:        creativeSavesTable.title,
        toolType:     creativeSavesTable.toolType,
        contentText:  creativeSavesTable.contentText,
        contentJson:  creativeSavesTable.contentJson,
        contentUrl:   creativeSavesTable.contentUrl,
        fileName:     creativeSavesTable.fileName,
        createdAt:    creativeSavesTable.createdAt,
        projectName:  creativeProjectsTable.name,
        projectColor: creativeProjectsTable.color,
        createdBy:    creativeProjectsTable.createdBy,
      })
      .from(creativeSavesTable)
      .innerJoin(creativeProjectsTable, eq(creativeSavesTable.creativeProjectId, creativeProjectsTable.id))
      .where(eq(creativeSavesTable.id, id))
      .limit(1);

    if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }
    const r = rows[0];
    res.json({ ...r, createdAt: r.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "testing-lab: get product failed");
    res.status(500).json({ error: "Failed to load product" });
  }
});

export default router;
