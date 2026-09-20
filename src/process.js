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
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const maxOutputBytes = options.maxOutputBytes == null ? Number.POSITIVE_INFINITY : options.maxOutputBytes;
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs) : null;
    function capture(current, chunk) {
      const next = current + chunk;
      if (Buffer.byteLength(next) <= maxOutputBytes) return next;
      outputLimitExceeded = true;
      child.kill("SIGKILL");
      return next.slice(0, maxOutputBytes);
    }
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk.toString());
      if (options.stream) writeStream(process.stdout, chunk, options.streamPrefix || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk.toString());
      if (options.stream) writeStream(process.stderr, chunk, options.streamPrefix || "");
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout, stderr, timedOut, outputLimitExceeded });
      }
    });
    if (options.input != null && child.stdin) {
      child.stdin.on("error", (error) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
        if (timeout) clearTimeout(timeout);
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(error);
        }
      });
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
