'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { admit, wait, decision, limitsOf, recordOf, REPOSITORY_ID, VERIFY, ADMISSION } = require('./ci/submission_admission.js');
const NOW = Date.parse('2026-11-15T18:00:00Z');
const HOUR = 3600_000, DAY = HOUR * 24;
const LIMITS = { active: 1, perHour: 6, perDay: 20 };
const account = { id: 111, login: 'participant' };
const stamp = (n) => new Date(n).toISOString();

function record(sourceId, at = NOW - 1000, overrides = {}) {
  return { id: 900 + sourceId, workflow_id: 200, path: ADMISSION, event: 'workflow_run', head_branch: 'main',
    actor: account, repository: { id: REPOSITORY_ID }, display_title: `admission:${sourceId}:1`,
    created_at: stamp(at), run_attempt: 1, status: 'completed', conclusion: 'success',
    html_url: `https://github.com/zapatacomputing/forshor-submissions/actions/runs/${900 + sourceId}`, ...overrides };
}

function rig() {
  const source = { id: 10, workflow_id: 100, path: VERIFY, event: 'pull_request', head_sha: 'a'.repeat(40),
    actor: account, triggering_actor: account, repository: { id: REPOSITORY_ID }, run_attempt: 1,
    status: 'in_progress', run_started_at: stamp(NOW - 5000), html_url: 'https://github.com/source/10' };
  const current = record(10, NOW, { id: 1000, status: 'in_progress', conclusion: null });
  const runs = [current];
  const byId = new Map([[10, source], [1000, current]]);
  const failed = [], messages = [];
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  const core = { summary, notice: (message) => messages.push(message), setFailed: (message) => failed.push(message) };
  const context = { repo: { owner: 'zapatacomputing', repo: 'forshor-submissions' },
    payload: { repository: { id: REPOSITORY_ID }, workflow_run: { id: 10, run_attempt: 1, head_sha: source.head_sha } },
    eventName: 'workflow_run', ref: 'refs/heads/main', runId: 1000 };
  const github = { rest: { actions: {
    getWorkflow: async ({ workflow_id }) => ({ data: { id: workflow_id === 'submission-admission.yml' ? 200 : 100 } }),
    getWorkflowRun: async ({ run_id }) => { assert.ok(byId.has(run_id), `Unexpected run ${run_id}`); return { data: byId.get(run_id) }; },
    listWorkflowRuns: async () => ({ data: { total_count: runs.length, workflow_runs: runs } }),
    listJobsForWorkflowRun: async () => ({ data: { jobs: [{ conclusion: 'failure', check_run_url: 'https://api.github.com/repos/zapatacomputing/forshor-submissions/check-runs/123' }] } }),
  }, checks: { listAnnotations: async () => ({ data: [{ annotation_level: 'failure', message: 'Six attempts/hour: retry after 19:00 UTC.' }] }) } } };
  const call = (limits = LIMITS) => admit({ github, context, core, limits, now: NOW });
  return { source, current, runs, byId, core, context, github, failed, messages, call };
}

test('hour/day windows use GitHub timestamps, deduplicate events, and say when to retry', () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({ key: String(i), at: NOW - (i + 1) * 1000 }));
  assert.equal(decision(recent.slice(0, 5), [], LIMITS, NOW).allowed, true);
  assert.equal(decision([...recent, recent[0]], [], LIMITS, NOW).retryAt, stamp(NOW + HOUR - 6000));
  assert.equal(decision([{ key: 'boundary', at: NOW - HOUR }], [], { ...LIMITS, perHour: 1 }, NOW).allowed, true);
  const daily = Array.from({ length: 20 }, (_, i) => ({ key: String(i), at: NOW - HOUR * 2 - i * 1000 }));
  assert.match(decision(daily, [], LIMITS, NOW).reason, /20.*rolling day/);
  assert.equal(decision([{ key: 'old', at: NOW - DAY }], [], LIMITS, NOW).allowed, true);
});

test('one active account is refused while other configured limits remain adjustable', () => {
  assert.equal(decision([], ['https://github.com/active'], LIMITS, NOW).allowed, false);
  assert.equal(decision([], ['https://github.com/active'], { ...LIMITS, active: 2 }, NOW).allowed, true);
  for (const bad of [{ active: 0, perHour: 6, perDay: 20 }, { ...LIMITS, extra: true }, { ...LIMITS, perDay: 2 }]) assert.throws(() => limitsOf(bad));
  assert.throws(() => decision([{ key: 'future', at: NOW + HOUR }], [], LIMITS, NOW));
});

test('participant/fork workflows and fabricated names are never accepted as quota records', () => {
  const good = record(1);
  assert.equal(recordOf(good, 200, 111).key, '1:1');
  for (const change of [{ event: 'pull_request' }, { head_branch: 'participant-branch' }, { workflow_id: 999 },
    { repository: { id: 42 } }, { actor: { id: 222 } }, { display_title: 'any participant PR title' }]) {
    assert.equal(recordOf({ ...good, ...change }, 200, 111), null);
  }
});

