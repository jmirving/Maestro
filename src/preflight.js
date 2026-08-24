const { runShellChecked } = require("./process");

function requiredCapabilities(items = []) {
  return [...new Set(items.flatMap((item) => item.requires || []))];
}

function describePreflights(config, items) {
  return requiredCapabilities(items).map((name) => ({
    name,
    definition: config.capabilities?.[name] || {},
    command: config.capabilities?.[name]?.preflight || null
  }));
}

async function runPreflights(config, items, { cwd, runner = runShellChecked } = {}) {
  const results = [];
  for (const entry of describePreflights(config, items)) {
    if (!entry.command) {
      results.push({ capability: entry.name, status: "available-no-command" });
      continue;
    }
    try {
      const result = await runner(entry.command, { cwd });
      results.push({ capability: entry.name, status: "passed", stdout: result.stdout.trim() });
    } catch (error) {
      results.push({ capability: entry.name, status: "failed", stderr: error.result?.stderr?.trim() || error.message });
      if (entry.definition.required !== false) {
        const failure = new Error(`Required capability '${entry.name}' failed preflight.`);
        failure.capability = entry.name;
        failure.results = results;
        throw failure;
      }
    }
  }
  return results;
}

module.exports = { requiredCapabilities, describePreflights, runPreflights };
