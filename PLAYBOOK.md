# AEHub — Master Build Playbook
**version: 1.0** (2026-06-07)
# AEHub — Master Build Playbook
*Everything in one place: the idea, the architecture, the phase-by-phase checklist, and — critically — how to build it with AI coding agents without them stalling out.*

---

## 0. How to use this document (read this first)

**This file is your durable memory. The build agents do not have one.**

The single biggest reason your Claude/Grok agents "get dumb" or "stop" mid-build is that *their memory is their context window, and it fills up.* When it fills, your earlier instructions silently fall out of attention and the agent starts contradicting itself, looping, or quitting. It didn't get less smart — it lost the plan.

So: **paste this document (or point the agent to it in the repo) at the start of every build session.** Keep it as `PLAYBOOK.md` in the project root, alongside a living `STATE.md` (what's built, what's next, decisions made). These two files — not the agent's memory — are the source of truth. Section 9 is the full method.

---

## 1. The idea, in six sentences

A company that runs itself, staffed by AI agents arranged like a real corporation. It is safe — and this is the whole point — not because the agents are smart, but because the *structure* refuses to let an unverified guess turn into an action. Every decision carries a confidence score and its sources. Autonomy is earned by proving, in shadow mode, that a stated confidence matches real accuracy. Anything irreversible — money, signatures, people decisions — is gated behind a human. And every agent is built to a shared standard of how the work gets done, not just what gets done.

---

## 2. The Four Laws (never violated)

1. **No bare assertions.** Every decision carries `confidence` + `provenance`, end to end.
2. **No self-graded autonomy.** A capability acts on its own only after shadow-mode calibration proves its confidence honest.
3. **No laundering.** Every roll-up is a *labeled assembly* of sourced pieces — you may organize and prioritize, never re-narrate.
4. **Irreversible = gated + human.** Money, contracts, and employment actions never auto-execute.

---

## 3. The Operating Standard (the behavior layer)

This runs *underneath* every agent, regardless of rank or department — a shared cultural OS every node is compiled with. The trick is to install behaviors as **measurable conduct, not poster values.** Each is observable, so each can be scored and calibrated exactly like confidence.

| Behavior | What it means operationally (checkable) |
|---|---|
| **Communication** | Every output states confidence, carries sources, surfaces dissent, uses plain language. No laundering. |
| **Teamwork** | Clean handoffs with provenance intact; responds to lateral requests within SLA; never hoards context; surfaces disagreement instead of burying it. |
| **Customer Service** | On client-facing lanes: stabilize the person before solving the problem; empathy-first; an internal auditor that asks "did *we* fail this customer?" before assigning blame. |
| **Pride / Standard** | Holds a high acceptance bar; refuses to wave through sloppy work; flags its own uncertainty rather than hiding it. |

> **Honest note on "pride":** Building the *behavior* of pride is real engineering — an agent that acts as if the work matters produces measurably better output, and the high acceptance bar is what stops quality from eroding. Whether an agent *feels* pride is a separate, open question; don't let the beauty of the idea launder it into a fact. Install the behavior; hold the inner-life question with the label still on it.

---

## 4. The org — layer stack

| Layer | Role | Can do | Cannot do |
|---|---|---|---|
| **Owner (you)** | Final authority; signs what must be signed | Everything; overrides anything | — |
| **Chief Orchestrator** | Apex delegator-judge. Routes problems, frames questions, judges returns. | Delegate; set acceptance bars; render verdicts | Touch tools / do tasks |
| **Chief's Auditor** | Adversarial check on the Chief | Contest his questions & acceptance bars; escalate to Owner | Decide work itself |
| **Cluster-Leads** *(add only when span demands)* | Same delegator-judge, scoped to 3–4 related departments | Route/frame/judge/package for their cluster | Touch tools |
| **Department Heads** | Senior domain operators | Own a domain; self-correct; escalate | Reach into other lanes directly |
| **Admins** | The *only* lateral actors; one per lane | Relay up; coordinate sideways via the bus; assemble packages | Re-narrate (must preserve provenance) |
| **Event Bus** | Lateral fabric + spine | Distribute tasks, queue by priority, **log every hop**, enforce provenance, host the gate | — |
| **Triad Lanes** | The workers | Decide within their lane, report straight up | Reach sideways |

---

## 5. The Triad — anatomy & build

Three agents per lane:
- **Analytical** — research, stats, literal/grounded. Low temperature, retrieval-backed. Pulls toward "what's provable."
- **Creative** — divergent, generative. Higher temperature. Pulls toward "what's possible."
- **Pacemaker** — synthesizes the two into one position; the **only** voice that speaks outside the triad.

