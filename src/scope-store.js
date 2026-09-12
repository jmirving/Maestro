const fs = require("node:fs/promises");
const path = require("node:path");
const { reportRootForRepo } = require("./reporter");
const { validateWorksetName } = require("./worksets");

function scopePath(repoPath, name) {
  return path.join(reportRootForRepo(repoPath), `scope-${validateWorksetName(name)}.json`);
}

async function loadScopeSnapshot(repoPath, name) {
  try {
    return JSON.parse(await fs.readFile(scopePath(repoPath, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveScopeSnapshot(repoPath, name, snapshot) {
  const file = scopePath(repoPath, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return file;
}

module.exports = { scopePath, loadScopeSnapshot, saveScopeSnapshot };
