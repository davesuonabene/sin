"""Run the Python test suite in full or by section without repository pollution."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, message=".*datetime.datetime.utcnow.*")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = PROJECT_ROOT / "tests"

SUITES = {
    "all": ["test_*.py"],
    "quick": ["test_*.py"],
    "full": ["test_*.py"],
    "core": ["test_core.py", "test_stretching.py"],
    "cli": ["test_cli.py", "test_gaia_metadata_cli.py"],
    "gaia": [
        "test_gaia_library.py",
        "test_gaia_container_library.py",
        "test_gaia_metadata_cli.py",
        "test_gaia_deletion.py",
        "test_gaia_profiles.py",
        "test_gaia_playlists.py",
    ],
    "projects": [
        "test_gaia_projects.py",
        "test_gaia_media_editor.py",
        "test_gaia_reconciler.py",
    ],
}


def detect_changed_patterns() -> list[str]:
    """Detect which test files to run based on git status and diff."""
    try:
        res = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        changed_paths = [
            line[3:].strip() for line in res.stdout.splitlines() if len(line) > 3
        ]
    except Exception:
        return SUITES["quick"]

    if not changed_paths:
        return SUITES["quick"]

    patterns: set[str] = set()
    for p in changed_paths:
        p_lower = p.replace("\\", "/").lower()
        if "tests/test_" in p_lower and p_lower.endswith(".py"):
            patterns.add(Path(p).name)
        elif "core/" in p_lower or "ermes/" in p_lower:
            patterns.update(SUITES["core"])
            patterns.update(SUITES["cli"])
        elif "cli.py" in p_lower:
            patterns.update(SUITES["cli"])
        elif "gaia/" in p_lower:
            patterns.update(SUITES["gaia"])
            patterns.update(SUITES["projects"])
        elif "presets/" in p_lower or "saves/" in p_lower:
            patterns.update(SUITES["cli"])

    return sorted(patterns) if patterns else SUITES["quick"]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run SIN and GAIA Python test suites in full or modular sections.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Suites:
  quick     Run fast unit suite (default, skips expensive regressions)
  full      Run all unit, scale, and integration tests
  core      Audio engine, DSP, and stretching (test_core, test_stretching)
  cli       CLI commands, preset QA, and options (test_cli, test_gaia_metadata_cli)
  gaia      GAIA library management and vaults
  projects  GAIA project manifests, media editor, and reconciler

Examples:
  python tests/run.py
  python tests/run.py full
  python tests/run.py --changed
  python tests/run.py core -k stretch
  python tests/run.py cli
  python tests/run.py test_core.py:TestCoreAudio.test_simple_graph
""",
    )
    parser.add_argument(
        "targets",
        nargs="*",
        help="Optional suite name ('quick', 'full', 'core', 'gaia', 'projects', 'cli') or test file/method.",
    )
    parser.add_argument(
        "-s", "--suite",
        choices=list(SUITES.keys()),
        default=None,
        help="Target suite preset.",
    )
    parser.add_argument(
        "-p", "--pattern",
        default=None,
        help="Custom test filename pattern (e.g. 'test_core*.py').",
    )
    parser.add_argument(
        "-k", "--keyword",
        default=None,
        help="Only run tests whose ID contains the given substring (case-insensitive).",
    )
    parser.add_argument(
        "--slow",
        action="store_true",
        help="Include scale regressions and stress tests marked with @slow.",
    )
    parser.add_argument(
        "--integration",
        action="store_true",
        help="Include tests requiring the developer's real GAIA database/vaults.",
    )
    parser.add_argument(
        "--changed",
        action="store_true",
        help="Run tests targeting uncommitted or modified repository files.",
    )
    parser.add_argument(
        "-x", "--failfast",
        action="store_true",
        help="Stop on first failure or error.",
    )
    parser.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Minimal output.",
    )
    parser.add_argument(
        "--list-suites",
        action="store_true",
        help="List available test suites and exit.",
    )
    return parser.parse_args(argv)


def filter_suite_by_keyword(suite: unittest.TestSuite, keyword: str) -> unittest.TestSuite:
    """Recursively filter a TestSuite to tests whose id matches the keyword."""
    filtered = unittest.TestSuite()
    kw = keyword.lower()
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            sub = filter_suite_by_keyword(item, keyword)
            if sub.countTestCases() > 0:
                filtered.addTest(sub)
        elif isinstance(item, unittest.TestCase):
            if kw in item.id().lower():
                filtered.addTest(item)
    return filtered


