"""No-Docker mode: DATABASE_URL=embedded (or embedded-test) runs PostgreSQL from the `pgserver` pip package.
The data lives in %LOCALAPPDATA%\\CarbonKhata\\pgdata (Windows) or ~/.local/share/carbonkhata/pgdata, outside the repo,
so a space in the project path never reaches PostgreSQL. The server keeps running between commands; any
process that asks for it reuses the running one."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

_cache: dict[str, str] = {}


def data_dir() -> Path:
    base = os.environ.get("CARBONKHATA_DATA_DIR")
    if base:
        return Path(base)
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "CarbonKhata" / "pgdata"
    return Path.home() / ".local" / "share" / "carbonkhata" / "pgdata"


def resolve(url: str) -> str:
    """'embedded' → psycopg URL of the embedded server's 'carbonkhata' database ('embedded-test' → 'carbonkhata_test')."""
    if not url.startswith("embedded"):
        return url
    if url in _cache:
        return _cache[url]
    try:
        import pgserver
    except ImportError as e:
        raise RuntimeError("DATABASE_URL=embedded needs the 'pgserver' package: pip install pgserver") from e
    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    srv = pgserver.get_server(str(d), cleanup_mode=None)  # keep running after this process exits
    dbname = "carbonkhata_test" if url == "embedded-test" else "carbonkhata"
    u = urlsplit(srv.get_uri())
    # Talk to the server directly (pgserver's psql() helper breaks on paths containing spaces).
    import psycopg
    admin = urlunsplit(("postgresql", u.netloc, "/postgres", u.query, ""))
    with psycopg.connect(admin, autocommit=True) as c:
        if not c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone():
            c.execute(f'CREATE DATABASE "{dbname}"')
    out = urlunsplit(("postgresql+psycopg", u.netloc, f"/{dbname}", u.query, ""))
    _cache[url] = out
    return out


def stop():
    import pgserver
    pgserver.get_server(str(data_dir()), cleanup_mode="stop").cleanup()
