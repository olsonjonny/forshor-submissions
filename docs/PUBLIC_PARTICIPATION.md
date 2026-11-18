# Public participation and repository protections

How public submissions reach the verifier, the limits that apply, and the GitHub
protections around the repository. Neither the CLI nor the protection script
changes repository visibility or Google resources.

## Participant workflow

Clone `zapatacomputing/forshor-submissions`, run `./forshor setup`, write
`TableGeneration/Submission/Policy.lean`, then run `./forshor check` and
`./forshor submit`. The optional `summary.tex` remains text and is never compiled.

For public submissions the CLI creates or reuses the authenticated user's fork,
pushes there, and opens a PR against `zapatacomputing/forshor-submissions/main`.
The fixed upstream main supplies the verifier even when origin is a fork.
Participants need only Read access upstream. Accepted source and evidence go
to `zapatacomputing/forshor-submissions/submission-results`; the submitted policy
PR closes without merging after publication confirmation. The website uses
the shared cached JSON data flow.

## Job limits and queue behavior

| Work | Maximum active | Timeout |
| --- | ---: | ---: |
| Lean/exact-width verification, including setup | 4 | 60 minutes per job |
| Trusted Qualtran, archive, publication and PR reporting | 1 | 40 minutes per job |

GitHub has no numeric repository-wide four-job setting. New CLI branch names
are randomly assigned to `submission/q0/` through `submission/q3/`. The trusted
verification workflow maps those prefixes to exactly four fixed concurrency
groups, each with one active job and `queue: max` (100 waiting jobs). All other
branch names use q0. Arbitrary branch names cannot create extra queues. A busy
queue can wait while another is idle; this is not a shared work-stealing queue.
Publication has its own single queue with 100 waiting jobs. Organization-wide
runner limits can further reduce available capacity.

The 60-minute verifier limit covers setup, ForShor, and the STO mirror together.
The mirror also has a 10-minute overall limit. The 15-minute per-stage setting
applies to individual STO replay stages; it does not set a ForShor deadline. The separately trusted main cache warmer may
take up to 180 minutes; that is maintenance, not a per-submission allowance.
Warm the pinned caches before testing the largest supported policies. Cold
cache misses can cause a submission job to time out: report an infrastructure
failure, warm the trusted cache, then rerun verification. PR jobs never save
trusted dependency caches.

An updated commit cancels only the older verification of that same PR. The
publisher is never automatically canceled during archive or snapshot writes.
Timeouts, exhausted queues and missing artifacts are visible failures, not
mathematical rejections. Retry a canceled queued verification after capacity is
available. Rerunning upstream jobs requires a maintainer. If Lean passed and
publication failed, a maintainer reruns the publisher rather than Lean; the
participant follows with `./forshor status --watch`. This bounded queue cannot absorb a 10,000-submission burst.

## Rules enforced by GitHub

Both **zapatacomputing/forshor-submissions/main** and
**zapatacomputing/forshor-submissions/submission-results** block branch deletion
and non-fast-forward pushes. The `ForShor preserve history` ruleset has no
administrator or automation bypass.

Ordinary direct pushes remain allowed for people and automation with repository
Write access. No PR, approving review, required status check, or automation-only
archive restriction is imposed. `Maintenance checks` still runs on main pushes
and PRs, but does not gate a push. Keep Write/Admin access limited to trusted
maintainers; public participants can fork and open PRs without upstream Write access.

These rules preserve the branch's history, not every file in its latest commit:
a normal commit can still remove files, with earlier versions retained for recovery.
Administrators can also edit rules or delete the repository. Independent backups
remain necessary. An archive correction must stay consistent with the published
ledger; do not manually edit accepted records as a routine operation.

The current publisher uses GitHub's Actions App. Its token gets explicit
Contents Write only in the trusted publisher workflow. Verification gets
Contents Read, no publishing secrets, and no Google identity token permission.
Do not enable write tokens or secrets for fork PR jobs.

Default workflow tokens are read-only and cannot approve PRs. Review the
existing collaborator list with the repository owner; do not automatically
remove collaborators or change organization-wide MFA policy. Confirm maintainers
use two-factor authentication. A missing MFA field from the API means unknown,
not that MFA is disabled.

## Prepare and activate protections

```sh
python3 scripts/ci/repository_security.py plan
# Once the repository is public:
python3 scripts/ci/repository_security.py apply
```

The script never changes visibility, saves the previous settings under ignored
`artifacts/security/`, applies the rules through GitHub's API, and reads them
back. It only manages the named history ruleset; it does not change collaborators,
workflow token permissions, other rulesets or branch contents. Inspect effective
rules on both branches for any additional inherited restrictions.

To recover a mistakenly deleted file, restore it from an earlier commit and make a
new ordinary commit. Do not force-push the branch backward. If this ruleset itself
needs rollback, use its recorded GitHub rule ID and the saved previous configuration
under an explicit maintenance decision; re-read the resulting rules afterward.

On GitHub Free, branch protection is only available for public repositories.
Apply the protections and read them back whenever visibility changes; do not
treat them as active until the read-back succeeds.

## Rehearsal and monitoring

Before release, run the CLI/fork tests, publisher trust and conflict-recovery
suites, and at least one hosted PhaseProduct and PhaseTripleProduct submission
against a test deployment. Test invalid source, a new commit during verification,
and four simultaneous queues. Check archived source bytes, every accepted
identity, PR outcomes, and the dashboard's snapshot. Preserve accepted test
contributions; do not rewrite the archive to clean them up.

After public visibility and protections are active, use an external GitHub
account with no upstream Write access to test the full fork route. Unit tests
and a maintainer's private submission are not a substitute for that test.

```sh
gh run list --repo zapatacomputing/forshor-submissions --workflow table-generation-submission.yml --limit 100
gh run list --repo zapatacomputing/forshor-submissions --workflow publish-results.yml --limit 100
gh api repos/zapatacomputing/forshor-submissions/actions/permissions/workflow
```

Inspect queue age, canceled runs, timeout conclusions, cache misses, publication
failures, and storage usage in GitHub Actions and the organization's billing
dashboard. Standard hosted compute is free for the public repository; larger
runners and excess artifact/cache storage can still cost money.

Sources: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[branch protections and plans](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule),
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
