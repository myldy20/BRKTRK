#!/bin/sh
set -eu

usage() {
    echo "usage: $0 <brk_modal_p45_benchmark> <output-directory>" >&2
    exit 2
}

[ "$#" -eq 2 ] || usage
BENCHMARK="$1"
OUTPUT_DIR="$2"

[ -x "$BENCHMARK" ] || {
    echo "benchmark executable is not runnable: $BENCHMARK" >&2
    exit 2
}

mkdir -p "$OUTPUT_DIR"
REPORT="$OUTPUT_DIR/brk-modal-target-benchmark.json"
SYSTEM="$OUTPUT_DIR/target-system.json"
STDOUT_LOG="$OUTPUT_DIR/benchmark-stdout.txt"

json_escape() {
    # JSON-safe single-line text for the small metadata values collected here.
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g'
}

read_first() {
    for path in "$@"; do
        if [ -r "$path" ]; then
            head -n 1 "$path" 2>/dev/null || true
            return 0
        fi
    done
    printf ''
}

CPU_MODEL="$(
    if [ -r /proc/cpuinfo ]; then
        sed -n -e 's/^model name[[:space:]]*:[[:space:]]*//p' \
               -e 's/^Hardware[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo | head -n 1
    fi
)"
UNAME="$(uname -a 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"
CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || printf '0')"
GOVERNOR="$(read_first /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
CUR_FREQ_KHZ="$(read_first /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq)"
MIN_FREQ_KHZ="$(read_first /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq)"
MAX_FREQ_KHZ="$(read_first /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq)"
TEMP_MILLIC="$(read_first /sys/class/thermal/thermal_zone0/temp)"
MEM_TOTAL_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
MEM_AVAILABLE_BEFORE_KB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
BENCHMARK_SHA256="$(sha256sum "$BENCHMARK" 2>/dev/null | awk '{print $1}' || true)"

cat > "$SYSTEM" <<EOF
{
  "schema": "brk-modal-p45-target-system-v1",
  "capturedAtUtc": "$(json_escape "$DATE_UTC")",
  "uname": "$(json_escape "$UNAME")",
  "architecture": "$(json_escape "$ARCH")",
  "cpuModel": "$(json_escape "$CPU_MODEL")",
  "onlineCpuCount": ${CORES:-0},
  "cpuGovernor": "$(json_escape "$GOVERNOR")",
  "cpuCurrentFrequencyKHzBefore": "$(json_escape "$CUR_FREQ_KHZ")",
  "cpuMinimumFrequencyKHz": "$(json_escape "$MIN_FREQ_KHZ")",
  "cpuMaximumFrequencyKHz": "$(json_escape "$MAX_FREQ_KHZ")",
  "thermalZone0MilliCelsiusBefore": "$(json_escape "$TEMP_MILLIC")",
  "memoryTotalKiB": ${MEM_TOTAL_KB:-0},
  "memoryAvailableKiBBefore": ${MEM_AVAILABLE_BEFORE_KB:-0},
  "benchmarkSha256": "$(json_escape "$BENCHMARK_SHA256")"
}
EOF

"$BENCHMARK" "$REPORT" > "$STDOUT_LOG" 2>&1

CUR_FREQ_AFTER_KHZ="$(read_first /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq)"
TEMP_AFTER_MILLIC="$(read_first /sys/class/thermal/thermal_zone0/temp)"
MEM_AVAILABLE_AFTER_KB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"

python3 - "$SYSTEM" "$CUR_FREQ_AFTER_KHZ" "$TEMP_AFTER_MILLIC" "$MEM_AVAILABLE_AFTER_KB" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["cpuCurrentFrequencyKHzAfter"] = sys.argv[2]
data["thermalZone0MilliCelsiusAfter"] = sys.argv[3]
data["memoryAvailableKiBAfter"] = int(sys.argv[4] or 0)
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

python3 - "$REPORT" "$SYSTEM" <<'PY'
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
system_path = Path(sys.argv[2])
report = json.loads(report_path.read_text(encoding="utf-8"))
system = json.loads(system_path.read_text(encoding="utf-8"))
assert report["schema"] == "brk-modal-p45-benchmark-v1"
assert report["mode"] == "target-full"
assert report["sampleRate"] == 48000
assert report["blockSize"] == 128
assert len(report["cases"]) == 19
assert system["schema"] == "brk-modal-p45-target-system-v1"
assert all(case["p99Microseconds"] >= 0 for case in report["cases"])
print("target_case_count=19")
print("target_system=" + system.get("cpuModel", "unknown"))
for case in report["cases"]:
    print(
        f"{case['id']}: p99_us={case['p99Microseconds']:.3f} "
        f"deadline={case['p99DeadlineFraction']:.4f}"
    )
PY

printf 'target benchmark complete: %s\n' "$OUTPUT_DIR"
