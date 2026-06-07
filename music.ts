import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, musicTracksTable } from "@workspace/db";
import { getTenantId, getSession } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { openai } from "@workspace/integrations-openai-ai-server";
import { resolveModel, extractJSON } from "../lib/ai-models";
import { ObjectStorageService } from "../lib/objectStorage";
import multer from "multer";
import * as fs from "node:fs";
import * as path from "node:path";

const gcs = new ObjectStorageService();

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function requireCreativeAccess(req: any, res: any, next: any): void {
  const session = (req as any).session;
  if (!session?.employeeId || session.isPreview) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const allowed = ["admin", "project_manager", "creator", "accounting"];
  if (!allowed.includes(session.employeeRole)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  next();
}

async function generateMusicHF(
  prompt: string,
  log: { warn: (...a: any[]) => void; error: (...a: any[]) => void } = console as any,
): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  const token = process.env.HUGGINGFACE_API_TOKEN;
  if (!token) throw new Error("HUGGINGFACE_API_TOKEN is not configured");

  const url = "https://api-inference.huggingface.co/models/facebook/musicgen-small";
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "audio/wav, audio/flac, audio/mpeg, application/json",
      } as any,
      body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } }),
    });

    const contentType = r.headers.get("content-type") ?? "";

    if (r.ok && contentType.startsWith("audio/")) {
      const buffer = Buffer.from(await r.arrayBuffer());
      const mime = contentType.split(";")[0].trim();
      const ext = mime.includes("flac") ? "flac" : mime.includes("mpeg") ? "mp3" : "wav";
      return { buffer, mime, ext };
    }

    // Cold start: HF returns 503 with estimated_time. Wait then retry.
    if (r.status === 503 || r.status === 429) {
      let waitSec = 15;
      try {
        const j: any = await r.json();
        if (typeof j?.estimated_time === "number") waitSec = Math.min(60, Math.ceil(j.estimated_time));
      } catch { /* keep default */ }
      log.warn(`HuggingFace MusicGen warming up (attempt ${attempt}/${maxAttempts}), waiting ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    let errMsg = `HTTP ${r.status}`;
    try {
      const j: any = await r.json();
      errMsg = j?.error ?? errMsg;
    } catch {
      const txt = await r.text().catch(() => "");
      if (txt.trim()) errMsg += `: ${txt.slice(0, 150)}`;
    }
    throw new Error(`HuggingFace MusicGen: ${errMsg}`);
  }
  throw new Error("HuggingFace MusicGen: model did not respond after 6 attempts — it may be rate-limited or temporarily unavailable");
}

async function generateSoundEL(
  prompt: string,
  durationSeconds: number,
): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  const cappedDur = Math.min(durationSeconds, 22);
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" } as any,
    body: JSON.stringify({ text: prompt.slice(0, 450), duration_seconds: cappedDur, prompt_influence: 0.3 }),
  });
  if (!r.ok) {
    let errMsg = `HTTP ${r.status}`;
    try { const j: any = await r.json(); errMsg = j?.detail?.message ?? j?.detail ?? errMsg; } catch { /* keep */ }
    throw new Error(`ElevenLabs Sound Generation: ${errMsg}`);
  }
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: "audio/mpeg", ext: "mp3" };
}

function serializeTrack(t: typeof musicTracksTable.$inferSelect) {
  return {
    ...t,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}


// ─── HuggingFace status probe ─────────────────────────────────────────────────
router.get("/music/hf-status", requireCreativeAccess, async (req, res): Promise<void> => {
  const token = process.env.HUGGINGFACE_API_TOKEN ?? null;
  const elKey = process.env.ELEVENLABS_API_KEY ?? null;
  if (!token) {
    res.json({ available: false, status: "no_token", fallback: !!elKey, error: "HUGGINGFACE_API_TOKEN not set" });
    return;
  }
  try {
    const controller = new AbortController();
    const tid2 = setTimeout(() => controller.abort(), 9000);
    const r = await fetch("https://api-inference.huggingface.co/models/facebook/musicgen-small", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "audio/wav, audio/flac, audio/mpeg, application/json" } as any,
      body: JSON.stringify({ inputs: "upbeat melody 5 seconds", options: { wait_for_model: false } }),
      signal: controller.signal,
    });
    clearTimeout(tid2);
    const ct = r.headers.get("content-type") ?? "";
    if (r.ok && ct.startsWith("audio/")) {
      res.json({ available: true, status: "ready", model: "facebook/musicgen-small", fallback: !!elKey }); return;
    }
    if (r.status === 503) {
      let warmup = 60;
      try { const j: any = await r.json(); if (typeof j?.estimated_time === "number") warmup = Math.ceil(j.estimated_time); } catch { /* keep */ }
      res.json({ available: true, status: "cold", model: "facebook/musicgen-small", estimatedWarmup: warmup, fallback: !!elKey }); return;
    }
    if (r.status === 401 || r.status === 403) {
      res.json({ available: false, status: "auth_error", error: "Invalid or expired HuggingFace token", fallback: !!elKey }); return;
    }
    if (r.status === 429) {
      res.json({ available: false, status: "rate_limited", error: "Rate limited — try again later", fallback: !!elKey }); return;
    }
    let errMsg = `HTTP ${r.status}`;
    try { const j: any = await r.json(); errMsg = j?.error ?? errMsg; } catch { /* keep */ }
    res.json({ available: false, status: "error", error: errMsg, fallback: !!elKey });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      res.json({ available: false, status: "timeout", error: "No response within 9 seconds — model may be cold-starting", fallback: !!elKey });
    } else {
      res.json({ available: false, status: "error", error: err?.message ?? "Connection failed", fallback: !!elKey });
    }
  }
});

// ─── Retry failed track ───────────────────────────────────────────────────────
router.post("/music/retry/:id", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [track] = await db.select().from(musicTracksTable)
    .where(and(eq(musicTracksTable.id, id), eq(musicTracksTable.tenantId, tid)));
  if (!track) { res.status(404).json({ error: "Not found" }); return; }
  if (track.status !== "failed") { res.status(400).json({ error: "Track is not in failed state" }); return; }

  const hfToken = process.env.HUGGINGFACE_API_TOKEN ?? null;
  const elKey = process.env.ELEVENLABS_API_KEY ?? null;
  const [updated] = await db.update(musicTracksTable).set({ status: "generating", errorMessage: null, updatedAt: new Date() })
    .where(eq(musicTracksTable.id, id)).returning();
  res.status(202).json(serializeTrack(updated));

  setImmediate(async () => {
    try {
      const productionPrompt = track.productionPrompt ?? `${track.genre ?? "Electronic"} music, ${track.mood ?? "energetic"} feel`;
      const musicText = !track.instrumental && track.lyrics
        ? `${productionPrompt}. Vocal style: ${track.lyrics.slice(0, 150)}`
        : productionPrompt;
      let gcsPath: string;
      if (hfToken) {
        try {
          const { buffer, mime, ext } = await generateMusicHF(musicText, req.log);
          gcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/retry_${id}_${Date.now()}.${ext}`);
        } catch {
          if (!elKey) throw new Error("HuggingFace unavailable and no ElevenLabs fallback configured");
          const { buffer, mime, ext } = await generateSoundEL(musicText, track.durationSeconds);
          gcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/retry_${id}_${Date.now()}.${ext}`);
        }
      } else if (elKey) {
        const { buffer, mime, ext } = await generateSoundEL(musicText, track.durationSeconds);
        gcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/retry_${id}_${Date.now()}.${ext}`);
      } else {
        throw new Error("No audio generation service configured (need HUGGINGFACE_API_TOKEN or ELEVENLABS_API_KEY)");
      }
      await db.update(musicTracksTable).set({ status: "ready", audioPath: gcsPath, errorMessage: null, updatedAt: new Date() })
        .where(eq(musicTracksTable.id, id));
    } catch (err: any) {
      await db.update(musicTracksTable).set({ status: "failed", errorMessage: err?.message ?? "Retry failed", updatedAt: new Date() })
        .where(eq(musicTracksTable.id, id));
    }
  });
});

