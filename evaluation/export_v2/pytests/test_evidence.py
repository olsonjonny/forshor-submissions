"""Run from evaluation/: python -m pytest export_v2/pytests -q. The engine and Lean are NOT needed: the harness is a stub."""
import copy
import hashlib
import json
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from export_v2 import canon, evidence  # noqa: E402

GOLDEN = json.loads((Path(__file__).parent / "data" / "golden.json").read_text())
MODEL = GOLDEN["model"]
PP_POLICY = GOLDEN["cases"]["full_submission"]["view"]["policy_json"]
PTP_POLICY = GOLDEN["cases"]["ptp_planner"]["view"]["policy_json"]

STUB = textwrap.dedent('''
    import hashlib, json, sys
    from pathlib import Path
    args = sys.argv[1:]
    policy = Path(args[0]); out = Path(args[args.index("--out") + 1])
    doc = json.loads(policy.read_text())
    verdict = "rejected" if "REJECT" in doc["name"] else "accepted"
    rec = {"tool": "stub", "policy_sha256": hashlib.sha256(policy.read_bytes()).hexdigest(), "target_width": 2048,
           "widths_rule": "exact", "mode": doc["mode"], "verdict": verdict,
           "bands": [{"threshold": b["threshold"], "k": b["k"]} for b in doc["bands"]]}
    if verdict == "rejected":
        rec["rejection"] = {"stage": "threshold", "reason": "does not shrink"}
    out.write_text(json.dumps(rec))
    sys.exit(0 if verdict == "accepted" else 1)
''')


def make_tree(tmp_path, *, lean=None, pin=None, base="361e81e", stub=STUB, notes="PROVENANCE.md"):
    tree = tmp_path / "tree"
    (tree / "scripts").mkdir(parents=True)
    (tree / "lean-toolchain").write_text((lean or MODEL["lean"]) + "\n")
    (tree / "lake-manifest.json").write_text(json.dumps({"packages": [
        {"name": "mathlib", "rev": "x"}, {"name": "Fast_multiplication", "rev": pin or MODEL["forshor"]["pin"]}]}))
    if notes:
        (tree / notes).write_text(f"- **Base:** upstream `main` at `{base}` (2026-11-03)\n")
    for name in ("check_banded_policy.py", "check_ptp_policy.py"):
        (tree / "scripts" / name).write_text(stub)
    return tree


def envelope(tmp_path, policy=PP_POLICY, board="pp", **tree_kwargs):
    return evidence.run_mirror(policy, board, make_tree(tmp_path, **tree_kwargs), tmp_path / "out")


def test_a_bound_accepted_exact_check_on_the_epochs_toolchain_becomes_evidence(tmp_path):
    env = envelope(tmp_path)
    got, why = evidence.stomirror_from_envelope(env, PP_POLICY, MODEL, "pp")
    assert why is None
    assert got["harness"] == "check_banded_policy" and got["widths"] == "exact" and got["verdict"] == "accepted"
    assert got["claim"] == "policy-algebra-and-exact-widths"
    assert got["ran"] == {"lean": MODEL["lean"], "stoCommit": MODEL["sto"]["commit"], "forshorPin": MODEL["forshor"]["pin"]}
    assert got["recordSha256"] == canon.sha256_hex(env["record"])
    # the same policy under another title is the same policy: the evidence still applies
    retitled = copy.deepcopy(PP_POLICY); retitled["name"] = "another title"
    assert evidence.stomirror_from_envelope(env, retitled, MODEL, "full")[0] is not None


def test_a_phase_triple_product_policy_uses_its_own_harness(tmp_path):
    env = envelope(tmp_path, PTP_POLICY, "ptp")
    assert env["harness"] == "check_ptp_policy"
    assert evidence.stomirror_from_envelope(env, PTP_POLICY, MODEL, "ptp")[0]["harness"] == "check_ptp_policy"
    assert "harness" in evidence.stomirror_from_envelope(env, PTP_POLICY, MODEL, "pp")[1]


