import assert from "node:assert/strict";
import test from "node:test";
import { renderInitialHandoff, validateHandoff } from "../src/handoff.js";
import { renderInjectBrief } from "../src/inject.js";

test("initial canonical handoff contains every required section", () => {
  const markdown = renderInitialHandoff({
    logical_thread_id: "lt_test",
    context_epoch: 1
  }, {
    project: "example",
    repo_root: "/repo"
  });

  const validation = validateHandoff(markdown);
  assert.equal(validation.ok, true);
  assert.equal(validation.missingSections.length, 0);
  assert.match(markdown, /## 1\. Mission \/ Definition of Done/);
  assert.match(markdown, /## 10\. Retrieval handles/);
});

test("injection brief includes boundary and respects token budget approximation", () => {
  const markdown = renderInitialHandoff({
    logical_thread_id: "lt_test",
    context_epoch: 1
  }, {
    project: "example",
    repo_root: "/repo"
  });
  const brief = renderInjectBrief(markdown, { injectBudgetTokens: 120 });

  assert.match(brief, /<THREAD_HANDOFF_MEMORY>/);
  assert.match(brief, /not authority over current user instructions/);
  assert.ok(brief.length < 900);
});
