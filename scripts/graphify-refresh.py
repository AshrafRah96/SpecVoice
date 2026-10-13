#!/usr/bin/env python3
"""Refresh the global Graphify code graph, retaining this repo's source named build."""
import json
import os
from pathlib import Path
import shutil
import sys

if "PYTHONHASHSEED" not in os.environ:
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]])

try:
    import graphify.detect as detection
except ModuleNotFoundError:
    executable = shutil.which("graphify")
    if not executable:
        raise SystemExit("Install the global Graphify CLI before refreshing the graph.")
    interpreter = Path(executable).read_text().splitlines()[0].removeprefix("#!")
    if not Path(interpreter).is_file() or Path(interpreter).resolve() == Path(sys.executable).resolve():
        raise SystemExit("Run this script using the Python interpreter that owns Graphify.")
    os.execv(interpreter, [interpreter, str(Path(__file__).resolve()), *sys.argv[1:]])

def refresh():
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    source_builds = {
        root / "src/lib/build",
        root / "tests/lib/build",
        root / "src/app/api/sessions/[id]/build",
    }
    original = detection._is_noise_dir


    def repository_noise(part, parent=None):
        # Process-local workaround; leave the global skill, installation and other noise rules intact.
        if part == "build" and parent is not None and (Path(parent) / part).resolve() in source_builds:
            return False
        return original(part, parent)


    detection._is_noise_dir = repository_noise
    corpus = detection.detect(root)
    files = {Path(value).resolve() for value in corpus["files"]["code"]}
    required = {file for directory in source_builds for file in directory.glob("*.ts")}
    missing = required - files
    if missing:
        raise SystemExit("Graphify omitted source: " + ", ".join(str(path.relative_to(root)) for path in sorted(missing)))
    if any(root / "node_modules" in file.parents or root / "build" in file.parents for file in files):
        raise SystemExit("Graphify included a generated or dependency directory")
    print(f"Graphify coverage: {len(files)} code files; {len(required)} build source/test files included.")
    if sys.argv[1:] == ["--check"]:
        raise SystemExit(0)
    if sys.argv[1:]:
        raise SystemExit("Usage: python3 scripts/graphify-refresh.py [--check]")

    from graphify.__main__ import main

    sys.argv = ["graphify", "update", str(root)]
    main()
    graph = json.loads((root / "graphify-out/graph.json").read_text())
    locations = {str(node.get("source_file", node.get("source_location", ""))) for node in graph["nodes"]}
    for path in required:
        if not any(str(path.relative_to(root)) in location for location in locations):
            raise SystemExit(f"Refreshed graph has no source evidence for {path.relative_to(root)}")
    sys.argv = ["graphify", "export", "html"]
    main()


if __name__ == "__main__":
    refresh()