@pytest.mark.parametrize("name,mutate,expected", [
    ("another policy", lambda e: e.__setitem__("policyDigest", "0" * 64), "another policy"),
    ("not accepted", lambda e: e["record"].update(verdict="rejected", rejection={"stage": "threshold"}), "did not accept"),
    ("scan widths", lambda e: e["record"].update(widths_rule="scan"), "exact-width"),
    ("other width", lambda e: e["record"].update(target_width=1024), "exact-width"),
    ("other mode", lambda e: e["record"].update(mode="PhaseTripleProduct"), "mode or bands"),
    ("other bands", lambda e: e["record"]["bands"][0].update(threshold=1), "mode or bands"),
    ("other file", lambda e: e["policyFile"].update(sha256="1" * 64), "different file"),
    ("wrong schema", lambda e: e.update(schema="x"), "not a mirror-evidence"),
])
def test_evidence_that_is_not_bound_accepted_exact_and_for_this_policy_is_refused(tmp_path, name, mutate, expected):
    env = envelope(tmp_path)
    mutate(env)
    got, why = evidence.stomirror_from_envelope(env, PP_POLICY, MODEL, "pp")
    assert got is None and expected in why, (name, why)


@pytest.mark.parametrize("kwargs,expected", [
    ({"lean": "leanprover/lean4:v4.28.0"}, "v4.28.0"),
    ({"pin": "f" * 40}, "ForShor fffffffff"),
    ({"base": "deadbee"}, "STO base"),
])
def test_evidence_from_another_toolchain_is_reported_not_used(tmp_path, kwargs, expected):
    got, why = evidence.stomirror_from_envelope(envelope(tmp_path, **kwargs), PP_POLICY, MODEL, "pp")
    assert got is None and expected in why


def test_the_runner_records_a_rejection_and_fails_loudly_without_a_record(tmp_path):
    bad = copy.deepcopy(PP_POLICY); bad["name"] = "REJECT me"
    env = evidence.run_mirror(bad, "pp", make_tree(tmp_path), tmp_path / "o1")
    assert env["record"]["verdict"] == "rejected"
    assert "did not accept" in evidence.stomirror_from_envelope(env, bad, MODEL, "pp")[1]
    silent = make_tree(tmp_path / "x", stub="import sys; sys.exit(3)")
    with pytest.raises(RuntimeError, match="no record"):
        evidence.run_mirror(PP_POLICY, "pp", silent, tmp_path / "o2")


def test_the_store_finds_evidence_by_policy_and_explains_what_is_missing(tmp_path):
    out = tmp_path / "out"
    evidence.run_mirror(PP_POLICY, "pp", make_tree(tmp_path, base="deadbee"), out)
    store = evidence.EvidenceStore(out)
    got, why = store.stomirror(PP_POLICY, MODEL, "pp")
    assert got is None and "STO base" in why
    assert evidence.EvidenceStore(out).stomirror(PTP_POLICY, MODEL, "ptp") == (None, "no mirror evidence for this policy")
    good = tmp_path / "good"
    evidence.run_mirror(PP_POLICY, "pp", make_tree(tmp_path / "g"), good)
    assert evidence.EvidenceStore(good).stomirror(PP_POLICY, MODEL, "pp")[0]["ran"]["lean"] == MODEL["lean"]


def test_tree_pins_read_a_trees_own_files(tmp_path):
    assert evidence.tree_pins(make_tree(tmp_path)) == {"lean": MODEL["lean"], "forshorPin": MODEL["forshor"]["pin"], "stoBase": "361e81e"}
    assert evidence.tree_pins(tmp_path / "empty") == {"lean": None, "forshorPin": None, "stoBase": None}


def test_tree_pins_read_provenance_md_and_only_that_file(tmp_path):
    assert evidence.tree_pins(make_tree(tmp_path / "a", base="abcdef1"))["stoBase"] == "abcdef1"
    old = make_tree(tmp_path / "b", notes="JMC_NOTES.md", base="3333333")
    assert evidence.tree_pins(old)["stoBase"] is None, "the old notes file is no longer read"