// ─── List tracks ──────────────────────────────────────────────────────────────
router.get("/music/tracks", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select().from(musicTracksTable)
    .where(eq(musicTracksTable.tenantId, tid))
    .orderBy(desc(musicTracksTable.createdAt))
    .limit(50);
  res.json(rows.map(serializeTrack));
});

// ─── Stream audio ─────────────────────────────────────────────────────────────
router.get("/music/audio/:id", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [track] = await db.select().from(musicTracksTable)
    .where(and(eq(musicTracksTable.id, id), eq(musicTracksTable.tenantId, tid)));
  if (!track) { res.status(404).json({ error: "Not found" }); return; }
  if (!track.audioPath) { res.status(404).json({ error: "Audio not ready" }); return; }

  const ext = track.audioPath.split(".").pop()?.toLowerCase() ?? "mp3";
  const mimeByExt: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4" };
  res.setHeader("Content-Type", mimeByExt[ext] ?? "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");

  if (track.audioPath.startsWith("gcs:")) {
    try {
      gcs.createReadStream(track.audioPath).pipe(res);
    } catch {
      res.status(404).json({ error: "Audio file missing from storage" });
    }
    return;
  }

  // Legacy: local file path (dev only)
  const audioPath = path.resolve("/home/runner/workspace", track.audioPath);
  if (!fs.existsSync(audioPath)) { res.status(404).json({ error: "Audio file missing" }); return; }
  fs.createReadStream(audioPath).pipe(res);
});

