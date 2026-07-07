import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { requiredHandoffSections, renderInitialHandoff } from "../src/handoff.js";

test("Stop requests one continuation when the handoff is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-stop-"));

  try {
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
      handoff: {
        freshness: "stale",
        last_model_written_at: "2026-07-06T00:00:00.000Z"
      }
    }));

    const result = await runCli(["stop"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_STOP_HOOK_CONTINUATION: "true"
    });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /update the thread handoff file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop continuation prompt tells the model to use the canonical handoff schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-stop-schema-"));

  try {
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
      handoff: {
        freshness: "stale",
        last_model_written_at: "2026-07-06T00:00:00.000Z"
      }
    }));

    const result = await runCli(["stop"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), { PLUGIN_DATA: root });

    const output = JSON.parse(result.stdout);
    for (const section of requiredHandoffSections) {
      assert.match(output.reason, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop accepts a freshly written valid handoff even if state was still missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-stop-fresh-file-"));

  try {
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
      handoff: {
        latest_path: "latest.md",
        inject_path: "latest.inject.md",
        last_model_written_at: null,
        last_event_seq: 0,
        freshness: "missing"
      }
    }));
    await writeFile(join(threadDir, "latest.md"), renderInitialHandoff({
      logical_thread_id: "lt_test",
      context_epoch: 1
    }, {
      project: "example",
      repo_root: "/repo"
    }));

    const result = await runCli(["stop"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), { PLUGIN_DATA: root });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});

    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.handoff.freshness, "fresh");
    assert.equal(typeof state.handoff.last_model_written_at, "string");
    assert.match(await readFile(join(threadDir, "latest.inject.md"), "utf8"), /THREAD_HANDOFF_MEMORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