test('only trusted main and the exact current source attempt can admit work', async () => {
  const r = rig();
  assert.equal((await r.call()).allowed, true);
  assert.equal(r.failed.length, 0);
  for (const change of [{ eventName: 'pull_request' }, { ref: 'refs/pull/1/merge' }]) {
    await assert.rejects(admit({ github: r.github, core: r.core, context: { ...r.context, ...change }, limits: LIMITS, now: NOW }), /trusted main/);
  }
  for (const change of [{ run_attempt: 2 }, { status: 'completed' }, { head_sha: 'b'.repeat(40) }, { workflow_id: 999 }]) {
    const x = rig(); Object.assign(x.source, change);
    await assert.rejects(x.call(), /stale, inactive|expected PR/);
  }
});

test('serial admission reserves one account; completion releases it and denied requests do not count', async () => {
  const r = rig();
  r.runs.push(record(11));
  r.byId.set(11, { status: 'in_progress', run_attempt: 1, html_url: 'https://github.com/active/11' });
  assert.equal((await r.call()).allowed, false);
  assert.match(r.failed[0], /already has 1 active/);
  r.byId.get(11).status = 'completed';
  r.runs.push(record(12, NOW - 500, { conclusion: 'failure' }));
  assert.equal((await r.call()).allowed, true);
});

test('duplicate callbacks reuse the same admission; root reruns are separate attempts', async () => {
  const r = rig(); r.runs.push(record(10));
  assert.equal((await r.call()).duplicate, true);
  r.source.run_attempt = 2;
  r.context.payload.workflow_run.run_attempt = 2;
  r.current.display_title = 'admission:10:2';
  const result = await r.call({ active: 1, perHour: 1, perDay: 20 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /rolling hour/);
});

test('rerunning a failed metadata workflow cannot erase an earlier approved decision', async () => {
  const r = rig();
  r.runs.push(record(11, NOW - 1000, { run_attempt: 2, conclusion: 'failure' }));
  r.byId.set(11, { status: 'completed', run_attempt: 1 });
  r.github.rest.actions.getWorkflowRunAttempt = async ({ attempt_number }) => ({ data: { status: 'completed', conclusion: attempt_number === 1 ? 'success' : 'failure' } });
  assert.equal((await r.call({ active: 1, perHour: 1, perDay: 20 })).allowed, false);
});

test('completed older admissions still count for the day without requiring source lookups for active work', async () => {
  const r = rig();
  r.runs.push(record(999, NOW - HOUR * 2));
  // No source lookup exists for 999. It cannot still be active after the
  // verifier's 60-minute deadline, but its admitted attempt remains charged.
  assert.equal((await r.call()).allowed, true);
});

test('unavailable/incomplete history fails closed rather than silently becoming an empty counter', async () => {
  const r = rig();
  r.github.rest.actions.listWorkflowRuns = async () => { throw new Error('GitHub unavailable'); };
  await assert.rejects(r.call(), /unavailable/);
  r.github.rest.actions.listWorkflowRuns = async () => ({ data: { total_count: 1000, workflow_runs: [] } });
  await assert.rejects(r.call(), /too busy/);
});

test('the PR step waits for a trusted completed approval and copies a clear refusal reason', async () => {
  const r = rig();
  const ctx = { ...r.context, eventName: 'pull_request', runId: 10 };
  r.current.status = 'completed'; r.current.conclusion = 'success';
  await wait({ github: r.github, context: ctx, core: r.core, attempt: 1, tries: 1, sleep: async () => {} });
  r.current.conclusion = 'failure';
  await assert.rejects(wait({ github: r.github, context: ctx, core: r.core, attempt: 1, tries: 1, sleep: async () => {} }), /Six attempts\/hour.*Admission details/);
  r.current.event = 'pull_request';
  await assert.rejects(wait({ github: r.github, context: ctx, core: r.core, attempt: 1, tries: 1, sleep: async () => {} }), /unavailable/);
});

test('the integration preserves read-only verification, global slots and PR cancellation before dependency setup', () => {
  const workflow = readFileSync('.github/workflows/table-generation-submission.yml', 'utf8');
  const gate = readFileSync('.github/workflows/submission-admission.yml', 'utf8');
  assert.ok(workflow.indexOf('Check submission quota before setup') < workflow.indexOf('Install Lean'));
  assert.ok(workflow.includes('forshor-verification-') && workflow.includes('timeout-minutes: 60'));
  assert.ok(workflow.includes('cancel-in-progress: true'));
  assert.equal(/(?:contents|actions|checks|id-token): write/.test(workflow + gate), false);
  assert.equal((workflow + gate).includes('pull_request_target'), false);
  assert.ok(gate.includes('ref: main') && gate.includes('group: forshor-submission-admission') && gate.includes('cancel-in-progress: false'));
});
