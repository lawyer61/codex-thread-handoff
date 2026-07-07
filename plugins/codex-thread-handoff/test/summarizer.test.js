import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderInitialHandoff } from "../src/handoff.js";
import { applySummarizerOutput } from "../src/summarizer.js";

function validHandoff(marker) {
  return `${renderInitialHandoff({
    logical_thread_id: "lt_test",
    context_epoch: 1
  }, {
    project: "example",
    repo_root: "/repo"
  })}\n\n${marker}\n`;
}

async function seed(root, handoff) {
  const projectDir = join(root, "codex-thread-handoff", "projects", "preseed");
  const threadDir = join(projectDir, "threads", "lt_test");
  await mkdir(threadDir, { recursive: true });
  await writeFile(join(projectDir, "active_thread"), "lt_test\n");
  await writeFile(join(threadDir, "latest.md"), handoff);
  await writeFile(join(threadDir, "state.json"), JSON.stringify({
    schema_version: 1,
    logical_thread_id: "lt_test",
    project_hash: "preseed",
    repo_root: "/repo",
    context_epoch: 1,
    handoff: {
      latest_path: "latest.md",
      inject_path: "latest.inject.md",
      last_model_written_at: "2026-07-07T00:00:00.000Z",
      last_event_seq: 10,
      last_summary_priority: 2,
      last_summary_trigger: "precompact",
      freshness: "fresh"
    }
  }));

  return {
    threadDir,
    statePath: join(threadDir, "state.json"),
    latestPath: join(threadDir, "latest.md"),
    injectPath: join(threadDir, "latest.inject.md"),
    eventsPath: join(threadDir, "events.jsonl")
  };
}

test("a stale Stop summarizer result cannot overwrite a PreCompact result for the same event seq", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-summarizer-"));

  try {
    const paths = await seed(root, validHandoff("PreCompact result"));

    const result = await applySummarizerOutput(paths, {
      job_id: "job_stop",
      trigger: "stop",
      priority: 1,
      input_event_seq_max: 10,
      started_at: "2026-07-07T00:00:01.000Z"
    }, {
      latest_md: validHandoff("Late Stop result"),
      confidence: "high",
      source_event_seq: 10,
      warnings: []
    }, {
      redactSecrets: true,
      injectBudgetTokens: 6000
    });

    assert.deepEqual(result, {
      written: false,
      reason: "covered_by_newer_or_higher_priority_handoff"
    });
    assert.match(await readFile(paths.latestPath, "utf8"), /PreCompact result/);
    assert.doesNotMatch(await readFile(paths.latestPath, "utf8"), /Late Stop result/);
    assert.match(await readFile(paths.eventsPath, "utf8"), /summary_job_discarded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first Stop summarizer result can write even when no source events exist yet", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-summarizer-first-"));

  try {
    const paths = await seed(root, validHandoff("Bootstrap"));
    await writeFile(paths.statePath, JSON.stringify({
      schema_version: 1,
      logical_thread_id: "lt_test",
      project_hash: "preseed",
      repo_root: "/repo",
      context_epoch: 1,
      handoff: {
        latest_path: "latest.md",
        inject_path: "latest.inject.md",
        last_model_written_at: null,
        last_event_seq: 0,
        freshness: "missing"
      }
    }));

    const result = await applySummarizerOutput(paths, {
      job_id: "job_stop_first",
      trigger: "stop",
      priority: 1,
      input_event_seq_max: 0,
      started_at: "2026-07-07T00:00:01.000Z"
    }, {
      latest_md: validHandoff("First Stop result"),
      confidence: "medium",
      source_event_seq: 0,
      warnings: []
    }, {
      redactSecrets: true,
      injectBudgetTokens: 6000
    });

    assert.deepEqual(result, { written: true, source_event_seq: 0 });
    assert.match(await readFile(paths.latestPath, "utf8"), /First Stop result/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
