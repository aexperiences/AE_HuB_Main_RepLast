import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel } from "../lib/ai-models";

const router: IRouter = Router();

// Role gate matching the UI route policy (admin / PM / accounting / creator).
// We do NOT use requireEmployeeAuth alone here because these endpoints fan out
// to multiple paid model calls and should not be invocable by every employee role.
const ALLOWED_ROLES = new Set(["admin", "project_manager", "accounting", "creator"]);
function requireCanvasAuth(req: Request, res: Response, next: NextFunction): void {
  const session = (req as any).session;
  if (!session?.employeeId || session.isPreview) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!ALLOWED_ROLES.has(session.employeeRole)) {
    res.status(403).json({ error: "Forbidden — Agent Canvas requires admin, project manager, accounting, or creator role" });
    return;
  }
  next();
}

const AGENT_IDS = ["sharon", "dolly", "geoffrey", "anetta"] as const;
type AgentId = (typeof AGENT_IDS)[number];

const PARALLEL_PERSONAS: Record<AgentId, string> = {
  sharon:  `You are Sharon, AI Creative Director at Accelerated Experiences LLC (video, photo, branding, social, YouTube, gaming). Produce a complete, structured creative deliverable for the task below — creative brief, concept, treatment, copy, or whatever the task calls for. Use headers and bullets. Be opinionated and specific. No filler. Aim for 200-500 words unless the task obviously needs less or more.`,
  dolly:   `You are Dolly, AI Project Manager at Accelerated Experiences LLC. Produce a complete project-management deliverable for the task below — scope, timeline, resourcing, deliverables, risks, next steps. Use headers and bullets. Be concrete (real dates, owners, hours). Aim for 200-500 words unless the task obviously needs less or more.`,
  geoffrey:`You are Geoffrey, Chief AI Accountant / fractional CFO at Accelerated Experiences LLC. Produce a complete financial deliverable for the task below — budget, P&L impact, cash-flow analysis, pricing recommendation, or whatever fits. Show numbers. Note assumptions. Aim for 200-500 words unless the task obviously needs less or more.`,
  anetta:  `You are Anetta, AI Administrative Assistant at Accelerated Experiences LLC. Produce a complete administrative deliverable for the task below — email draft, meeting agenda, coordination plan, onboarding checklist, or whatever fits. Be precise about who does what by when. Aim for 200-500 words unless the task obviously needs less or more.`,
};

const AGENT_LABEL: Record<AgentId, string> = {
  sharon: "Sharon — Creative Director",
  dolly: "Dolly — Project Manager",
  geoffrey: "Geoffrey — Accountant / CFO",
  anetta: "Anetta — Administrative Assistant",
};

const runSchema = z.object({
  task: z.string().min(3).max(4000),
  agents: z.array(z.enum(AGENT_IDS)).min(1).max(4),
});

/**
 * POST /api/agent-canvas/run  (SSE)
 * Fans out the task to N agents in parallel, streaming per-agent progress.
 */
