const fs = require("node:fs/promises");
const path = require("node:path");
const { reportRootForRepo } = require("./reporter");

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRepositoryCoordination(repoPath, operation, {
  retryMs = LOCK_RETRY_MS,
  timeoutMs = LOCK_TIMEOUT_MS
} = {}) {
  const root = reportRootForRepo(repoPath);
  const lock = path.join(root, ".coordination.lock");
  await fs.mkdir(root, { recursive: true });
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await fs.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number((await fs.readFile(lock, "utf8")).trim());
        if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
      } catch (ownerError) {
        if (ownerError.code === "ESRCH") {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Maestro's repository coordination lock at ${lock}.`);
      }
      await sleep(retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

module.exports = { withRepositoryCoordination };