def resolve_patterns_and_names(args: argparse.Namespace) -> tuple[list[str], list[str]]:
    """Return a tuple of (discovery_patterns, explicit_test_names)."""
    if args.changed:
        return detect_changed_patterns(), []
    if args.suite:
        return SUITES[args.suite], []
    if args.pattern:
        return [args.pattern], []
    if args.targets:
        patterns: list[str] = []
        names: list[str] = []
        for target in args.targets:
            normalized = target.strip().lower()
            if normalized in SUITES:
                patterns.extend(SUITES[normalized])
                continue

            # Check if target specifies class/method, e.g. "test_core.py:TestCoreAudio.test_foo"
            if ":" in target:
                file_part, test_part = target.split(":", 1)
                file_part = Path(file_part).name
                stem = Path(file_part).stem
                test_part = test_part.lstrip(":")
                names.append(f"tests.{stem}.{test_part}")
                continue

            clean_target = Path(target).name
            if clean_target.endswith(".py"):
                patterns.append(clean_target)
            elif clean_target.startswith("test_"):
                patterns.append(f"{clean_target}*.py")
            else:
                patterns.append(f"test_{clean_target}*.py")
        return patterns, names
    return SUITES["quick"], []


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    # Automatically enable slow & integration on 'full'
    is_full = (args.suite == "full") or ("full" in [t.lower() for t in args.targets])
    if is_full:
        args.slow = True
        args.integration = True

    if args.slow:
        os.environ["SIN_TEST_SLOW"] = "1"
    if args.integration:
        os.environ["SIN_TEST_INTEGRATION"] = "1"

    if args.list_suites:
        print("Available test suites:")
        for name, files in SUITES.items():
            print(f"  {name:10} -> {', '.join(files)}")
        return 0

    os.environ["PYTHONIOENCODING"] = "utf-8"
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
                environment["PYTHONIOENCODING"] = "utf-8"
                if args.slow:
                    environment["SIN_TEST_SLOW"] = "1"
                if args.integration:
                    environment["SIN_TEST_INTEGRATION"] = "1"
                try:
                    return subprocess.call(
                        [str(candidate), "-B", str(Path(__file__).resolve()), *sys.argv[1:]],
                        cwd=PROJECT_ROOT,
                        env=environment,
                    )
                except OSError:
                    pass

    patterns, explicit_names = resolve_patterns_and_names(args)
    previous_cwd = Path.cwd()
    start_time = time.perf_counter()

    with tempfile.TemporaryDirectory(prefix="sin-test-run-") as runtime_directory:
        runtime_path = Path(runtime_directory)
        # api.py serves this path at import time; the entire sandbox is removed
        # after the run, along with disk renders and export files.
        (runtime_path / "static").mkdir()
        os.chdir(runtime_path)
        try:
            suite = unittest.TestSuite()

            # Load explicit test names first
            for name in explicit_names:
                try:
                    loaded = unittest.defaultTestLoader.loadTestsFromName(name)
                    suite.addTests(loaded)
                except Exception as e:
                    print(f"Error loading explicit test '{name}': {e}", file=sys.stderr)

            # Discover patterns
            for pattern in patterns:
                if pattern.endswith(".py") and "*" not in pattern:
                    module_name = f"tests.{Path(pattern).stem}"
                    try:
                        loaded = unittest.defaultTestLoader.loadTestsFromName(module_name)
                        suite.addTests(loaded)
                        continue
                    except Exception:
                        pass
                discovered = unittest.defaultTestLoader.discover(
                    start_dir=str(TEST_ROOT),
                    pattern=pattern if pattern.endswith(".py") else f"{pattern}.py",
                    top_level_dir=str(PROJECT_ROOT),
                )
                suite.addTests(discovered)

            if args.keyword:
                suite = filter_suite_by_keyword(suite, args.keyword)

            total_cases = suite.countTestCases()
            if total_cases == 0:
                print(f"No tests matched the requested target/keyword (patterns: {patterns}, keyword: {args.keyword})")
                return 0

            verbosity = 1 if args.quiet else 2
            runner = unittest.TextTestRunner(verbosity=verbosity, failfast=args.failfast)
            result = runner.run(suite)
        finally:
            os.chdir(previous_cwd)

    duration = time.perf_counter() - start_time
    if not args.quiet:
        print(f"\n[SUITE RUN SUMMARY] Ran {result.testsRun} tests in {duration:.2f}s | Failures: {len(result.failures)} | Errors: {len(result.errors)}")

    if not result.wasSuccessful():
        failed_ids = [test.id() for test, _ in result.failures + result.errors]
        print(f"[FAILURES DETECTED] {len(failed_ids)} test(s) failed:")
        for fid in failed_ids[:5]:
            print(f"  - {fid} (rerun with: python tests/run.py -k {fid.split('.')[-1]})")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