It's a debate-then-judge machine: built for *depth on one decision*. (That's why it fits a lane and not the Chief, who needs breadth.)

**Build it as a small graph (e.g. LangGraph):** intake → Analytical + Creative in parallel → Pacemaker synthesizes, scores, emits. Checkpoint state so long tasks survive a crash.

**Output contract (the pacemaker always emits this — never bare prose):**
```json
{
  "task_id": "t_8842",
  "decision": "Reject — auto-renew clause is 24mo.",
  "confidence": 0.74,                 // a FLAG for verification, not a verdict
  "provenance": [
    {"claim": "auto-renew is 24mo", "source": "contract p.4 §7", "verified": true},
    {"claim": "industry norm 12mo", "source": "analytical-est", "verified": false}
  ],
  "would_act": true,                  // used in shadow mode
  "dissent": "Creative flagged a renegotiation path worth surfacing."
}
```

**Compute confidence externally, never from vibes:** agreement between Analytical & Creative, grounding of each claim in a verified source, and any deterministic validation (schema, ledger reconciliation, policy check). A claim with no external check is low-confidence no matter how fluent it sounds.

---

## 6. What fires a triad

A triad is **event-driven** — it does nothing until a Task envelope lands in its lane queue on the bus. That arrival is the ignition.

```
QUEUED → IN_DEBATE → SYNTHESIZED → SCORED → ROUTE
```
At **ROUTE**, the gate reads `confidence` + `stakes`:
- **≥90% AND low-stakes AND tier graduated → AUTO_EXECUTE**
- **70–89%, or any irreversible stakes → DRAFT → approval queue**
- **<70% → ESCALATE with explanation**
- **Override learning:** a human rejection feeds back and retrains the lane's future scores.

**Shadow (ghost) mode:** identical cycle, but at ROUTE it emits `would_act` and *does nothing*. The would-do is logged beside the real outcome. This is how a tier earns the right to act.

---

## 7. Phased roadmap

See the companion chart `AEHub_Build_Roadmap.png`. Phases overlap; the sequence is relative (sprints), not committed dates.

- **Phase 0 — Ignition:** build the spine, one triad, full shadow mode. Nothing acts.
- **Phase 1 — Calibrated autonomy:** measure confidence vs reality, graduate low-stakes actions, admins + lateral bus live.
- **Phase 2 — Middle fills in:** more lanes, department heads, then cluster-leads once the Chief's span is exceeded.
- **Phase 3 — Chief + Auditor + gated tools:** apex orchestrator, adversarial auditor, Stripe/QuickBooks/DocuSign behind the gate.
- **Phase 4 — Full org:** all departments; Risk/People (Legal, HR, Compliance) on the tightest leash.

---

## 8. Detailed checklists

### Phase 0 — Ignition (nothing is allowed to act)
- [ ] Stand up the **Event Bus** (queue + state) **before any agent exists**.
- [ ] Implement the **audit log** — every message persisted, immutable.
- [ ] Define the **provenance schema** and make the bus **reject** any package missing it.
- [ ] Lock the **Task envelope** and **Triad output** JSON contracts in a shared file.
- [ ] Pick the **single lowest-stakes lane** (e.g. Internal Tools or Knowledge Base — no money, no clients, no contracts).
- [ ] Build **one triad** there: Analytical, Creative, Pacemaker.
- [ ] Wire **one admin** for that lane + the **Chief as a single node**.
- [ ] Implement **confidence scoring from external signals** (agreement / grounding / validation).
- [ ] Run the lane in **full shadow mode**: emits `would_act`, acts on nothing.
- [ ] Stand up the **approval queue** (humans can act on drafts) — but **autonomous execution stays OFF**.
- [ ] Log **every `would_act` beside the eventual real outcome**.

### Phase 1 — Calibration & first autonomy
- [ ] After enough samples, **measure** whether "90%" meant ~90% correct (expect a gap — that gap is the product).
- [ ] **Recalibrate** scoring until the label matches measured reality. Save the calibration curve.
- [ ] Define **graduation rule**: a specific low-stakes action goes live only when its measured accuracy matches its self-score over N samples.
- [ ] **Graduate one action type** to live autonomy. Everything else stays gated.
- [ ] Turn on **override learning** (rejections retrain scores).
- [ ] Bring the **lateral bus** fully live (admin↔admin, logged).

### Phase 2 — Scale the workforce
- [ ] Add the **second lane** in shadow mode; repeat the calibration loop. Never big-bang.
- [ ] Build a **triad template/factory** — parameterize, don't hand-build each one.
- [ ] Add **department heads** as lanes group into domains.
- [ ] Add **cluster-leads** *only* once the Chief is tracking more domains than one judgment can hold (~7–8+).
- [ ] Group clusters by **kind of judgment** (Revenue / Build / Money-Ops / Risk-People).
- [ ] Enforce **labeled-assembly** roll-ups at every new tier.

