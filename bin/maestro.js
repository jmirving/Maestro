#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { computePlan } = require("../src/planner");

function usage() {
  console.error("Usage: maestro plan <manifest.json>");
  process.exit(2);
}

const [, , command, manifestPath] = process.argv;
if (command !== "plan" || !manifestPath) usage();

const absolute = path.resolve(process.cwd(), manifestPath);
const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
const plan = computePlan(config);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
