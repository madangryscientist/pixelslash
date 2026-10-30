"""Samples pixelslash-web's and pixelslash-diff's memory on the CT; driven by rss-burst.ts over ssh.

Prints one JSON line per sample (every INTERVAL s): each process class's resident MB (VmRSS, summed),
each unit's cgroup memory (current, swap, anon, file) and the unit's `high` event count. A line on
stdin `mark NAME` prints a mark line with every class's VmHWM (the peak since the last mark) and then
resets VmHWM (clear_refs 5), so the next mark is the peak of the phase in between.
Needs root (clear_refs) and cgroup v2. Read-only apart from the HWM reset.

PS-220: `CG`, `WEB_UNIT` and `DIFF_UNIT` point it at other cgroups, so the same run can sample two
`systemd-run --user` units on a desktop (perf/rss-burst.ts --local). Processes of the web unit are
workerd, `vite` (vite preview), `host` (deploy/ssh/serve.ts, PS-220) or `other` (bunx).
"""

import json
import os
import select
import sys
import time

INTERVAL = float(os.environ.get("INTERVAL", "0.25"))
CG = os.environ.get("CG", "/sys/fs/cgroup/system.slice/")
UNITS = {
    "web": os.environ.get("WEB_UNIT", "pixelslash-web.service"),
    "diff": os.environ.get("DIFF_UNIT", "pixelslash-diff.service"),
}


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def kb(pid, field):
    for line in read(f"/proc/{pid}/status").splitlines():
        if line.startswith(field + ":"):
            return int(line.split()[1])
    return 0


def klass(unit, pid):
    comm = read(f"/proc/{pid}/comm").strip()
    cmd = read(f"/proc/{pid}/cmdline")
    if unit == "diff":
        return "sidecar"
    if comm.startswith("workerd"):
        return "workerd"
    if "vite" in cmd:
        return "vite"
    if "serve.ts" in cmd:
        return "host"
    return "other"  # bunx and anything else in the unit


def pids():
    out = []
    for unit, name in UNITS.items():
        for pid in read(f"{CG}{name}/cgroup.procs").split():
            out.append((klass(unit, pid), pid))
    return out


def stat(unit, key):
    for line in read(f"{CG}{UNITS[unit]}/memory.stat").splitlines():
        k, v = line.split()
        if k == key:
            return int(v)
    return 0


def number(path):
    text = read(path).strip()
    return int(text) if text.isdigit() else 0


def mb(n):
    return round(n / 1048576, 1)


def sample():
    rss = {"workerd": 0, "vite": 0, "host": 0, "other": 0, "sidecar": 0}
    for cls, pid in pids():
        rss[cls] += kb(pid, "VmRSS")
    row = {"t": round(time.time(), 3)}
    for cls, v in rss.items():
        row[cls] = round(v / 1024, 1)
    for unit, name in UNITS.items():
        row[unit + "_cur"] = mb(number(f"{CG}{name}/memory.current"))
        row[unit + "_swap"] = mb(number(f"{CG}{name}/memory.swap.current"))
        row[unit + "_anon"] = mb(stat(unit, "anon"))
        row[unit + "_file"] = mb(stat(unit, "file"))
    high = 0
    for line in read(f"{CG}{UNITS['web']}/memory.events").splitlines():
        if line.startswith("high "):
            high = int(line.split()[1])
    row["web_high_events"] = high
    return row


def mark(name):
    hwm = {"workerd": 0, "vite": 0, "host": 0, "other": 0, "sidecar": 0}
    for cls, pid in pids():
        hwm[cls] += kb(pid, "VmHWM")
        try:
            with open(f"/proc/{pid}/clear_refs", "w") as f:
                f.write("5")
        except OSError:
            pass
    row = {"mark": name, "t": round(time.time(), 3)}
    for cls, v in hwm.items():
        row[cls + "_hwm"] = round(v / 1024, 1)
    return row


def emit(row):
    sys.stdout.write(json.dumps(row) + "\n")
    sys.stdout.flush()


while True:
    ready, _, _ = select.select([sys.stdin], [], [], INTERVAL)
    if ready:
        line = sys.stdin.readline()
        if not line:
            break
        words = line.split()
        if len(words) == 2 and words[0] == "mark":
            emit(mark(words[1]))
    emit(sample())