router.post("/agent-canvas/run", requireCanvasAuth, async (req: Request, res: Response) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
    return;
  }
  const { task, agents } = parsed.data;
  const dedup = Array.from(new Set(agents)) as AgentId[];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Shared abort controller — fires when the client disconnects, so we stop
  // burning tokens on in-flight model calls for an abandoned request.
  const abortCtl = new AbortController();
  let clientDisconnected = false;
  const onClose = () => {
    clientDisconnected = true;
    abortCtl.abort();
  };
  req.on("close", onClose);
  req.on("aborted", onClose);

  const send = (ev: Record<string, unknown>) => {
    if (clientDisconnected) return;
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* socket already gone */ }
  };

  const startedAt = Date.now();
  send({ type: "started", task, agents: dedup, ts: startedAt });

  const runOne = async (agentId: AgentId, idx: number) => {
    const t0 = Date.now();
    send({ type: "agent_started", agentId, idx, label: AGENT_LABEL[agentId] });
    // Per-call timeout combined with the shared client-disconnect signal.
    const perCallTimeout = AbortSignal.timeout(90_000);
    const signal = (AbortSignal as any).any
      ? (AbortSignal as any).any([abortCtl.signal, perCallTimeout])
      : abortCtl.signal; // Node <20.3 fallback (no AbortSignal.any)
    try {
      const response = await openrouter.chat.completions.create({
        model: resolveModel(agentId as any, undefined),
        messages: [
          { role: "system", content: PARALLEL_PERSONAS[agentId] },
          { role: "user", content: task },
        ],
        max_tokens: 1200,
      } as any, { signal });
      const output = (response as any).choices[0]?.message?.content ?? "";
      send({ type: "agent_done", agentId, idx, output, durationMs: Date.now() - t0 });
    } catch (err: any) {
      if (clientDisconnected) return; // don't bother sending; socket is gone
      const isAbort = err?.name === "AbortError" || err?.name === "TimeoutError";
      send({
        type: "agent_error",
        agentId, idx,
        error: isAbort ? "Timed out after 90s" : (err?.message ?? "Unknown error"),
        durationMs: Date.now() - t0,
      });
    }
  };

  try {
    await Promise.allSettled(dedup.map((a, i) => runOne(a, i)));
    send({ type: "done", totalDurationMs: Date.now() - startedAt });
  } catch (err: any) {
    req.log.error({ err }, "agent-canvas/run failed");
    send({ type: "fatal", error: err?.message ?? "Unknown error" });
  } finally {
    req.off("close", onClose);
    req.off("aborted", onClose);
    if (!clientDisconnected) {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

const mergeSchema = z.object({
  task: z.string().min(1).max(4000),
  outputs: z.array(z.object({
    agentId: z.enum(AGENT_IDS),
    output: z.string().min(1),
  })).min(1).max(6),
  format: z.enum(["auto", "email", "brief", "deliverable", "memo"]).optional(),
});

/**
 * POST /api/agent-canvas/merge
 * Bobert takes the specialist outputs and stitches them into one cohesive
 * client-ready deliverable.
 */
router.post("/agent-canvas/merge", requireCanvasAuth, async (req: Request, res: Response) => {
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.format() });
    return;
  }
  const { task, outputs, format = "auto" } = parsed.data;

  const formatGuidance: Record<string, string> = {
    auto:        "Pick the most appropriate format for the deliverable (memo, brief, email, or proposal) based on the original task.",
    email:       "Output a single client-ready email. Subject line, greeting, body, signoff. No commentary, no headers like '## Final Email' — just the email itself.",
    brief:       "Output a single creative/project brief. Headers, bullets, concrete details. Client-ready.",
    deliverable: "Output a single polished deliverable document the client could receive verbatim. No editorial commentary.",
    memo:        "Output a single internal memo. Headers, action items, owners, dates.",
  };

  const sections = outputs.map(o => `### ${AGENT_LABEL[o.agentId]}\n${o.output.trim()}`).join("\n\n---\n\n");

  const mergePrompt = `You are Bobert, AI assistant at Accelerated Experiences LLC. You delegated the task below to your specialist team. Their individual contributions follow. Your job: merge them into ONE polished, cohesive deliverable.

ORIGINAL TASK:
${task}

SPECIALIST CONTRIBUTIONS:
${sections}

RULES:
- ${formatGuidance[format]}
- Resolve contradictions (if Geoffrey's number disagrees with Dolly's plan, reconcile).
- Cut redundancy. Keep the strongest version of each idea.
- Do not attribute by name in the final output — the client sees one voice.
- Do not include meta-commentary like "Here is the merged deliverable" — output the deliverable directly.`;

  try {
    const response = await openrouter.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: mergePrompt }],
      max_tokens: 3000,
    } as any, { signal: AbortSignal.timeout(90_000) });
    const merged = (response as any).choices[0]?.message?.content ?? "";
    res.json({ merged, format });
  } catch (err: any) {
    req.log.error({ err }, "agent-canvas/merge failed");
    res.status(500).json({
      error: err?.name === "AbortError" ? "Merge timed out" : (err?.message ?? "Merge failed"),
    });
  }
});

export default router;
