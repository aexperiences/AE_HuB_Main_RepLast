# AEHub — Single Source of Truth

**Last Updated:** June 8, 2026  
**Status:** Refactoring for safety (Phase 0)

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

- Replit account is closed — all work is now on this local/GitHub copy
- The hub is **usable today** for manual chat with agents (Anetta, Sharon, Dolly, Geoffrey, etc.)
- Unsafe automatic/scheduled execution is being turned off (in progress)
- We are following the phased approach from `PLAYBOOK.md`:
  - Currently in **Phase 0** safety cleanup
  - Goal: Make the hub safe and human-gated first, then gradually add proper triads + shadow mode later

**Key Files (Single Source of Truth set):**
- `PLAYBOOK.md` — The full master architecture and build rules
- `SOURCE_OF_TRUTH.md` — This file (living status + decisions)
- `AEHub_Build_Roadmap.md` — Visual phased roadmap
- `STATE.md` — (Create this next if it doesn’t exist) — short “what’s built / what’s next” tracker

---

## 3. What We Are Doing Right Now

**Immediate Goal:** Turn the hub into a **safe, human-gated tool** you can actually use today.

We are **not** ripping everything out. We are:
1. Disabling automatic/scheduled agent runs (so nothing happens without you)
2. Keeping all manual chat and tool use working normally
3. Adding proper provenance + confidence requirements over time
4. Following one small, safe change at a time

**Current Task (in progress):**
- Commenting out the Schedules + Auto-Run sections in `agent-hub.ts`
- This stops background automation while leaving normal chat fully functional

---

## 4. How to Use This Hub Safely Right Now

- You can still chat with Anetta, Sharon, Dolly, Geoffrey, etc.
- Agents can still read data and draft things
- **Nothing should run automatically** after the current safety edit
- Any action that creates/updates real data should go through you for approval (we are enforcing this)

---

## 5. Next Small Steps (do these one at a time)

1. Finish commenting out the auto-run code in `agent-hub.ts` (we are on this)
2. Create `STATE.md` (short living tracker)
3. Test that manual chat still works after the change
4. Push the safety changes to GitHub
5. Decide the next bounded improvement (user-friendliness, navigation, or adding provenance to outputs)

---

## 6. Important Notes

- Do **not** try to run the full server until we finish the safety cleanup (it has been causing long delays).
- All future work must reference `PLAYBOOK.md` at the start of every session.
- This `SOURCE_OF_TRUTH.md` file is the single place to check current status and decisions.

---

**This file is the living Single Source of Truth.**  
Update it at the end of every work session.

Next action: Finish the current safety edit in `agent-hub.ts`.