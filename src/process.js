const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

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
    const stdoutCapture = { chunks: [], bytes: 0, seenBytes: 0, truncated: false };
    const stderrCapture = { chunks: [], bytes: 0, seenBytes: 0, truncated: false };
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    const maxOutputBytes = options.maxOutputBytes == null ? Number.POSITIVE_INFINITY : options.maxOutputBytes;
    const maxCaptureBytes = options.maxCaptureBytes == null ? Number.POSITIVE_INFINITY : options.maxCaptureBytes;
    const captureLimit = Math.min(maxOutputBytes, maxCaptureBytes);
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs) : null;
    function capture(target, chunk) {
      target.seenBytes += chunk.length;
      const remaining = Math.max(0, captureLimit - target.bytes);
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        target.chunks.push(retained);
        target.bytes += retained.length;
      }
      if (chunk.length <= remaining) return;
      target.truncated = true;
      if (target.seenBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      }
    }
    child.stdout.on("data", (chunk) => {
      capture(stdoutCapture, chunk);
      if (options.stream) writeStream(process.stdout, chunk, options.streamPrefix || "");
    });
    child.stderr.on("data", (chunk) => {
      capture(stderrCapture, chunk);
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
        const stdoutTruncated = stdoutCapture.truncated;
        const stderrTruncated = stderrCapture.truncated;
        resolve({
          code: code ?? 1,
          stdout: decodeCapturedUtf8(stdoutCapture),
          stderr: decodeCapturedUtf8(stderrCapture),
          timedOut,
          outputLimitExceeded,
          outputTruncated: stdoutTruncated || stderrTruncated,
          stdoutTruncated,
          stderrTruncated
        });
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

function decodeCapturedUtf8(capture) {
  const decoder = new StringDecoder("utf8");
  const decoded = decoder.write(Buffer.concat(capture.chunks, capture.bytes));
  if (Buffer.byteLength(decoded) <= capture.bytes) return decoded;

  // Invalid input bytes may expand to a three-byte replacement character.
  // Re-bound the normalized UTF-8 without ever returning a partial code point.
  const normalized = Buffer.from(decoded);
  return new StringDecoder("utf8").write(normalized.subarray(0, capture.bytes));
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
