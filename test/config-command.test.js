const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getDefaultConcurrency, setDefaultConcurrency } = require("../src/config-command");

function fixture(config = { repository: "owner/repo", work: { "1": { status: "ready", note: "preserve" } } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-config-test-"));
  const manifestPath = path.join(dir, ".maestro.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(config, null, 2)}\n`);
  return manifestPath;
}

test("config get reports an absent saved value and the fallback", () => {
  const result = getDefaultConcurrency(fixture());
  assert.equal(result.saved, null);
  assert.deepEqual(result.setting, { value: 2, source: "built-in fallback", savedDefault: null });
});

test("config set changes only defaultConcurrency and is idempotent", () => {
  const manifestPath = fixture({
    repository: "owner/repo",
    defaultConcurrency: 2,
    planning: { advisoryConflicts: [] },
    integration: { enabled: false },
    work: { "1": { status: "complete", note: "preserve" }, "2": { status: "ready", blockedBy: ["1"] } }
  });
  const result = setDefaultConcurrency(manifestPath, "4");
  assert.deepEqual(result, { manifestPath, old: 2, next: 4, changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), {
    repository: "owner/repo",
    defaultConcurrency: 4,
    planning: { advisoryConflicts: [] },
    integration: { enabled: false },
    work: { "1": { status: "complete", note: "preserve" }, "2": { status: "ready", blockedBy: ["1"] } }
  });
  let writes = 0;
  assert.equal(setDefaultConcurrency(manifestPath, 4, { writer: () => { writes += 1; } }).changed, false);
  assert.equal(writes, 0);
});

test("invalid, malformed, failed, and concurrent updates leave the current manifest intact", () => {
  const manifestPath = fixture();
  const original = fs.readFileSync(manifestPath, "utf8");
  assert.throws(() => setDefaultConcurrency(manifestPath, "0"), /between 1 and 8/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
  assert.throws(() => setDefaultConcurrency(manifestPath, 4, { writer: () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);

  const concurrent = `${JSON.stringify({ repository: "owner/repo", work: { "1": { status: "complete" } } }, null, 2)}\n`;
  assert.throws(() => setDefaultConcurrency(manifestPath, 4, {
    beforeWrite: () => fs.writeFileSync(manifestPath, concurrent)
  }), /manifest changed.*no changes were written/i);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), concurrent);

  fs.writeFileSync(manifestPath, "{ malformed\n");
  assert.throws(() => setDefaultConcurrency(manifestPath, 4), /Cannot read Maestro manifest/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "{ malformed\n");
});
