import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("doctor --json returns a machine-readable status envelope", async () => {
  const result = await runCli(["doctor", "--json"], "", {
    PLUGIN_DATA: "/tmp/thread-handoff-test",
    PLUGIN_ROOT: "/tmp/plugin-root"
  });

  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(result.stderr, "");
});

test("unknown command returns usage and exit code 2", async () => {
  const result = await runCli(["not-a-command"], "", {});

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: thread-handoff/);
});

test("bin hook failures exit successfully and write diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-bin-hook-error-"));
  const pluginDataFile = join(root, "plugin-data");

  try {
    await writeFile(pluginDataFile, "not a directory\n");

    const result = spawnSync(process.execPath, [
      join(__dirname, "..", "bin", "thread-handoff.js"),
      "user-prompt-submit"
    ], {
      input: JSON.stringify({
        cwd: root,
        session_id: "session-1",
        prompt: "continue"
      }),
      env: {
        ...process.env,
        PLUGIN_DATA: pluginDataFile
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "{}\n");
    assert.match(result.stderr, /thread-handoff hook failed; see /);

    const errors = await readFile(join(root, ".thread-handoff", "hook-errors.jsonl"), "utf8");
    assert.match(errors, /user-prompt-submit/);
    assert.match(errors, /ENOTDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
