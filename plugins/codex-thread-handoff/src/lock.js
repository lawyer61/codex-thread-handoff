import { mkdir, rm, stat } from "node:fs/promises";

export async function withLock(lockDir, fn, options = {}) {
  const staleAfterMs = options.staleAfterMs || 30_000;

  try {
    await mkdir(lockDir, { recursive: false });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs < staleAfterMs) {
      throw error;
    }

    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir, { recursive: false });
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