def test_the_old_notes_file_is_gone_from_the_repository_and_the_reader():
    repo = Path(__file__).resolve().parents[3]
    assert not (repo / "JMC_NOTES.md").exists()
    assert "JMC_NOTES" not in (repo / "evaluation/export_v2/evidence.py").read_text()


def test_a_tree_without_the_provenance_file_is_refused_with_the_same_words(tmp_path):
    pins = evidence.tree_pins(make_tree(tmp_path, notes=None))
    assert pins["stoBase"] is None
    ran, why = evidence._ran(pins, MODEL)
    assert ran is None and why.startswith("the tree's STO base (None) is not the model's (")


def test_the_repositorys_own_provenance_file_satisfies_the_reader_and_names_the_models_sto_commit(tmp_path):
    """The guard against deleting or rewording the file the evidence reads: every submission's evidence depends on this line."""
    from export_v2 import epoch
    repo = Path(__file__).resolve().parents[3]
    assert (repo / "PROVENANCE.md").exists(), "PROVENANCE.md is at the repository root"
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "PROVENANCE.md").write_text((repo / "PROVENANCE.md").read_text())
    base = evidence.tree_pins(tree)["stoBase"]
    assert base and epoch.STO_COMMIT.startswith(base), f"the base line ({base}) is the model's STO commit ({epoch.STO_COMMIT[:9]})"


VERIFIED = {"lean": {"status": "policy-verified", "policy_verified": True, "runs": [
    {"status": "lean-ok", "printed_policy_matches": True, "conversion_agrees": True,
     "forshor": {"commit": "10fe620568dfc1b4b3d98debaaf78219e3fa40f2"}}]}}


def test_forshor_evidence_counts_only_at_the_epochs_pin_and_maps_its_two_flags():
    got, why = evidence.forshor_from_seed(VERIFIED, MODEL)
    assert got is None and "10fe620" in why and MODEL["forshor"]["pin"][:9] in why
    at_pin = copy.deepcopy(VERIFIED)
    at_pin["lean"]["runs"][0]["forshor"]["commit"] = MODEL["forshor"]["pin"]
    got, why = evidence.forshor_from_seed(at_pin, MODEL)
    assert why is None and got == {"verified": True, "bandsAgree": True, "irPriceAgrees": True,
                                   "claim": "forshor-policy-submission", "forshorCommit": MODEL["forshor"]["pin"]}
    at_pin["lean"]["runs"][0]["conversion_agrees"] = False
    assert evidence.forshor_from_seed(at_pin, MODEL)[0]["irPriceAgrees"] is False
    stale = {"lean": {"status": "stale", "policy_verified": False, "reason": "checked before it was re-planned"}}
    assert evidence.forshor_from_seed(stale, MODEL) == (None, "checked before it was re-planned")


def test_a_demo_mirror_record_cannot_satisfy_the_pinned_contract():
    rec = {"sto_mirror": {"status": "accepted", "lean_toolchain": "leanprover/lean4:v4.28.0", "mirror_tree_sha256": "a" * 64}}
    got, why = evidence.stomirror_from_seed(rec, MODEL)
    assert got is None and "v4.28.0" in why
    rec["sto_mirror"]["lean_toolchain"] = MODEL["lean"]
    got, why = evidence.stomirror_from_seed(rec, MODEL)
    assert got is None and "revisions" in why


ORPHAN = textwrap.dedent('''
    import json, subprocess, sys, hashlib
    from pathlib import Path
    args = sys.argv[1:]
    policy = Path(args[0]); out = Path(args[args.index("--out") + 1])
    subprocess.Popen(["sleep", "987123"])        # what a harness leaves behind: a child that outlives it
    doc = json.loads(policy.read_text())
    out.write_text(json.dumps({"tool": "stub", "policy_sha256": hashlib.sha256(policy.read_bytes()).hexdigest(), "target_width": 2048,
        "widths_rule": "exact", "mode": doc["mode"], "verdict": "accepted", "bands": [{"threshold": b["threshold"], "k": b["k"]} for b in doc["bands"]]}))
''')
HANG = textwrap.dedent('''
    import subprocess, sys, time
    subprocess.Popen(["sleep", "987124"])
    time.sleep(60)
''')


