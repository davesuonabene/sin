#!/usr/bin/env python3
"""Launch IRIDE and its FastAPI backend."""

import sys
import argparse
import logging
import uvicorn


def main():
    parser = argparse.ArgumentParser(
        description="Launch IRIDE and its audio-rendering API."
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

    logger = logging.getLogger("iride")
    logger.info("==================================================")
    logger.info(" Starting IRIDE Server")
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
