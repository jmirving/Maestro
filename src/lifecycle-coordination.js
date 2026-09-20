const { loadPersistedRunStates, loadRunState, saveRunState } = require("./run-store");
const { withRepositoryCoordination } = require("./repository-coordination");

function reservedIssues(state) {
  if (state.status !== "running") return [];
  if (state.capacity?.issues) return state.capacity.issues.map(String);
  return (state.plan?.selected || []).map((item) => String(item.id));
}

function activeIssueOwners(states) {
  const owners = new Map();
  for (const state of states) {
    for (const issue of reservedIssues(state)) {
      if (!owners.has(issue)) owners.set(issue, []);
      owners.get(issue).push(String(state.runId));
    }
  }
  return owners;
}

async function commitLifecycleTransition({
  repoPath,
  runId,
  issueIds,
  mutate,
  stateLoader = loadRunState,
  statesLoader = loadPersistedRunStates,
  stateSaver = saveRunState,
  beforePersist = async () => {}
}) {
  const issues = [...new Set((issueIds || []).map(String))];
  return withRepositoryCoordination(repoPath, async () => {
    const states = await statesLoader(repoPath);
    const owners = activeIssueOwners(states);
    const conflict = issues.map((issue) => ({
      issue,
      owners: (owners.get(issue) || []).filter((owner) => owner !== String(runId))
    })).find((entry) => entry.owners.length);
    if (conflict) {
      const error = new Error(
        `Cannot commit lifecycle transition for issue #${conflict.issue}; active ownership belongs to run ${conflict.owners[0]}.`
      );
      error.code = "ISSUE_ACTIVE_OWNERSHIP";
      error.issue = conflict.issue;
      error.ownerRunId = conflict.owners[0];
      throw error;
    }

    const state = await stateLoader(repoPath, runId);
    const next = await mutate(state) || state;
    await beforePersist({ state: next, states, owners });
    await stateSaver(repoPath, runId, next);
    return next;
  });
}

module.exports = { activeIssueOwners, commitLifecycleTransition };