def _alive(marker: str) -> bool:
    import subprocess
    return subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode == 0


def test_a_child_the_harness_leaves_behind_is_swept_when_it_ends(tmp_path):
    tree = make_tree(tmp_path, stub=ORPHAN)
    env = evidence.run_mirror(PP_POLICY, "pp", tree, tmp_path / "o")
    assert env["record"]["verdict"] == "accepted"
    import time
    time.sleep(0.3)
    assert not _alive("sleep 987123"), "the orphan outlived the run"


def test_a_harness_that_times_out_is_killed_with_everything_it_started(tmp_path):
    tree = make_tree(tmp_path, stub=HANG)
    with pytest.raises(Exception):
        evidence.run_mirror(PP_POLICY, "pp", tree, tmp_path / "o2", timeout=2)
    import time
    time.sleep(0.3)
    assert not _alive("sleep 987124"), "the timed-out run left its child running"


ARGV = textwrap.dedent('''
    import json, sys, hashlib
    from pathlib import Path
    args = sys.argv[1:]
    policy = Path(args[0]); out = Path(args[args.index("--out") + 1])
    doc = json.loads(policy.read_text())
    out.write_text(json.dumps({"tool": "stub", "policy_sha256": hashlib.sha256(policy.read_bytes()).hexdigest(), "target_width": 2048,
        "widths_rule": "exact", "mode": doc["mode"], "verdict": "accepted", "argv": args,
        "bands": [{"threshold": b["threshold"], "k": b["k"]} for b in doc["bands"]]}))
''')


def test_the_harness_stage_timeout_is_passed_only_when_asked_for(tmp_path):
    tree = make_tree(tmp_path, stub=ARGV)
    plain = evidence.run_mirror(PP_POLICY, "pp", tree, tmp_path / "a")
    assert "--timeout" not in plain["record"]["argv"], "the harness keeps its own default"
    long_ = evidence.run_mirror(PP_POLICY, "pp", tree, tmp_path / "b", stage_timeout=14400)
    argv = long_["record"]["argv"]
    assert argv[argv.index("--timeout") + 1] == "14400"


ARGV_STUB = STUB.replace('rec = {"tool": "stub",', 'rec = {"tool": "stub", "argv": args,')


@pytest.mark.parametrize("board,policy", [("pp", PP_POLICY), ("ptp", PTP_POLICY)])
def test_shared_replay_budget_reaches_both_harnesses_without_removing_limits(tmp_path, board, policy):
    tree = make_tree(tmp_path, stub=ARGV_STUB)
    default = evidence.run_mirror(policy, board, tree, tmp_path / "default", stage_timeout=900, fast=True)
    argv = default["record"]["argv"]
    assert argv[argv.index("--cap-gb") + 1] == "12.0"
    assert argv[argv.index("--timeout") + 1] == "900"
    assert "--fast" in argv
    tighter = evidence.run_mirror(policy, board, tree, tmp_path / "tighter", cap_gb=8.0)
    argv = tighter["record"]["argv"]
    assert argv[argv.index("--cap-gb") + 1] == "8.0"


def test_fast_is_passed_to_either_harness_when_asked_for(tmp_path):
    ptp = evidence.run_mirror(PTP_POLICY, "ptp", make_tree(tmp_path / "a", stub=ARGV_STUB), tmp_path / "oa", fast=True)
    assert "--fast" in ptp["record"]["argv"]
    pp = evidence.run_mirror(PP_POLICY, "pp", make_tree(tmp_path / "b", stub=ARGV_STUB), tmp_path / "ob", fast=True)
    assert "--fast" in pp["record"]["argv"], "the PhaseProduct harness has the option too (it skips the interpreted report stage)"
    for board, pol in (("ptp", PTP_POLICY), ("pp", PP_POLICY)):
        slow = evidence.run_mirror(pol, board, make_tree(tmp_path / f"c{board}", stub=ARGV_STUB), tmp_path / f"oc{board}")
        assert "--fast" not in slow["record"]["argv"], "off by default"
