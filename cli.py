import typer
from pathlib import Path
from typing import Optional
from core.audio_object import AudioObject
from database.db import init_db, get_db_connection

app = typer.Typer(help="Automated Beat Generator CLI")


@app.callback()
def callback():
    """
    Automated Beat Generator CLI tool.
    """
    # Ensure database table exists
    init_db()


@app.command()
def add_sample(
    name: str = typer.Argument(..., help="Name of the audio sample"),
    filepath: Optional[str] = typer.Option(None, "--file", "-f", help="Path to audio file"),
    duration: float = typer.Option(0.0, "--duration", "-d", help="Duration in seconds")
):
    """
    Add an audio sample to the beat generator library.
    """
    audio_obj = AudioObject(name=name, filepath=Path(filepath) if filepath else None, duration=duration)
    
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO audio_objects (name, filepath, duration, is_composite) VALUES (?, ?, ?, ?)",
            (audio_obj.name, str(audio_obj.filepath) if audio_obj.filepath else None, audio_obj.duration, 0)
        )
        conn.commit()
        sample_id = cursor.lastrowid

    typer.echo(f"Successfully registered AudioObject [ID: {sample_id}] '{audio_obj.name}' (Duration: {audio_obj.duration}s)")


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

