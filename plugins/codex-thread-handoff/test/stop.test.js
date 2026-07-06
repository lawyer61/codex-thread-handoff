import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

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
