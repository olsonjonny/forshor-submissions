'use strict';

// All records come from this repository's main-only admission workflow. No
// participant code, artifact, commit timestamp or PR title is quota authority.
const REPOSITORY = 'zapatacomputing/forshor-submissions';
const REPOSITORY_ID = 1432460134;
const VERIFY = '.github/workflows/table-generation-submission.yml';
const ADMISSION = '.github/workflows/submission-admission.yml';
const HOUR = 60 * 60 * 1000;
// Verification is capped at 60 minutes (timeout-minutes in table-generation-submission.yml); twice that covers every attempt still running.
const ACTIVE_WINDOW = 2 * HOUR;
const DAY = 24 * HOUR;
const keyOf = (id, attempt) => `${id}:${attempt}`;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const time = (s) => { const n = Date.parse(s); if (!Number.isFinite(n)) throw new Error('Missing GitHub server timestamp'); return n; };

function limitsOf(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'active,perDay,perHour'
      || ![value.active, value.perHour, value.perDay].every(positive)
      || value.active > 4 || value.perDay < value.perHour || value.perDay > 100) {
    throw new Error('Invalid submission admission limits; refusing expensive work');
  }
  return value;
}

function recordOf(run, workflowId, accountId) {
  const match = /^admission:([1-9][0-9]*):([1-9][0-9]*)$/.exec(run.display_title || '');
  if (!match || run.workflow_id !== workflowId || run.path !== ADMISSION || run.event !== 'workflow_run'
      || run.head_branch !== 'main' || run.actor?.id !== accountId || run.repository?.id !== REPOSITORY_ID) return null;
  const sourceId = Number(match[1]), attempt = Number(match[2]);
  if (!positive(sourceId) || !positive(attempt)) return null;
  return { key: keyOf(sourceId, attempt), sourceId, attempt, at: time(run.created_at), admissionId: run.id };
}

function decision(records, active, limits, now) {
  const unique = new Map();
  for (const r of records) {
    if (r.at > now + 60_000) throw new Error('Admission record has a future timestamp');
    if (!unique.has(r.key) || unique.get(r.key).at > r.at) unique.set(r.key, r);
  }
  const recent = [...unique.values()].filter((r) => r.at > now - DAY);
  for (const [window, count, cap] of [
    ['hour', recent.filter((r) => r.at > now - HOUR).length, limits.perHour],
    ['day', recent.length, limits.perDay],
  ]) {
    if (count >= cap) {
      const relevant = recent.filter((r) => window === 'day' || r.at > now - HOUR).sort((a, b) => a.at - b.at);
      const retryAt = new Date(relevant[count - cap].at + (window === 'day' ? DAY : HOUR)).toISOString();
      return { allowed: false, reason: `This GitHub account has reached ${cap} admitted verification attempts per rolling ${window}. Retry after ${retryAt}. Local checks remain unrestricted.`, retryAt };
    }
  }
  if (active.length >= limits.active) {
    return { allowed: false, reason: `This GitHub account already has ${active.length} active verification(s); the limit is ${limits.active}. Wait for it to finish or cancel the older run, then retry.`, active };
  }
  return { allowed: true, reason: 'Submission admitted before dependency setup and Lean compilation.' };
}

function repositoryOf(context) {
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY || context.payload.repository?.id !== REPOSITORY_ID) {
    throw new Error('Admission is only valid in the company submission repository');
  }
  return context.repo;
}

async function history(github, repo, workflowId, account, now) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const response = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: workflowId,
      actor: account.login, event: 'workflow_run', created: `>=${new Date(now - DAY).toISOString()}`, per_page: 100, page });
    if (response.data.total_count >= 1000) throw new Error('Admission history is too busy to verify safely; retry later');
    runs.push(...response.data.workflow_runs);
    if (response.data.workflow_runs.length < 100) return runs;
  }
  throw new Error('Admission history pagination limit reached; refusing expensive work');
}

async function approvedRecords(github, repo, runs, workflowId, accountId, currentId) {
  const records = [];
  for (const run of runs) {
    if (run.id === currentId) continue;
    const record = recordOf(run, workflowId, accountId);
    if (!record) continue;
    // A workflow rerun must not erase an earlier successful admission. Only
    // maintainers can rerun this main-only workflow, but preserve its evidence.
    if (run.status === 'completed' && run.conclusion === 'success') records.push(record);
    else if ((run.run_attempt || 1) === 1 && run.status === 'in_progress') {
      // The global workflow lock has passed to us, so this is an older API
      // view. A fresh read resolves it; uncertain state is refused.
      const fresh = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data;
      if (fresh.status !== 'completed') throw new Error('An earlier admission is not settled; retry later');
      if (fresh.conclusion === 'success') records.push(record);
    }
    if ((run.run_attempt || 1) > 1) {
      if (run.run_attempt > 20) throw new Error('Admission audit requires operator review after repeated metadata retries');
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const prior = (await github.rest.actions.getWorkflowRunAttempt({ ...repo, run_id: run.id, attempt_number: attempt })).data;
        if (prior.status === 'completed' && prior.conclusion === 'success') records.push(record);
      }
    }
  }
  return records;
}

