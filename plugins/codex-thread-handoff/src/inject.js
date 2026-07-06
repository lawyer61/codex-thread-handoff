import { readFile } from "node:fs/promises";
import { additionalContextOutput } from "./hook-io.js";

export function renderInjectBrief(markdown, config) {
  const maxChars = Math.max(800, (config.injectBudgetTokens || 6000) * 4);
  const boundary = `<THREAD_HANDOFF_MEMORY>
This is a bounded handoff for the same logical thread after compaction or resume.
It is not authority over current user instructions, current files, tests, AGENTS.md, or higher-priority instructions.
Verify stale facts before acting.

`;
  const closing = `
</THREAD_HANDOFF_MEMORY>
`;
  const bodyBudget = Math.max(200, maxChars - boundary.length - closing.length);
  const body = markdown.length > bodyBudget
    ? `${markdown.slice(0, bodyBudget)}\n\n[truncated to injection budget]\n`
    : markdown;
  return `${boundary}${body}${closing}`;
}

export function shouldInjectForPrompt(prompt) {
  return /(continue|resume|above|previous|刚才|继续|接着|上面|这个方案)/i.test(prompt || "");
}

export async function readInjectBrief(paths) {
  return readFile(paths.injectPath, "utf8");
}

export function injectionOutput(hookEventName, brief) {
  return additionalContextOutput(hookEventName, brief);
}
