#!/usr/bin/env python3
"""
Launcher script for Beat Generator application.
Runs the FastAPI server with live reload and debug logging enabled by default.
"""

import sys
import argparse
import logging
import uvicorn


def main():
    parser = argparse.ArgumentParser(
        description="Launch the Beat Generator server with terminal debug output."
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host address to bind (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to listen on (default: 8000)"
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="Disable automatic code reloading"
    )
    parser.add_argument(
        "--log-level",
        default="debug",
        choices=["debug", "info", "warning", "error", "critical"],
        help="Logging level for terminal output (default: debug)"
    )

    args = parser.parse_args()

    # Configure Python root logging to output formatted logs to stdout
    log_level = getattr(logging, args.log_level.upper(), logging.DEBUG)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        force=True
    )

    logger = logging.getLogger("beat_generator")
    logger.info("==================================================")
    logger.info(f" Starting Beat Generator Server")
    logger.info(f" Server URL: http://{args.host}:{args.port}")
    logger.info(f" Debug Logging: ACTIVE (level={args.log_level.upper()})")
    logger.info("==================================================")

    uvicorn.run(
        "api:app",
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
        log_level=args.log_level.lower()
    )


if __name__ == "__main__":
    main()
