const { runShell } = require("./process");

async function captureBaseline(config, { cwd, runner = runShell } = {}) {
  const baseline = config.baseline || {};
  const commands = baseline.commands || config.integration?.commands || [];
  if (!commands.length) return { enabled: false, allowFailing: false, commands: [], results: [], passing: true };

  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    console.error(`[Maestro] baseline ${index + 1}/${commands.length}: ${command}`);
    const result = await runner(command, {
      cwd,
      stream: true,
      streamPrefix: `[baseline:${index + 1}/${commands.length}] `
    });
    results.push({ command, code: result.code, stdout: result.stdout, stderr: result.stderr });
    console.error(`[Maestro] baseline ${index + 1}/${commands.length} ${result.code === 0 ? "passed" : "failed"}`);
  }
  const passing = results.every((entry) => entry.code === 0);
  const allowFailing = baseline.allowFailing === true;
  if (!passing && !allowFailing) {
    const error = new Error("Target repository baseline is failing. Set baseline.allowFailing=true only when you intentionally want Maestro to continue against a known failing baseline.");
    error.code = "BASELINE_FAILED";
    error.baseline = { enabled: true, allowFailing, commands, results, passing };
    throw error;
  }
  return { enabled: true, allowFailing, commands, results, passing };
}

function summarizeBaseline(baseline) {
  if (!baseline?.enabled) return "No baseline suite configured.";
  return baseline.results.map((entry) => {
    const state = entry.code === 0 ? "PASS" : "FAIL";
    return `${state}: ${entry.command}\n${entry.stdout || ""}${entry.stderr || ""}`.trim();
  }).join("\n\n");
}

module.exports = { captureBaseline, summarizeBaseline };
