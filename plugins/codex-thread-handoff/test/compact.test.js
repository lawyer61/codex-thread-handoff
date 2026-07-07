import assert from "node:assert/strict";
import { createServer } from "node:http";
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

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("PreCompact strict allows compaction when handoff is missing and the summarizer is unavailable", async () => {
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

    assert.deepEqual(output, { continue: true });

    const projectRoot = join(root, "codex-thread-handoff", "projects");
    const [projectHash] = await readdir(projectRoot);
    const activeThread = (await readFile(join(projectRoot, projectHash, "active_thread"), "utf8")).trim();
    const events = await readFile(join(projectRoot, projectHash, "threads", activeThread, "events.jsonl"), "utf8");
    assert.match(events, /summary_job_skipped/);
    assert.match(events, /api_key_missing/);
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

test("PreCompact waits for the external summarizer and writes latest artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-precompact-summarizer-"));
  const latest = `${renderInitialHandoff({
    logical_thread_id: "lt_test",
    context_epoch: 1
  }, {
    project: "example",
    repo_root: "/repo"
  })}\n\nSummarized by external API.\n`;

  try {
    const threadDir = await seed(root, "stale");
    await writeFile(join(threadDir, "events.jsonl"), `${JSON.stringify({
      seq: 7,
      type: "user_prompt",
      timestamp: "2026-07-07T00:00:00.000Z",
      prompt_summary: "finish the plugin"
    })}\n`);

    let requestBody;
    await withServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestBody = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                latest_md: latest,
                confidence: "high",
                source_event_seq: 7,
                warnings: []
              })
            }
          }]
        }));
      });
    }, async (baseUrl) => {
      const result = await runCli(["pre-compact"], JSON.stringify({
        cwd: "/repo",
        project_hash_override: "preseed",
        trigger: "manual"
      }), {
        PLUGIN_DATA: root,
        THREAD_HANDOFF_MODE: "strict",
        THREAD_HANDOFF_SUMMARIZER_BASE_URL: baseUrl,
        OPENAI_API_KEY: "test-key"
      });

      assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    });

    assert.equal(requestBody.model, "gpt-5.4");
    assert.match(JSON.stringify(requestBody.messages), /finish the plugin/);
    assert.match(await readFile(join(threadDir, "latest.md"), "utf8"), /Summarized by external API/);
    assert.match(await readFile(join(threadDir, "latest.inject.md"), "utf8"), /THREAD_HANDOFF_MEMORY/);

    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.handoff.last_event_seq, 7);
    assert.equal(state.handoff.freshness, "fresh");
    assert.equal(state.handoff.last_summary_trigger, "precompact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PreCompact accepts a valid handoff file when freshness metadata was not updated yet", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-handoff-precompact-filefresh-"));

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

    const result = await runCli(["pre-compact"], JSON.stringify({
      cwd: "/repo",
      project_hash_override: "preseed"
    }), {
      PLUGIN_DATA: root,
      THREAD_HANDOFF_MODE: "strict"
    });

    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    const state = JSON.parse(await readFile(join(threadDir, "state.json"), "utf8"));
    assert.equal(state.handoff.freshness, "fresh");
    assert.equal(typeof state.handoff.last_model_written_at, "string");
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
