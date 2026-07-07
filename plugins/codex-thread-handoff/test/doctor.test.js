import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { buildCtxHandles } from "../src/ctx-handles.js";

test("buildCtxHandles creates file-specific ctx searches", () => {
  const handles = buildCtxHandles([
    {
      type: "tool_observation",
      tool_response_summary: "Failed parser null case",
      files_touched: ["src/parser.js", "test/parser.test.js"]
    }
  ]);

  assert.ok(handles.includes('ctx search --file src/parser.js --term "Failed" --term "parser"'));
});

test("doctor --json reports config and storage", async () => {
  const result = await runCli(["doctor", "--json"], "", {
    PLUGIN_DATA: "/tmp/thread-handoff-doctor",
    PLUGIN_ROOT: "/tmp/plugin-root"
  });

  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.config.mode, "strict");
  assert.equal(report.storage.root, "/tmp/thread-handoff-doctor/codex-thread-handoff");
  assert.equal(report.diagnostics.hookErrorPaths[0], "/tmp/thread-handoff-doctor/codex-thread-handoff/hook-errors.jsonl");
});

test("doctor --json reports project-local fallback when .codex is a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-doctor-dot-codex-"));

  try {
    await writeFile(join(root, ".codex"), "not a directory\n");

    const result = await runCli(["doctor", "--json"], JSON.stringify({
      cwd: root
    }), {
      THREAD_HANDOFF_PROJECT_LOCAL: "true"
    });

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.storage.root, join(root, ".thread-handoff"));
    assert.ok(report.diagnostics.hookErrorPaths.includes(join(root, ".thread-handoff", "hook-errors.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
