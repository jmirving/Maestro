const { spawn } = require("node:child_process");

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input != null) {
      child.stdin.end(options.input);
    }
  });
}

async function runChecked(command, args = [], options = {}) {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed with exit ${result.code}`);
    error.result = result;
    throw error;
  }
  return result;
}

function runShell(script, options = {}) {
  return runProcess("bash", ["-lc", script], options);
}

async function runShellChecked(script, options = {}) {
  const result = await runShell(script, options);
  if (result.code !== 0) {
    const error = new Error(`preflight failed: ${script}`);
    error.result = result;
    throw error;
  }
  return result;
}

module.exports = { runProcess, runChecked, runShell, runShellChecked };
