"""Gerenciador de conexões WebSocket — responsável pelo broadcast.

Sempre que um contador (ou o tema) muda, o servidor chama `broadcast(...)`
e todos os navegadores conectados (overlay e admin) recebem a atualização
em tempo real, sem precisar dar F5.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active.append(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active:
                self.active.remove(websocket)

    async def send_personal(self, message: dict[str, Any], websocket: WebSocket) -> None:
        try:
            await websocket.send_json(message)
        except Exception:
            await self.disconnect(websocket)

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Envia a mensagem para todos EM PARALELO; remove conexões que falharem.

        Os envios são concorrentes (asyncio.gather) para que um cliente lento
        ou travado (buffer cheio no OBS/navegador) não atrase os demais.
        """
        async with self._lock:
            targets = list(self.active)
        if not targets:
            return

        results = await asyncio.gather(
            *(ws.send_json(message) for ws in targets),
            return_exceptions=True,
        )
        dead = [ws for ws, r in zip(targets, results) if isinstance(r, BaseException)]

        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self.active:
                        self.active.remove(ws)

    @property
    def count(self) -> int:
        return len(self.active)
