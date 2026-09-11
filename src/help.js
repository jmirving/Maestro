const { COMMANDS, COMMAND_BY_NAME, COMMAND_ALIASES, WALKTHROUGH_BY_NAME } = require("./command-registry");

function cliError(message) {
  const error = new Error(message);
  error.code = "CLI_USAGE";
  return error;
}

function normalizeCommand(name) {
  return COMMAND_ALIASES.get(name) || name;
}

function label(command) {
  return `${command.name}${command.aliases?.length ? ` (${command.aliases.join(", ")})` : ""}`;
}

function renderTopLevelHelp() {
  const groups = [];
  for (const command of COMMANDS) {
    let group = groups.find((entry) => entry.name === command.category);
    if (!group) {
      group = { name: command.category, commands: [] };
      groups.push(group);
    }
    group.commands.push(command);
  }
  const sections = groups.map((group) => `${group.name}:
${group.commands.map((command) => `  ${label(command).padEnd(23)} ${command.summary}`).join("\n")}`).join("\n\n");
  return `Maestro — safe, dependency-aware repository agent orchestration

Normal workflow
  draft → plan → start → status/details → rework or approve → commit → next

Workers and validators run in isolated worktrees. Normal start/next never integrate;
validator approval, human approval, and serialized integration are separate gates.
Run maestro status between actions for state-derived next commands.

${sections}

Help and walkthroughs
  maestro help <command>   Command purpose, syntax, state requirements, and examples
  maestro <command> --help Same command guidance; safe outside a configured checkout
  maestro help workflow    Expanded supervised lifecycle and exception paths

Start with: maestro draft (create/refresh scope), maestro plan (preview existing scope),
or maestro status (resume persisted work).`;
}

function formatOptions(command) {
  const entries = Object.entries(command.options || {});
  if (!entries.length) return null;
  const width = Math.max(...entries.map(([name, option]) => `${name}${option.value ? ` ${option.value}` : ""}`.length));
  return entries.map(([name, option]) => {
    const syntax = `${name}${option.value ? ` ${option.value}` : ""}`;
    return `  ${syntax.padEnd(width)}  ${option.description}`;
  }).join("\n");
}

function renderCommandHelp(command) {
  const sections = [
    `maestro ${label(command)} — ${command.summary}`,
    `When to use
  ${command.when}`,
    `Usage
${command.usages.map((usage) => `  ${usage}`).join("\n")}`
  ];
  if (command.positionals) sections.push(`Arguments
  ${command.positionals}`);
  const options = formatOptions(command);
  if (options) sections.push(`Options
${options}`);
  sections.push(`State requirements
  ${command.prerequisites}`);
  sections.push(`State changes
  ${command.effects}`);
  if (command.cautions) sections.push(`Important
  ${command.cautions}`);
  sections.push(`Likely next commands
${command.next.map((next) => `  ${next}`).join("\n")}`);
  sections.push(`Examples
${command.examples.map((args) => `  maestro ${args.join(" ")}`).join("\n")}`);
  return sections.join("\n\n");
}

function resolveHelp(args) {
  if (!args.length || ["-h", "--help"].includes(args[0])) return { requested: true, text: renderTopLevelHelp() };
  if (args[0] === "help") {
    if (args.length === 1 || ["-h", "--help"].includes(args[1])) return { requested: true, text: renderTopLevelHelp() };
    if (args.length > 2) throw cliError("maestro help accepts one command or walkthrough name. Try `maestro help`.");
    return { requested: true, text: renderHelpTarget(args[1]) };
  }
  if (args.includes("-h") || args.includes("--help")) return { requested: true, text: renderHelpTarget(args[0]) };
  return { requested: false };
}

function renderHelpTarget(target) {
  const name = normalizeCommand(target);
  const command = COMMAND_BY_NAME.get(name);
  if (command) return renderCommandHelp(command);
  const walkthrough = WALKTHROUGH_BY_NAME.get(target);
  if (walkthrough) return walkthrough.render();
  throw cliError(`Unknown Maestro command or help topic: ${target}. Try \`maestro help\` to see available commands.`);
}

