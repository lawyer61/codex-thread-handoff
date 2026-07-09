import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { renderInitialHandoff } from "../src/handoff.js";

test("Stop does not schedule a summarizer by default when the handoff is stale", async () => {
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
      OPENAI_API_KEY: "test-key",
      THREAD_HANDOFF_SUMMARIZER_BASE_URL: "http://127.0.0.1:9/v1",
      THREAD_HANDOFF_SUMMARIZER_BACKGROUND_SPAWN: "false"
    });

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});

    await assert.rejects(
      () => readFile(join(threadDir, "events.jsonl"), "utf8"),
      (error) => error.code === "ENOENT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop records a background summarizer job when enabled and the API key is configured", async () => {
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
    }), {
      PLUGIN_DATA: root,
      OPENAI_API_KEY: "test-key",
      THREAD_HANDOFF_SUMMARIZER_BASE_URL: "http://127.0.0.1:9/v1",
      THREAD_HANDOFF_STOP_SUMMARIZER_ENABLED: "true",
      THREAD_HANDOFF_SUMMARIZER_BACKGROUND_SPAWN: "false"
    });

    assert.deepEqual(JSON.parse(result.stdout), {});
    const events = await readFile(join(threadDir, "events.jsonl"), "utf8");
    assert.match(events, /summary_job_scheduled/);
    assert.match(events, /"trigger":"stop"/);
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
