"""Atalhos globais (Fase 2) — funciona em Windows, Linux X11 e **Wayland**.

Por que dois backends?
    - No Windows usamos `pynput` (hook global padrão).
    - No Linux, o Wayland bloqueia a captura global via X, então lemos o teclado
      direto do kernel via **evdev** (`/dev/input/event*`). Isso funciona igual em
      X11 e Wayland, pois acontece ANTES do compositor. (Em X11 o evdev também
      funciona; se o evdev não estiver disponível, caímos no pynput.)

Combos usam a TECLA FÍSICA (não o caractere), então são independentes de layout e
de Shift. Tokens canônicos: `ctrl` `alt` `shift` `meta`, letras `a`..`z`, dígitos
`0`..`9`, `f1`..`f24`, `space` `enter` `escape` `tab` `equal` `minus`
`numpadadd` `numpadsubtract` ... — os mesmos no navegador (`KeyboardEvent.code`)
e no evdev (keycodes).

Permissões no Linux: para ler `/dev/input` o usuário precisa estar no grupo
`input` (`sudo usermod -aG input $USER` e refazer login). Sem isso, os atalhos
ficam inativos com um erro explicativo.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import logger
from . import storage
from . import sysperms

HOTKEYS_FILE = "hotkeys.json"
VALID_ACTIONS = ("inc", "dec", "reset")
# Cooldown por combo: ignora repetições mais rápidas que isto (auto-repeat do
# teclado, bounce de switch). 80ms ainda permite spam manual honesto (~12/s).
COMBO_COOLDOWN_S = 0.08
DEFAULT: dict[str, Any] = {"enabled": False, "bindings": {}, "devices": []}
MOD_ORDER = ("ctrl", "alt", "shift", "meta")

# ------------------------------------------------------------------ tokens
# nomes de modificadores -> token canônico
_MODS_IN = {
    "ctrl": "ctrl", "control": "ctrl",
    "alt": "alt", "option": "alt",
    "shift": "shift",
    "cmd": "meta", "meta": "meta", "super": "meta", "win": "meta",
}
# token de modificador -> formato pynput
_MODS_PYNPUT = {"ctrl": "<ctrl>", "alt": "<alt>", "shift": "<shift>", "meta": "<cmd>"}
# tokens especiais -> formato pynput
_PYNPUT_SPECIAL = {
    "space": "<space>", "enter": "<enter>", "escape": "<esc>", "tab": "<tab>",
    "backspace": "<backspace>", "delete": "<delete>", "insert": "<insert>",
    "home": "<home>", "end": "<end>", "pageup": "<page_up>", "pagedown": "<page_down>",
    "up": "<up>", "down": "<down>", "left": "<left>", "right": "<right>",
    "equal": "=", "minus": "-",
    "numpadadd": "+", "numpadsubtract": "-", "numpadmultiply": "*",
    "numpaddivide": "/", "numpadenter": "<enter>",
}
# migração de combos antigos (baseados em caractere US) -> token físico
_LEGACY_CHAR = {"=": "equal", "+": "equal", "-": "minus", "_": "minus", "*": "numpadmultiply", "/": "numpaddivide"}


def normalize_combo(combo: str) -> Optional[str]:
    """Normaliza um combo para tokens canônicos (idempotente). Migra formato antigo."""
    s = str(combo or "").strip().lower()
    if not s:
        return None
    mods: list[str] = []
    changed = True
    while changed:
        changed = False
        for name, tok in _MODS_IN.items():
            pref = name + "+"
            if s.startswith(pref):
                if tok not in mods:
                    mods.append(tok)
                s = s[len(pref):]
                changed = True
    key = s
    if key in _LEGACY_CHAR:
        key = _LEGACY_CHAR[key]
    if not key:
        return None
    ordered = [m for m in MOD_ORDER if m in mods]
    return "+".join(ordered + [key])


def to_pynput(combo: str) -> str:
    """Converte um combo canônico -> formato do pynput ('<ctrl>+<f1>')."""
    out: list[str] = []
    for p in [x.strip().lower() for x in str(combo).split("+") if x.strip()]:
        if p in _MODS_IN:
            out.append(_MODS_PYNPUT[_MODS_IN[p]])
        elif p in _PYNPUT_SPECIAL:
            out.append(_PYNPUT_SPECIAL[p])
        elif len(p) == 1:
            out.append(p)
        elif p.startswith("f") and p[1:].isdigit():
            out.append(f"<{p}>")
        elif p.startswith("numpad") and p[6:].isdigit():
            out.append(p[6:])          # numpad0-9 -> dígito (melhor esforço)
        else:
            out.append(f"<{p}>")
    return "+".join(out)


# evdev: keycode -> token canônico (apenas casos que diferem do genérico)
_EVDEV_TOKENS = {
    "KEY_SPACE": "space", "KEY_ENTER": "enter", "KEY_ESC": "escape", "KEY_TAB": "tab",
    "KEY_BACKSPACE": "backspace", "KEY_DELETE": "delete", "KEY_INSERT": "insert",
    "KEY_HOME": "home", "KEY_END": "end", "KEY_PAGEUP": "pageup", "KEY_PAGEDOWN": "pagedown",
    "KEY_UP": "up", "KEY_DOWN": "down", "KEY_LEFT": "left", "KEY_RIGHT": "right",
    "KEY_EQUAL": "equal", "KEY_MINUS": "minus",
    "KEY_KPPLUS": "numpadadd", "KEY_KPMINUS": "numpadsubtract",
    "KEY_KPASTERISK": "numpadmultiply", "KEY_KPSLASH": "numpaddivide", "KEY_KPENTER": "numpadenter",
    "KEY_KP0": "numpad0", "KEY_KP1": "numpad1", "KEY_KP2": "numpad2", "KEY_KP3": "numpad3",
    "KEY_KP4": "numpad4", "KEY_KP5": "numpad5", "KEY_KP6": "numpad6", "KEY_KP7": "numpad7",
    "KEY_KP8": "numpad8", "KEY_KP9": "numpad9",
}


def evdev_token(name) -> Optional[str]:
    if isinstance(name, (list, tuple)):
        name = name[0]
    if not name or not isinstance(name, str):
        return None
    if name in _EVDEV_TOKENS:
        return _EVDEV_TOKENS[name]
    if name.startswith("KEY_"):
        return name[4:].lower()   # KEY_A->a, KEY_1->1, KEY_F1->f1, KEY_SEMICOLON->semicolon
    return None


class HotkeyManager:
    def __init__(self) -> None:
        storage.ensure_dirs()
        self._path = storage.config_path(HOTKEYS_FILE)
        self.data: dict[str, Any] = dict(DEFAULT)
        self.backend: Optional[str] = None
        self._dispatch: Optional[Callable[[str, str], None]] = None
        self._monitor_cb: Optional[Callable[[str], None]] = None
        self._last_fire: dict[str, float] = {}   # combo -> monotonic do último disparo
        self.monitor = False
        self._lock = threading.RLock()
        # backends
        self._pynput_listener = None
        self._evdev_thread: Optional[threading.Thread] = None
        self._evdev_stop: Optional[threading.Event] = None
        self.available, self.backend, self.last_error = self._detect_backend()
        self.load()
        logger.log("hotkeys init: available={}, backend={}, last_error={}", self.available, self.backend, self.last_error)

    # -------------------------------------------------------------- backend
    def _detect_backend(self) -> tuple[bool, Optional[str], Optional[str]]:
        if sys.platform.startswith("linux"):
            try:
                import evdev  # noqa: F401
                return True, "evdev", None
            except Exception as e_ev:
                ok, err = self._try_pynput()
                if ok:
                    return True, "pynput", None
                return False, None, f"evdev indisponível ({e_ev}); pynput: {err}"
        ok, err = self._try_pynput()
        return (True, "pynput", None) if ok else (False, None, err)

    @staticmethod
    def _try_pynput() -> tuple[bool, Optional[str]]:
        try:
            import pynput  # noqa: F401
            return True, None
        except ImportError:
            return False, "pynput não instalado (rode o start.bat/start.sh)"
        except Exception as e:
            return False, f"pynput não pôde iniciar: {e}"

    # ------------------------------------------------------------------- IO
    def load(self) -> dict[str, Any]:
        loaded = storage.load_json(self._path, default=None)
        if not isinstance(loaded, dict):
            self.data = dict(DEFAULT)
            self.save()
            return self.data
        raw = loaded.get("bindings")
        if isinstance(raw, list):
            raw = self._from_list(raw)
        elif not isinstance(raw, dict):
            raw = {}
        devices = loaded.get("devices")
        if not isinstance(devices, list):
            devices = []
        self.data = {
            "enabled": bool(loaded.get("enabled", False)),
            "bindings": self._normalize_all(raw),
            "devices": [str(p) for p in devices if isinstance(p, str)],
        }
        self.save()   # grava já normalizado
        return self.data

    @staticmethod
    def _from_list(lst: list) -> dict[str, Any]:
        b: dict[str, Any] = {}
        for item in lst:
            if not isinstance(item, dict):
                continue
            cid, act, keys = item.get("counter_id"), item.get("action"), item.get("keys")
            if cid and act in VALID_ACTIONS and keys:
                b.setdefault(cid, {})[act] = keys
        return b

    @staticmethod
    def _normalize_all(bindings: dict) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for cid, acts in (bindings or {}).items():
            if not isinstance(acts, dict):
                continue
            entry = {}
            for act, combo in acts.items():
                if act in VALID_ACTIONS and combo:
                    n = normalize_combo(combo)
                    if n:
                        entry[act] = n
            if entry:
                out[cid] = entry
        return out

    def set_path(self, path) -> dict[str, Any]:
        """Aponta para outro arquivo (troca de perfil) e recarrega os atalhos."""
        self._path = path
        self.load()
        self.reload()
        return self.data

    def save(self) -> None:
        storage.save_json(self._path, self.data, backup=True)

    # --------------------------------------------------------------- leitura
    def get(self) -> dict[str, Any]:
        return self.data

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.data.get("enabled")),
            "bindings": self.data.get("bindings", {}),
            "available": self.available,
            "active": self.active,
            "backend": self.backend,
            "monitor": self.monitor,
            "error": self.last_error,
            "perm": sysperms.input_status(),
            "devices": self._probe_evdev_devices() if self.backend == "evdev" else [],
            "selected_devices": [str(p) for p in self.data.get("devices", [])],
        }

    # ------------------------------------------------------------- alterações
    def set_all(self, enabled: Optional[bool] = None, bindings: Optional[dict] = None) -> dict[str, Any]:
        if enabled is not None:
            self.data["enabled"] = bool(enabled)
        if isinstance(bindings, dict):
            self.data["bindings"] = self._normalize_all(bindings)
        self.save()
        logger.log("set_all: enabled={}, bindings={} entries", self.data.get("enabled"), len(self.data.get("bindings", {})))
        self.reload()
        return self.data

    def set_binding(self, counter_id: str, action: str, keys: str) -> dict[str, Any]:
        if action not in VALID_ACTIONS:
            return self.data
        binds = self.data.setdefault("bindings", {})
        entry = binds.setdefault(counter_id, {})
        n = normalize_combo(keys) if keys else ""
        if n:
            entry[action] = n
        else:
            entry.pop(action, None)
        if not entry:
            binds.pop(counter_id, None)
        self.save()
        logger.log("set_binding: counter_id={}, action={}, keys={}", counter_id, action, n or "")
        self.reload()
        return self.data

    def remove_counter(self, counter_id: str) -> dict[str, Any]:
        if counter_id in self.data.get("bindings", {}):
            self.data["bindings"].pop(counter_id, None)
            self.save()
            self.reload()
        return self.data

    def set_devices(self, paths: list[str]) -> dict[str, Any]:
        valid = [str(p) for p in (paths or []) if isinstance(p, str)]
        self.data["devices"] = valid
        self.save()
        logger.log("set_devices: {}", valid)
        self.reload()
        return self.status()

    # ------------------------------------------------------------- callbacks
    def start(self, dispatch: Callable[[str, str], None]) -> None:
        self._dispatch = dispatch
        logger.log("start: dispatch set, enabled={}, monitor={}", self.data.get("enabled"), self.monitor)
        self.reload()

    def set_monitor_cb(self, cb: Callable[[str], None]) -> None:
        self._monitor_cb = cb

    def set_monitor(self, on: bool) -> dict[str, Any]:
        """Liga/desliga a detecção de teclas (mostra o que está sendo lido)."""
        self.monitor = bool(on)
        logger.log("set_monitor: {}", self.monitor)
        self.reload()
        return self.status()

    # -------------------------------------------------------------- listener
    def _should_run(self) -> bool:
        # roda se houver o que fazer: atalhos ligados OU monitor de teste ligado
        return bool(self.available and self._dispatch is not None and (self.data.get("enabled") or self.monitor))

    def _combos(self) -> list[str]:
        """Todos os combos registrados (para diagnóstico)."""
        return sorted({c for acts in self.data.get("bindings", {}).values() for c in (acts or {}).values()})

    def reload(self) -> None:
        with self._lock:
            self._stop_locked()
            n = sum(len(a or {}) for a in self.data.get("bindings", {}).values())
            logger.log("reload: backend={} enabled={} monitor={} bindings={} combos=[{}]",
                       self.backend, self.data.get("enabled"), self.monitor, n, ", ".join(self._combos()))
            if not self._should_run():
                reason = ("backend indisponível: " + str(self.last_error)) if not self.available \
                    else ("dispatch ainda não configurado" if self._dispatch is None
                          else "hotkeys desligadas e monitor desligado")
                logger.log("reload: listener NÃO iniciado ({})", reason)
                return
            if self.backend == "evdev":
                self._start_evdev()
            else:
                self._start_pynput()
            logger.log("reload: listener ativo={} (backend={}, erro={})", self.active, self.backend, self.last_error)

    # --- pynput (Windows / Linux X11 fallback) ---
    def _start_pynput(self) -> None:
        try:
            from pynput import keyboard
            mapping: dict[str, Callable[[], None]] = {}
            if self.data.get("enabled"):
                for cid, acts in self.data.get("bindings", {}).items():
                    for act, combo in (acts or {}).items():
                        if act in VALID_ACTIONS and combo:
                            try:
                                mapping[to_pynput(combo)] = self._make_cb(act, cid)
                            except Exception:
                                pass
            if not mapping:
                logger.log("pynput: nenhum binding para registrar (enabled={})", self.data.get("enabled"))
                return
            self._pynput_listener = keyboard.GlobalHotKeys(mapping)
            self._pynput_listener.start()
            self.last_error = None
            logger.log("pynput ativo com {} bindings: [{}]", len(mapping), ", ".join(mapping.keys()))
        except Exception as e:
            self.last_error = str(e)
            logger.log("pynput failed: {}", self.last_error)
            self._pynput_listener = None

    # --- evdev (Linux X11 + Wayland) ---
    def _read_evdev_meta(self, path: str) -> tuple[str, str, str]:
        name = ""
        phys = ""
        uniq = ""
        try:
            event = Path(path).name
            base = Path("/sys/class/input") / event / "device"
            if base.exists():
                name_file = base / "name"
                phys_file = base / "phys"
                uniq_file = base / "uniq"
                if name_file.exists():
                    name = name_file.read_text("utf-8", errors="ignore").strip()
                if phys_file.exists():
                    phys = phys_file.read_text("utf-8", errors="ignore").strip()
                if uniq_file.exists():
                    uniq = uniq_file.read_text("utf-8", errors="ignore").strip()
        except Exception:
            pass
        return name, phys, uniq

    def _scan_evdev_paths(self) -> list[str]:
        try:
            import evdev
            from evdev import ecodes
            available = []
            for path in sorted(Path("/dev/input").glob("event*")):
                path = str(path)
                try:
                    d = evdev.InputDevice(path)
                    caps = d.capabilities()
                    keys = caps.get(ecodes.EV_KEY, [])
                    if keys:
                        available.append(path)
                    d.close()
                except Exception:
                    pass
            selected = [str(p) for p in self.data.get("devices", []) if isinstance(p, str)]
            if selected:
                return [p for p in selected if p in available]
            return available
        except Exception:
            return []

    def _probe_evdev_devices(self) -> list[dict[str, Any]]:
        try:
            import evdev
            from evdev import ecodes
            devices = []
            for path_obj in sorted(Path("/dev/input").glob("event*")):
                path = str(path_obj)
                name, phys, uniq = self._read_evdev_meta(path)
                info = {
                    "path": path,
                    "name": name or "",
                    "phys": phys or "",
                    "uniq": uniq or "",
                    "key_count": 0,
                    "capabilities": [],
                    "readable": False,
                }
                try:
                    d = evdev.InputDevice(path)
                    caps = d.capabilities()
                    keys = caps.get(ecodes.EV_KEY, [])
                    info["readable"] = True
                    info["key_count"] = len(keys)
                    info["capabilities"] = sorted(caps.keys())
                    d.close()
                except PermissionError:
                    pass
                except Exception:
                    pass
                devices.append(info)
            return devices
        except Exception:
            return []

    def _start_evdev(self) -> None:
        try:
            import evdev
            from evdev import ecodes
            paths = self._scan_evdev_paths()
            keyboards = []
            for path in paths:
                try:
                    d = evdev.InputDevice(path)
                    caps = d.capabilities()
                    keys = caps.get(ecodes.EV_KEY, [])
                    if not keys:
                        d.close()
                        continue
                    logger.log("evdev opening device: path={} name={} keys={} capabilities={}", path, d.name or "<unknown>", len(keys), list(caps.keys()))
                    keyboards.append(d)
                except Exception as exc:
                    logger.log("evdev open error for {}: {}", path, exc)
            if not keyboards:
                self.last_error = "sem acesso a um teclado em /dev/input — adicione seu usuário ao grupo 'input' (sudo usermod -aG input $USER) e refaça login."
                return
            self._evdev_stop = threading.Event()
            self._evdev_thread = threading.Thread(target=self._evdev_loop, args=(keyboards,), daemon=True)
            self._evdev_thread.start()
            self.last_error = None
            logger.log("evdev started on {} devices: {}", len(keyboards), ", ".join(f"{d.path}({d.name or '<unknown>'})" for d in keyboards))
        except PermissionError:
            self.last_error = "sem permissão para ler /dev/input (grupo 'input')."
            logger.log("evdev permission error: {}", self.last_error)
        except Exception as e:
            self.last_error = str(e)
            logger.log("evdev failed: {}", self.last_error)

    def _evdev_loop(self, keyboards) -> None:
        import select
        from evdev import ecodes
        MODS = {
            ecodes.KEY_LEFTCTRL: "ctrl", ecodes.KEY_RIGHTCTRL: "ctrl",
            ecodes.KEY_LEFTSHIFT: "shift", ecodes.KEY_RIGHTSHIFT: "shift",
            ecodes.KEY_LEFTALT: "alt", ecodes.KEY_RIGHTALT: "alt",
            ecodes.KEY_LEFTMETA: "meta", ecodes.KEY_RIGHTMETA: "meta",
        }
        fd_map = {d.fd: d for d in keyboards}
        pressed_mods: set[str] = set()
        stop = self._evdev_stop
        dead: set[int] = set()   # fds com erro (loga uma vez, não spamma)
        logger.log("evdev loop: escutando {} dispositivo(s)", len(keyboards))
        try:
            while stop and not stop.is_set():
                r, _, _ = select.select(list(fd_map.keys()), [], [], 0.4)
                for fd in r:
                    dev = fd_map.get(fd)
                    if not dev:
                        continue
                    try:
                        for event in dev.read():
                            if event.type != ecodes.EV_KEY:
                                continue
                            code, val = event.code, event.value
                            if code in MODS:
                                if val == 1:
                                    pressed_mods.add(MODS[code])
                                elif val == 0:
                                    pressed_mods.discard(MODS[code])
                                continue
                            if val != 1:      # só key-down de tecla normal
                                continue
                            tok = evdev_token(ecodes.KEY.get(code))
                            if not tok:
                                continue
                            combo = "+".join([m for m in MOD_ORDER if m in pressed_mods] + [tok])
                            self._on_combo(combo)
                    except OSError as exc:
                        if fd not in dead:
                            dead.add(fd)
                            logger.log("evdev loop: erro lendo {} ({}) — dispositivo desconectado?", dev.path, exc)
        finally:
            logger.log("evdev loop: encerrado")
            for d in keyboards:
                try:
                    d.close()
                except Exception:
                    pass

    def _on_combo(self, combo: str) -> None:
        # PRIVACIDADE: teclas arbitrárias só vão para o log com o MONITOR ligado
        # (janela de Hotkeys aberta = depuração consciente). Sem monitor, apenas
        # combos que casam com um atalho são logados.
        if self.monitor:
            logger.log("tecla detectada: {} [modo teste]", combo)
        # 1) dispara ações vinculadas (só se atalhos habilitados)
        matched = False
        # Cooldown: segura auto-repeat/bounce sem afetar toques intencionais
        # (só o DISPARO é suprimido; o monitor de teste continua mostrando).
        now = time.monotonic()
        throttled = now - self._last_fire.get(combo, 0.0) < COMBO_COOLDOWN_S
        if self.data.get("enabled") and self._dispatch and not throttled:
            for cid, acts in self.data.get("bindings", {}).items():
                for act, c in (acts or {}).items():
                    if c == combo:
                        matched = True
                        self._last_fire[combo] = now
                        try:
                            logger.log("MATCH: combo={} -> action={} counter_id={}", combo, act, cid)
                            self._dispatch(act, cid)
                            logger.log("MATCH: dispatch de {} concluído", combo)
                        except Exception as exc:
                            logger.log("MATCH: dispatch FALHOU: {}", exc)
            if not matched and self.monitor:
                logger.log("tecla {} não casa com nenhum combo registrado: [{}]", combo, ", ".join(self._combos()))
        # 2) monitor de teste: mostra a tecla detectada no painel
        if self.monitor and self._monitor_cb:
            try:
                self._monitor_cb(combo)
            except Exception:
                pass

    # ------------------------------------------------------------------ util
    def _make_cb(self, action: str, counter_id: str) -> Callable[[], None]:
        d = self._dispatch
        return lambda: (d(action, counter_id) if d else None)

    def _stop_locked(self) -> None:
        if self._pynput_listener:
            try:
                self._pynput_listener.stop()
            except Exception:
                pass
            self._pynput_listener = None
        if self._evdev_stop:
            self._evdev_stop.set()
        if self._evdev_thread and self._evdev_thread.is_alive():
            # Espera a thread antiga soltar os devices antes de abrir de novo.
            self._evdev_thread.join(timeout=1.0)
        self._evdev_thread = None
        self._evdev_stop = None

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    @property
    def active(self) -> bool:
        return self._pynput_listener is not None or self._evdev_thread is not None
