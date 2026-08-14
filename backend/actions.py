"""Action Manager — ponto único de mutação de VALOR dos contadores.

Botões da interface, hotkeys globais, e no futuro Stream Deck / Twitch / plugins
passam TODOS por aqui. Assim a lógica nunca é duplicada e ganhamos um único lugar
para (futuramente) histórico, desfazer/refazer, estatísticas e automações.

Fluxo de cada ação::

    dispatch(action, counter_id)
        │
        ├── valida
        ├── aplica no CounterManager (salva JSON)
        ├── registra evento
        └── notifica o WebSocket  (Controle + Overlay atualizam)

`dispatch` é seguro para ser chamado de QUALQUER thread (ex.: a thread do
listener de hotkeys), pois a notificação do WebSocket é agendada no event loop
via asyncio.run_coroutine_threadsafe.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from . import logger


class ActionManager:
    ACTIONS = {"inc", "dec", "reset", "set"}

    def __init__(self, counters) -> None:
        self.counters = counters
        self._push: Optional[Callable[[], Any]] = None   # fábrica de corrotina de broadcast
        self._loop = None                                # event loop principal
        self._listeners: list[Callable[[dict], None]] = []
        self.events: list[dict] = []                     # histórico da sessão (stats)
        self._max_events = 1000

    # ------------------------------------------------------------------ setup
    def set_push(self, push_coro_factory: Callable[[], Any]) -> None:
        """Recebe uma função que RETORNA a corrotina de broadcast dos contadores."""
        self._push = push_coro_factory

    def set_loop(self, loop) -> None:
        self._loop = loop

    def on_event(self, fn: Callable[[dict], None]) -> None:
        self._listeners.append(fn)

    # ---------------------------------------------------------------- dispatch
    def dispatch(
        self,
        action: str,
        counter_id: str,
        amount: Optional[int] = None,
        value: Optional[int] = None,
        notify: bool = True,
    ) -> Optional[dict[str, Any]]:
        if action not in self.ACTIONS:
            logger.log("actions: ação desconhecida '{}'", action)
            return None

        before = self.counters.get(counter_id)
        if before is None:
            logger.log("actions: elemento {} NÃO existe (o atalho aponta para um elemento excluído?)", counter_id)
        before_val = before["value"] if before else None

        # Timer: hotkey/botão de inc ou dec vira play/pause; reset zera.
        if before is not None and before.get("type") == "timer":
            if action in ("inc", "dec"):
                c = self.counters.timer_op(counter_id, "toggle")
            elif action == "reset":
                c = self.counters.timer_op(counter_id, "reset")
            else:
                c = None
            if c is None:
                return None
            self._record({"action": f"timer_{action}", "counter_id": counter_id,
                          "before": before_val, "after": c.get("elapsed"), "ts": time.time()})
            if notify:
                self._notify()
            return c

        if action == "inc":
            c = self.counters.increment(counter_id, amount)
        elif action == "dec":
            c = self.counters.decrement(counter_id, amount)
        elif action == "reset":
            c = self.counters.reset(counter_id)
        else:  # set
            c = self.counters.set_value(counter_id, int(value or 0))

        if c is None:
            return None

        self._record({
            "action": action,
            "counter_id": counter_id,
            "before": before_val,
            "after": c["value"],
            "ts": time.time(),
        })
        if notify:
            self._notify()
        return c

    # ------------------------------------------------------------------ interno
    def _record(self, evt: dict) -> None:
        self.events.append(evt)
        if len(self.events) > self._max_events:
            self.events.pop(0)
        for fn in self._listeners:
            try:
                fn(evt)
            except Exception:
                pass

    def _notify(self) -> None:
        """Agenda o broadcast no event loop, a partir de qualquer thread."""
        if not self._push or not self._loop:
            logger.log("actions: broadcast pulado (push={}, loop={})", bool(self._push), bool(self._loop))
            return
        try:
            import asyncio
            asyncio.run_coroutine_threadsafe(self._push(), self._loop)
        except Exception as exc:
            logger.log("actions: broadcast FALHOU: {}", exc)
