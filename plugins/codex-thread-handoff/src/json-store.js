import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withLock } from "./lock.js";

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withLock(`${path}.lock`, async () => {
    await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  });
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await withLock(`${path}.lock`, async () => {
    await rename(tmp, path);
  });
}

export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await withLock(`${path}.lock`, async () => {
    await rename(tmp, path);
  });
}
