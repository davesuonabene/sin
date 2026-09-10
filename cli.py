import typer

app = typer.Typer(help="IRIDE node editor CLI")


@app.callback()
def callback():
    """
    IRIDE node editor CLI tool.
    """
    pass


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Host address to bind"),
    port: int = typer.Option(8000, "--port", "-p", help="Port to listen on"),
    reload: bool = typer.Option(True, "--reload/--no-reload", help="Enable auto-reload"),
    debug: bool = typer.Option(True, "--debug/--no-debug", help="Enable debug logging"),
):
    """
    Launch IRIDE and its audio-rendering API with debug terminal output.
    """
    import uvicorn
    import logging

    log_level = "debug" if debug else "info"
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        force=True
    )
    logging.getLogger("numba").setLevel(logging.WARNING)
    typer.echo(f"Starting IRIDE server on http://{host}:{port} (log level: {log_level})...")
    uvicorn.run("api:app", host=host, port=port, reload=reload, log_level=log_level)


if __name__ == "__main__":
    app()