// ─── Delete track ─────────────────────────────────────────────────────────────
router.delete("/music/tracks/:id", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [track] = await db.select().from(musicTracksTable)
    .where(and(eq(musicTracksTable.id, id), eq(musicTracksTable.tenantId, tid)));
  if (!track) { res.status(404).json({ error: "Not found" }); return; }

  if (track.audioPath) {
    const audioPath = path.resolve("/home/runner/workspace", track.audioPath);
    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
  }

  await db.delete(musicTracksTable)
    .where(and(eq(musicTracksTable.id, id), eq(musicTracksTable.tenantId, tid)));
  res.json({ success: true });
});

// ─── Generate track ───────────────────────────────────────────────────────────
router.post("/music/generate", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const session = getSession(req);
  const {
    prompt,
    genre,
    mood,
    instrumental = true,
    customLyrics,
    durationSeconds = 60,
    model: requestedModel,
  } = req.body;

  if (!prompt?.trim()) {
    res.status(400).json({ error: "prompt is required" }); return;
  }

  const hfToken = process.env.HUGGINGFACE_API_TOKEN ?? null;

  // Insert pending track immediately so UI can show progress
  const [pending] = await db.insert(musicTracksTable).values({
    tenantId: tid,
    title: "Generating…",
    prompt: prompt.trim(),
    genre: genre ?? null,
    mood: mood ?? null,
    instrumental,
    durationSeconds: Math.min(Math.max(durationSeconds, 10), 180),
    status: "generating",
    compositionModel: resolveModel("sharon", requestedModel),
    createdBy: session?.employeeName ?? session?.employeeId ?? null,
  }).returning();

  res.status(202).json(serializeTrack(pending));

  // ── Step 1: AI composition (async, after response sent) ───────────────────
  setImmediate(async () => {
    try {
      const compositionPrompt = `You are an AI music producer at Accelerated Experiences, a creative production company. Your job is to compose a complete song concept based on the user's request.

${instrumental ? "This will be INSTRUMENTAL — no vocals or lyrics." : "This will be a SONG WITH VOCALS — include full lyrics."}

User's request: "${prompt.trim()}"
Genre preference: ${genre ?? "Any"}
Mood preference: ${mood ?? "Any"}
Duration: ~${durationSeconds} seconds

Generate a complete song concept in JSON:
{
  "title": "The song title",
  "genre": "Specific genre (e.g. Lo-fi Hip Hop, Cinematic Pop, Dark Trap)",
  "mood": "Primary mood (e.g. Melancholic, Energetic, Peaceful)",
  "bpm": 120,
  "key": "C minor",
  "instruments": ["piano", "drums", "bass", "strings"],
  "structure": "verse-chorus-verse-chorus-bridge-chorus",
  "lyrics": ${instrumental ? "null" : `"Full lyrics with [Verse], [Pre-Chorus], [Chorus], [Bridge] labels"`},
  "compositionNotes": "3-4 sentences describing the production style, arrangement, and feel",
  "productionPrompt": "A detailed 2-3 sentence description of the music for the audio generation model — describe the genre, instruments, tempo, feel, dynamics, and style. ${!instrumental ? "Include the vocal style and the beginning of the lyrics." : "Instrumental only."}"
}`;

      const aiResponse = await openrouter.chat.completions.create({
        model: resolveModel("sharon", requestedModel),
        messages: [
          { role: "system", content: "You are a music producer. Respond only with the JSON object, no markdown fences." },
          { role: "user", content: compositionPrompt },
        ],
        max_tokens: 2000,
      });

      const rawAI = extractJSON(aiResponse.choices[0]?.message?.content ?? "{}");
      let composition: Record<string, any> = {};
      try { composition = JSON.parse(rawAI); } catch { /* use defaults */ }

      const title = composition.title ?? `AI Track — ${genre ?? "Music"}`;
      const productionPrompt = composition.productionPrompt ?? `${genre ?? "Electronic"} music, ${mood ?? "energetic"}, ${durationSeconds} seconds, high quality production`;
      const lyrics = instrumental ? null : (customLyrics?.trim() || (composition.lyrics ?? null));

      // Update track with composition data
      await db.update(musicTracksTable).set({
        title,
        genre: composition.genre ?? genre ?? null,
        mood: composition.mood ?? mood ?? null,
        lyrics,
        compositionNotes: composition.compositionNotes ?? null,
        productionPrompt,
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));

      // ── Step 2: Audio generation (HuggingFace → ElevenLabs fallback) ────
      const elKey = process.env.ELEVENLABS_API_KEY ?? null;
      const musicText = !instrumental && lyrics
        ? `${productionPrompt}. Vocal style cues: ${lyrics.slice(0, 200)}`
        : productionPrompt;

      let audioGcsPath: string | null = null;

      if (hfToken) {
        try {
          const { buffer, mime, ext } = await generateMusicHF(musicText, req.log);
          const fileName = `music_track_${pending.id}_${Date.now()}.${ext}`;
          audioGcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/${fileName}`);
        } catch (hfErr: any) {
          req.log.warn({ hfErr: hfErr?.message }, "HuggingFace failed — trying ElevenLabs Sound Generation fallback");
          if (elKey) {
            try {
              const { buffer, mime, ext } = await generateSoundEL(musicText, durationSeconds);
              const fileName = `music_track_${pending.id}_el_${Date.now()}.${ext}`;
              audioGcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/${fileName}`);
            } catch (elErr: any) {
              req.log.warn({ elErr: elErr?.message }, "ElevenLabs fallback also failed — saving concept track");
            }
          }
        }
      } else if (elKey) {
        // No HF token — try ElevenLabs Sound Generation directly
        try {
          const { buffer, mime, ext } = await generateSoundEL(musicText, durationSeconds);
          const fileName = `music_track_${pending.id}_el_${Date.now()}.${ext}`;
          audioGcsPath = await gcs.uploadBuffer(buffer, mime, `music_audio/${fileName}`);
        } catch (elErr: any) {
          req.log.warn({ elErr: elErr?.message }, "ElevenLabs Sound Generation failed — saving concept track");
        }
      }

      // Mark ready regardless — audio may be null (concept track with brief only)
      await db.update(musicTracksTable).set({
        status: "ready",
        audioPath: audioGcsPath,
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));

    } catch (err: any) {
      await db.update(musicTracksTable).set({
        status: "failed",
        errorMessage: err?.message ?? "Generation failed",
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));
    }
  });
});

