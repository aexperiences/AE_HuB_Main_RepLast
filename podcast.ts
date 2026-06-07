import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, podcastShowsTable, podcastEpisodesTable } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

const toShow = (s: typeof podcastShowsTable.$inferSelect) => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const toEpisode = (e: typeof podcastEpisodesTable.$inferSelect) => ({
  ...e,
  publishedAt: e.publishedAt ? e.publishedAt.toISOString() : null,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

const ShowBody = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  hostName: z.string().optional().nullable(),
  category: z.enum(["internal", "client"]).optional(),
  clientName: z.string().optional().nullable(),
  artworkUrl: z.string().optional().nullable(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  spotifyUrl: z.string().optional().nullable(),
  appleUrl: z.string().optional().nullable(),
  youtubeUrl: z.string().optional().nullable(),
  rssUrl: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

const EpisodeBody = z.object({
  title: z.string().min(1),
  episodeNumber: z.number().int().optional().nullable(),
  description: z.string().optional().nullable(),
  showNotes: z.string().optional().nullable(),
  status: z.enum(["draft", "recording", "editing", "review", "published"]).optional(),
  audioUrl: z.string().optional().nullable(),
  duration: z.number().int().optional().nullable(),
  guestName: z.string().optional().nullable(),
  guestBio: z.string().optional().nullable(),
  tags: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

/* ── Shows ────────────────────────────────────────────────────────── */

router.get("/api/podcast/shows", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const rows = await db
    .select()
    .from(podcastShowsTable)
    .where(eq(podcastShowsTable.tenantId, tenantId))
    .orderBy(desc(podcastShowsTable.updatedAt));
  res.json(rows.map(toShow));
});

router.post("/api/podcast/shows", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const body = ShowBody.parse(req.body);
  const [row] = await db
    .insert(podcastShowsTable)
    .values({ ...body, tenantId })
    .returning();
  res.status(201).json(toShow(row));
});

router.get("/api/podcast/shows/:id", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(podcastShowsTable)
    .where(and(eq(podcastShowsTable.id, id), eq(podcastShowsTable.tenantId, tenantId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toShow(row));
});

router.patch("/api/podcast/shows/:id", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const id = Number(req.params.id);
  const body = ShowBody.partial().parse(req.body);
  const [row] = await db
    .update(podcastShowsTable)
    .set(body)
    .where(and(eq(podcastShowsTable.id, id), eq(podcastShowsTable.tenantId, tenantId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toShow(row));
});

router.delete("/api/podcast/shows/:id", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const id = Number(req.params.id);
  await db
    .delete(podcastShowsTable)
    .where(and(eq(podcastShowsTable.id, id), eq(podcastShowsTable.tenantId, tenantId)));
  res.status(204).end();
});

/* ── Episodes ─────────────────────────────────────────────────────── */

router.get("/api/podcast/shows/:showId/episodes", requireEmployeeAuth, async (req, res) => {
  const showId = Number(req.params.showId);
  const rows = await db
    .select()
    .from(podcastEpisodesTable)
    .where(eq(podcastEpisodesTable.showId, showId))
    .orderBy(desc(podcastEpisodesTable.episodeNumber));
  res.json(rows.map(toEpisode));
});

router.post("/api/podcast/shows/:showId/episodes", requireEmployeeAuth, async (req, res) => {
  const showId = Number(req.params.showId);
  const body = EpisodeBody.parse(req.body);
  const [row] = await db
    .insert(podcastEpisodesTable)
    .values({ ...body, showId })
    .returning();
  res.status(201).json(toEpisode(row));
});

router.get("/api/podcast/episodes/:id", requireEmployeeAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(podcastEpisodesTable)
    .where(eq(podcastEpisodesTable.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toEpisode(row));
});

router.patch("/api/podcast/episodes/:id", requireEmployeeAuth, async (req, res) => {
  const id = Number(req.params.id);
  const body = EpisodeBody.partial().parse(req.body);
  const [row] = await db
    .update(podcastEpisodesTable)
    .set(body)
    .where(eq(podcastEpisodesTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toEpisode(row));
});

router.delete("/api/podcast/episodes/:id", requireEmployeeAuth, async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(podcastEpisodesTable).where(eq(podcastEpisodesTable.id, id));
  res.status(204).end();
});

export default router;
