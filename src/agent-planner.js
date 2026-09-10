const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv2020 = require("ajv/dist/2020");
const { runProcess } = require("./process");
const agentOutputSchema = require("../schemas/agent-planning-output.schema.json");

const validateOutput = new Ajv2020({ allErrors: true, strict: false }).compile(agentOutputSchema);

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateAgentOutput(output) {
  if (validateOutput(output)) return output;
  const details = (validateOutput.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
  throw new Error(`Agent planner output does not match the structured-output schema: ${details}`);
}

async function trackedFiles(repoPath, runner) {
  const result = await runner("git", ["ls-files", "-z"], { cwd: repoPath, maxOutputBytes: 1024 * 1024 });
  if (result.code !== 0) throw new Error(`Cannot assemble agent planning context: git ls-files failed with exit ${result.code}.`);
  return result.stdout.split("\0").filter(Boolean).sort();
}

function contextFilePriority(file) {
  if (file === "AGENTS.md") return 0;
  if (file === "README.md") return 1;
  if (file.startsWith("docs/") && file.endsWith(".md")) return 2;
  if (file === "package.json" || file.startsWith("schemas/")) return 3;
  if (file.startsWith("src/") && /\.(js|ts|json)$/.test(file)) return 4;
  return 99;
}

async function assembleAgentContext({ repoPath, repository, issues, manifest, deterministicFindings, runner = runProcess, maxBytes = 96 * 1024, maxFiles = 500, maxIssues = 200, maxIssueBytes = 64 * 1024 }) {
  const allFiles = await trackedFiles(repoPath, runner);
  const tree = allFiles.slice(0, maxFiles);
  const candidates = allFiles.filter((file) => contextFilePriority(file) < 99)
    .sort((left, right) => contextFilePriority(left) - contextFilePriority(right) || left.localeCompare(right));
  const uniqueIssues = new Map();
  for (const issue of issues) {
    if (Number.isSafeInteger(issue?.number) && issue.number > 0 && !uniqueIssues.has(String(issue.number))) uniqueIssues.set(String(issue.number), issue);
  }
  const orderedIssues = [...uniqueIssues.values()].sort((left, right) => left.number - right.number);
  if (orderedIssues.length > maxIssues) {
    throw new Error(`Agent planning context has ${orderedIssues.length} issues; select at most ${maxIssues} issues per invocation.`);
  }
  const bodyLimit = Math.max(0, Math.floor(maxIssueBytes / Math.max(1, orderedIssues.length)));
  const context = {
    version: 1,
    repository,
    policy: {
      advisoryOnly: true,
      deterministicTruthWins: true,
      highConfidenceRequiredForHardDependencies: true,
      lowConfidenceRemainsUnresolved: true
    },
    issues: orderedIssues.map((issue) => ({
      number: issue.number,
      state: issue.state,
      title: String(issue.title || "").slice(0, 500),
      body: String(issue.body || "").slice(0, Math.min(16000, bodyLimit)),
      labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean).slice(0, 50)
    })),
    manifest,
    deterministicFindings,
    repositoryTree: tree,
    files: []
  };
  const promptSize = () => Buffer.byteLength(`${plannerPrompt(context)}\n`);
  const fixedBytes = promptSize();
  if (fixedBytes > maxBytes) {
    throw new Error(`Agent planning context requires ${fixedBytes} bytes before repository excerpts; the aggregate limit is ${maxBytes} bytes. Select fewer issues or reduce the manifest.`);
  }

  for (const relativePath of candidates) {
    if (context.files.length >= maxFiles) break;
    const absolutePath = path.resolve(repoPath, relativePath);
    if (!absolutePath.startsWith(`${path.resolve(repoPath)}${path.sep}`)) continue;
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const raw = await fs.readFile(absolutePath);
    const content = raw.toString("utf8");
    const entry = { path: relativePath, sha256: digest(raw), truncated: false, content };
    context.files.push(entry);
    if (promptSize() <= maxBytes) continue;

    entry.truncated = true;
    let low = 0;
    let high = content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      entry.content = content.slice(0, middle);
      if (promptSize() <= maxBytes) low = middle;
      else high = middle - 1;
    }
    entry.content = content.slice(0, low);
    if (promptSize() > maxBytes) context.files.pop();
    break;
  }
  const serialized = JSON.stringify(context);
  return { context, digest: digest(serialized), files: context.files.map(({ path: file, sha256, truncated }) => ({ path: file, sha256, truncated })) };
}

