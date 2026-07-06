import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { renderInitialHandoff } from "../src/handoff.js";

async function seed(root, freshness = "fresh") {
  const projectDir = join(root, "codex-thread-handoff", "projects", "preseed");
  const threadDir = join(projectDir, "threads", "lt_test");
  await mkdir(threadDir, { recursive: true });
  await writeFile(join(projectDir, "active_thread"), "lt_test\n");
  await writeFile(join(threadDir, "state.json"), JSON.stringify({
    schema_version: 1,
    logical_thread_id: "lt_test",
    project_hash: "preseed",
    repo_root: "/repo",
    context_epoch: 1,
    handoff: { freshness, last_model_written_at: new Date().toISOString() }
  }));
  await writeFile(join(threadDir, "latest.md"), renderInitialHandoff({
    logical_thread_id: "lt_test",
    context_epoch: 1
  }, {
    project: "example",
    repo_root: "/repo"
  }));
  return threadDir;
}

test("PreCompact strict blocks when handoff is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-precompact-"));

  try {
    const result = await runCli(["pre-compact"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_MODE: "strict"
    });
    const output = JSON.parse(result.stdout);

    assert.equal(output.continue, false);
    assert.match(output.stopReason, /No fresh thread handoff exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PreCompact writes a snapshot and allows fresh handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-precompact-fresh-"));

  try {
    const threadDir = await seed(root);
    const result = await runCli(["pre-compact"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_MODE: "strict"
    });

    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    const snapshots = await readdir(join(threadDir, "snapshots"));
    assert.equal(snapshots.length, 1);
    assert.match(await readFile(join(threadDir, "latest.inject.md"), "utf8"), /THREAD_HANDOFF_MEMORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostCompact advances the context epoch and records a boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-postcompact-"));

  try {
    const threadDir = await seed(root);
    const result = await runCli(["post-compact"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed",
      trigger: "manual"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.context_epoch, 2);
    assert.match(await readFile(join(threadDir, "events.jsonl"), "utf8"), /compact_boundary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
