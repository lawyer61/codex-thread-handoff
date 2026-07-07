import { mkdir, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export async function withLock(lockDir, fn, options = {}) {
  const staleAfterMs = options.staleAfterMs || 30_000;
  const waitTimeoutMs = options.waitTimeoutMs || options.timeoutMs || 5_000;
  const retryDelayMs = options.retryDelayMs || 25;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      let stale = false;
      try {
        const info = await stat(lockDir);
        stale = Date.now() - info.mtimeMs >= staleAfterMs;
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }

      if (stale) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= waitTimeoutMs) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