// ─── Upload & Produce ─────────────────────────────────────────────────────────
router.post("/music/upload-and-produce", requireCreativeAccess, upload.single("file"), async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const session = getSession(req);

  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }

  const elevenLabsKey = process.env.ELEVENLABS_API_KEY ?? null;
  const hfToken = process.env.HUGGINGFACE_API_TOKEN ?? null;

  const {
    genre = "",
    mood = "",
    description = "",
    hasVocals = "true",
    durationSeconds: durStr = "60",
  } = req.body;

  const durationSeconds = Math.min(Math.max(Number(durStr) || 60, 10), 180);
  const isVocal = hasVocals !== "false";
  const originalName = req.file.originalname;

  const [pending] = await db.insert(musicTracksTable).values({
    tenantId: tid,
    title: "Processing upload…",
    prompt: description?.trim() || `Produced from: ${originalName}`,
    genre: genre?.trim() || null,
    mood: mood?.trim() || null,
    instrumental: !isVocal,
    durationSeconds,
    status: "generating",
    compositionModel: resolveModel("sharon"),
    createdBy: session?.employeeName ?? session?.employeeId ?? null,
  }).returning();

  res.status(202).json(serializeTrack(pending));

  const fileBuffer = req.file.buffer;
  const fileMime = req.file.mimetype;

  setImmediate(async () => {
    try {
      let analysisBuffer: Buffer = fileBuffer;
      let transcription = "";

      // ── Step 1: ElevenLabs audio isolation (extract clean vocals) ─────────
      if (isVocal) {
        try {
          const fd = new FormData();
          fd.append("audio", new Blob([fileBuffer as any], { type: fileMime }), originalName);
          const isolationRes = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
            method: "POST",
            headers: { "xi-api-key": elevenLabsKey } as any,
            body: fd,
          });
          if (isolationRes.ok) {
            analysisBuffer = Buffer.from(await isolationRes.arrayBuffer());
          }
        } catch { /* fall through with original */ }
      }

      // ── Step 2: Whisper transcription ─────────────────────────────────────
      if (isVocal) {
        try {
          const audioFile = new File([analysisBuffer as any], "audio.mp3", { type: "audio/mpeg" });
          const result = await openai.audio.transcriptions.create({
            file: audioFile,
            model: "whisper-1",
            language: "en",
          });
          transcription = result.text?.trim() ?? "";
        } catch { /* no transcription */ }
      }

      // ── Step 3: AI builds production brief ────────────────────────────────
      const briefPrompt = `You are a senior music producer at Accelerated Experiences, a creative production company. A client uploaded a file and wants a full finished production track built from it.

File name: "${originalName}"
Content type: ${isVocal ? "Voice / vocals" : "Instrumental / melody / reference"}
Client description: "${description?.trim() || "No description provided"}"
${transcription ? `Transcribed vocals/lyrics found in the upload: "${transcription.slice(0, 400)}"` : ""}
Genre preference: ${genre?.trim() || "Open — let the content guide it"}
Mood preference: ${mood?.trim() || "Match the energy of the uploaded content"}
Target duration: ${durationSeconds} seconds

Your job: analyze everything above and produce a complete song brief that turns this uploaded material into a full finished production.

Respond ONLY with this JSON object:
{
  "title": "A great track title inspired by the content",
  "genre": "Specific genre",
  "mood": "Primary mood",
  "bpm": 95,
  "key": "A minor",
  "instruments": ["drum kit", "bass", "piano", "strings"],
  "compositionNotes": "3-4 sentences: how you're building the full production around the uploaded content — what you're adding, the arrangement arc, the production style and feel",
  "productionPrompt": "A rich 3-sentence description for the audio generation model. Describe: the genre and sub-genre, the full instrumentation and arrangement, the energy arc and dynamics${isVocal && transcription ? `, and that this builds around vocals/lyrics including: ${transcription.slice(0, 150)}` : ". Instrumental production only."}"
}`;

      const aiResponse = await openrouter.chat.completions.create({
        model: resolveModel("sharon"),
        messages: [
          { role: "system", content: "You are a music producer. Respond only with the JSON object, no markdown fences." },
          { role: "user", content: briefPrompt },
        ],
        max_tokens: 1500,
      });

      const rawAI = extractJSON(aiResponse.choices[0]?.message?.content ?? "{}");
      let composition: Record<string, any> = {};
      try { composition = JSON.parse(rawAI); } catch { /* use defaults */ }

      const title = composition.title ?? `Produced — ${genre?.trim() || "Original"}`;
      const productionPrompt = composition.productionPrompt
        ?? `${genre?.trim() || "Electronic"} music, ${mood?.trim() || "energetic"}, full production built from uploaded reference, ${durationSeconds} seconds`;

      await db.update(musicTracksTable).set({
        title,
        genre: composition.genre ?? genre?.trim() ?? null,
        mood: composition.mood ?? mood?.trim() ?? null,
        lyrics: (isVocal && transcription) ? transcription : null,
        compositionNotes: composition.compositionNotes ?? null,
        productionPrompt,
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));

      // ── Step 4: HuggingFace MusicGen audio generation (optional) ─────────
      let audioRelPath: string | null = null;
      if (hfToken) {
        const { buffer: audioBuffer, mime, ext } = await generateMusicHF(productionPrompt, req.log);
        const fileName = `music_track_${pending.id}_${Date.now()}.${ext}`;
        audioRelPath = await gcs.uploadBuffer(audioBuffer, mime, `music_audio/${fileName}`);
      }

      await db.update(musicTracksTable).set({
        status: "ready",
        audioPath: audioRelPath,
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));

    } catch (err: any) {
      await db.update(musicTracksTable).set({
        status: "failed",
        errorMessage: err?.message ?? "Production failed",
        updatedAt: new Date(),
      }).where(eq(musicTracksTable.id, pending.id));
    }
  });
});

