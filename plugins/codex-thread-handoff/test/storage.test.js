import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { loadThreadHandoffIgnore } from "../src/ignore.js";
import { appendJsonl, writeJsonAtomic } from "../src/json-store.js";
import { withLock } from "../src/lock.js";
import { redactSecrets } from "../src/redaction.js";

test("appendJsonl writes one JSON object per line", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-store-"));

  try {
    const file = join(root, "events.jsonl");
    await appendJsonl(file, { seq: 1, type: "user_prompt" });
    await appendJsonl(file, { seq: 2, type: "tool_observation" });

    assert.deepEqual(
      (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse),
      [
        { seq: 1, type: "user_prompt" },
        { seq: 2, type: "tool_observation" }
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomic replaces a JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-json-"));

  try {
    const file = join(root, "state.json");
    await writeJsonAtomic(file, { value: 1 });
    await writeJsonAtomic(file, { value: 2 });

    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { value: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withLock waits for an active lock to clear", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-lock-wait-"));

  try {
    const lockDir = join(root, "state.json.lock");
    await mkdir(lockDir);

    const release = sleep(20).then(() => rm(lockDir, { recursive: true, force: true }));
    const result = await withLock(lockDir, async () => "acquired", {
      retryDelayMs: 5,
      waitTimeoutMs: 500
    });
    await release;

    assert.equal(result, "acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactSecrets masks common token shapes", () => {
  const result = redactSecrets("Authorization: Bearer sk-test-1234567890abcdef");

  assert.equal(result.redacted, true);
  assert.match(result.text, /Bearer \[REDACTED:openai_key\]/);
  assert.deepEqual(result.rules, ["openai_key"]);
});

test(".threadhandoffignore filters paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-ignore-"));

  try {
    await writeFile(join(root, ".threadhandoffignore"), "secrets/\n*.pem\n");
    const ignored = await loadThreadHandoffIgnore(root);

    assert.equal(ignored("secrets/app.env"), true);
    assert.equal(ignored("certs/dev.pem"), true);
    assert.equal(ignored("src/app.js"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
