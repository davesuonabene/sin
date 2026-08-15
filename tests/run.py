"""Run the complete Python suite without writing into the repository."""

from __future__ import annotations

import os
import site
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = PROJECT_ROOT / "tests"


def main() -> int:
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(PROJECT_ROOT))

    # npm scripts do not inherit an activated shell environment. Prefer the
    # checkout's interpreter so dependency loading and native-library caches
    # behave exactly as they do in an activated development shell.
    local_interpreters = [
        PROJECT_ROOT / ".venv" / "Scripts" / "python.exe",
        PROJECT_ROOT / ".venv" / "bin" / "python",
    ]
    if os.environ.get("SIN_TEST_BOOTSTRAPPED") != "1":
        active_interpreter = Path(sys.executable).resolve()
        for candidate in local_interpreters:
            if candidate.is_file() and candidate.resolve() != active_interpreter:
                environment = os.environ.copy()
                environment["SIN_TEST_BOOTSTRAPPED"] = "1"
                try:
                    return subprocess.call(
                        [str(candidate), "-B", str(Path(__file__).resolve())],
                        cwd=PROJECT_ROOT,
                        env=environment,
                    )
                except OSError:
                    pass

    # Fall back to the local packages if a platform prevents re-execution.
    local_site_packages = [
        PROJECT_ROOT / ".venv" / "Lib" / "site-packages",
        PROJECT_ROOT
        / ".venv"
        / "lib"
        / f"python{sys.version_info.major}.{sys.version_info.minor}"
        / "site-packages",
    ]
    for candidate in local_site_packages:
        if candidate.is_dir() and str(candidate) not in sys.path:
            site.addsitedir(str(candidate))

    previous_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="sin-test-run-") as runtime_directory:
        runtime_path = Path(runtime_directory)
        # api.py serves this path at import time; the entire sandbox is removed
        # after the run, along with disk renders and export files.
        (runtime_path / "static").mkdir()
        os.chdir(runtime_path)
        try:
            suite = unittest.defaultTestLoader.discover(
                start_dir=str(TEST_ROOT),
                pattern="test_*.py",
                top_level_dir=str(PROJECT_ROOT),
            )
            result = unittest.TextTestRunner(verbosity=2).run(suite)
        finally:
            os.chdir(previous_cwd)

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
