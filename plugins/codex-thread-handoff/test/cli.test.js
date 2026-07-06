import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

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