function plannerPrompt(context) {
  return `You are a bounded planning analyzer. Do not execute work or modify any repository or provider. Analyze only the supplied JSON context. Return exactly one JSON object, without Markdown, matching this contract:\n${JSON.stringify(agentOutputSchema)}\n\nPlanning context:\n${JSON.stringify(context)}`;
}

async function invokeAgentPlanner({ contextBundle, runner = runProcess, command = "codex", timeoutMs = 120000, retries = 1, maxOutputBytes = 256 * 1024 }) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-agent-plan-"));
    const outputPath = path.join(tempDir, "output.json");
    const schemaPath = path.join(tempDir, "output-schema.json");
    try {
      await fs.writeFile(schemaPath, JSON.stringify(agentOutputSchema), "utf8");
      const result = await runner(command, [
        "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--config", "shell_environment_policy.inherit=none",
        "--config", "mcp_servers={}",
        "--config", "hooks={}",
        "--config", "apps._default.enabled=false",
        "--config", "tools.web_search=false",
        "--config", "features.shell_tool=false",
        "--output-schema", schemaPath, "--output-last-message", outputPath, "-"
      ], {
        cwd: tempDir,
        input: `${plannerPrompt(contextBundle.context)}\n`,
        timeoutMs,
        maxOutputBytes
      });
      if (result.timedOut) throw new Error(`Agent planner timed out after ${timeoutMs}ms.`);
      if (result.outputLimitExceeded) throw new Error(`Agent planner exceeded the ${maxOutputBytes}-byte process output limit.`);
      if (result.code !== 0) throw new Error(`Agent planner command failed with exit ${result.code}: ${(result.stderr || result.stdout || "no diagnostics").trim().slice(-2000)}`);
      let raw;
      try { raw = await fs.readFile(outputPath, "utf8"); } catch { raw = result.stdout; }
      if (Buffer.byteLength(raw) > maxOutputBytes) throw new Error(`Agent planner response exceeded the ${maxOutputBytes}-byte structured-output limit.`);
      let output;
      try { output = JSON.parse(raw); } catch { throw new Error("Agent planner returned invalid JSON."); }
      validateAgentOutput(output);
      return {
        output,
        metadata: {
          analyzer: "agent",
          provider: path.basename(command),
          contextDigest: contextBundle.digest,
          outputDigest: digest(JSON.stringify(output)),
          attempts: attempt,
          issueIds: contextBundle.context.issues.map((issue) => String(issue.number)),
          files: contextBundle.files
        }
      };
    } catch (error) {
      lastError = error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
  throw new Error(`Agent-assisted planning failed after ${retries + 1} attempt(s) for context ${contextBundle.digest.slice(0, 12)}: ${lastError.message}`);
}

function createAgentPlanner(options = {}) {
  return {
    name: "agent",
    async analyze(input) {
      const contextBundle = await assembleAgentContext({ ...input, runner: options.contextRunner || options.runner || runProcess, maxBytes: options.maxContextBytes, maxFiles: options.maxContextFiles, maxIssues: options.maxIssues, maxIssueBytes: options.maxIssueBytes });
      return invokeAgentPlanner({ contextBundle, runner: options.runner || runProcess, command: options.command, timeoutMs: options.timeoutMs, retries: options.retries, maxOutputBytes: options.maxOutputBytes });
    }
  };
}

module.exports = { agentOutputSchema, validateAgentOutput, assembleAgentContext, invokeAgentPlanner, createAgentPlanner, plannerPrompt };
