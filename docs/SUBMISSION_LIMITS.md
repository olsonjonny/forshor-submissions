# Hosted verification limits

The hosted check admits one active verification per GitHub account, up to six
admitted attempts in a rolling hour and twenty in a rolling day. The trusted
configuration is `scripts/ci/submission-limits.json`. Local experiments and
`./forshor check` are unrestricted. The account is the numeric GitHub identity
attributed to the verification request, not a name supplied in the policy.

The quota step appears inside the existing **Verify submission with Lean** job,
before submission checkout, dependencies or Lean setup. Over-limit attempts fail
with the limit and an expiry time, or a request to finish/cancel an active run.
Open the linked admission decision for details, then retry the verification.
An admitted attempt consumes quota even if its later mathematical check fails or
it is cancelled. A quota refusal does not consume another admission. Updating a
PR starts a new attempt; rerunning verification is also a new attempt. Duplicate
notifications for the same run/attempt reuse their decision.

Maintainer-only manual dispatch of the verifier remains an explicit operational
recovery path. It is recorded by GitHub and is not available to public read-only
participants. Retrying the separate publication workflow does not run Lean or
consume a new verification admission.

## Trust and concurrency

GitHub's `workflow_run: in_progress` event starts **Submission admission** from
upstream main when the verification job gets a runner. This event also occurs on
reruns. Admission jobs are serialized without cancelling earlier decisions.
They inspect only GitHub API metadata, never the PR checkout or artifacts.

Successful main-only admission workflow records are the quota ledger. GitHub's
numeric actor IDs, server timestamps, workflow ID/path, repository ID, event and
main branch bind each record. The original verification run and attempt are
rechecked. The existing PR workflow waits for that exact trusted decision; a
fork cannot replace it with a similarly named job or artifact. It reads the
trusted main control, not a copy of the control from the submission branch.

The global admission lock makes each decision see the preceding reservation.
The next decision checks whether previously admitted verifications are still
active. The existing four global queues, 60-minute verification deadline,
cancellation of superseded PR commits, and separate trusted publication remain.
There are no added Google credentials, databases, mutable quota branches, keys,
or write tokens in either the verification or admission job.

GitHub outages, incomplete/overloaded API history, invalid configuration or an
unavailable decision stop work before expensive setup. History over 1,000
admission records per account/day is refused for operator review. A single
verification waits up to three minutes for admission; rerun later after a transient
failure. Rerunning the metadata workflow cannot erase an earlier approval.

These limits bound expensive work per account. They do not stop someone from
opening PRs, creating multiple accounts, or consuming all GitHub request capacity.
Public fork approval settings and repository branch rules are separate controls.

## Operations

Change only `scripts/ci/submission-limits.json` on main to tune the three limits.
It does not change the scoring model, Lean cache keys or model epoch. A limit
change affects new admissions; it never removes or reprices accepted submissions.

Review the **Submission admission** Actions runs for decisions. The original
PR's Lean check links the exact decision and includes its refusal message.
For an incident, check source run/attempt, numeric actor and the active run links.
Do not delete admission runs during their rolling day: they are the quota ledger.
Normal workflow history retention must remain at least 24 hours.

Test with `node --test scripts/test_submission_admission.js`. Maintainer release
checks should show a fresh intentionally invalid policy being admitted, then
refused by the existing source filter before Lean setup, and a simultaneous
same-account request refused by admission. Neither request should archive or
publish a result. Always close these test PRs without merging them.
