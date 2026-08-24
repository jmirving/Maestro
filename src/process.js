const { spawn } = require("node:child_process");

function writeStream(target, chunk, prefix) {
  if (!target) return;
  const text = chunk.toString();
  if (!prefix) {
    target.write(text);
    return;
  }
  for (const part of text.split(/(?<=\n)/)) {
    if (!part) continue;
    target.write(`${prefix}${part}`);
  }
}

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.stream) writeStream(process.stdout, chunk, options.streamPrefix || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.stream) writeStream(process.stderr, chunk, options.streamPrefix || "");
    });
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
