# Operations: queues, limits and recovery

How submissions are queued and limited, and how a slow, rejected or failed publication is handled. For the policy route's CI see [POLICY_CI.md](POLICY_CI.md).

## Queues and recovery

The detailed receipt/catalog paths below describe the original table-generator route. Policy evidence is archived separately with its trusted `ciVerification` receipt; [POLICY_CI.md](POLICY_CI.md) describes the v2 route.

Allow **up to four active verification jobs and one active publication job**.
The CLI assigns new submission branches across four fixed verification queues;
each allows one active job and up to 100 waiting jobs. Older/manual branch names
use the first queue. A busy queue can wait while another is idle: these are four
independent queues, not a scheduler that moves work between them. Publication
uses a separate single queue with up to 100 waiting jobs. Waiting does not hold
a runner. All jobs still share the organization's overall Actions concurrency.

Verification has a **60-minute job timeout**, shared by setup, ForShor, and
the STO mirror. The mirror also has a 10-minute overall limit. The
trusted Qualtran/archive/publication job has a **40-minute job timeout**.
Timeouts report a failure, not a mathematical rejection. Trusted cache warming
is separate and may take longer on a cold build. An updated PR cancels only its
older verification run. It never cancels another PR or an active publication.

An accepted verification gets a trusted receipt on `submission-results` at
`results/evaluations/<key>.json`. The key includes the submitted commit and
the trusted verifier/Lean contract, dependency and scoring inputs. An identical
submission checks this receipt before installing Lean or compiling. It reuses
the accepted verification without trusting an artifact-selected identity.
Scientific configuration changes invalidate reuse; infrastructure-only changes
do not. Receipt/source identities are cross-checked against the accepted index.

Publication has its own key, which also includes the estimator program and
dependency lock. The publisher records completed keys **in the same
atomic pointer update as the results**. A duplicate or a retry after a lost
acknowledgement is a no-op, without resource estimation, history changes or
another website write. Failed/rejected submissions leave the last complete
snapshot visible. GitHub job summaries distinguish rejection, supersession,
verification reuse, successful publication and an already-published result.

**Repeated policies.** A policy is identified by its digest (mode and bands; comments, formatting and `summary.tex` do not change it). When the archive
already holds that digest, `evaluation/archive_policy.py` applies `DUPLICATE_RULES`: by default the **same participant** (same GitHub login, case-insensitive)
is refused with stage `duplicate`, no row, and a pull-request comment naming the earlier submission, while **another participant** is published normally and the
repeat is only identified (the `duplicates` of the archive result in `publication-result.json`, and a `duplicate-policy:` line in the publish log). To refuse
other participants as well, set `DUPLICATE_RULES["other_participant"] = "refuse"`. Only policies the publisher has actually published count (the archive is written first, so an archived head whose publication failed does not block a retry); a rerun of the same head commit is never a repeat. To list repeats already
published, group `leaderboard/policy-submissions.json` on the `submission-results` branch by `digest`; rows published before this rule stay.

Archive writes rebuild the index from the exact current parent on every
non-fast-forward retry. Publication conflicts refresh both the published state and
the accepted archive, then recalculate one consistent snapshot. Transient
transport/storage failures retry up to four times with bounded backoff. The
planner/Qualtran equations and the website are unchanged.

### Recover a failed publication

Open the failed **Publish Verified Results** run and choose **Re-run failed
jobs**, or run `gh run rerun PUBLISH_RUN_ID --repo zapatacomputing/forshor-submissions --failed`.
This reruns only trusted publication; do not rerun **Policy submission**.
The source run and original attempt are fixed, and artifacts are named by both.
Once verification is archived, recovery reads the trusted receipt and accepted
files directly; it does not require the original run artifact. This matters
because rerunning a GitHub workflow can remove earlier-attempt artifacts.
For older frozen publication workflows that still contain an unconditional
download step, a surviving later-attempt artifact is downloaded only as unused
data; the trusted archive remains the sole source of accepted verification.
Recovery also works after the submission PR closes, provided its head is still
the verified commit and the branch still identifies the PR. A PR that has moved
to a newer head is superseded and skipped. GitHub API outages/rate limits fail
visibly rather than being mistaken for missing cache entries.

Verifier artifacts are retained for 90 days; publication diagnostics for 14.
Before verification is archived, its source artifact must still exist. After
archival, modern recovery does not depend on artifact retention. If a queue's 100-job waiting
limit is reached, GitHub cancels additional arrivals visibly: rerun those runs after
capacity is available. This is a bounded queue, not an unlimited intake
service. Retry exhaustion is a failed job with recovery instructions, never a
successful workflow that silently lost a result.

Local checks:

```sh
node scripts/test_report_trust.js
node --test scripts/test_publication.js scripts/test_pr_publication.js
python3 -m unittest discover -s scripts/ci -p 'test_*.py'
python -m unittest discover -s evaluation -p 'test_*.py' # pinned Qualtran environment
```

See [public participation and repository protections](PUBLIC_PARTICIPATION.md)
for fork behavior, limits, and repository protections.