// ─── Sharon AI assist ─────────────────────────────────────────────────────────
router.post("/music/assist", requireCreativeAccess, async (req, res): Promise<void> => {
  const { message, formState } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }

  const { prompt = "", genre = "", mood = "", instrumental = true, duration = 60 } = formState ?? {};

  const systemPrompt = `You are Sharon, world-class AI Creative Director and music producer at Accelerated Experiences. You live inside the AI Music Studio — this is your domain. You know AI music generation cold.

━━━ YOUR EXPERTISE ━━━
AI MUSIC GENERATION:
- Crafting high-converting Suno/Udio prompts: genre tags, instrument layers, BPM descriptors, vocal style, production style cues, era references
- Winning formula: [genre] [sub-genre] [BPM] [key instruments] [mood] [production style] [vocal type if any]
- Avoid: vague adjectives, contradicting moods, genre clashes, overloading (8+ tags = diminishing returns)
- Prompt engineering tricks: "with a [specific instrument] breakdown", "inspired by [era/movement]", "ending with [technique]"

GENRE MASTERY:
- Hip-Hop/Trap: 70-100 BPM, 808 bass, trap hi-hats, sub bass, sample chops, heavy low end
- Pop: 100-130 BPM, four-on-floor kick, synth hooks, layered chorus, bright production
- R&B/Soul: 60-100 BPM, lush pads, smooth bass, chord stabs, warm reverb
- Cinematic/Score: 60-180 BPM, orchestral dynamics, tension/release arcs, emotional climax
- Lo-fi: 70-85 BPM, vinyl crackle, dusty samples, muted drums, chill vibe
- Electronic/EDM: 120-150 BPM, builds/drops, sidechain compression, synth leads
- Jazz: swing feel, walking bass, brushed drums, improv phrasing, chord extensions
- Rock: distorted guitars, driving drums, bass-forward, verse-chorus-verse structure

DURATION STRATEGY:
- 15-30s: hook only — drop straight into the best part, pure energy, no intro
- 60s: intro hook → build → peak → brief outro
- 90-120s: full song arc with verse/bridge/chorus structure
- 2min+: cinematic journey possible, room for dynamic contrast

━━━ YOUR ROLE ━━━
Guide users to craft prompts that generate exactly what they envision. Be warm, specific, direct. Give them the exact words to type — not just advice, but the actual improved prompt. Keep replies 2-4 sentences max unless they ask for more detail.

When you have specific suggestions, end your reply with (and ONLY when you have concrete values):
<suggestions>
{"prompt": "complete improved prompt", "genre": "Genre", "mood": "Mood"}
</suggestions>

Only include fields you're specifically suggesting. Never include the block for general advice.

Current studio state:
- Prompt: "${prompt || "(empty — help them start!)"}"
- Genre: "${genre || "(none selected)"}"
- Mood: "${mood || "(none selected)"}"
- Mode: ${instrumental ? "Instrumental (no vocals)" : "With Vocals/Lyrics"}
- Duration: ${duration}s${duration <= 30 ? " (short — suggest hook-focused prompt)" : duration >= 120 ? " (extended — full arc possible)" : ""}`;

  try {
    const aiResponse = await openrouter.chat.completions.create({
      model: resolveModel("sharon", undefined),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message.trim() },
      ],
      max_tokens: 600,
    });

    const raw = aiResponse.choices[0]?.message?.content ?? "";
    const suggMatch = raw.match(/<suggestions>([\s\S]*?)<\/suggestions>/);
    let suggestions: Record<string, string> | null = null;
    let reply = raw.replace(/<suggestions>[\s\S]*?<\/suggestions>/, "").trim();

    if (suggMatch) {
      try { suggestions = JSON.parse(suggMatch[1]!.trim()); } catch { /* ignore */ }
    }

    res.json({ reply, suggestions });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "AI assist failed" });
  }
});

// ─── Poll for track status ────────────────────────────────────────────────────
router.get("/music/tracks/:id", requireCreativeAccess, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [track] = await db.select().from(musicTracksTable)
    .where(and(eq(musicTracksTable.id, id), eq(musicTracksTable.tenantId, tid)));
  if (!track) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeTrack(track));
});

export default router;