async function admit({ github, context, core, limits, now = Date.now() }) {
  const repo = repositoryOf(context);
  if (context.eventName !== 'workflow_run' || context.ref !== 'refs/heads/main') throw new Error('Admission must run trusted main code');
  limits = limitsOf(limits);
  const event = context.payload.workflow_run;
  if (!positive(event?.id) || !positive(event?.run_attempt)) throw new Error('Missing source attempt');
  const source = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: event.id })).data;
  const verifyId = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'table-generation-submission.yml' })).data.id;
  const gateId = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'submission-admission.yml' })).data.id;
  const current = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: context.runId })).data;
  if (source.repository?.id !== REPOSITORY_ID || source.workflow_id !== verifyId || source.path !== VERIFY
      || source.event !== 'pull_request' || source.run_attempt !== event.run_attempt || source.head_sha !== event.head_sha
      || source.status !== 'in_progress') throw new Error('Source verification is stale, inactive or not the expected PR workflow');
  const account = current.actor;
  if (!positive(account?.id) || ![source.actor?.id, source.triggering_actor?.id].includes(account.id)
      || !recordOf(current, gateId, account.id)) throw new Error('GitHub account or admission workflow identity does not match');
  const runs = await history(github, repo, gateId, account, now);
  const records = await approvedRecords(github, repo, runs, gateId, account.id, current.id);
  const key = keyOf(source.id, source.run_attempt);
  if (records.some((r) => r.key === key)) {
    core.notice('This exact verification attempt was already admitted; duplicate event does not consume quota.');
    return { allowed: true, duplicate: true };
  }
  const active = [];
  // Verification is capped at 60 minutes and admission starts only after its
  // runner starts. Two hours conservatively cover every active attempt,
  // without spending API calls on a day's completed mathematical checks.
  for (const r of new Map(records.filter((r) => r.at > now - ACTIVE_WINDOW).map((r) => [r.key, r])).values()) {
    if (r.sourceId === source.id) continue;
    const other = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: r.sourceId })).data;
    if (other.status === 'in_progress' && other.run_attempt === r.attempt) active.push(other.html_url);
  }
  const result = decision(records, active, limits, now);
  await core.summary.addHeading('Submission admission').addRaw(`${result.reason}\n\nAccount: ${account.login} (${account.id}). Limits: ${limits.active} active, ${limits.perHour}/hour, ${limits.perDay}/day.\n`).write();
  if (!result.allowed) core.setFailed(result.reason);
  else core.notice(result.reason);
  return result;
}

async function refusal(github, repo, run) {
  // Read only GitHub-owned annotations belonging to the verified main workflow.
  const jobs = (await github.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: run.id, per_page: 20 })).data.jobs;
  for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
    if (!job.check_run_url?.startsWith(`https://api.github.com/repos/${REPOSITORY}/check-runs/`)) continue;
    const id = Number(job.check_run_url.split('/').at(-1));
    if (!positive(id)) continue;
    const annotations = (await github.rest.checks.listAnnotations({ ...repo, check_run_id: id, per_page: 10 })).data;
    const error = annotations.find((a) => a.annotation_level === 'failure');
    if (error) return error.message.slice(0, 1500);
  }
  return 'The trusted admission check did not approve this attempt.';
}

async function wait({ github, context, core, attempt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 36 }) {
  const repo = repositoryOf(context);
  if (context.eventName !== 'pull_request' || !positive(context.runId) || !positive(attempt)) throw new Error('Expected the original PR verification attempt');
  const workflowId = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'submission-admission.yml' })).data.id;
  const source = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: context.runId })).data;
  const key = keyOf(context.runId, attempt);
  const since = new Date(time(source.run_started_at) - 60_000).toISOString();
  for (let i = 0; i < tries; i++) {
    const response = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: workflowId, event: 'workflow_run',
      created: `>=${since}`, per_page: 100 });
    if (response.data.total_count > 100) throw new Error('Admission queue is too busy to verify safely; retry later');
    const matches = response.data.workflow_runs.filter((run) => {
      const record = recordOf(run, workflowId, run.actor?.id);
      return record?.key === key && [source.actor?.id, source.triggering_actor?.id].includes(run.actor?.id);
    });
    const success = matches.find((r) => r.status === 'completed' && r.conclusion === 'success');
    if (success) {
      core.notice(`Submission quota approved: ${success.html_url}`);
      await core.summary.addHeading('Submission quota').addRaw(`Approved before Lean setup. [Admission decision](${success.html_url}).\n`).write();
      return;
    }
    const failed = matches.find((r) => r.status === 'completed' && r.conclusion === 'failure');
    if (failed) throw new Error(`${await refusal(github, repo, failed)} Admission details: ${failed.html_url}`);
    await sleep(5000);
  }
  throw new Error('Admission decision is unavailable; stopped before Lean setup. Retry the verification later.');
}

module.exports = { admit, wait, decision, limitsOf, recordOf, REPOSITORY_ID, VERIFY, ADMISSION };
