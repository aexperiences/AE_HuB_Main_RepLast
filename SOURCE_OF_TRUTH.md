# AEHub — Single Source of Truth

**Last Updated:** June 8, 2026  
**Status:** Phase 0 Safety Cleanup — In Progress

---

## 1. What This Project Is

AEHub is the internal operating system for Accelerated Experiences LLC.  
It is being rebuilt as a **safe, structured, AI-augmented company** following the principles in `PLAYBOOK.md`.

**Core Rules (never violated):**
- No bare assertions — every decision must carry confidence + provenance
- No self-graded autonomy — nothing acts on its own until proven in shadow mode
- Irreversible actions (money, contracts, signatures) are always human-gated
- Everything important is logged and auditable

---

## 2. Current State (as of June 8, 2026)

- Replit account is closed — all work is now on this GitHub copy
- The hub is **usable today** for manual chat with agents (Anetta, Sharon, Dolly, Geoffrey, etc.)
- **Safety edit complete**: Automatic/scheduled agent runs are now disabled in `agent-hub.ts`
- We are following the phased approach from `PLAYBOOK.md`:
  - Currently in **Phase 0** (safety first)
  - Goal: Make the hub safe and human-gated, then gradually add proper triads + shadow mode later

**Key Files (Single Source of Truth set):**
- `PLAYBOOK.md` — Master architecture and build rules
- `SOURCE_OF_TRUTH.md` — This file (living status + decisions)
- `AEHub_Build_Roadmap.md` — Visual phased roadmap
- `STATE.md` — Short “what’s built / what’s next” tracker (create next)

---

## 3. What We Are Doing Right Now

**Immediate Goal:** Turn the hub into a **safe, human-gated tool** you can actually use today.

We are doing this **one small, safe change at a time**:
1. Disabled automatic/scheduled agent runs (done)
2. Keeping all manual chat and tool use fully working
3. Will gradually add provenance + confidence requirements
4. Editing directly on GitHub for speed (no local server needed right now)

**Current Status:**
- ✅ Schedules + Auto-Run sections in `agent-hub.ts` are disabled
- Manual chat with all agents remains fully functional
- Next: Create/update `STATE.md` and decide the next bounded improvement

---

## 4. How to Use This Hub Safely Right Now

- You can chat normally with Anetta, Sharon, Dolly, Geoffrey, etc.
- Agents can still read data and draft things
- **Nothing runs automatically** in the background
- Any action that creates or updates real data should go through you for approval

---

## 5. Next Small Steps (one at a time)

1. Create or update `STATE.md` (short living tracker)
2. Decide the next bounded improvement (user-friendliness, navigation, or adding provenance to outputs)
3. Keep all future work referencing `PLAYBOOK.md` at the start of every session

---

## 6. Important Notes

- We are editing directly on GitHub for speed right now.
- Do **not** try to run the full server until we finish the current safety cleanup.
- This `SOURCE_OF_TRUTH.md` file is the single place to check current status and decisions.

---

**This file is the living Single Source of Truth.**  
Update it at the end of every work session.

**Next action:** Create `STATE.md`
