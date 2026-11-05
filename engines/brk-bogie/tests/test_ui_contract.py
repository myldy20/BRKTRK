#!/usr/bin/env python3
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root / "parameter-registry.json").read_text(encoding="utf-8"))
ui = json.loads((root / "brk-ui.json").read_text(encoding="utf-8"))

params = registry["parameters"]
keys = [item["key"] for item in params]
assert len(keys) == 8
assert len(set(keys)) == len(keys)
assert ui["parameterCount"] == len(keys)

main = next(page for page in ui["pages"] if page["id"] == "main")
assert main["mode"] == "curated"
assert main["controls"] == keys, (
    "Bogie Main UI must expose every registered parameter in registry order; "
    f"registry={keys}, main={main['controls']}"
)

all_pages = [page for page in ui["pages"] if page.get("mode") == "all"]
assert len(all_pages) == 1, "Bogie must provide exactly one descriptor-driven All page"

group_keys = {item["group"] for item in params}
assert group_keys <= set(ui["groupLabels"])

enum_params = [item for item in params if item["type"] == "enum"]
for item in enum_params:
    labels = ui["enumLabels"].get(item["key"])
    assert labels == item["values"], f"enum labels mismatch for {item['key']}"

modulatable = [item["key"] for item in params if item.get("modulatable")]
assert ui["modulation"]["destinations"] == modulatable

print("brk_bogie_ui_contract=PASS")
