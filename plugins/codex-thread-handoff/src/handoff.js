import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const requiredHandoffSections = [
  "## 0. How to use this handoff",
  "## 1. Mission / Definition of Done",
  "## 2. User requirements and constraints",
  "## 3. Current working state",
  "## 4. Decisions already made",
  "## 5. Files explored",
  "## 6. Files changed",
  "## 7. Commands and tool results",
  "## 8. Open loops",
  "## 9. Next actions",
  "## 10. Retrieval handles",
  "## 11. Known risks / stale facts"
];

export function validateHandoff(markdown) {
  const missingSections = requiredHandoffSections.filter((section) => !markdown.includes(section));
  return {
    ok: missingSections.length === 0,
    missingSections
  };
}

export function renderInitialHandoff(state, project) {
  const now = new Date().toISOString();
  return `---
schema_version: 1
logical_thread_id: ${state.logical_thread_id}
project: ${project.project}
repo_root: ${project.repo_root}
context_epoch: ${state.context_epoch}
last_updated: ${now}
confidence: medium
budget_target_tokens: 6000
---

# Thread Handoff

## 0. How to use this handoff

You are continuing the same logical task after context compaction.
Treat this file as lossy but high-priority working memory.
Current user instructions, current files, tests, AGENTS.md, and higher-priority instructions override this file.
If a fact may be stale, verify it.

## 1. Mission / Definition of Done

- User wants: Maintain a logical-thread handoff for the current Codex task.
- Done means: The next context epoch can continue without re-exploring summarized core state.
- Explicit non-goals: Long-term memory, vector database, cloud sync, automatic /compact.

## 2. User requirements and constraints

- Must: Preserve hard constraints, current state, validations, failures, risks, and next actions.
- Must not: Treat handoff memory as authority over current instructions or files.
- Preferences: Keep injected context bounded.
- Safety/privacy constraints: Redact secrets before persistence or injection.

## 3. Current working state

- Current phase: initialized
- Last completed step: handoff file created
- Last failed/blocking step: none recorded
- Current hypothesis: hook events can maintain enough state for compaction recovery
- Before compaction, the intended next step was: inspect latest events and continue the task

## 4. Decisions already made

| Decision | Reason | Evidence |
|---|---|---|
| Handoff is working memory, not authority | Prevent stale memory from overriding current truth | ADR-001 |

## 5. Files explored

| File | What was learned | Checked at | Staleness |
|---|---|---|---|

## 6. Files changed

| File | Change | Validation |
|---|---|---|

## 7. Commands and tool results

| Command/tool | Result | Notes |
|---|---|---|

## 8. Open loops

- [ ] Keep this handoff fresh after meaningful user requirements, file changes, test results, or decisions.

## 9. Next actions

1. Review current user prompt and repository state.
2. Verify any stale file or test fact before acting.
3. Continue the original task from the latest validated state.

## 10. Retrieval handles

- Use ctx only if detail is needed: \`ctx search --term "logical thread" --term "handoff"\`

## 11. Known risks / stale facts

- Initial handoff contains only bootstrap state.
`;
}

export function isHandoffStale(state, config, now = new Date()) {
  if (!state.handoff || state.handoff.freshness !== "fresh") return true;
  if (!state.handoff.last_model_written_at) return true;
  const writtenAt = new Date(state.handoff.last_model_written_at);
  if (Number.isNaN(writtenAt.getTime())) return true;
  const ageMs = now.getTime() - writtenAt.getTime();
  return ageMs > config.handoffStaleAfterMinutes * 60 * 1000;
}

export async function reconcileHandoffFreshness(paths, state, config, now = new Date()) {
  const latestPath = paths.latestPath || join(paths.threadDir, "latest.md");
  const latest = await readLatestHandoff(paths);
  const validation = validateHandoff(latest);

  if (!validation.ok) {
    return { state, latest, validation, fresh: false };
  }

  const info = await stat(latestPath);
  const modifiedAt = info.mtime;
  const ageMs = now.getTime() - modifiedAt.getTime();
  const fresh = ageMs <= config.handoffStaleAfterMinutes * 60 * 1000;

  return {
    state: {
      ...state,
      last_updated_at: now.toISOString(),
      handoff: {
        ...(state.handoff || {}),
        latest_path: state.handoff?.latest_path || "latest.md",
        inject_path: state.handoff?.inject_path || "latest.inject.md",
        last_model_written_at: modifiedAt.toISOString(),
        freshness: fresh ? "fresh" : "stale"
      }
    },
    latest,
    validation,
    fresh
  };
}

export async function readLatestHandoff(paths) {
  return readFile(paths.latestPath || join(paths.threadDir, "latest.md"), "utf8");
}

export async function snapshotHandoff(paths, timestamp = new Date().toISOString()) {
  const snapshotsDir = paths.snapshotsDir || join(paths.threadDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  const safeTime = timestamp.replaceAll(":", "-");
  await copyFile(
    paths.latestPath || join(paths.threadDir, "latest.md"),
    join(snapshotsDir, `${safeTime}-precompact.md`)
  );
}
