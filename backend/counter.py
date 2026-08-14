"""Gerenciamento dos contadores: CRUD, reordenação e visibilidade.

Formato de um contador::

    {
        "id":      "abc123",     # identificador único
        "name":    "Mortes",     # nome exibido
        "value":   0,            # valor atual (inteiro)
        "step":    1,            # passo de incremento/decremento
        "visible": true,         # aparece no overlay?
        "order":   0             # posição na lista
    }

Concorrência: as mutações podem vir do event loop (rotas HTTP) E da thread do
listener de hotkeys ao mesmo tempo, então todas passam por um RLock.

Persistência: mudanças de VALOR (inc/dec/reset/set/posição) são muito
frequentes — ex.: segurar uma hotkey — então o save vai a disco com um pequeno
debounce. Mudanças estruturais (criar/excluir/renomear/estilo) salvam na hora.
`flush()` força a gravação pendente (chamado no shutdown do servidor).
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Optional

from . import storage

COUNTERS_FILE = "counters.json"
SAVE_DEBOUNCE_S = 0.5
ELEMENT_TYPES = ("counter", "text", "image", "timer", "group")


def _new_id() -> str:
    return "c-" + uuid.uuid4().hex[:10]


class CounterManager:
    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(COUNTERS_FILE)
        self._counters: list[dict[str, Any]] = []
        self._lock = threading.RLock()
        self._save_timer: Optional[threading.Timer] = None
        self.load()

    # ------------------------------------------------------------------ IO
    def load(self) -> list[dict[str, Any]]:
        with self._lock:
            data = storage.load_json(self._path, default={"counters": []})
            counters = data.get("counters", []) if isinstance(data, dict) else []
            # Sanitiza cada contador para garantir todos os campos.
            self._counters = [self._sanitize(c) for c in counters if isinstance(c, dict)]
            self._fix_parents()
            self._normalize_order()
            return self.list()

    def set_path(self, path) -> list[dict[str, Any]]:
        """Aponta para outro arquivo (troca de perfil) e recarrega."""
        with self._lock:
            self.flush()
            self._path = path
            return self.load()

    def save(self) -> None:
        with self._lock:
            self._cancel_timer()
            storage.save_json(self._path, {"counters": self._counters}, backup=True)

    def _save_soon(self) -> None:
        """Agenda um save com debounce (mudanças de valor são frequentes)."""
        with self._lock:
            self._cancel_timer()
            t = threading.Timer(SAVE_DEBOUNCE_S, self.save)
            t.daemon = True
            self._save_timer = t
            t.start()

    def _cancel_timer(self) -> None:
        if self._save_timer is not None:
            self._save_timer.cancel()
            self._save_timer = None

    def flush(self) -> None:
        """Grava imediatamente qualquer save pendente."""
        with self._lock:
            if self._save_timer is not None:
                self.save()

    # --------------------------------------------------------------- helpers
    @staticmethod
    def _sanitize(c: dict[str, Any]) -> dict[str, Any]:
        style = c.get("style")
        order = int(c.get("order", 0))
        # Posição no canvas 1920x1080 (canto superior esquerdo do card).
        try:
            x = float(c.get("x"))
        except (TypeError, ValueError):
            x = 48.0
        try:
            y = float(c.get("y"))
        except (TypeError, ValueError):
            y = 48.0 + order * 96  # empilha por padrão na 1ª vez
        el_type = str(c.get("type", "counter"))
        if el_type not in ELEMENT_TYPES:
            el_type = "counter"
        try:
            started_at = float(c.get("started_at")) if c.get("started_at") else None
        except (TypeError, ValueError):
            started_at = None
        return {
            "id": str(c.get("id") or _new_id()),
            "type": el_type,                        # counter | text | image | timer
            "name": str(c.get("name", "Contador")),
            "value": int(c.get("value", 0)),
            "step": int(c.get("step", 1)) or 1,
            "src": str(c.get("src", "") or ""),     # imagem: URL/caminho
            "running": bool(c.get("running", False)),      # timer
            "elapsed": float(c.get("elapsed", 0) or 0.0),  # timer: segundos acumulados
            "started_at": started_at,                      # timer: epoch do último start
            "visible": bool(c.get("visible", True)),
            "locked": bool(c.get("locked", False)),
            "order": order,
            "x": x,
            "y": y,
            # Grupo pai ("" = raiz do canvas). Validado em _fix_parents().
            "parent": str(c.get("parent", "") or ""),
            # Overrides visuais deste contador (vazio = herda o tema global).
            "style": style if isinstance(style, dict) else {},
        }

    def _normalize_order(self) -> None:
        """Reatribui order = 0..n-1 conforme a ordem atual (sem buracos)."""
        self._counters.sort(key=lambda c: c.get("order", 0))
        for i, c in enumerate(self._counters):
            c["order"] = i

    def _find(self, counter_id: str) -> Optional[dict[str, Any]]:
        return next((c for c in self._counters if c["id"] == counter_id), None)

    # ------------------------------------------------------------- hierarquia
    def _children(self, counter_id: str) -> list[dict[str, Any]]:
        return [c for c in self._counters if c.get("parent") == counter_id]

    def _is_ancestor(self, maybe_ancestor: str, counter_id: str) -> bool:
        """True se `maybe_ancestor` está na cadeia de pais de `counter_id`."""
        seen: set[str] = set()
        cur = self._find(counter_id)
        while cur is not None:
            pid = cur.get("parent") or ""
            if not pid or pid in seen:
                return False
            if pid == maybe_ancestor:
                return True
            seen.add(pid)
            cur = self._find(pid)
        return False

    def _fix_parents(self) -> None:
        """Remove referências de pai inválidas: inexistente, não-grupo ou ciclo."""
        ids = {c["id"]: c for c in self._counters}
        for c in self._counters:
            pid = c.get("parent") or ""
            p = ids.get(pid)
            if pid and (p is None or p.get("type") != "group" or pid == c["id"]):
                c["parent"] = ""
        # Quebra ciclos (grupo dentro do próprio descendente).
        for c in self._counters:
            if c.get("parent") and self._is_ancestor(c["id"], c["id"]):
                c["parent"] = ""

    # --------------------------------------------------------------- leitura
    def list(self) -> list[dict[str, Any]]:
        """Retorna todos os elementos ordenados por `order` (cópias).

        Para timers em execução, `elapsed` já vem calculado até AGORA e
        `started_at` é rebatizado para o momento atual — assim o cliente só
        precisa somar o tempo desde que recebeu os dados (imune a diferença
        de relógio entre servidor e navegador).
        """
        now = time.time()
        with self._lock:
            out = []
            for c in sorted(self._counters, key=lambda x: x["order"]):
                d = dict(c)
                if d.get("type") == "timer" and d.get("running") and d.get("started_at"):
                    d["elapsed"] = float(d["elapsed"]) + (now - d["started_at"])
                    d["started_at"] = now
                out.append(d)
            return out

    def visible(self) -> list[dict[str, Any]]:
        """Apenas os contadores visíveis (para o overlay)."""
        return [c for c in self.list() if c["visible"]]

    def get(self, counter_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            return self._find(counter_id)

    # ------------------------------------------------------------------ CRUD
    def create(
        self,
        name: str = "Novo Contador",
        value: int = 0,
        step: int = 1,
        el_type: str = "counter",
        src: str = "",
        parent: str = "",
    ) -> dict[str, Any]:
        if el_type not in ELEMENT_TYPES:
            el_type = "counter"
        with self._lock:
            # Pai precisa existir e ser um grupo.
            p = self._find(parent) if parent else None
            if parent and (p is None or p.get("type") != "group"):
                parent = ""
            n = len(self._counters)
            counter = {
                "id": _new_id(),
                "type": el_type,
                "name": str(name).strip() or "Novo Contador",
                "value": int(value),
                "step": int(step) or 1,
                "src": str(src or ""),
                "running": False,
                "elapsed": 0.0,
                "started_at": None,
                "visible": True,
                "locked": False,
                "order": n,
                "x": 48.0,
                "y": 48.0 + n * 96,
                "parent": parent,
                # Imagem nasce com largura definida (senão o tamanho natural
                # pode estourar o canvas).
                "style": {"card_width": 320} if el_type == "image" else {},
            }
            self._counters.append(counter)
            self._normalize_order()
            self.save()
            return counter

    def _clone_of(self, src: dict[str, Any], order: int, suffix: str = " cópia") -> dict[str, Any]:
        return {
            "id": _new_id(),
            "type": src.get("type", "counter"),
            "name": f"{src['name']}{suffix}",
            "value": int(src.get("value", 0)),
            "step": int(src.get("step", 1)) or 1,
            "src": str(src.get("src", "") or ""),
            "running": False,                          # timer clonado nasce pausado
            "elapsed": float(src.get("elapsed", 0) or 0.0),
            "started_at": None,
            "visible": True,
            "locked": False,
            "order": order,
            "x": float(src.get("x", 48.0)) + 24,
            "y": float(src.get("y", 48.0)) + 24,
            "parent": str(src.get("parent", "") or ""),
            "style": dict(src.get("style") or {}),
        }

    def duplicate(self, counter_id: str) -> Optional[dict[str, Any]]:
        """Duplica o elemento; grupos são duplicados com todos os descendentes."""
        with self._lock:
            src = self._find(counter_id)
            if not src:
                return None
            clone = self._clone_of(src, len(self._counters))
            self._counters.append(clone)
            # Grupo: copia a subárvore, remapeando os pais para os clones.
            if src.get("type") == "group":
                id_map = {src["id"]: clone["id"]}
                queue = [src["id"]]
                while queue:
                    pid = queue.pop(0)
                    for child in self._children(pid):
                        if child["id"] in id_map:
                            continue
                        cc = self._clone_of(child, len(self._counters), suffix="")
                        cc["parent"] = id_map[pid]
                        id_map[child["id"]] = cc["id"]
                        self._counters.append(cc)
                        if child.get("type") == "group":
                            queue.append(child["id"])
            self._normalize_order()
            self.save()
            return clone

    def set_position(self, counter_id: str, x: float, y: float) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["x"] = float(x)
            c["y"] = float(y)
            self._save_soon()
            return c

    def set_lock(self, counter_id: str, locked: bool) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["locked"] = bool(locked)
            self.save()
            return c

    def delete(self, counter_id: str) -> bool:
        """Exclui o elemento. Filhos de um grupo excluído são SOLTOS (não apagados):
        sobem para o pai do grupo (ou para a raiz) e ganham posições empilhadas
        perto de onde o grupo estava, para não caírem uns sobre os outros."""
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return False
            kids = self._children(counter_id)
            for i, k in enumerate(kids):
                k["parent"] = c.get("parent", "") or ""
                if not k["parent"]:
                    k["x"] = float(c.get("x", 48.0))
                    k["y"] = float(c.get("y", 48.0)) + i * 96
            self._counters.remove(c)
            self._normalize_order()
            self.save()
            return True

    def rename(self, counter_id: str, name: str) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["name"] = str(name).strip() or c["name"]
            self.save()
            return c

    def set_step(self, counter_id: str, step: int) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["step"] = int(step) or 1
            self.save()
            return c

    def set_style(
        self,
        counter_id: str,
        style: dict[str, Any],
        merge: bool = True,
    ) -> Optional[dict[str, Any]]:
        """Define os overrides visuais do contador.

        merge=True  -> mescla; um valor None remove aquele override.
        merge=False -> substitui todo o style (usado em undo/redo).
        """
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            if not isinstance(c.get("style"), dict):
                c["style"] = {}
            if merge:
                for k, v in (style or {}).items():
                    if v is None:
                        c["style"].pop(k, None)
                    else:
                        c["style"][k] = v
            else:
                c["style"] = {k: v for k, v in (style or {}).items() if v is not None}
            self.save()
            return c

    # ----------------------------------------------------------------- valor
    def set_value(self, counter_id: str, value: int) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["value"] = int(value)
            self._save_soon()
            return c

    def increment(self, counter_id: str, amount: Optional[int] = None) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["value"] += int(amount) if amount is not None else c["step"]
            self._save_soon()
            return c

    def decrement(self, counter_id: str, amount: Optional[int] = None) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["value"] -= int(amount) if amount is not None else c["step"]
            self._save_soon()
            return c

    def reset(self, counter_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["value"] = 0
            self._save_soon()
            return c

    # ------------------------------------------------------------------ extras
    def set_type(self, counter_id: str, el_type: str) -> Optional[dict[str, Any]]:
        """Converte o elemento para outro tipo (counter/text/image/timer).

        Os campos comuns (posição, estilo, nome, visibilidade) são mantidos;
        um timer recém-convertido nasce pausado.
        """
        if el_type not in ELEMENT_TYPES:
            return None
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            if c.get("type") == el_type:
                return c
            # Deixou de ser grupo? Solta os filhos (mesma regra do delete).
            if c.get("type") == "group" and el_type != "group":
                for i, k in enumerate(self._children(counter_id)):
                    k["parent"] = c.get("parent", "") or ""
                    if not k["parent"]:
                        k["x"] = float(c.get("x", 48.0))
                        k["y"] = float(c.get("y", 48.0)) + i * 96
            c["type"] = el_type
            if el_type == "timer":
                c["running"] = False
                c["started_at"] = None
            if el_type == "image" and not (c.get("style") or {}).get("card_width"):
                c.setdefault("style", {})["card_width"] = 320
            self.save()
            return c

    def set_parent(self, counter_id: str, parent: str) -> Optional[dict[str, Any]]:
        """Move o elemento para dentro de um grupo ("" = raiz do canvas).

        Regras: o pai precisa existir e ser um grupo; um elemento não pode ser
        pai de si mesmo nem entrar num descendente seu (ciclo).
        """
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            parent = str(parent or "")
            if parent:
                p = self._find(parent)
                if p is None or p.get("type") != "group":
                    raise ValueError("O pai precisa ser um grupo existente.")
                if parent == counter_id or self._is_ancestor(counter_id, parent):
                    raise ValueError("Um grupo não pode ficar dentro de si mesmo.")
            c["parent"] = parent
            self.save()
            return c

    def set_src(self, counter_id: str, src: str) -> Optional[dict[str, Any]]:
        """Define a URL/caminho da imagem de um elemento."""
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["src"] = str(src or "")
            self.save()
            return c

    def timer_op(self, counter_id: str, op: str) -> Optional[dict[str, Any]]:
        """Opera um cronômetro: start | pause | toggle | reset."""
        with self._lock:
            c = self._find(counter_id)
            if not c or c.get("type") != "timer":
                return None
            now = time.time()
            if op == "toggle":
                op = "pause" if c["running"] else "start"
            if op == "start" and not c["running"]:
                c["running"] = True
                c["started_at"] = now
            elif op == "pause" and c["running"]:
                c["elapsed"] = float(c["elapsed"]) + (now - (c["started_at"] or now))
                c["running"] = False
                c["started_at"] = None
            elif op == "reset":
                c["elapsed"] = 0.0
                c["started_at"] = now if c["running"] else None
            self._save_soon()
            return c

    # ------------------------------------------------------------ visibilidade
    def set_visibility(self, counter_id: str, visible: bool) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["visible"] = bool(visible)
            self.save()
            return c

    def toggle_visibility(self, counter_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            c = self._find(counter_id)
            if not c:
                return None
            c["visible"] = not c["visible"]
            self.save()
            return c

    # -------------------------------------------------------------- reordenar
    def move(self, counter_id: str, direction: str) -> list[dict[str, Any]]:
        """Move um contador para cima ('up') ou para baixo ('down')."""
        with self._lock:
            ordered = self.list()
            idx = next((i for i, c in enumerate(ordered) if c["id"] == counter_id), None)
            if idx is None:
                return self.list()

            if direction == "up" and idx > 0:
                ordered[idx - 1], ordered[idx] = ordered[idx], ordered[idx - 1]
            elif direction == "down" and idx < len(ordered) - 1:
                ordered[idx + 1], ordered[idx] = ordered[idx], ordered[idx + 1]

            for i, c in enumerate(ordered):
                c["order"] = i
            self._counters = ordered
            self.save()
            return self.list()

    def reorder(self, ordered_ids: list[str]) -> list[dict[str, Any]]:
        """Reordena a partir de uma lista completa de ids (ex.: drag & drop)."""
        with self._lock:
            pos = {cid: i for i, cid in enumerate(ordered_ids)}
            # Contadores não citados vão para o fim, mantendo ordem relativa.
            self._counters.sort(key=lambda c: pos.get(c["id"], len(pos) + c["order"]))
            # Reatribui `order` direto (NÃO usar _normalize_order aqui: ele
            # ordena pelo campo antigo e desfaria o reorder).
            for i, c in enumerate(self._counters):
                c["order"] = i
            self.save()
            return self.list()

    # ---------------------------------------------------------------- exemplo
    def ensure_example(self) -> None:
        """Cria um contador de exemplo se a lista estiver vazia (primeira execução)."""
        if not self._counters:
            self.create(name="Mortes", value=0, step=1)
