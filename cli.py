import typer
from pathlib import Path
from typing import Optional
from core.audio_object import AudioObject

app = typer.Typer(help="Automated Beat Generator CLI")


@app.callback()
def callback():
    """
    Automated Beat Generator CLI tool.
    """
    pass


@app.command()
def add_sample(
    name: str = typer.Argument(..., help="Name of the audio sample"),
    filepath: Optional[str] = typer.Option(None, "--file", "-f", help="Path to audio file"),
    duration: float = typer.Option(0.0, "--duration", "-d", help="Duration in seconds")
):
    """
    Register an audio sample (GAIA library manager handles asset vaults).
    """
    audio_obj = AudioObject(name=name, filepath=Path(filepath) if filepath else None, duration=duration)
    typer.echo(f"Created AudioObject '{audio_obj.name}' (Duration: {audio_obj.duration}s). Note: Library assets are managed via GAIA.")


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Host address to bind"),
    port: int = typer.Option(8000, "--port", "-p", help="Port to listen on"),
    reload: bool = typer.Option(True, "--reload/--no-reload", help="Enable auto-reload"),
    debug: bool = typer.Option(True, "--debug/--no-debug", help="Enable debug logging"),
):
    """
    Launch the Beat Generator web server and API with debug terminal output.
    """
    import uvicorn
    import logging

    log_level = "debug" if debug else "info"
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        force=True
    )
    typer.echo(f"Starting Beat Generator server on http://{host}:{port} (log level: {log_level})...")
    uvicorn.run("api:app", host=host, port=port, reload=reload, log_level=log_level)


if __name__ == "__main__":
    app()