function isManifest(value) {
  return value.endsWith(".json") || value.includes("/");
}

function parsePositionals(command, positionals) {
  const kind = command.positionalKind;
  let issues = [];
  if (kind === "none" && positionals.length) throw cliError(`maestro ${command.name} does not accept positional arguments.`);
  if (kind === "optional-manifest") {
    if (positionals.length > 1 || (positionals.length === 1 && !isManifest(positionals[0]))) {
      throw cliError(`maestro ${command.name} accepts at most one manifest path.`);
    }
  }
  if (["manifest-issues", "loose-manifest-issues"].includes(kind)) {
    const manifests = positionals.filter(isManifest);
    if (manifests.length > 1) throw cliError(`maestro ${command.name} accepts at most one manifest path.`);
    if (kind === "manifest-issues" && manifests.length && positionals[0] !== manifests[0]) {
      throw cliError(`The manifest path for maestro ${command.name} must precede issue numbers.`);
    }
    issues = positionals.filter((value) => !isManifest(value));
    const invalid = issues.find((value) => !/^[1-9]\d*$/.test(value));
    if (invalid) throw cliError(`Invalid issue number: ${invalid}.`);
  }
  if ((command.minIssues || 0) > issues.length) {
    if (command.name === "discard") throw cliError("maestro discard requires at least one explicit issue number.");
    throw cliError(`maestro ${command.name} requires at least ${command.minIssues} issue number${command.minIssues === 1 ? "" : "s"}.`);
  }
  return { issues };
}

function parseInvocation(args) {
  const rawName = args[0];
  const name = normalizeCommand(rawName);
  const command = COMMAND_BY_NAME.get(name);
  if (!command) throw cliError(`Unknown Maestro command: ${rawName}. Try \`maestro help\` to see available commands.`);
  const values = {};
  const positionals = [];
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const definition = command.options?.[token];
    if (!definition) throw cliError(`Unknown option for maestro ${name}: ${token}. Try \`maestro help ${name}\`.`);
    if (values[token] !== undefined) throw cliError(`Option ${token} may only be provided once.`);
    if (definition.value) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw cliError(`${token} requires a value. Try \`maestro help ${name}\`.`);
      values[token] = value;
      index += 1;
    } else {
      values[token] = true;
    }
  }
  for (const [option, definition] of Object.entries(command.options || {})) {
    if (definition.required && values[option] === undefined) throw cliError(`maestro ${name} requires ${option}. Try \`maestro help ${name}\`.`);
  }
  for (const group of command.exclusive || []) {
    const selected = group.filter((option) => values[option] !== undefined);
    if (selected.length > 1) throw cliError(`maestro ${name} accepts only one of ${group.join(", ")}.`);
  }
  if (command.allowedValues) {
    for (const [option, allowed] of Object.entries(command.allowedValues)) {
      if (values[option] !== undefined && !allowed.includes(values[option])) {
        throw cliError(`${option} must be one of: ${allowed.join(", ")}.`);
      }
    }
  }
  for (const option of command.numericOptions || []) {
    if (values[option] !== undefined && !/^[1-9]\d*$/.test(values[option])) {
      throw cliError(`${option} requires a positive issue number.`);
    }
  }
  const parsed = parsePositionals(command, positionals);
  const manifest = positionals.find(isManifest);
  if (manifest && command.positionalKind !== "loose-manifest-issues" && args[1] !== manifest) {
    throw cliError(`The manifest path for maestro ${name} must be the first argument.`);
  }
  for (const option of command.requiresIssuesWith || []) {
    if (values[option] !== undefined && !parsed.issues.length) throw cliError(`${option} requires explicit issue numbers.`);
  }
  for (const [left, right] of command.conflicts || []) {
    if (values[left] !== undefined && right === "$issues" && parsed.issues.length) {
      throw cliError(`maestro ${name} accepts either issue numbers or ${left}, not both.`);
    }
  }
  return { command: name, rawCommand: rawName, definition: command, rest: args.slice(1), options: values, positionals };
}

module.exports = { normalizeCommand, parseInvocation, renderCommandHelp, renderTopLevelHelp, resolveHelp };
