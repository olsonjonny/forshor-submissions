#!/usr/bin/env python3
"""Run a command under a memory cap and a timeout (macOS or Linux).

    memcap.py --cap-gb 10 --timeout 1800 --log run.mem.json -- CMD ARGS...

Polls every second the whole process tree's resident plus swapped memory on Linux,
or `top -stats mem` (resident + compressed) on macOS, and kills the
tree when the sum exceeds the cap or the timeout passes. Writes peak memory,
wall time and outcome to --log. Exit code: the command's, or 137 if killed.
"""
import argparse, json, os, platform, re, signal, subprocess, sys, time
from pathlib import Path

UNITS = {"B": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30}


def tree(pid):
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True).stdout
    kids = {}
    for line in out.splitlines():
        p, pp = map(int, line.split())
        kids.setdefault(pp, []).append(p)
    seen, stack = [], [pid]
    while stack:
        p = stack.pop()
        seen.append(p)
        stack.extend(kids.get(p, []))
    return seen


def mem(pid):
    if sys.platform.startswith("linux"):
        try:
            status = Path(f"/proc/{pid}/status").read_text()
        except (FileNotFoundError, ProcessLookupError):
            return 0
        # Include swapped pages: RSS alone would evade the cap on small runners.
        return sum(int(kb) * 1024 for kb in re.findall(r"^(?:VmRSS|VmSwap):\s+(\d+)\s+kB", status, re.M))
    out = subprocess.run(["top", "-l", "1", "-pid", str(pid), "-stats", "mem"], capture_output=True, text=True).stdout
    vals = re.findall(r"^\s*([\d.]+)([BKMG])\+?-?\s*$", out, re.M)
    return int(float(vals[-1][0]) * UNITS[vals[-1][1]]) if vals else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap-gb", type=float, default=10)
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("--log")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    cap = int(a.cap_gb * (1 << 30))
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, start_new_session=True)
    peak, outcome = 0, None
    peak_process_count = 0
    while p.poll() is None:
        processes = tree(p.pid)
        total = sum(mem(q) for q in processes)
        if total > peak:
            peak_process_count = len(processes)
        peak = max(peak, total)
        if total > cap:
            outcome = f"killed: memory {total / (1 << 30):.2f} GB > cap {a.cap_gb} GB"
        elif time.monotonic() - t0 > a.timeout:
            outcome = f"killed: timeout {a.timeout} s"
        if outcome:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            break
        time.sleep(1)
    rc = 137 if outcome else p.returncode
    rec = {"cmd": cmd, "exit": rc, "outcome": outcome or "finished", "peak_gb": round(peak / (1 << 30), 2),
           "seconds": round(time.monotonic() - t0, 1), "cap_gb": a.cap_gb,
           "platform": sys.platform, "architecture": platform.machine(),
           "memory_metric": "sum(VmRSS + VmSwap)" if sys.platform.startswith("linux") else "sum(top mem: resident + compressed)",
           "memory_unit": "GiB", "peak_process_count": peak_process_count}
    if sys.platform.startswith("linux"):
        try:
            host = Path("/proc/meminfo").read_text()
            rec["host_memory_gb"] = round(int(re.search(r"^MemTotal:\s+(\d+)\s+kB", host, re.M).group(1)) / (1 << 20), 2)
        except (OSError, AttributeError):
            pass  # Diagnostics must not change the command's result.
    if a.log:
        with open(a.log, "w") as f:
            json.dump(rec, f)
    print(json.dumps(rec), file=sys.stderr)
    sys.exit(rc)


if __name__ == "__main__":
    main()
