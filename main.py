from __future__ import annotations

import asyncio
import argparse
import socket
import threading
import time
import uuid
import webbrowser
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import quote

import aiofiles
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "download"
UPLOAD_DIR = BASE_DIR / "upload"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
CHUNK_SIZE = 1024 * 1024

for directory in (DOWNLOAD_DIR, UPLOAD_DIR, STATIC_DIR, TEMPLATES_DIR):
    directory.mkdir(exist_ok=True)


def get_lan_ip() -> str:
    """获取当前机器在局域网中的 IPv4 地址。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def build_urls(port: int) -> dict[str, str]:
    lan_ip = get_lan_ip()
    return {
        "host": lan_ip,
        "port": str(port),
        "local_url": f"http://127.0.0.1:{port}",
        "lan_url": f"http://{lan_ip}:{port}",
    }


@dataclass
class Transfer:
    id: str
    filename: str
    direction: str
    total: int
    transferred: int = 0
    started_at: float = 0.0
    updated_at: float = 0.0

    @property
    def speed(self) -> float:
        elapsed = max(time.monotonic() - self.started_at, 0.001)
        return self.transferred / elapsed

    @property
    def percent(self) -> float:
        if self.total <= 0:
            return 0.0
        return min(self.transferred / self.total * 100, 100.0)


class TransferHub:
    def __init__(self) -> None:
        self.active: dict[str, Transfer] = {}
        self.clients: set[WebSocket] = set()
        self.total_bytes = 0
        self.completed_count = 0
        self.started_at = time.monotonic()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.clients.add(websocket)
        await self.send_snapshot(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.clients.discard(websocket)
        await self.broadcast()

    async def begin(self, filename: str, direction: str, total: int) -> str:
        transfer_id = uuid.uuid4().hex
        now = time.monotonic()
        async with self._lock:
            self.active[transfer_id] = Transfer(
                id=transfer_id,
                filename=filename,
                direction=direction,
                total=total,
                started_at=now,
                updated_at=now,
            )
        await self.broadcast()
        return transfer_id

    async def add_bytes(self, transfer_id: str, size: int) -> None:
        async with self._lock:
            transfer = self.active.get(transfer_id)
            if transfer is None:
                return
            transfer.transferred += size
            transfer.updated_at = time.monotonic()
            self.total_bytes += size
        await self.broadcast(throttle=True)

    async def finish(self, transfer_id: str) -> None:
        async with self._lock:
            if transfer_id in self.active:
                self.active.pop(transfer_id)
                self.completed_count += 1
        await self.broadcast()

    async def snapshot(self) -> dict:
        async with self._lock:
            transfers = list(self.active.values())
            total_speed = sum(item.speed for item in transfers)
            return {
                "online": len(self.clients),
                "active_count": len(transfers),
                "total_speed": total_speed,
                "total_bytes": self.total_bytes,
                "completed_count": self.completed_count,
                "uptime": time.monotonic() - self.started_at,
                "transfers": [
                    {
                        "id": item.id,
                        "filename": item.filename,
                        "direction": item.direction,
                        "total": item.total,
                        "transferred": item.transferred,
                        "speed": item.speed,
                        "percent": item.percent,
                    }
                    for item in transfers
                ],
            }

    async def send_snapshot(self, websocket: WebSocket) -> None:
        await websocket.send_json(await self.snapshot())

    async def broadcast(self, throttle: bool = False) -> None:
        if throttle:
            now = time.monotonic()
            if getattr(self, "_last_broadcast", 0.0) + 0.35 > now:
                return
            self._last_broadcast = now

        data = await self.snapshot()
        stale: list[WebSocket] = []
        async with self._lock:
            clients = list(self.clients)
        for client in clients:
            try:
                await client.send_json(data)
            except Exception:
                stale.append(client)
        if stale:
            async with self._lock:
                for client in stale:
                    self.clients.discard(client)


hub = TransferHub()

# 读取 HTML 模板
_HTML_CONTENT: str | None = None


def get_html() -> str:
    global _HTML_CONTENT
    if _HTML_CONTENT is None:
        _HTML_CONTENT = (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")
    return _HTML_CONTENT


@asynccontextmanager
async def lifespan(app: FastAPI):
    broadcaster = asyncio.create_task(periodic_broadcast())
    try:
        yield
    finally:
        broadcaster.cancel()


app = FastAPI(title="Laneway", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


async def periodic_broadcast() -> None:
    while True:
        await asyncio.sleep(1)
        await hub.broadcast()


def safe_path(directory: Path, filename: str) -> Path:
    name = Path(filename).name
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="文件名无效")
    path = (directory / name).resolve()
    if directory.resolve() not in path.parents and path != directory.resolve():
        raise HTTPException(status_code=400, detail="文件路径无效")
    return path


def unique_upload_path(filename: str) -> Path:
    original = Path(filename).name or "upload.bin"
    target = safe_path(UPLOAD_DIR, original)
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    counter = 1
    while True:
        candidate = UPLOAD_DIR / f"{stem}_{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def file_info(path: Path, route: str = "download") -> dict:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "url": f"/{route}/{quote(path.name)}",
    }


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(get_html())


@app.get("/api/files")
async def list_files():
    files = [file_info(path, "download") for path in DOWNLOAD_DIR.iterdir() if path.is_file()]
    files.sort(key=lambda item: item["mtime"], reverse=True)
    uploads = [file_info(path, "uploads") for path in UPLOAD_DIR.iterdir() if path.is_file()]
    uploads.sort(key=lambda item: item["mtime"], reverse=True)
    return {"download": files, "upload": uploads}


@app.get("/api/stats")
async def stats():
    return await hub.snapshot()


@app.get("/api/address")
async def address(request: Request):
    port = request.url.port or 80
    return build_urls(port)


async def upload_size(file: UploadFile) -> int:
    """获取已解析上传文件的真实大小，避免 multipart 边界影响进度。"""
    try:
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(0)
        return size
    except Exception:
        return int(file.headers.get("content-length") or 0)


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    target = unique_upload_path(file.filename or "upload.bin")
    total = await upload_size(file)
    transfer_id = await hub.begin(target.name, "upload", total)
    try:
        async with aiofiles.open(target, "wb") as output:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                await output.write(chunk)
                await hub.add_bytes(transfer_id, len(chunk))
    except Exception:
        if target.exists():
            target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
        await hub.finish(transfer_id)
    return JSONResponse({"ok": True, "filename": target.name, "size": target.stat().st_size})


async def _stream_file(path: Path, direction: str) -> StreamingResponse:
    """通用文件下载流，同时追踪传输速度。"""
    total = path.stat().st_size
    transfer_id = await hub.begin(path.name, direction, total)

    async def stream() -> AsyncGenerator[bytes, None]:
        try:
            async with aiofiles.open(path, "rb") as input_file:
                while True:
                    chunk = await input_file.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    await hub.add_bytes(transfer_id, len(chunk))
                    yield chunk
        finally:
            await hub.finish(transfer_id)

    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(path.name)}",
        "Content-Length": str(total),
    }
    return StreamingResponse(stream(), media_type="application/octet-stream", headers=headers)


@app.get("/download/{filename}")
async def download_file(filename: str):
    path = safe_path(DOWNLOAD_DIR, filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return await _stream_file(path, "download")


@app.get("/uploads/{filename}")
async def download_upload(filename: str):
    path = safe_path(UPLOAD_DIR, filename)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return await _stream_file(path, "download")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(websocket)


def open_browser_later(url: str) -> None:
    def _open() -> None:
        time.sleep(1.2)
        webbrowser.open(url)

    threading.Thread(target=_open, daemon=True).start()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Laneway 局域网文件传输服务")
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="服务监听端口，默认 8000",
    )
    return parser.parse_args()


if __name__ == "__main__":
    import uvicorn

    args = parse_args()
    port = args.port
    urls = build_urls(port)
    print("\n" + "=" * 56)
    print("Laneway 局域网传输服务启动中")
    print(f"本机访问: {urls['local_url']}")
    print(f"局域网访问: {urls['lan_url']}")
    print(f"共享下载目录: {DOWNLOAD_DIR}")
    print(f"上传保存目录: {UPLOAD_DIR}")
    print("按 Ctrl+C 停止服务")
    print("=" * 56 + "\n")
    open_browser_later(urls["local_url"])
    uvicorn.run(app, host="0.0.0.0", port=port)