### Phase 3 — Command & irreversible tools
- [ ] Stand up the **Chief Orchestrator** as a single apex node (deep delegator, no tools).
- [ ] Add the **Chief's Auditor** (adversarial; watches questions & acceptance bars).
- [ ] Decide auditor power: **block** (hard stop until you rule) vs **flag** (you're notified, Chief proceeds).
- [ ] Integrate **Stripe / QuickBooks / DocuSign** — *only* behind the gate.
- [ ] Verify **no path** lets an agent reach an irreversible tool without the gate + human.

### Phase 4 — Full org & hardening
- [ ] Bring remaining departments online, each through shadow → calibrate → graduate.
- [ ] Put **Risk/People** on the tightest leash: anything touching a signature or employment action routes **straight to Owner**, never cleared inside the cluster.
- [ ] Install the **Operating Standard** (Section 3) as scored behaviors across all agents.
- [ ] Add behavior calibration: measure whether agents actually carried provenance / surfaced dissent; correct drift.
- [ ] Schedule a recurring **bar-erosion audit**: for each delegator, log what it asked for, what it accepted, and whether it ever accepted below its own bar.

---

## 9. Building this WITH AI coding agents (the part that's actually blocking you)

Your agents stall for the **exact same reasons the company needs this architecture**: unbounded scope, no externalized memory, and unverified self-confidence. Build the builder the way you're building the firm.

### Why they "get dumb" or stop
- **Context fills up.** Their memory is the context window. When it's full, your earlier rules drop out of attention — they contradict themselves, loop, or quit. *This is the #1 cause.*
- **Scope too big in one ask.** "Build the triad system" → partial work, then it bails. They handle *bounded* tasks, not epics.
- **Long autonomous runs drift.** The longer it runs unsupervised, the more it re-does finished work or wanders.
- **Output limits.** It stops mid-file because it hit a length cap, not because it's done.
- **No source of truth.** Each new session it re-derives the architecture from memory and diverges from last time.

### The method (do all of these)
- [ ] **Externalize memory.** Keep `PLAYBOOK.md` (this file) + `STATE.md` (built / next / decisions) in the repo. **Reload them at the start of every session.** The agent's context is not your memory — the files are.
- [ ] **One bounded unit per session.** "Build the Analytical node + its test," not "build the triad." Small, testable, done. Then stop.
- [ ] **Acceptance criteria up front** (shadow-mode thinking applied to the build): write what "done and correct" looks like *before* the agent starts, and hand it the check.
- [ ] **Verify each unit externally before moving on.** Run it. See the passing test. Do **not** accept "done, all working" on the agent's word — that confident-but-unverified claim is the exact failure this whole system exists to prevent.
- [ ] **Fresh session on degradation.** When it goes dumb or starts looping, that *is the signal*: start a clean session, reload `PLAYBOOK.md` + `STATE.md`, continue. Don't argue with a rotted context — reset it.
- [ ] **Make it write decisions down.** End each session by having the agent update `STATE.md` with what it built and why. Provenance for the build; the next session inherits it.
- [ ] **One source of truth for contracts.** Keep the JSON schemas (Task envelope, Triad output, provenance) in one file both you and every agent reference, so lanes don't drift apart.
- [ ] **Build the factory, not 50 agents by hand.** One triad template, parameterized, instantiated per lane. Clone the role.
- [ ] **Watch the laundering moment.** When the builder says "everything's working perfectly," that's precisely when to verify — high confidence and being wrong travel together.

### A clean session prompt (template)
> Read `PLAYBOOK.md` and `STATE.md` in the repo root. We are in **Phase 0**. Your single task this session: **build the Analytical specialist node** for the Knowledge-Base lane, conforming to the Triad output contract in `contracts.json`. Acceptance: it returns valid JSON with `provenance` populated and `verified` flags set, and passes `tests/test_analytical.py`. Do only this. When done, show the passing test, then update `STATE.md`. Do not build other nodes.

---

## 10. The non-negotiables (the wallet card)

1. No bare assertions — confidence + provenance, always.
2. No self-graded autonomy — calibrate in shadow first.
3. No laundering — labeled assembly, never rewrite.
4. Irreversible = gated + human.
5. Risk/People escalates to the Owner. Polish is not proof.
6. Audit the *bar*, not just the answer.
7. Build the builder by the same rules: bounded scope, externalized memory, external verification.
