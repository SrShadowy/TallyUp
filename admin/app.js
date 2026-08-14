/* ==========================================================================
   TallyUp — Painel (Controle + Editor visual de canvas)
   JavaScript puro. Uma única conexão WebSocket. Canvas 1920x1080.
   ========================================================================== */
(() => {
  "use strict";

  /* ----------------------------------------------------------------- utils */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    for (const k in props) {
      const v = props[k];
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "dataset") for (const d in v) n.dataset[d] = v[d];
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => { if (c == null) return; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  /* ------------------------------------------------------------- cor: math */
  function hexToRgb(hex) {
    hex = String(hex || "").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex || "000000", 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgbToHex = (r, g, b) => "#" + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
  function parseColor(str) {
    str = String(str || "").trim();
    if (str === "" || str === "transparent") return { r: 0, g: 0, b: 0, a: str === "transparent" ? 0 : 1 };
    if (str[0] === "#") { const { r, g, b } = hexToRgb(str); return { r, g, b, a: 1 }; }
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (m) { const p = m[1].split(",").map((s) => parseFloat(s.trim())); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? (isNaN(p[3]) ? 1 : p[3]) : 1 }; }
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  const rgbaStr = ({ r, g, b, a }) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a).toFixed(2)})`;
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { h, s: mx === 0 ? 0 : d / mx, v: mx };
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  function parseBorder(str) {
    str = String(str || "");
    const w = (str.match(/(\d+(?:\.\d+)?)px/) || [])[1];
    const cm = str.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i);
    const c = parseColor(cm ? cm[1] : "#ffffff");
    return { width: w ? Math.round(parseFloat(w)) : 0, hex: rgbToHex(c.r, c.g, c.b) };
  }
  const SHADOWS = {
    card: { none: "none", soft: "0 4px 10px rgba(0,0,0,0.35)", medium: "0 6px 18px rgba(0,0,0,0.45)", strong: "0 10px 28px rgba(0,0,0,0.65)" },
    text: { none: "none", soft: "1px 1px 3px rgba(0,0,0,0.8)", strong: "2px 2px 6px rgba(0,0,0,0.9)" },
  };
  function shadowKey(kind, value) { const map = SHADOWS[kind], n = norm(value); for (const k in map) if (norm(map[k]) === n) return k; return null; }

  /* ------------------------------------------------------------------- API */
  const API = {
    get: (p) => fetch(p).then((r) => r.json()),
    post: async (p, b) => {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `Erro ${r.status}`); }
      return r.json();
    },
  };

  /* ------------------------------------------- elementos: tipos e timers */
  const TYPE_ICON = { text: "🅣", image: "🖼", timer: "⏱", group: "🗂" };

  /* -------------------------------------------------- grupos: helpers */
  const elById = (id) => Store.counters.find((c) => c.id === id);
  const childrenOf = (pid) => Store.counters.filter((c) => (c.parent || "") === pid);
  // true se `maybeAncestor` está na cadeia de pais de `id`
  function isDescendant(id, maybeAncestor) {
    let cur = elById(id), hops = 0;
    while (cur && cur.parent && hops++ < 50) {
      if (cur.parent === maybeAncestor) return true;
      cur = elById(cur.parent);
    }
    return false;
  }
  // visível de verdade = ele E todos os grupos acima
  function effVisible(c) {
    let cur = c, hops = 0;
    while (cur) { if (!cur.visible) return false; cur = cur.parent ? elById(cur.parent) : null; if (++hops > 50) return false; }
    return true;
  }
  const GROUP_ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
  function applyGroupVars(elm, style) {
    style = style || {};
    elm.style.setProperty("--group-dir", style.group_dir === "row" ? "row" : "column");
    elm.style.setProperty("--group-gap", (Number(style.group_gap ?? 12) || 0) + "px");
    elm.style.setProperty("--group-align", GROUP_ALIGN[style.group_align] || "stretch");
    elm.classList.toggle("free", !!style.group_free);
    if (style.group_free) elm.style.setProperty("--group-height", (Number(style.group_height) || 300) + "px");
    else elm.style.removeProperty("--group-height");
  }

  /* -------------------------------- CSS personalizado (escopo por elemento) */
  function scopeCss(id, css) {
    const scope = `.counter[data-id="${id}"]`;
    css = String(css || "").trim();
    if (!css) return "";
    if (css.indexOf("{") === -1) return `${scope} { ${css} }`;
    return css.replace(/(^|\})([^{}]+)\{/g, (m, brace, sel) => {
      const scoped = sel.split(",").map((s) => {
        s = s.trim();
        if (!s) return s;
        if (s.startsWith("@") || /^(from|to|\d+%)$/i.test(s)) return s;
        if (s === "&") return scope;
        if (s.startsWith("&")) return scope + s.slice(1);
        return scope + " " + s;
      }).join(", ");
      return brace + " " + scoped + " {";
    });
  }
  let customCssEl = null;
  function applyCustomCss(list) {
    if (!customCssEl) { customCssEl = el("style", { id: "custom-css-admin" }); document.head.appendChild(customCssEl); }
    const txt = (list || []).filter((c) => c.style && c.style.custom_css).map((c) => scopeCss(c.id, c.style.custom_css)).join("\n\n");
    if (customCssEl.textContent !== txt) customCssEl.textContent = txt;
  }

  /* --------------------------- 🏆 template pronto: placar de partida */
  async function createScoreboard() {
    try {
      const g = (await API.post("/counter/create", { name: "Placar", type: "group" })).counter;
      await API.post("/counter/style", { id: g.id, style: { group_dir: "row", group_gap: 24, group_title: true }, merge: true });
      for (const nm of ["Time A", "Time B"]) {
        const t = (await API.post("/counter/create", { name: nm, type: "group", parent: g.id })).counter;
        await API.post("/counter/style", { id: t.id, style: { group_title: true, group_gap: 8 }, merge: true });
        for (const cn of ["Vitórias", "Derrotas", "Empates"]) {
          await API.post("/counter/create", { name: cn, type: "counter", parent: t.id });
        }
      }
      const r = await API.get("/counters");
      Store.setCounters(r.counters);
      Store.select(g.id);
      toast("🏆 Placar de partida criado — Placar > Time A / Time B");
    } catch (e) { toast(e.message); }
  }
  function fmtTime(secs) {
    let s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  // Macros de texto (%winrate% %wins% %losses% %games%) — espelha o overlay
  function wrByIdOrGuess(id, re) {
    return Store.counters.find((c) => c.id === id) ||
           Store.counters.find((c) => (!c.type || c.type === "counter") && re.test(c.name)) || null;
  }
  function expandMacros(text) {
    text = String(text ?? "");
    if (text.indexOf("%") === -1) return text;
    const w = wrByIdOrGuess(Store.theme.winrate_w, /vit[óo]|win|ganh/i);
    const l = wrByIdOrGuess(Store.theme.winrate_l, /derrot|loss|lose|perd/i);
    const wins = w ? Number(w.value) || 0 : 0;
    const losses = l ? Number(l.value) || 0 : 0;
    const games = wins + losses;
    const pct = games ? ((wins / games) * 100).toFixed(1).replace(".", ",") + "%" : "—";
    return text
      .replace(/%winrate%/gi, pct)
      .replace(/%wins%/gi, String(wins))
      .replace(/%losses%/gi, String(losses))
      .replace(/%games%/gi, String(games));
  }

  // Estado local dos cronômetros: base do servidor + tempo desde o recebimento
  const Timers = {
    map: new Map(),
    sync(list) {
      const seen = new Set();
      (list || []).forEach((c) => {
        if (c.type === "timer") { seen.add(c.id); this.map.set(c.id, { base: Number(c.elapsed) || 0, running: !!c.running, at: Date.now() }); }
      });
      [...this.map.keys()].forEach((k) => { if (!seen.has(k)) this.map.delete(k); });
    },
    secs(id) { const t = this.map.get(id); return t ? t.base + (t.running ? (Date.now() - t.at) / 1000 : 0) : 0; },
    running(id) { const t = this.map.get(id); return !!(t && t.running); },
  };

  /* ----------------------------------------------------------------- Store */
  const Store = {
    counters: [], theme: {}, selectedId: null, selectedIds: [],
    _subs: { counters: [], theme: [], selection: [] },
    on(e, fn) { (this._subs[e] || (this._subs[e] = [])).push(fn); },
    emit(e) { (this._subs[e] || []).forEach((fn) => fn(this)); },
    setCounters(list) {
      this.counters = Array.isArray(list) ? list : [];
      Timers.sync(this.counters);
      this.selectedIds = this.selectedIds.filter((id) => this.counters.some((c) => c.id === id));
      if (this.selectedId && !this.counters.some((c) => c.id === this.selectedId)) this.selectedId = this.selectedIds[this.selectedIds.length - 1] || null;
      this.emit("counters");
    },
    setTheme(t) { this.theme = t || {}; this.emit("theme"); },
    // additive=true (Shift+clique) alterna o id na seleção múltipla.
    select(id, additive) {
      if (additive && id) {
        const i = this.selectedIds.indexOf(id);
        if (i >= 0) this.selectedIds.splice(i, 1); else this.selectedIds.push(id);
        this.selectedId = this.selectedIds[this.selectedIds.length - 1] || null;
      } else {
        this.selectedIds = id ? [id] : [];
        this.selectedId = id || null;
      }
      this.emit("selection");
    },
    selected() { return this.counters.find((c) => c.id === this.selectedId) || null; },
  };

  // Tamanho do canvas do overlay (vem do tema; por perfil)
  const CW = () => Number(Store.theme.canvas_width) || 1920;
  const CH = () => Number(Store.theme.canvas_height) || 1080;

  const Live = {
    ws: null, timer: null,
    connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`); this.ws = ws;
      ws.onopen = () => setStatus("on", "Conectado");
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "init") { Store.setTheme(m.theme); Store.setCounters(m.counters); if (m.hotkeys) Hotkeys.onData(m.hotkeys); if (m.profiles) Profiles.onData(m.profiles); if (m.effects) FX.onData(m.effects); if (m.theme_presets) UserPresets.onData(m.theme_presets); }
        else if (m.type === "counters") { Store.setCounters(m.data); }
        else if (m.type === "theme") { Store.setTheme(m.data); }
        else if (m.type === "hotkeys") { Hotkeys.onData(m.data); }
        else if (m.type === "profiles") { Profiles.onData(m.data); }
        else if (m.type === "effects") { FX.onData(m.data); }
        else if (m.type === "theme_presets") { UserPresets.onData(m.data); }
        else if (m.type === "hotkey_detected") { Hotkeys.onDetected(m.combo); } };
      ws.onclose = () => { setStatus("off", "Reconectando…"); clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), 1200); };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    },
  };
  // Batimento do painel: detecta conexões fantasmas e força o reconnect.
  setInterval(() => { try { if (Live.ws && Live.ws.readyState === 1) Live.ws.send("ping"); } catch (_) {} }, 20000);
  function setStatus(kind, text) { const s = $("#status"); if (!s) return; s.classList.remove("status--on", "status--off", "status--dead"); s.classList.add(`status--${kind}`); s.querySelector(".status-text").textContent = text; }
  let toastEl = null, toastTimer = null;
  function toast(msg) { if (!toastEl) { toastEl = el("div", { class: "toast" }); document.body.appendChild(toastEl); } toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200); }

  /* =================================================================
     COLOR PICKER
     ================================================================= */
  const ColorPicker = {
    pop: null, state: { h: 0, s: 0, v: 0, a: 1 }, alpha: false, cb: null, open_: false, RECENT_KEY: "obsco.recent",
    recents() { try { return JSON.parse(localStorage.getItem(this.RECENT_KEY) || "[]"); } catch { return []; } },
    pushRecent(c) { let r = this.recents().filter((x) => x !== c); r.unshift(c); r = r.slice(0, 14); try { localStorage.setItem(this.RECENT_KEY, JSON.stringify(r)); } catch (_) {} },
    build() {
      if (this.pop) return;
      const sv = el("div", { class: "cp-sv" }, [el("div", { class: "cp-sv-thumb" })]);
      const hue = el("div", { class: "cp-hue" }, [el("div", { class: "cp-slider-thumb" })]);
      const alpha = el("div", { class: "cp-alpha" }, [el("div", { class: "cp-alpha-bar" }), el("div", { class: "cp-slider-thumb" })]);
      const hexIn = el("input", { class: "cp-hex", maxlength: 7 });
      const rIn = el("input", { class: "cp-num", type: "number", min: 0, max: 255 });
      const gIn = el("input", { class: "cp-num", type: "number", min: 0, max: 255 });
      const bIn = el("input", { class: "cp-num", type: "number", min: 0, max: 255 });
      const aIn = el("input", { class: "cp-num", type: "number", min: 0, max: 100 });
      const fields = el("div", { class: "cp-fields" }, [
        el("label", {}, [el("span", { text: "HEX" }), hexIn]), el("label", {}, [el("span", { text: "R" }), rIn]),
        el("label", {}, [el("span", { text: "G" }), gIn]), el("label", {}, [el("span", { text: "B" }), bIn]),
        el("label", { class: "cp-a-field" }, [el("span", { text: "A%" }), aIn]),
      ]);
      const recents = el("div", { class: "cp-recents" });
      this.pop = el("div", { class: "cp-pop" }, [sv, hue, alpha, fields, recents]);
      this.els = { sv, svThumb: sv.firstElementChild, hue, hueThumb: hue.firstElementChild, alpha, alphaBar: alpha.firstElementChild, alphaThumb: alpha.lastElementChild, hexIn, rIn, gIn, bIn, aIn, recents };
      document.body.appendChild(this.pop);
      dragArea(sv, (x, y) => { this.state.s = x; this.state.v = 1 - y; this.render(); this.emit(); });
      dragArea(hue, (x) => { this.state.h = x * 360; this.render(); this.emit(); });
      dragArea(alpha, (x) => { this.state.a = x; this.render(); this.emit(); });
      hexIn.addEventListener("change", () => { const t = hexIn.value.trim(); const c = parseColor(t[0] === "#" ? t : "#" + t); this.setRgb(c.r, c.g, c.b); this.render(); this.emit(); });
      [rIn, gIn, bIn].forEach((inp) => inp.addEventListener("input", () => { this.setRgb(+rIn.value || 0, +gIn.value || 0, +bIn.value || 0); this.render(false); this.emit(); }));
      aIn.addEventListener("input", () => { this.state.a = clamp((+aIn.value || 0) / 100, 0, 1); this.render(false); this.emit(); });
      document.addEventListener("pointerdown", (e) => { if (this.open_ && !this.pop.contains(e.target) && e.target !== this.anchor && !(this.anchor && this.anchor.contains(e.target))) this.close(); });
    },
    setRgb(r, g, b) { const h = rgbToHsv(r, g, b); this.state.h = h.h; this.state.s = h.s; this.state.v = h.v; },
    open({ anchor, color, alpha, onChange }) {
      this.build(); this.alpha = !!alpha; this.cb = onChange; this.anchor = anchor;
      const c = parseColor(color); this.setRgb(c.r, c.g, c.b); this.state.a = this.alpha ? c.a : 1;
      this.pop.classList.toggle("no-alpha", !this.alpha); this.renderRecents(); this.render();
      this.pop.style.visibility = "hidden"; this.pop.style.display = "block";
      const r = anchor.getBoundingClientRect(), pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
      let left = clamp(r.left + window.scrollX, 8 + window.scrollX, window.scrollX + window.innerWidth - pw - 8);
      let top = r.bottom + window.scrollY + 6;
      if (top + ph > window.scrollY + window.innerHeight - 8) top = r.top + window.scrollY - ph - 6;
      this.pop.style.left = left + "px"; this.pop.style.top = top + "px"; this.pop.style.visibility = "visible"; this.open_ = true;
    },
    close() { if (!this.open_) return; this.open_ = false; this.pop.style.display = "none"; this.pushRecent(this.output()); },
    output() { const { r, g, b } = hsvToRgb(this.state.h, this.state.s, this.state.v); return this.alpha ? rgbaStr({ r, g, b, a: this.state.a }) : rgbToHex(r, g, b); },
    emit() { if (this.cb) this.cb(this.output()); },
    renderRecents() { const box = this.els.recents; box.innerHTML = ""; this.recents().forEach((c) => { const sw = el("button", { class: "cp-recent", type: "button", title: c }); sw.style.background = c; sw.addEventListener("click", () => { const p = parseColor(c); this.setRgb(p.r, p.g, p.b); this.state.a = this.alpha ? p.a : 1; this.render(); this.emit(); }); box.appendChild(sw); }); },
    render(updateFields = true) {
      const { h, s, v, a } = this.state, E = this.els;
      const hueHex = rgbToHex(...Object.values(hsvToRgb(h, 1, 1)).map(Math.round));
      const { r, g, b } = hsvToRgb(h, s, v);
      E.sv.style.background = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${hueHex})`;
      E.svThumb.style.left = s * 100 + "%"; E.svThumb.style.top = (1 - v) * 100 + "%";
      E.hueThumb.style.left = (h / 360) * 100 + "%";
      E.alphaBar.style.background = `linear-gradient(to right, rgba(${r | 0},${g | 0},${b | 0},0), rgba(${r | 0},${g | 0},${b | 0},1))`;
      E.alphaThumb.style.left = a * 100 + "%";
      if (updateFields) { E.hexIn.value = rgbToHex(r, g, b); E.rIn.value = Math.round(r); E.gIn.value = Math.round(g); E.bIn.value = Math.round(b); E.aIn.value = Math.round(a * 100); }
    },
  };
  function dragArea(elm, cb) {
    const move = (e) => { const r = elm.getBoundingClientRect(); cb(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    elm.addEventListener("pointerdown", (e) => { e.preventDefault(); move(e); window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); });
  }

  /* =================================================================
     CONTROLE — grade de contadores (uso ao vivo)
     ================================================================= */
  // Navegação entre modos (ponte Controle <-> Editor)
  const Nav = {
    gotoEditor(id) { const b = document.querySelector('.mode-btn[data-mode="editor"]'); if (b) b.click(); if (id) Store.select(id); },
    gotoControl(id) {
      const b = document.querySelector('.mode-btn[data-mode="control"]'); if (b) b.click(); if (id) Store.select(id);
      setTimeout(() => { const it = document.querySelector(`#control-main .ci[data-id="${id}"]`); if (it) it.scrollIntoView({ behavior: "smooth", block: "center" }); }, 60);
    },
  };

  // Menu de contexto flutuante (⋮)
  const Menu = {
    el: null,
    _out(e) { if (Menu.el && !Menu.el.contains(e.target)) Menu.close(); },
    open(anchor, items) {
      this.close();
      const m = el("div", { class: "ctx-menu" });
      items.forEach((it) => {
        if (it.sep) { m.appendChild(el("div", { class: "ctx-sep" })); return; }
        m.appendChild(el("button", { class: "ctx-item" + (it.danger ? " danger" : ""), type: "button", text: it.label, onclick: () => { this.close(); it.onClick(); } }));
      });
      document.body.appendChild(m); this.el = m;
      const r = anchor.getBoundingClientRect();
      let left = Math.max(8, r.right + window.scrollX - 170);
      let top = r.bottom + window.scrollY + 4;
      if (top + m.offsetHeight > window.scrollY + window.innerHeight - 8) top = r.top + window.scrollY - m.offsetHeight - 4;
      m.style.left = left + "px"; m.style.top = top + "px";
      setTimeout(() => document.addEventListener("pointerdown", this._out), 0);
    },
    close() { if (this.el) { this.el.remove(); this.el = null; document.removeEventListener("pointerdown", this._out); } },
  };

  const Control = (() => {
    const main = $("#control-main"), emptyEl = $("#empty"), search = $("#ctrl-search");
    let mode = localStorage.getItem("obsco.cmode") || "cards";
    let query = "", lastKey = "", dragId = null;
    const getC = (id) => Store.counters.find((c) => c.id === id);
    const getName = (id) => (getC(id) || {}).name || "";
    const filtered = () => { const q = query.trim().toLowerCase(); return q ? Store.counters.filter((c) => c.name.toLowerCase().includes(q)) : Store.counters; };

    const menuBtn = () => el("button", { class: "icon-btn ci-menu", dataset: { action: "menu" }, title: "Mais ações", text: "⋮" });
    const handle = () => el("span", { class: "ci-handle", draggable: "true", title: "Arraste para reordenar", text: "☰" });
    const cls = (c, base) => base + (c.id === Store.selectedId ? " selected" : "") + (c.visible ? "" : " off");

    function buildCard(c) {
      return el("article", { class: cls(c, "ci ci-card"), dataset: { id: c.id } }, [
        el("div", { class: "ci-head" }, [handle(), el("input", { class: "ci-name", dataset: { field: "name" }, maxlength: 40, value: c.name }), menuBtn()]),
        el("div", { class: "ci-main" }, [
          el("button", { class: "big-btn dec", dataset: { action: "dec" }, text: "−" }),
          el("input", { class: "ci-value", type: "number", inputmode: "numeric", dataset: { field: "value" }, value: c.value }),
          el("button", { class: "big-btn inc", dataset: { action: "inc" }, text: "＋" }),
        ]),
        el("div", { class: "ci-foot" }, [
          el("label", { class: "step-field" }, ["Passo", el("input", { class: "ci-step", type: "number", min: 1, dataset: { field: "step" }, value: c.step })]),
          el("button", { class: "btn btn-ghost sm", dataset: { action: "reset" }, text: "↺ Zerar" }),
        ]),
      ]);
    }
    function buildTile(c) {
      return el("div", { class: cls(c, "ci ci-tile"), dataset: { id: c.id } }, [
        el("div", { class: "tile-head" }, [el("span", { class: "tile-name", text: c.name }), menuBtn()]),
        el("div", { class: "tile-val", text: c.value }),
        el("div", { class: "tile-btns" }, [
          el("button", { class: "big-btn dec", dataset: { action: "dec" }, text: "−" }),
          el("button", { class: "big-btn inc", dataset: { action: "inc" }, text: "＋" }),
        ]),
      ]);
    }
    function buildListRow(c) {
      return el("div", { class: cls(c, "ci ci-lrow"), dataset: { id: c.id } }, [
        handle(),
        el("input", { class: "ci-name", dataset: { field: "name" }, maxlength: 40, value: c.name }),
        el("div", { class: "lrow-ctl" }, [
          el("button", { class: "mini-btn dec", dataset: { action: "dec" }, text: "−" }),
          el("input", { class: "ci-value", type: "number", dataset: { field: "value" }, value: c.value }),
          el("button", { class: "mini-btn inc", dataset: { action: "inc" }, text: "＋" }),
        ]),
        el("label", { class: "step-field inline" }, ["Passo", el("input", { class: "ci-step", type: "number", min: 1, dataset: { field: "step" }, value: c.step })]),
        menuBtn(),
      ]);
    }
    function buildTableRow(c) {
      return el("tr", { class: cls(c, "ci"), dataset: { id: c.id } }, [
        el("td", { class: "td-handle" }, handle()),
        el("td", {}, el("input", { class: "ci-name", dataset: { field: "name" }, maxlength: 40, value: c.name })),
        el("td", { class: "num" }, el("div", { class: "cell-val" }, [
          el("button", { class: "mini-btn dec", dataset: { action: "dec" }, text: "−" }),
          el("input", { class: "ci-value", type: "number", dataset: { field: "value" }, value: c.value }),
          el("button", { class: "mini-btn inc", dataset: { action: "inc" }, text: "＋" }),
        ])),
        el("td", { class: "num" }, el("input", { class: "ci-step", type: "number", min: 1, dataset: { field: "step" }, value: c.step })),
        el("td", {}, el("div", { class: "cell-acts" }, [el("button", { class: "icon-btn", dataset: { action: "reset" }, title: "Zerar", text: "↺" }), menuBtn()])),
      ]);
    }

    // Card simplificado para elementos que não são contadores (texto/imagem/timer)
    function buildSimple(c) {
      const kids = [
        el("div", { class: "ci-head" }, [
          el("span", { class: "ci-type", title: c.type, text: TYPE_ICON[c.type] || "" }),
          el("input", { class: "ci-name", dataset: { field: "name" }, maxlength: 120, value: c.name }),
          menuBtn(),
        ]),
      ];
      if (c.type === "timer") {
        kids.push(el("div", { class: "ci-main" }, [
          el("button", { class: "big-btn", dataset: { action: "timer-toggle" }, title: "Iniciar/Pausar", text: Timers.running(c.id) ? "⏸" : "▶" }),
          el("div", { class: "ci-timer", text: fmtTime(Timers.secs(c.id)) }),
          el("button", { class: "big-btn", dataset: { action: "timer-reset" }, title: "Zerar", text: "↺" }),
        ]));
      } else {
        const subs = {
          text: "Texto do overlay — o nome acima é o conteúdo exibido.",
          image: "Imagem — defina a URL/arquivo no Editor.",
          group: "Grupo — organiza elementos dentro dele (edite no Editor).",
        };
        kids.push(el("div", { class: "ci-sub", text: subs[c.type] || "" }));
      }
      return el("article", { class: cls(c, "ci ci-card ci-simple"), dataset: { id: c.id } }, kids);
    }

    const keyOf = (list) => mode + "|" + query + "|" + list.map((c) => c.id + (c.visible ? 1 : 0) + (c.type || "")).join(",");

    function render() {
      const list = filtered();
      emptyEl.classList.toggle("hidden", Store.counters.length > 0);
      const key = keyOf(list);
      if (key === lastKey && main.firstChild) { list.forEach(updateItem); return; }
      lastKey = key; main.innerHTML = "";
      if (!Store.counters.length) return;
      if (list.length === 0) { main.appendChild(el("div", { class: "ci-noresult", text: `Nenhum contador encontrado para "${query}".` })); return; }
      const counters = list.filter((c) => !c.type || c.type === "counter");
      const others = list.filter((c) => c.type && c.type !== "counter");
      if (mode === "cards") { const w = el("div", { class: "ci-grid" }); counters.forEach((c) => w.appendChild(buildCard(c))); main.appendChild(w); }
      else if (mode === "grid") { const w = el("div", { class: "ci-grid tiles" }); counters.forEach((c) => w.appendChild(buildTile(c))); main.appendChild(w); }
      else if (mode === "list") { const w = el("div", { class: "ci-listwrap" }); counters.forEach((c) => w.appendChild(buildListRow(c))); main.appendChild(w); }
      else if (mode === "table") {
        const tbl = el("table", { class: "ci-table" }, [
          el("thead", {}, el("tr", {}, [el("th", { text: "" }), el("th", { text: "Nome" }), el("th", { class: "num", text: "Valor" }), el("th", { class: "num", text: "Passo" }), el("th", { text: "Ações" })])),
        ]);
        const tb = el("tbody"); counters.forEach((c) => tb.appendChild(buildTableRow(c))); tbl.appendChild(tb); main.appendChild(tbl);
      }
      if (others.length) {
        if (counters.length) main.appendChild(el("div", { class: "ci-section", text: "Outros elementos" }));
        const w = el("div", { class: "ci-grid simple" }); others.forEach((c) => w.appendChild(buildSimple(c))); main.appendChild(w);
      }
    }
    function updateItem(c) {
      const it = main.querySelector(`.ci[data-id="${c.id}"]`); if (!it) return;
      it.classList.toggle("selected", c.id === Store.selectedId); it.classList.toggle("off", !c.visible);
      const n = it.querySelector(".ci-name"); if (n && document.activeElement !== n) n.value = c.name;
      const v = it.querySelector(".ci-value"); if (v && document.activeElement !== v) v.value = c.value;
      const s = it.querySelector(".ci-step"); if (s && document.activeElement !== s) s.value = c.step;
      const tv = it.querySelector(".tile-val"); if (tv) tv.textContent = c.value;
      const tn = it.querySelector(".tile-name"); if (tn) tn.textContent = c.name;
      const tb = it.querySelector('[data-action="timer-toggle"]'); if (tb) tb.textContent = Timers.running(c.id) ? "⏸" : "▶";
    }
    const updateSel = () => $$(".ci", main).forEach((it) => it.classList.toggle("selected", it.dataset.id === Store.selectedId));

    async function doAction(a, id) {
      try {
        if (a === "inc") Store.setCounters((await API.post("/counter/inc", { id })).counters);
        else if (a === "dec") Store.setCounters((await API.post("/counter/dec", { id })).counters);
        else if (a === "reset") Store.setCounters((await API.post("/counter/reset", { id })).counters);
        else if (a === "visibility") Store.setCounters((await API.post("/counter/visibility", { id })).counters);
        else if (a === "up") Store.setCounters((await API.post("/counter/move", { id, direction: "up" })).counters);
        else if (a === "down") Store.setCounters((await API.post("/counter/move", { id, direction: "down" })).counters);
        else if (a === "timer-toggle") Store.setCounters((await API.post("/counter/timer", { id, op: "toggle" })).counters);
        else if (a === "timer-reset") Store.setCounters((await API.post("/counter/timer", { id, op: "reset" })).counters);
        else if (a === "duplicate") { const r = await API.post("/counter/duplicate", { id }); Store.setCounters(r.counters); Store.select(r.counter.id); toast("Duplicado"); }
        else if (a === "delete") { if (confirm(`Excluir o contador "${getName(id)}"?`)) { if (Store.selectedId === id) Store.selectedId = null; Store.setCounters((await API.post("/counter/delete", { id })).counters); toast("Excluído"); } }
      } catch (err) { toast(err.message); }
    }
    function openMenu(id, anchor) {
      const c = getC(id); if (!c) return;
      Menu.open(anchor, [
        { label: "✏ Editar aparência", onClick: () => Nav.gotoEditor(id) },
        { label: "⧉ Duplicar", onClick: () => doAction("duplicate", id) },
        { label: c.visible ? "🙈 Ocultar" : "👁 Mostrar", onClick: () => doAction("visibility", id) },
        { label: "↺ Zerar", onClick: () => doAction("reset", id) },
        { sep: true },
        { label: "⬆ Subir", onClick: () => doAction("up", id) },
        { label: "⬇ Descer", onClick: () => doAction("down", id) },
        { sep: true },
        { label: "🗑 Excluir", danger: true, onClick: () => doAction("delete", id) },
      ]);
    }

    function onClick(e) {
      const mb = e.target.closest('[data-action="menu"]'); if (mb) { const it = mb.closest(".ci"); if (it) openMenu(it.dataset.id, mb); return; }
      const ab = e.target.closest("[data-action]"); if (ab) { const it = ab.closest(".ci"); if (it) doAction(ab.dataset.action, it.dataset.id); return; }
      const item = e.target.closest(".ci"); if (item && !e.target.closest("input,button,a,label,.ci-handle")) Store.select(item.dataset.id);
    }
    async function onFieldChange(e) {
      const f = e.target.closest("[data-field]"); const it = e.target.closest(".ci"); if (!f || !it) return; const id = it.dataset.id;
      try {
        if (f.dataset.field === "name") { const name = f.value.trim(); if (!name) { f.value = getName(id); return; } Store.setCounters((await API.post("/counter/rename", { id, name })).counters); }
        else if (f.dataset.field === "value") { const value = parseInt(f.value, 10); if (isNaN(value)) return; Store.setCounters((await API.post("/counter/set", { id, value })).counters); }
        else if (f.dataset.field === "step") { let step = parseInt(f.value, 10); if (isNaN(step) || step < 1) step = 1; Store.setCounters((await API.post("/counter/step", { id, step })).counters); }
      } catch (err) { toast(err.message); }
    }
    async function add(type) {
      const names = { counter: "Novo Contador", text: "Texto livre", image: "Imagem", timer: "Timer", group: "Grupo" };
      try {
        const r = await API.post("/counter/create", { name: names[type] || "Novo Contador", type: type || "counter" });
        Store.setCounters(r.counters); Store.select(r.counter.id);
        setTimeout(() => { const inp = main.querySelector(`.ci[data-id="${r.counter.id}"] .ci-name`); if (inp) { inp.focus(); if (inp.select) inp.select(); } }, 40);
        if (type === "image") toast("Imagem criada — defina a URL/arquivo no Editor (menu ⋮ → Editar aparência)");
      } catch (e) { toast(e.message); }
    }
    async function reorder(dragId, targetId) {
      const order = Store.counters.map((c) => c.id).filter((x) => x !== dragId);
      const idx = order.indexOf(targetId); if (idx < 0) return; order.splice(idx, 0, dragId);
      try { Store.setCounters((await API.post("/counter/reorder", { order })).counters); } catch (e) { toast(e.message); }
    }

    function setMode(m) {
      mode = m; try { localStorage.setItem("obsco.cmode", m); } catch (_) {}
      $$("#ctrl-mode-seg button").forEach((b) => b.classList.toggle("active", b.dataset.cmode === m));
      main.dataset.cmode = m; lastKey = ""; render();
    }
    function setPreview(open) {
      const aside = $("#control-preview"); if (!aside) return;
      aside.classList.toggle("hidden", !open);
      const t = $("#ctrl-preview-toggle"); if (t) t.classList.toggle("active", open);
      try { localStorage.setItem("obsco.cpreview", open ? "1" : "0"); } catch (_) {}
      if (open) setTimeout(scalePreview, 30);
    }
    function scalePreview() {
      const wrap = $("#cprev-wrap"), f = $("#cprev-frame"); if (!wrap || !f) return;
      const w = wrap.clientWidth; if (!w) return; const s = w / CW();
      f.style.width = CW() + "px"; f.style.height = CH() + "px";
      f.style.transform = `scale(${s})`; wrap.style.height = s * CH() + "px";
    }
    function touchAutosave() {
      const a = $("#autosave"); if (!a) return; const t = new Date();
      const p = (n) => String(n).padStart(2, "0");
      a.textContent = `Auto-save ✓ · última alteração ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    }

    function init() {
      main.addEventListener("click", onClick);
      main.addEventListener("change", onFieldChange);
      main.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); e.target.blur(); } });
      main.addEventListener("dragstart", (e) => { const h = e.target.closest(".ci-handle"); if (!h) { if (e.target.closest("input")) return; e.preventDefault(); return; } const it = h.closest(".ci"); if (!it) return; dragId = it.dataset.id; it.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragId); } catch (_) {} });
      main.addEventListener("dragover", (e) => { if (dragId) e.preventDefault(); });
      main.addEventListener("drop", (e) => { if (!dragId) return; e.preventDefault(); const it = e.target.closest(".ci"); if (it && it.dataset.id !== dragId) reorder(dragId, it.dataset.id); });
      main.addEventListener("dragend", () => { dragId = null; $$(".ci.dragging", main).forEach((x) => x.classList.remove("dragging")); });

      $("#ctrl-mode-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.cmode); });
      search.addEventListener("input", () => { query = search.value; render(); });
      $("#ctrl-add").addEventListener("click", (e) => Menu.open(e.currentTarget, [
        { label: "🔢 Contador", onClick: () => add("counter") },
        { label: "🅣 Texto livre", onClick: () => add("text") },
        { label: "🖼 Imagem", onClick: () => add("image") },
        { label: "⏱ Timer / cronômetro", onClick: () => add("timer") },
        { sep: true },
        { label: "🗂 Grupo", onClick: () => add("group") },
        { label: "🏆 Placar de partida (2 times)", onClick: () => createScoreboard() },
      ]));
      $("#ctrl-preview-toggle").addEventListener("click", () => setPreview($("#control-preview").classList.contains("hidden")));
      $("#ctrl-preview-close").addEventListener("click", () => setPreview(false));

      Store.on("counters", () => { render(); touchAutosave(); });
      Store.on("theme", () => { touchAutosave(); scalePreview(); });
      Store.on("selection", updateSel);
      window.addEventListener("resize", scalePreview);

      setMode(mode);
      setPreview(localStorage.getItem("obsco.cpreview") !== "0");
    }
    return { init, scalePreview: () => scalePreview() };
  })();

  /* =================================================================
     EDITOR — dados de apoio
     ================================================================= */
  const FONTS = [
    ["Inter, Segoe UI, Arial, sans-serif", "Inter"], ["'Segoe UI', Arial, sans-serif", "Segoe UI"],
    ["Arial, sans-serif", "Arial"], ["'Trebuchet MS', sans-serif", "Trebuchet MS"], ["Georgia, serif", "Georgia"],
    ["Impact, sans-serif", "Impact"], ["Verdana, sans-serif", "Verdana"], ["'Comic Sans MS', cursive", "Comic Sans"],
    ["'Courier New', monospace", "Monospace"],
  ];
  const PRESETS = [
    { id: "obsdark", name: "OBS Dark", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 48, font_weight: "800", value_color: "#ffffff", label_color: "#c8f5d4", accent_color: "#00e676", card_background: "rgba(0,0,0,0.55)", card_border: "0px solid transparent", border_radius: 14, padding: 16, shadow: "0 6px 18px rgba(0,0,0,0.45)", text_shadow: "2px 2px 6px rgba(0,0,0,0.9)", uppercase_labels: true, show_labels: true, italic: false, letter_spacing: 0, line_height: 1.1, text_transform: "none" } },
    { id: "minimal", name: "Minimal", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 44, font_weight: "600", value_color: "#ffffff", label_color: "#b8c0cc", accent_color: "#ffffff", card_background: "rgba(0,0,0,0.00)", card_border: "0px solid transparent", border_radius: 0, padding: 4, shadow: "none", text_shadow: "1px 1px 3px rgba(0,0,0,0.8)", uppercase_labels: true, italic: false, letter_spacing: 1, line_height: 1.1, text_transform: "none" } },
    { id: "cyberpunk", name: "Cyberpunk", theme: { font_family: "'Segoe UI', Arial, sans-serif", font_size: 50, font_weight: "800", value_color: "#f9f002", label_color: "#00fff9", accent_color: "#ff003c", card_background: "rgba(20,0,30,0.6)", card_border: "2px solid #ff003c", border_radius: 2, padding: 14, shadow: "0 0 20px rgba(255,0,60,0.6)", text_shadow: "0 0 8px rgba(0,255,249,0.9)", uppercase_labels: true, italic: false, letter_spacing: 1, line_height: 1.1, text_transform: "uppercase" } },
    { id: "arcade", name: "Arcade", theme: { font_family: "'Courier New', monospace", font_size: 42, font_weight: "900", value_color: "#ffef3a", label_color: "#ff5edb", accent_color: "#ff5edb", card_background: "rgba(10,0,40,0.8)", card_border: "3px solid #ff5edb", border_radius: 0, padding: 12, shadow: "5px 5px 0 rgba(0,0,0,0.9)", text_shadow: "2px 2px 0 #000", uppercase_labels: true, italic: false, letter_spacing: 1, line_height: 1.1, text_transform: "uppercase" } },
    { id: "pixel", name: "Pixel", theme: { font_family: "'Courier New', monospace", font_size: 40, font_weight: "900", value_color: "#fff23a", label_color: "#ff4d4d", accent_color: "#ff4d4d", card_background: "rgba(0,0,0,0.8)", card_border: "3px solid #ffffff", border_radius: 0, padding: 12, shadow: "6px 6px 0 rgba(0,0,0,0.9)", text_shadow: "3px 3px 0 #000", uppercase_labels: true, italic: false, letter_spacing: 2, line_height: 1.1, text_transform: "uppercase" } },
    { id: "retro", name: "Retro", theme: { font_family: "Georgia, serif", font_size: 46, font_weight: "700", value_color: "#ffe8c2", label_color: "#ff9a3c", accent_color: "#ff9a3c", card_background: "rgba(40,24,10,0.7)", card_border: "2px solid #ffcf8a", border_radius: 10, padding: 16, shadow: "0 6px 16px rgba(0,0,0,0.5)", text_shadow: "1px 1px 3px rgba(0,0,0,0.8)", uppercase_labels: false, italic: true, letter_spacing: 0, line_height: 1.15, text_transform: "none" } },
    { id: "streamer", name: "Streamer", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 48, font_weight: "800", value_color: "#ffffff", label_color: "#a0e9ff", accent_color: "#1e90ff", card_background: "rgba(12,18,32,0.72)", card_border: "0px solid transparent", border_radius: 16, padding: 18, shadow: "0 8px 22px rgba(0,0,0,0.5)", text_shadow: "2px 2px 6px rgba(0,0,0,0.9)", uppercase_labels: true, italic: false, letter_spacing: 0, line_height: 1.1, text_transform: "none" } },
    { id: "speedrun", name: "Speedrun", theme: { font_family: "'Courier New', monospace", font_size: 44, font_weight: "700", value_color: "#ffffff", label_color: "#29ff90", accent_color: "#29ff90", card_background: "rgba(0,0,0,0.7)", card_border: "1px solid #29ff90", border_radius: 6, padding: 12, shadow: "0 4px 10px rgba(0,0,0,0.5)", text_shadow: "1px 1px 2px #000", uppercase_labels: true, italic: false, letter_spacing: 1, line_height: 1.1, text_transform: "uppercase" } },
    { id: "neon", name: "Neon", theme: { font_family: "'Segoe UI', Arial, sans-serif", font_size: 52, font_weight: "800", value_color: "#ffffff", label_color: "#00e5ff", accent_color: "#ff00e6", card_background: "rgba(10,10,22,0.55)", card_border: "2px solid #00e5ff", border_radius: 14, padding: 16, shadow: "0 0 18px rgba(0,229,255,0.65)", text_shadow: "0 0 8px rgba(0,229,255,0.9)", uppercase_labels: true, italic: false, letter_spacing: 0, line_height: 1.1, text_transform: "none" } },
    { id: "transparent", name: "Transparent", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 48, font_weight: "800", value_color: "#ffffff", label_color: "#ffffff", accent_color: "#ffffff", card_background: "rgba(0,0,0,0.00)", card_border: "0px solid transparent", border_radius: 0, padding: 2, shadow: "none", text_shadow: "2px 2px 6px rgba(0,0,0,0.95)", uppercase_labels: true, italic: false, letter_spacing: 0, line_height: 1.1, text_transform: "none" } },
    { id: "glass", name: "Glass", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 48, font_weight: "700", value_color: "#ffffff", label_color: "#dbeafe", accent_color: "#93c5fd", card_background: "rgba(255,255,255,0.10)", card_border: "1px solid rgba(255,255,255,0.35)", border_radius: 18, padding: 16, shadow: "0 8px 30px rgba(0,0,0,0.35)", text_shadow: "1px 1px 3px rgba(0,0,0,0.7)", uppercase_labels: true, italic: false, letter_spacing: 0, line_height: 1.1, text_transform: "none" } },
    { id: "terminal", name: "Terminal", theme: { font_family: "'Courier New', monospace", font_size: 44, font_weight: "700", value_color: "#33ff66", label_color: "#33ff66", accent_color: "#33ff66", card_background: "rgba(0,0,0,0.85)", card_border: "1px solid #113b1f", border_radius: 4, padding: 12, shadow: "none", text_shadow: "0 0 6px rgba(51,255,102,0.7)", uppercase_labels: false, italic: false, letter_spacing: 1, line_height: 1.2, text_transform: "none" } },
    // Temas inspirados em jogos (mesmos valores dos templates de perfil no backend)
    { id: "overwatch", name: "Overwatch", theme: { font_family: "Inter, Segoe UI, Arial, sans-serif", font_size: 48, font_weight: "900", italic: true, value_color: "#ffffff", label_color: "#f99e1a", accent_color: "#f99e1a", card_background: "rgba(24,30,44,0.85)", card_border: "0px solid transparent", border_radius: 6, padding: 16, shadow: "0 6px 18px rgba(0,0,0,0.45)", text_shadow: "2px 2px 6px rgba(0,0,0,0.9)", uppercase_labels: true, letter_spacing: 1, line_height: 1.1, text_transform: "none" } },
    { id: "darksouls", name: "Dark Souls", theme: { font_family: "Georgia, serif", font_size: 46, font_weight: "700", italic: false, value_color: "#e8d9a0", label_color: "#a89468", accent_color: "#8a1313", card_background: "rgba(12,10,8,0.82)", card_border: "1px solid #3a3226", border_radius: 4, padding: 16, shadow: "0 8px 22px rgba(0,0,0,0.7)", text_shadow: "2px 2px 8px rgba(0,0,0,0.95)", uppercase_labels: true, letter_spacing: 2, line_height: 1.15, text_transform: "none" } },
    { id: "valorantpreset", name: "Valorant", theme: { font_family: "'Segoe UI', Arial, sans-serif", font_size: 48, font_weight: "800", italic: false, value_color: "#ffffff", label_color: "#ff4655", accent_color: "#ff4655", card_background: "rgba(15,25,35,0.85)", card_border: "2px solid #ff4655", border_radius: 0, padding: 14, shadow: "0 4px 14px rgba(255,70,85,0.35)", text_shadow: "1px 1px 3px rgba(0,0,0,0.8)", uppercase_labels: true, letter_spacing: 2, line_height: 1.1, text_transform: "uppercase" } },
    { id: "league", name: "League of Legends", theme: { font_family: "Georgia, serif", font_size: 46, font_weight: "700", italic: false, value_color: "#f0e6d2", label_color: "#c8aa6e", accent_color: "#0ac8b9", card_background: "rgba(1,10,19,0.85)", card_border: "1px solid #c8aa6e", border_radius: 2, padding: 16, shadow: "0 6px 18px rgba(0,0,0,0.6)", text_shadow: "1px 1px 4px rgba(0,0,0,0.9)", uppercase_labels: true, letter_spacing: 1, line_height: 1.1, text_transform: "none" } },
    { id: "minecraft", name: "Minecraft", theme: { font_family: "'Courier New', monospace", font_size: 44, font_weight: "900", italic: false, value_color: "#ffffff", label_color: "#55ff55", accent_color: "#55ff55", card_background: "rgba(28,28,28,0.85)", card_border: "3px solid #000000", border_radius: 0, padding: 12, shadow: "4px 4px 0 rgba(0,0,0,0.8)", text_shadow: "3px 3px 0 #3f3f3f", uppercase_labels: false, letter_spacing: 1, line_height: 1.1, text_transform: "none" } },
  ];

  /* ------------------------------------ presets de tema salvos pelo usuário */
  const UserPresets = {
    list: [],
    byId(id) { return this.list.find((p) => p.id === id); },
    onData(list) { this.list = Array.isArray(list) ? list : []; this.rebuildSelect(); },
    async load() { try { this.onData((await API.get("/theme/presets")).presets); } catch (_) {} },
    rebuildSelect() {
      const psel = $("#preset-select"); if (!psel) return;
      psel.innerHTML = "";
      psel.appendChild(el("option", { value: "", text: "— escolher —" }));
      const gb = el("optgroup", { label: "Embutidos" });
      PRESETS.forEach((p) => gb.appendChild(el("option", { value: p.id, text: p.name })));
      psel.appendChild(gb);
      if (this.list.length) {
        const gu = el("optgroup", { label: "💾 Meus presets" });
        this.list.forEach((p) => gu.appendChild(el("option", { value: "u:" + p.id, text: p.name })));
        psel.appendChild(gu);
      }
    },
    async saveCurrent() {
      const name = prompt("Nome do preset (salva a aparência atual do tema):");
      if (!name || !name.trim()) return;
      try {
        const r = await API.post("/theme/presets/save", { name: name.trim() });
        this.onData(r.presets);
        toast(`Preset "${r.preset.name}" salvo ✓`);
      } catch (e) { toast(e.message); }
    },
    openDeleteMenu(anchor) {
      if (!this.list.length) { toast("Você ainda não salvou nenhum preset."); return; }
      Menu.open(anchor, this.list.map((p) => ({
        label: "🗑 " + p.name, danger: true,
        onClick: async () => {
          if (!confirm(`Excluir o preset "${p.name}"?`)) return;
          try {
            const r = await API.post("/theme/presets/delete", { id: p.id });
            this.onData(r.presets); toast("Preset excluído");
          } catch (e) { toast(e.message); }
        },
      })));
    },
  };

  const C = {
    value_color: { key: "value_color", label: "Cor do valor", type: "color" },
    label_color: { key: "label_color", label: "Cor do rótulo", type: "color" },
    accent_color: { key: "accent_color", label: "Destaque", type: "color" },
    font_family: { key: "font_family", label: "Fonte", type: "font" },
    font_weight: { key: "font_weight", label: "Peso", type: "weight" },
    font_size: { key: "font_size", label: "Tamanho", type: "range", min: 12, max: 200, unit: "px", skipElement: true },
    text_transform: { key: "text_transform", label: "Transformar", type: "select", options: [["none", "Normal"], ["uppercase", "MAIÚSCULAS"], ["lowercase", "minúsculas"], ["capitalize", "Capitalizar"]] },
    letter_spacing: { key: "letter_spacing", label: "Espaço entre letras", type: "range", min: -5, max: 30, unit: "px" },
    line_height: { key: "line_height", label: "Entrelinha", type: "range", min: 0.8, max: 2.4, step: 0.1, unit: "" },
    italic: { key: "italic", label: "Itálico", type: "toggle" },
    uppercase_labels: { key: "uppercase_labels", label: "Rótulos MAIÚSCULOS", type: "toggle", globalOnly: true },
    show_labels: { key: "show_labels", label: "Mostrar rótulos", type: "toggle", globalOnly: true },
    card_background: { key: "card_background", label: "Fundo do card", type: "colorAlpha" },
    card_background2: { key: "card_background2", label: "Fundo 2 (gradiente)", type: "colorAlpha", clearable: true },
    card_gradient_dir: { key: "card_gradient_dir", label: "Direção do gradiente", type: "range", min: 0, max: 360, unit: "°" },
    card_width: { key: "card_width", label: "Largura (0 = auto)", type: "range", min: 0, max: 900, unit: "px" },
    opacity: { key: "opacity", label: "Opacidade", type: "range", min: 0, max: 100, unit: "%" },
    rotation: { key: "rotation", label: "Rotação", type: "range", min: -180, max: 180, unit: "°" },
    text_stroke_width: { key: "text_stroke_width", label: "Contorno do texto", type: "range", min: 0, max: 10, unit: "px" },
    text_stroke_color: { key: "text_stroke_color", label: "Cor do contorno", type: "color" },
    label_position: { key: "label_position", label: "Posição do rótulo", type: "select", options: [["left", "Esquerda"], ["top", "Em cima"], ["right", "Direita"], ["bottom", "Embaixo"]] },
    hide_label: { key: "hide_label", label: "Ocultar rótulo", type: "toggle", elementOnly: true },
    text_align: { key: "text_align", label: "Alinhar conteúdo", type: "select", options: [["left", "Esquerda"], ["center", "Centro"], ["right", "Direita"]] },
    card_border: { key: "card_border", label: "Borda", type: "border" },
    border_radius: { key: "border_radius", label: "Cantos", type: "range", min: 0, max: 80, unit: "px" },
    padding: { key: "padding", label: "Padding", type: "range", min: 0, max: 80, unit: "px" },
    shadow: { key: "shadow", label: "Sombra do card", type: "shadow", kind: "card" },
    text_shadow: { key: "text_shadow", label: "Sombra do texto", type: "shadow", kind: "text" },
    effect: { key: "effect", label: "Animação ao mudar", type: "effect", globalOnly: true }, // por elemento fica no Transformar
  };
  const SECTIONS = [
    { title: "Aparência", controls: [C.value_color, C.label_color, C.accent_color, C.font_family, C.font_weight, C.font_size] },
    { title: "Texto", controls: [C.text_transform, C.letter_spacing, C.line_height, C.italic, C.text_stroke_width, C.text_stroke_color, C.label_position, C.hide_label, C.text_align, C.uppercase_labels, C.show_labels] },
    { title: "Card", collapsed: true, controls: [C.card_background, C.card_background2, C.card_gradient_dir, C.card_width, C.opacity, C.rotation, C.card_border, C.border_radius, C.padding] },
    { title: "Sombras", collapsed: true, controls: [C.shadow, C.text_shadow, C.effect] },
  ];
  // Chaves "extras" zeradas ao aplicar um preset (para o preset ficar fiel).
  const PRESET_EXTRAS = { card_background2: "", card_width: 0, opacity: 100, rotation: 0, text_stroke_width: 0 };

  const pxu = (v) => (typeof v === "number" ? `${v}px` : v);

  /* Variáveis computadas da personalização avançada (espelha o overlay). */
  const LABEL_DIR = { left: "row", right: "row-reverse", top: "column", bottom: "column-reverse" };
  const ALIGN_ITEMS = { left: "flex-start", center: "center", right: "flex-end" };
  function applyExtraVars(s, get) {
    const bg2 = get("card_background2");
    if (bg2) {
      const bg = get("card_background") || "rgba(0,0,0,0.55)";
      s.setProperty("--card-bg", `linear-gradient(${Number(get("card_gradient_dir")) || 180}deg, ${bg}, ${bg2})`);
    }
    const w = Number(get("card_width") || 0);
    if (w > 0) s.setProperty("--card-width", w + "px"); else s.removeProperty("--card-width");
    const op = Number(get("opacity"));
    if (!isNaN(op) && op < 100) s.setProperty("--opacity", String(clamp(op, 0, 100) / 100)); else s.removeProperty("--opacity");
    const rot = Number(get("rotation") || 0);
    if (rot) s.setProperty("--rotate", rot + "deg"); else s.removeProperty("--rotate");
    const sw = Number(get("text_stroke_width") || 0);
    if (sw > 0) s.setProperty("--text-stroke", sw + "px " + (get("text_stroke_color") || "#000000")); else s.removeProperty("--text-stroke");
    const pos = get("label_position") || "left";
    const ta = get("text_align") || "left";
    const vertical = pos === "top" || pos === "bottom";
    s.setProperty("--card-flex-dir", LABEL_DIR[pos] || "row");
    s.setProperty("--card-gap", vertical ? "2px" : "14px");
    s.setProperty("--card-item-align", vertical ? (ALIGN_ITEMS[ta] || "flex-start") : "baseline");
    s.setProperty("--card-justify", ALIGN_ITEMS[ta] || "flex-start");
    s.setProperty("--card-text-align", ta);
  }

  function applyThemeVars(elm, t) {
    const s = elm.style;
    if (t.font_family) s.setProperty("--font-family", t.font_family);
    if (t.font_size != null) s.setProperty("--font-size", pxu(t.font_size));
    if (t.font_weight != null) s.setProperty("--font-weight", t.font_weight);
    if (t.letter_spacing != null) s.setProperty("--letter-spacing", pxu(t.letter_spacing));
    if (t.line_height != null) s.setProperty("--line-height", t.line_height);
    s.setProperty("--font-style", t.italic ? "italic" : "normal");
    s.setProperty("--value-transform", t.text_transform || "none");
    s.setProperty("--text-color", t.text_color || t.value_color || "#fff");
    if (t.label_color) s.setProperty("--label-color", t.label_color);
    if (t.value_color) s.setProperty("--value-color", t.value_color);
    if (t.accent_color) s.setProperty("--accent", t.accent_color);
    if (t.card_background) s.setProperty("--card-bg", t.card_background);
    if (t.card_border) s.setProperty("--card-border", t.card_border);
    if (t.border_radius != null) s.setProperty("--radius", pxu(t.border_radius));
    if (t.padding != null) s.setProperty("--padding", pxu(t.padding));
    if (t.shadow) s.setProperty("--shadow", t.shadow);
    if (t.text_shadow) s.setProperty("--text-shadow", t.text_shadow);
    s.setProperty("--label-transform", t.uppercase_labels ? "uppercase" : "none");
    elm.classList.toggle("no-labels", t.show_labels === false);
    applyExtraVars(s, (k) => t[k]);
  }
  const STYLE_VARS = { value_color: "--value-color", label_color: "--label-color", accent_color: "--accent", card_background: "--card-bg", card_border: "--card-border", border_radius: "--radius", padding: "--padding", font_family: "--font-family", font_size: "--font-size", font_weight: "--font-weight", letter_spacing: "--letter-spacing", line_height: "--line-height", text_transform: "--value-transform", shadow: "--shadow", text_shadow: "--text-shadow" };
  const STYLE_PX = new Set(["border_radius", "padding", "font_size", "letter_spacing"]);
  function applyCounterStyleEl(elm, style) {
    style = style || {};
    elm.classList.toggle("no-label", !!style.hide_label);
    if ("italic" in style) elm.style.setProperty("--font-style", style.italic ? "italic" : "normal"); else elm.style.removeProperty("--font-style");
    for (const key in STYLE_VARS) { const v = style[key]; if (v == null || v === "") elm.style.removeProperty(STYLE_VARS[key]); else elm.style.setProperty(STYLE_VARS[key], STYLE_PX.has(key) && typeof v === "number" ? v + "px" : v); }
    applyExtraVars(elm.style, (k) => (k in style && style[k] !== null ? style[k] : Store.theme[k]));
  }

  /* =================================================================
     EDITOR
     ================================================================= */
  const Editor = {
    _init: false, _applying: false, _scale: 1, zoomMode: "fit",
    view: { grid: false, safe: false, snap: true, tree: true, props: true }, bg: "checker",
    panel: { treeW: 232, propsW: 320 },
    _pendingTheme: {}, _pendingStyles: {}, _pendingPos: {},
    _history: [], _hi: -1, _guides: [],

    onShow() { if (!this._init) this.init(); this.applyPrefs(); this.renderAll(); if (this._history.length === 0) this._pushHistoryNow(); },

    init() {
      this._init = true;
      this.tpl = $("#preview-counter-template");
      this.frame = $("#canvas-frame"); this.canvasCounters = $("#canvas-counters"); this.selBox = $("#sel-box");
      this.canvasWrap = $("#canvas-wrap"); this.canvasScale = $("#canvas-scale"); this.badge = $("#canvas-badge");
      this.tree = $("#tree"); this.propsCtx = $("#props-ctx");
      this.body3 = $(".editor-body3"); this.treePanel = $(".tree-panel"); this.propsPanel = $(".props-panel");
      this.initSplitters();
      this._flushDebounced = debounce(() => this._flush(), 140);
      this._historyDebounced = debounce(() => this._pushHistoryNow(), 500);

      // canvas: presets de tamanho + W×H personalizados
      this.initCanvasControls();

      // presets (embutidos + salvos pelo usuário)
      const psel = $("#preset-select");
      UserPresets.rebuildSelect();
      psel.addEventListener("change", () => {
        const v = psel.value; psel.value = "";
        if (v.indexOf("u:") === 0) {
          const p = UserPresets.byId(v.slice(2));
          if (p) this.applyPreset({ name: p.name, theme: p.theme });
        } else {
          const p = PRESETS.find((x) => x.id === v);
          if (p) this.applyPreset(p);
        }
      });
      $("#preset-save").addEventListener("click", () => UserPresets.saveCurrent());
      $("#preset-del").addEventListener("click", (e) => UserPresets.openDeleteMenu(e.currentTarget));

      // toolbar
      $("#undo").addEventListener("click", () => this.undo());
      $("#redo").addEventListener("click", () => this.redo());
      $("#zoom-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.setZoom(b.dataset.zoom === "fit" ? "fit" : parseFloat(b.dataset.zoom)); });
      $("#align-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.align(b.dataset.align); });
      $("#bg-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.setBg(b.dataset.bg); });
      $("#view-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) this.toggleView(b.dataset.view); });
      $("#theme-export").addEventListener("click", () => this.exportTheme());
      $("#theme-import-file").addEventListener("change", (e) => this.importTheme(e));
      $("#theme-reset").addEventListener("click", () => this.resetTheme());
      $("#tree-add").addEventListener("click", (e) => Menu.open(e.currentTarget, [
        { label: "🔢 Contador", onClick: () => this.addElement("counter") },
        { label: "🅣 Texto livre", onClick: () => this.addElement("text") },
        { label: "🖼 Imagem", onClick: () => this.addElement("image") },
        { label: "⏱ Timer / cronômetro", onClick: () => this.addElement("timer") },
        { sep: true },
        { label: "🗂 Grupo", onClick: () => this.addElement("group") },
        { label: "🏆 Placar de partida (2 times)", onClick: () => createScoreboard() },
      ]));

      // canvas: deseleciona ao clicar no vazio (Shift preserva a seleção múltipla,
      // mesmo se o clique "cair" no frame após o re-render da seleção)
      this.frame.addEventListener("click", (e) => { if (e.shiftKey) return; if (!e.target.closest(".counter") && !e.target.closest(".sel-box")) Store.select(null); });
      // handles de redimensionamento
      this.selBox.addEventListener("pointerdown", (e) => this.onHandleDown(e));

      // atalhos
      document.addEventListener("keydown", (e) => {
        if (document.body.dataset.mode !== "editor") return;
        const tag = (e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "select" || tag === "textarea") return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); }
        else if (e.key === "Delete" && Store.selectedIds.length) {
          Store.selectedIds.length > 1 ? this.delMany([...Store.selectedIds]) : this.del(Store.selectedId);
        }
        else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && Store.selectedIds.length) {
          // Setas movem a seleção (Shift = passo de 10px)
          e.preventDefault();
          const st = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -st : e.key === "ArrowRight" ? st : 0;
          const dy = e.key === "ArrowUp" ? -st : e.key === "ArrowDown" ? st : 0;
          Store.selectedIds.forEach((id) => {
            const c = Store.counters.find((x) => x.id === id);
            if (!c || c.locked) return;
            // Filho de grupo com layout automático não tem posição própria.
            const p = c.parent ? elById(c.parent) : null;
            if (p && !(p.style && p.style.group_free)) return;
            this.setPosition(id, { x: Math.round(c.x + dx), y: Math.round(c.y + dy) });
          });
        }
      });

      // tree delegação
      this.tree.addEventListener("click", (e) => this.onTreeClick(e));

      // reações
      Store.on("counters", () => { if (this.isVisible()) { this.renderCanvas(); this.renderTree(); } });
      Store.on("theme", () => {
        if (!this.isVisible()) return;
        applyThemeVars(this.canvasCounters, Store.theme); this.positionSelBox();
        // canvas mudou de tamanho? (troca de perfil, undo, import...)
        if (this._cw !== CW() || this._ch !== CH()) { this._cw = CW(); this._ch = CH(); this.syncCanvasControls(); this.setZoom(this.zoomMode); }
      });
      Store.on("selection", () => { if (this.isVisible()) { this.renderCanvas(); this.renderTree(); this.renderProps(); } });

      window.addEventListener("resize", () => { if (this.isVisible() && this.zoomMode === "fit") this.setZoom("fit"); });
    },

    /* ------------------------------------------------- tamanho do canvas */
    CANVAS_PRESETS: [
      [1920, 1080, "1920×1080 · Full HD"], [1280, 720, "1280×720 · HD"],
      [2560, 1440, "2560×1440 · QHD"], [3840, 2160, "3840×2160 · 4K"],
      [1080, 1920, "1080×1920 · Vertical"], [1080, 1080, "1080×1080 · Quadrado"],
    ],
    initCanvasControls() {
      const sel = $("#canvas-preset"), wIn = $("#canvas-w"), hIn = $("#canvas-h");
      this.CANVAS_PRESETS.forEach(([w, h, label]) => sel.appendChild(el("option", { value: `${w}x${h}`, text: label })));
      sel.appendChild(el("option", { value: "custom", text: "Personalizado" }));
      sel.addEventListener("change", () => {
        if (sel.value === "custom") return;
        const [w, h] = sel.value.split("x").map(Number);
        this.setCanvasSize(w, h);
      });
      const fromInputs = () => {
        const w = clamp(Math.round(Number(wIn.value) || 0), 320, 7680);
        const h = clamp(Math.round(Number(hIn.value) || 0), 320, 4320);
        if (w && h) this.setCanvasSize(w, h);
      };
      wIn.addEventListener("change", fromInputs);
      hIn.addEventListener("change", fromInputs);
      this.syncCanvasControls();
    },
    syncCanvasControls() {
      const sel = $("#canvas-preset"), wIn = $("#canvas-w"), hIn = $("#canvas-h");
      if (!sel) return;
      if (document.activeElement !== wIn) wIn.value = CW();
      if (document.activeElement !== hIn) hIn.value = CH();
      const match = this.CANVAS_PRESETS.find(([w, h]) => w === CW() && h === CH());
      sel.value = match ? `${match[0]}x${match[1]}` : "custom";
    },
    setCanvasSize(w, h) {
      if (w === CW() && h === CH()) return;
      this.patchTheme({ canvas_width: w, canvas_height: h });
      this.syncCanvasControls();
      this.setZoom(this.zoomMode);       // redimensiona o frame e reencaixa o zoom
      toast(`Canvas: ${w} × ${h}`);
    },

    isVisible() { return document.body.dataset.mode === "editor"; },
    counterElById(id) { return this.canvasCounters.querySelector(`.counter[data-id="${id}"]`); },

    applyPrefs() {
      this.bg = localStorage.getItem("obsco.bg") || "checker";
      this.view.snap = localStorage.getItem("obsco.snap") !== "0";
      this.view.grid = localStorage.getItem("obsco.grid") === "1";
      this.view.safe = localStorage.getItem("obsco.safe") === "1";
      this.view.tree = localStorage.getItem("obsco.tree") !== "0";
      this.view.props = localStorage.getItem("obsco.props") !== "0";
      this.panel.treeW = Number(localStorage.getItem("obsco.treew")) || 232;
      this.panel.propsW = Number(localStorage.getItem("obsco.propsw")) || 320;
      this.setBg(this.bg);
      this.frame.classList.toggle("show-grid", this.view.grid);
      this.frame.classList.toggle("show-safe", this.view.safe);
      $$("#view-seg button").forEach((b) => b.classList.toggle("active", this.view[b.dataset.view]));
      this.zoomMode = localStorage.getItem("obsco.zoom") || "fit";
      this.applyPanels(false);
    },

    /* -------------------------------------- painéis laterais (largura/ocultar) */
    applyPanels(refit = true) {
      const t = this.view.tree, p = this.view.props;
      const tw = clamp(this.panel.treeW, 160, 480), pw = clamp(this.panel.propsW, 240, 560);
      this.treePanel.classList.toggle("hidden", !t);
      $("#split-tree").classList.toggle("hidden", !t);
      this.propsPanel.classList.toggle("hidden", !p);
      $("#split-props").classList.toggle("hidden", !p);
      this.body3.style.gridTemplateColumns =
        `${t ? tw + "px 6px " : ""}1fr${p ? " 6px " + pw + "px" : ""}`;
      if (refit && this.zoomMode === "fit") this.setZoom("fit");
    },
    initSplitters() {
      const attach = (sel, side) => {
        $(sel).addEventListener("pointerdown", (e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = side === "tree" ? this.panel.treeW : this.panel.propsW;
          const move = (ev) => {
            const d = ev.clientX - startX;
            if (side === "tree") this.panel.treeW = clamp(Math.round(startW + d), 160, 480);
            else this.panel.propsW = clamp(Math.round(startW - d), 240, 560);
            this.applyPanels();
          };
          const up = () => {
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
            try { localStorage.setItem("obsco.treew", String(this.panel.treeW)); localStorage.setItem("obsco.propsw", String(this.panel.propsW)); } catch (_) {}
          };
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
        });
      };
      attach("#split-tree", "tree");
      attach("#split-props", "props");
    },
    renderAll() { this.setZoom(this.zoomMode); this.renderCanvas(); this.renderTree(); this.renderProps(); },

    /* ---------------------------------------------------------- canvas */
    renderCanvas() {
      applyThemeVars(this.canvasCounters, Store.theme);
      applyCustomCss(Store.counters);
      const list = Store.counters.filter((c) => effVisible(c));
      const kidsOf = new Map(); const roots = [];
      list.forEach((c) => {
        if (c.parent) { if (!kidsOf.has(c.parent)) kidsOf.set(c.parent, []); kidsOf.get(c.parent).push(c); }
        else roots.push(c);
      });
      this.canvasCounters.innerHTML = "";
      const build = (c) => {
        const n = this.tpl.content.firstElementChild.cloneNode(true);
        n.dataset.id = c.id;
        this.applyContent(n, c);
        applyCounterStyleEl(n, c.style);
        if (c.type === "group") applyGroupVars(n, c.style);
        if (Store.selectedIds.includes(c.id)) n.classList.add("selected");
        if (c.locked) n.classList.add("locked");
        n.addEventListener("click", (e) => { e.stopPropagation(); if (e.shiftKey) return; if (!Store.selectedIds.includes(c.id)) Store.select(c.id); });
        n.addEventListener("pointerdown", (e) => this.onCounterDown(e, c));
        if (c.type === "group") {
          const box = n.querySelector(".group-children");
          (kidsOf.get(c.id) || []).forEach((k) => {
            const kn = build(k);
            if (c.style && c.style.group_free) { kn.style.left = (k.x || 0) + "px"; kn.style.top = (k.y || 0) + "px"; }
            box.appendChild(kn);
          });
        }
        return n;
      };
      roots.forEach((c) => {
        const n = build(c);
        n.style.left = (c.x || 0) + "px"; n.style.top = (c.y || 0) + "px"; n.style.zIndex = c.order || 0;
        this.canvasCounters.appendChild(n);
      });
      this.positionSelBox();
    },
    /* Conteúdo do elemento no canvas conforme o tipo. */
    applyContent(n, c) {
      n.dataset.type = c.type || "counter";
      const label = n.querySelector(".label"), value = n.querySelector(".value");
      if (c.type === "text") { label.style.display = "none"; value.textContent = expandMacros(c.name); }
      else if (c.type === "image") {
        label.style.display = "none"; value.style.display = "none";
        if (c.src) { const img = el("img", { class: "el-img", draggable: "false" }); img.src = c.src; n.appendChild(img); }
        else n.appendChild(el("div", { class: "el-img-placeholder", text: "🖼 defina a imagem" }));
      }
      else if (c.type === "timer") { label.textContent = c.name; value.textContent = fmtTime(Timers.secs(c.id)); }
      else if (c.type === "group") {
        value.style.display = "none";
        if (c.style && c.style.group_title) { label.textContent = c.name; label.classList.add("group-title"); }
        else label.style.display = "none";
        n.appendChild(el("div", { class: "group-children" }));
      }
      else { label.textContent = c.name; value.textContent = c.value; }
    },

    positionSelBox() {
      const c = Store.selected(); const elm = c && effVisible(c) ? this.counterElById(c.id) : null;
      if (!elm) { this.selBox.hidden = true; return; }
      this.selBox.hidden = false;
      if (!c.parent) {
        this.selBox.style.left = elm.offsetLeft + "px"; this.selBox.style.top = elm.offsetTop + "px";
        this.selBox.style.width = elm.offsetWidth + "px"; this.selBox.style.height = elm.offsetHeight + "px";
        const rot = Number((c.style && c.style.rotation != null) ? c.style.rotation : Store.theme.rotation) || 0;
        this.selBox.style.transform = rot ? `rotate(${rot}deg)` : "";
      } else {
        // Aninhado: mede pela caixa na tela (compensando o zoom do canvas).
        const s = this.currentScale() || 1;
        const fr = this.frame.getBoundingClientRect(), r = elm.getBoundingClientRect();
        this.selBox.style.left = (r.left - fr.left) / s + "px";
        this.selBox.style.top = (r.top - fr.top) / s + "px";
        this.selBox.style.width = r.width / s + "px";
        this.selBox.style.height = r.height / s + "px";
        this.selBox.style.transform = "";
      }
      this.selBox.classList.toggle("locked", !!(c && c.locked));
    },
    currentScale() { return this._scale || 1; },

    onCounterDown(e, c) {
      if (e.button !== 0) return;
      e.stopPropagation();          // aninhado: não deixa o grupo pai também arrastar
      if (e.shiftKey) { Store.select(c.id, true); return; }
      if (!Store.selectedIds.includes(c.id)) Store.select(c.id);
      else if (Store.selectedId !== c.id) { Store.selectedId = c.id; Store.emit("selection"); }
      // Filho em grupo de layout AUTOMÁTICO não tem posição própria:
      // o arrasto move o grupo raiz inteiro. Em grupo LIVRE, move o próprio
      // elemento (x/y relativos ao grupo).
      let dragC = c, hops = 0;
      while (dragC.parent && hops++ < 50) {
        const p = elById(dragC.parent);
        if (!p) break;
        if (p.style && p.style.group_free) break;
        dragC = p;
      }
      if (dragC.locked) return;
      e.preventDefault();
      const relative = !!dragC.parent;   // dentro de grupo livre -> coords relativas
      const scale = this.currentScale();
      const sx = e.clientX, sy = e.clientY;
      const elm = this.counterElById(dragC.id);
      // Seleção múltipla só se arrasta em conjunto no nível raiz.
      const group = !relative && dragC.id === c.id
        ? Store.selectedIds.map((id) => Store.counters.find((x) => x.id === id)).filter((x) => x && !x.locked && !x.parent)
        : [];
      const targets = group.length ? group : [dragC];
      const orig = new Map(targets.map((t) => [t.id, { x: t.x, y: t.y }]));
      const move = (ev) => {
        const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
        const o = orig.get(dragC.id) || { x: dragC.x, y: dragC.y };
        let nx = o.x + dx, ny = o.y + dy;
        if (relative) { nx = Math.round(nx / 5) * 5; ny = Math.round(ny / 5) * 5; }  // grade fina dentro do grupo
        else [nx, ny] = this.smartSnapXY(dragC, nx, ny, elm, targets.map((t) => t.id));
        const adx = nx - o.x, ady = ny - o.y;
        targets.forEach((t) => {
          const ot = orig.get(t.id); t.x = ot.x + adx; t.y = ot.y + ady;
          const te = this.counterElById(t.id); if (te) { te.style.left = t.x + "px"; te.style.top = t.y + "px"; }
        });
        this.positionSelBox(); this.updateTransformInputs(dragC);
      };
      const up = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        this.clearGuides();
        targets.forEach((t) => { this._pendingPos[t.id] = { x: Math.round(t.x), y: Math.round(t.y) }; });
        this._flush(); this._pushHistoryNow(); Store.emit("counters");
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    },
    snapXY(x, y, elm) {
      if (!this.view.snap) return [x, y];
      const g = 10; x = Math.round(x / g) * g; y = Math.round(y / g) * g;
      const w = elm.offsetWidth, h = elm.offsetHeight, T = 8;
      if (Math.abs((x + w / 2) - CW() / 2) < T) x = CW() / 2 - w / 2;
      if (Math.abs((y + h / 2) - CH() / 2) < T) y = CH() / 2 - h / 2;
      return [x, y];
    },
    /* Snap com guias inteligentes: bordas e centros dos outros elementos + canvas.
       O limiar é em pixels de TELA (dividido pelo zoom), como no Photoshop —
       senão em zoom baixo o encaixe fica impossível de acionar. */
    smartSnapXY(c, x, y, elm, excludeIds) {
      if (!this.view.snap) { this.clearGuides(); return [x, y]; }
      const scale = this.currentScale();
      const T = Math.max(6, 8 / scale);          // ~8px de tela
      const w = elm.offsetWidth, h = elm.offsetHeight;
      const skip = new Set(excludeIds || [c.id]);
      const lines = []; let bestX = null, bestY = null;
      const others = Store.counters
        .filter((o) => !o.parent && o.visible && !skip.has(o.id))   // só raízes: filhos têm x/y relativos
        .map((o) => { const e2 = this.counterElById(o.id); return e2 ? { x: o.x, y: o.y, w: e2.offsetWidth, h: e2.offsetHeight } : null; })
        .filter(Boolean);
      others.push({ x: 0, y: 0, w: CW(), h: CH() }); // bordas e centro do canvas
      const myX = [0, w / 2, w], myY = [0, h / 2, h];
      let dxBest = Infinity, dyBest = Infinity;
      others.forEach((o) => {
        [o.x, o.x + o.w / 2, o.x + o.w].forEach((edge) => myX.forEach((off) => {
          const d = Math.abs((x + off) - edge);
          if (d < T && d < dxBest) { dxBest = d; bestX = edge - off; lines[0] = { v: edge }; }
        }));
        [o.y, o.y + o.h / 2, o.y + o.h].forEach((edge) => myY.forEach((off) => {
          const d = Math.abs((y + off) - edge);
          if (d < T && d < dyBest) { dyBest = d; bestY = edge - off; lines[1] = { h: edge }; }
        }));
      });
      x = bestX !== null ? bestX : Math.round(x / 10) * 10;
      y = bestY !== null ? bestY : Math.round(y / 10) * 10;
      this.renderGuides(lines.filter(Boolean));
      return [x, y];
    },
    renderGuides(lines) {
      this.clearGuides();
      // A linha vive DENTRO do frame escalado: compensa o zoom para que ela
      // tenha sempre ~1.5px na tela (senão some em zoom baixo).
      const px = Math.max(1, 1.5 / this.currentScale());
      lines.slice(0, 4).forEach((l) => {
        const g = el("div", { class: l.v != null ? "guide-v" : "guide-h" });
        if (l.v != null) { g.style.left = l.v + "px"; g.style.width = px + "px"; }
        else { g.style.top = l.h + "px"; g.style.height = px + "px"; }
        this.frame.appendChild(g); this._guides.push(g);
      });
    },
    clearGuides() { (this._guides || []).forEach((g) => g.remove()); this._guides = []; },
    onHandleDown(e) {
      const t = e.target; if (!t.classList || !t.classList.contains("h")) return;
      const corner = ["h-nw", "h-ne", "h-se", "h-sw"].find((k) => t.classList.contains(k));
      const side = ["h-e", "h-w"].find((k) => t.classList.contains(k));
      if (!corner && !side) return;
      const c = Store.selected(); if (!c || c.locked) return;
      e.stopPropagation(); e.preventDefault();
      const elm = this.counterElById(c.id); const scale = this.currentScale();
      const sx = e.clientX, sy = e.clientY;
      if (side) {
        // Alças laterais: redimensionam a LARGURA real do card (style.card_width).
        const baseW = elm.offsetWidth, mul = side === "h-e" ? 1 : -1;
        const move = (ev) => {
          const nw = clamp(Math.round(baseW + ((ev.clientX - sx) / scale) * mul), 60, 1600);
          c.style = c.style || {}; c.style.card_width = nw;
          applyCounterStyleEl(elm, c.style); this.positionSelBox();
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          (this._pendingStyles[c.id] || (this._pendingStyles[c.id] = {})).card_width = c.style.card_width;
          this._flush(); this._pushHistoryNow(); Store.emit("counters");
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
        return;
      }
      const base = (c.style && c.style.font_size != null) ? c.style.font_size : (Store.theme.font_size || 48);
      const move = (ev) => {
        const d = ((ev.clientX - sx) + (ev.clientY - sy)) / 2 / scale;
        const nf = clamp(Math.round(base + d * 0.5), 12, 300);
        c.style = c.style || {}; c.style.font_size = nf; applyCounterStyleEl(elm, c.style); this.positionSelBox(); this.updateTransformInputs(c);
      };
      const up = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        (this._pendingStyles[c.id] || (this._pendingStyles[c.id] = {})).font_size = c.style.font_size; this._flush(); this._pushHistoryNow(); Store.emit("counters");
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    },

    /* ---------------------------------------------------------- zoom / ver */
    setZoom(mode) {
      this.zoomMode = mode; let scale;
      if (mode === "fit") { const w = this.canvasWrap.clientWidth - 40, h = this.canvasWrap.clientHeight - 40; scale = Math.min(w / CW(), h / CH()); }
      else scale = Number(mode);
      scale = clamp(scale || 1, 0.05, 4); this._scale = scale;
      this.frame.style.width = CW() + "px"; this.frame.style.height = CH() + "px";
      this.canvasScale.style.width = CW() * scale + "px"; this.canvasScale.style.height = CH() * scale + "px";
      this.frame.style.transform = `scale(${scale})`;
      this.badge.textContent = `${CW()} × ${CH()} · ${Math.round(scale * 100)}%`;
      $$("#zoom-seg button").forEach((b) => b.classList.toggle("active", b.dataset.zoom === String(mode)));
      this.positionSelBox();
      try { localStorage.setItem("obsco.zoom", String(mode)); } catch (_) {}
    },
    setBg(kind) { this.bg = kind; this.canvasWrap.dataset.bg = kind; $$("#bg-seg button").forEach((b) => b.classList.toggle("active", b.dataset.bg === kind)); try { localStorage.setItem("obsco.bg", kind); } catch (_) {} },
    toggleView(v) {
      this.view[v] = !this.view[v];
      if (v === "grid") this.frame.classList.toggle("show-grid", this.view.grid);
      if (v === "safe") this.frame.classList.toggle("show-safe", this.view.safe);
      if (v === "tree" || v === "props") this.applyPanels();
      $$("#view-seg button").forEach((b) => b.classList.toggle("active", this.view[b.dataset.view]));
      try { localStorage.setItem("obsco." + v, this.view[v] ? "1" : "0"); } catch (_) {}
    },

    /* ---------------------------------------------------------- árvore */
    treeFilter: "all",
    treeCollapsed: new Set(),
    renderTree() {
      this.tree.innerHTML = "";
      // Tabs por tipo (com contagem) — informam e filtram os elementos.
      const counts = { all: Store.counters.length, counter: 0, text: 0, image: 0, timer: 0, group: 0 };
      Store.counters.forEach((c) => { const t = c.type || "counter"; counts[t] = (counts[t] || 0) + 1; });
      const TABS = [
        ["all", "Todos", "Todos os elementos"],
        ["counter", "🔢", "Contadores"],
        ["text", "🅣", "Textos"],
        ["image", "🖼", "Imagens"],
        ["timer", "⏱", "Timers"],
        ["group", "🗂", "Grupos"],
      ];
      const tabs = el("div", { class: "tree-tabs" });
      TABS.forEach(([k, lbl, title]) => {
        const b = el("button", { class: "tt-btn" + (this.treeFilter === k ? " active" : ""), type: "button", title, text: `${lbl} ${counts[k] || 0}` });
        b.addEventListener("click", () => { this.treeFilter = k; this.renderTree(); });
        tabs.appendChild(b);
      });
      this.tree.appendChild(tabs);

      const NAMES = { all: "Elementos", counter: "Contadores", text: "Textos", image: "Imagens", timer: "Timers", group: "Grupos" };
      const list = this.treeFilter === "all" ? Store.counters : Store.counters.filter((c) => (c.type || "counter") === this.treeFilter);
      this.tree.appendChild(el("div", { class: "tree-group" }, [el("span", { class: "tg-caret", text: "▾" }), el("span", { text: NAMES[this.treeFilter] }), el("span", { class: "tg-count", text: String(list.length) })]));
      if (!list.length) { this.tree.appendChild(el("div", { class: "tree-empty", text: this.treeFilter === "all" ? "Nenhum. Use + Elemento." : "Nenhum elemento deste tipo." })); return; }

      const buildItem = (c, depth) => {
        const isGroup = c.type === "group";
        const collapsed = this.treeCollapsed.has(c.id);
        const kids = [];
        if (isGroup) {
          const caret = el("button", { class: "ti-btn ti-caret", type: "button", title: collapsed ? "Expandir" : "Recolher", text: collapsed ? "▸" : "▾" });
          kids.push(caret);
        }
        kids.push(el("span", { class: "ti-name", text: (TYPE_ICON[c.type] ? TYPE_ICON[c.type] + " " : "") + c.name }));
        kids.push(el("div", { class: "ti-acts" }, [
          el("button", { class: "ti-btn ti-lock", type: "button", title: c.locked ? "Desbloquear" : "Bloquear", text: c.locked ? "🔒" : "🔓" }),
          el("button", { class: "ti-btn ti-vis", type: "button", title: c.visible ? "Ocultar" : "Mostrar", text: c.visible ? "👁" : "🙈" }),
          el("button", { class: "ti-btn ti-dup", type: "button", title: "Duplicar", text: "⧉" }),
          el("button", { class: "ti-btn ti-up", type: "button", title: "Subir", text: "▲" }),
          el("button", { class: "ti-btn ti-down", type: "button", title: "Descer", text: "▼" }),
          el("button", { class: "ti-btn ti-del danger", type: "button", title: "Excluir", text: "🗑" }),
        ]));
        const item = el("div", { class: "tree-item" + (Store.selectedIds.includes(c.id) ? " selected" : "") + (c.visible ? "" : " off"), dataset: { id: c.id } }, kids);
        if (depth) item.style.paddingLeft = (8 + depth * 16) + "px";
        this.tree.appendChild(item);
        if (isGroup && !collapsed && this.treeFilter === "all") childrenOf(c.id).forEach((k) => buildItem(k, depth + 1));
      };
      if (this.treeFilter === "all") list.filter((c) => !c.parent).forEach((c) => buildItem(c, 0));
      else list.forEach((c) => buildItem(c, 0));
    },
    onTreeClick(e) {
      const item = e.target.closest(".tree-item"); if (!item) return; const id = item.dataset.id;
      const btn = e.target.closest(".ti-btn");
      if (btn && btn.classList.contains("ti-caret")) {
        if (this.treeCollapsed.has(id)) this.treeCollapsed.delete(id); else this.treeCollapsed.add(id);
        this.renderTree(); return;
      }
      if (!btn) { Store.select(id, e.shiftKey); return; }
      const c = Store.counters.find((x) => x.id === id); if (!c) return;
      if (btn.classList.contains("ti-lock")) this.setLock(id, !c.locked);
      else if (btn.classList.contains("ti-vis")) this.toggleVis(id);
      else if (btn.classList.contains("ti-dup")) this.duplicate(id);
      else if (btn.classList.contains("ti-up")) this.move(id, "up");
      else if (btn.classList.contains("ti-down")) this.move(id, "down");
      else if (btn.classList.contains("ti-del")) this.del(id);
    },

    /* --------------------------------------------------- ações de estrutura */
    async addCounter() { return this.addElement("counter"); },
    async addElement(type) {
      const names = { counter: "Novo", text: "Texto livre", image: "Imagem", timer: "Timer", group: "Grupo" };
      // Com um grupo selecionado, o novo elemento já nasce dentro dele.
      const selc = Store.selected();
      const parent = selc && selc.type === "group" && type !== "group" ? selc.id : "";
      try {
        const r = await API.post("/counter/create", { name: names[type] || "Novo", type: type || "counter", parent });
        Store.setCounters(r.counters); Store.select(r.counter.id);
        if (parent) toast(`Criado dentro do grupo "${selc.name}"`);
      } catch (e) { toast(e.message); }
    },
    async duplicate(id) { try { const r = await API.post("/counter/duplicate", { id }); Store.setCounters(r.counters); Store.select(r.counter.id); toast("Duplicado"); } catch (e) { toast(e.message); } },
    async del(id) {
      const c = elById(id);
      const kids = childrenOf(id).length;
      const msg = c && c.type === "group" && kids
        ? `Excluir o grupo "${c.name}"? Os ${kids} elementos dentro dele serão soltos no canvas (não serão apagados).`
        : "Excluir este elemento?";
      if (!confirm(msg)) return;
      try { const r = await API.post("/counter/delete", { id }); if (Store.selectedId === id) Store.selectedId = null; Store.setCounters(r.counters); } catch (e) { toast(e.message); }
    },
    async delMany(ids) {
      if (!confirm(`Excluir ${ids.length} contadores selecionados?`)) return;
      try {
        let r = null;
        for (const id of ids) r = await API.post("/counter/delete", { id });
        Store.selectedIds = []; Store.selectedId = null;
        if (r) Store.setCounters(r.counters);
        toast(`${ids.length} contadores excluídos`);
      } catch (e) { toast(e.message); }
    },
    /* ------------------------------------------------ alinhar / distribuir */
    align(kind) {
      const items = Store.selectedIds
        .map((id) => { const c = Store.counters.find((x) => x.id === id); const elm = this.counterElById(id); return c && elm && !c.locked ? { c, w: elm.offsetWidth, h: elm.offsetHeight } : null; })
        .filter(Boolean);
      if (!items.length) { toast("Selecione ao menos um contador."); return; }
      // Com 1 selecionado, alinha em relação ao canvas; com vários, à seleção.
      const single = items.length === 1;
      const L = single ? 0 : Math.min(...items.map((i) => i.c.x));
      const R = single ? CW() : Math.max(...items.map((i) => i.c.x + i.w));
      const T = single ? 0 : Math.min(...items.map((i) => i.c.y));
      const B = single ? CH() : Math.max(...items.map((i) => i.c.y + i.h));
      if (kind === "left") items.forEach((i) => this.setPosition(i.c.id, { x: L }));
      else if (kind === "right") items.forEach((i) => this.setPosition(i.c.id, { x: Math.round(R - i.w) }));
      else if (kind === "ch") items.forEach((i) => this.setPosition(i.c.id, { x: Math.round((L + R) / 2 - i.w / 2) }));
      else if (kind === "top") items.forEach((i) => this.setPosition(i.c.id, { y: T }));
      else if (kind === "bottom") items.forEach((i) => this.setPosition(i.c.id, { y: Math.round(B - i.h) }));
      else if (kind === "cv") items.forEach((i) => this.setPosition(i.c.id, { y: Math.round((T + B) / 2 - i.h / 2) }));
      else if (kind === "dh" || kind === "dv") {
        if (items.length < 3) { toast("Distribuir precisa de 3+ selecionados."); return; }
        if (kind === "dh") {
          const sorted = [...items].sort((a, b) => a.c.x - b.c.x);
          const gap = ((R - L) - sorted.reduce((s, i) => s + i.w, 0)) / (sorted.length - 1);
          let x = L; sorted.forEach((i) => { this.setPosition(i.c.id, { x: Math.round(x) }); x += i.w + gap; });
        } else {
          const sorted = [...items].sort((a, b) => a.c.y - b.c.y);
          const gap = ((B - T) - sorted.reduce((s, i) => s + i.h, 0)) / (sorted.length - 1);
          let y = T; sorted.forEach((i) => { this.setPosition(i.c.id, { y: Math.round(y) }); y += i.h + gap; });
        }
      }
      this._pushHistoryNow();
    },
    async setLock(id, locked) { try { const r = await API.post("/counter/lock", { id, locked }); Store.setCounters(r.counters); } catch (e) { toast(e.message); } },
    async toggleVis(id) { try { const r = await API.post("/counter/visibility", { id }); Store.setCounters(r.counters); } catch (e) { toast(e.message); } },
    async move(id, dir) { try { const r = await API.post("/counter/move", { id, direction: dir }); Store.setCounters(r.counters); } catch (e) { toast(e.message); } },

    /* ---------------------------------------------------------- propriedades */
    ctxGlobal() { return { get: (k) => Store.theme[k], setPatch: (o) => this.patchTheme(o) }; },
    ctxSelected() {
      return {
        get: (k) => { const s = Store.selected(); return s && s.style && k in s.style ? s.style[k] : Store.theme[k]; },
        setPatch: (o) => { const s = Store.selected(); if (s) this.patchStyle(s.id, o); },
      };
    },
    renderProps() {
      const box = this.propsCtx; box.innerHTML = "";
      const sel = Store.selected();
      if (!sel) {
        box.appendChild(el("div", { class: "props-head" }, [el("span", { class: "sel-tag", text: "Global" }), el("strong", { text: "Todos os contadores" })]));
        this.buildSections(box, this.ctxGlobal(), true);
        return;
      }
      const nSel = Store.selectedIds.length;
      box.appendChild(el("div", { class: "sel-head" }, [
        el("div", {}, [
          el("span", { class: "sel-tag", text: nSel > 1 ? `${nSel} selecionados` : "Elemento" }),
          el("strong", { text: nSel > 1 ? `${sel.name} (principal)` : sel.name }),
        ]),
        el("div", { class: "sel-head-btns" }, [
          el("button", { class: "btn btn-ghost sm", type: "button", text: "▸ Controlar", title: "Controlar valores deste contador", onclick: () => Nav.gotoControl(sel.id) }),
          el("button", { class: "btn btn-ghost sm", type: "button", text: "Restaurar", title: "Restaurar ao global", onclick: () => this.restoreSelected(sel.id) }),
        ]),
      ]));
      const es = this.elementSection(sel);
      if (es) box.appendChild(es);
      box.appendChild(this.transformSection(sel));
      this.buildSections(box, this.ctxSelected(), false);
      box.appendChild(this.customCssSection(sel));
    },
    /* CSS livre, aplicado apenas ao elemento selecionado (overlay + canvas). */
    customCssSection(sel) {
      const body = el("div", { class: "sec-body" });
      const ta = el("textarea", { class: "fx-css ccss", spellcheck: "false",
        placeholder: "border: 2px solid gold;\n\n.value { color: #ffd700; }\n& { backdrop-filter: blur(4px); }" });
      ta.value = (sel.style && sel.style.custom_css) || "";
      ta.addEventListener("input", debounce(() => {
        this.patchStyle(sel.id, { custom_css: ta.value.trim() || null });
      }, 350));
      body.appendChild(ta);
      body.appendChild(el("div", { class: "hk-note", text: "Declarações soltas valem para o card inteiro. Seletores (ex.: .value, .label, .group-children) atingem as partes internas. \"&\" = o próprio card. Vale para o overlay e para este canvas." }));
      const has = !!(sel.style && sel.style.custom_css);
      const head = el("button", { class: "sec-head" + (has ? "" : " collapsed"), type: "button" }, [el("span", { text: "CSS personalizado" + (has ? " ●" : "") }), el("span", { class: "sec-caret", text: "▾" })]);
      if (!has) body.classList.add("hidden");
      head.addEventListener("click", () => { head.classList.toggle("collapsed"); body.classList.toggle("hidden"); });
      return el("div", { class: "sec" }, [head, body]);
    },
    /* Seção específica do tipo do elemento (texto / imagem / cronômetro). */
    elementSection(sel) {
      if (!sel.type || sel.type === "counter") return null;
      const body = el("div", { class: "sec-body" });
      if (sel.type === "text") {
        const inp = el("input", { class: "pf-name", maxlength: 200, value: sel.name });
        inp.addEventListener("change", async () => {
          const name = inp.value.trim(); if (!name) { inp.value = sel.name; return; }
          try { Store.setCounters((await API.post("/counter/rename", { id: sel.id, name })).counters); } catch (e) { toast(e.message); }
        });
        body.appendChild(el("label", { class: "pf-field" }, [el("span", { text: "Conteúdo do texto" }), inp]));
        body.appendChild(el("div", { class: "hk-note", text: "Macros: %winrate% · %wins% · %losses% · %games% — usam os contadores de V/D definidos no 📊 Stats." }));
      } else if (sel.type === "image") {
        const url = el("input", { class: "pf-name", value: sel.src || "", placeholder: "https://… ou use Enviar imagem" });
        url.addEventListener("change", async () => {
          try { Store.setCounters((await API.post("/counter/src", { id: sel.id, src: url.value.trim() })).counters); } catch (e) { toast(e.message); }
        });
        const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", hidden: true });
        file.addEventListener("change", async () => {
          const f = file.files[0]; if (!f) return;
          const fd = new FormData(); fd.append("file", f);
          try {
            const r = await fetch("/assets/upload", { method: "POST", body: fd });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || "Falha no upload");
            Store.setCounters((await API.post("/counter/src", { id: sel.id, src: d.url })).counters);
            this.renderProps(); toast("Imagem enviada ✓");
          } catch (e) { toast(e.message); }
          file.value = "";
        });
        body.appendChild(el("label", { class: "pf-field" }, [el("span", { text: "URL da imagem" }), url]));
        body.appendChild(el("div", { class: "row-actions" }, [
          el("button", { class: "btn btn-secondary sm", type: "button", text: "⬆ Enviar imagem", onclick: () => file.click() }),
        ]));
        body.appendChild(file);
      } else if (sel.type === "timer") {
        const st = sel.style || {};
        // Rótulo: renomear direto aqui
        const nameIn = el("input", { class: "pf-name", maxlength: 40, value: sel.name });
        nameIn.addEventListener("change", async () => {
          const name = nameIn.value.trim(); if (!name) { nameIn.value = sel.name; return; }
          try { Store.setCounters((await API.post("/counter/rename", { id: sel.id, name })).counters); } catch (e) { toast(e.message); }
        });
        body.appendChild(el("label", { class: "pf-field" }, [el("span", { text: "Rótulo (nome exibido)" }), nameIn]));
        // Mostrar/ocultar o rótulo
        const showIn = el("input", { type: "checkbox", class: "switch" }); showIn.checked = !st.hide_label;
        showIn.addEventListener("change", () => this.patchStyle(sel.id, { hide_label: showIn.checked ? null : true }));
        body.appendChild(el("label", { class: "row row-toggle" }, [el("span", { class: "row-label", text: "Mostrar rótulo" }), showIn]));
        // Linha ou coluna (atalho para a posição do rótulo)
        const laySel = el("select", { class: "row-select" });
        [["left", "➡ Linha — rótulo ao lado"], ["top", "⬇ Coluna — rótulo em cima"], ["right", "⬅ Linha — rótulo à direita"], ["bottom", "⬆ Coluna — rótulo embaixo"]].forEach(([v, n]) => {
          const o = el("option", { value: v, text: n }); if ((st.label_position || Store.theme.label_position || "left") === v) o.selected = true; laySel.appendChild(o);
        });
        laySel.addEventListener("change", () => this.patchStyle(sel.id, { label_position: laySel.value }));
        body.appendChild(row("Layout", laySel));
        body.appendChild(el("div", { class: "row-actions" }, [
          el("button", { class: "btn btn-secondary sm", type: "button", text: Timers.running(sel.id) ? "⏸ Pausar" : "▶ Iniciar",
            onclick: async () => { try { Store.setCounters((await API.post("/counter/timer", { id: sel.id, op: "toggle" })).counters); this.renderProps(); } catch (e) { toast(e.message); } } }),
          el("button", { class: "btn btn-ghost sm", type: "button", text: "↺ Zerar",
            onclick: async () => { try { Store.setCounters((await API.post("/counter/timer", { id: sel.id, op: "reset" })).counters); } catch (e) { toast(e.message); } } }),
        ]));
        body.appendChild(el("div", { class: "hk-note", text: "Dica: em ⌨ Hotkeys, o atalho de Incrementar vira Iniciar/Pausar e o de Reset zera o cronômetro." }));
      } else if (sel.type === "group") {
        const st = sel.style || {};
        const patch = (o) => this.patchStyle(sel.id, o);
        // Direção do empilhamento dos filhos
        const dirSel = el("select", { class: "row-select" });
        [["column", "⬇ Coluna (um embaixo do outro)"], ["row", "➡ Linha (lado a lado)"]].forEach(([v, n]) => {
          const o = el("option", { value: v, text: n }); if ((st.group_dir || "column") === v) o.selected = true; dirSel.appendChild(o);
        });
        dirSel.addEventListener("change", () => patch({ group_dir: dirSel.value }));
        body.appendChild(row("Direção", dirSel));
        body.appendChild(numRow("Espaçamento", Number(st.group_gap ?? 12), 0, 120, "px", "ggap", (v) => patch({ group_gap: v })));
        const alSel = el("select", { class: "row-select" });
        [["stretch", "Esticar"], ["start", "Início"], ["center", "Centro"], ["end", "Fim"]].forEach(([v, n]) => {
          const o = el("option", { value: v, text: n }); if ((st.group_align || "stretch") === v) o.selected = true; alSel.appendChild(o);
        });
        alSel.addEventListener("change", () => patch({ group_align: alSel.value }));
        body.appendChild(row("Alinhamento", alSel));
        const titleIn = el("input", { type: "checkbox", class: "switch" }); titleIn.checked = !!st.group_title;
        titleIn.addEventListener("change", () => { patch({ group_title: titleIn.checked }); });
        body.appendChild(el("label", { class: "row row-toggle" }, [el("span", { class: "row-label", text: "Mostrar título (nome do grupo)" }), titleIn]));
        const freeIn = el("input", { type: "checkbox", class: "switch" }); freeIn.checked = !!st.group_free;
        freeIn.addEventListener("change", () => { patch({ group_free: freeIn.checked }); Store.emit("selection"); });
        body.appendChild(el("label", { class: "row row-toggle" }, [el("span", { class: "row-label", text: "Posição livre (x/y dos filhos)" }), freeIn]));
        if (st.group_free) body.appendChild(numRow("Altura do grupo", Number(st.group_height) || 300, 60, 2000, "px", "gheight", (v) => patch({ group_height: v })));
        body.appendChild(el("div", { class: "hk-note", text: "Para colocar elementos aqui dentro: selecione o elemento e use Transformar → \"Grupo (pai)\" — ou crie um elemento novo com este grupo selecionado." }));
      }
      const titles = { text: "Texto", image: "Imagem", timer: "Cronômetro", group: "Grupo" };
      const head = el("button", { class: "sec-head", type: "button" }, [el("span", { text: titles[sel.type] }), el("span", { class: "sec-caret", text: "▾" })]);
      head.addEventListener("click", () => { head.classList.toggle("collapsed"); body.classList.toggle("hidden"); });
      return el("div", { class: "sec" }, [head, body]);
    },
    buildSections(box, ctx, isGlobal) {
      SECTIONS.forEach((sec) => {
        const controls = sec.controls.filter((s) => (isGlobal ? !s.elementOnly : !s.globalOnly && !s.skipElement));
        if (!controls.length) return;
        const body = el("div", { class: "sec-body" });
        controls.forEach((spec) => body.appendChild(renderControl(spec, ctx)));
        const head = el("button", { class: "sec-head" + (sec.collapsed ? " collapsed" : ""), type: "button" }, [el("span", { text: sec.title }), el("span", { class: "sec-caret", text: "▾" })]);
        if (sec.collapsed) body.classList.add("hidden");
        head.addEventListener("click", () => { head.classList.toggle("collapsed"); body.classList.toggle("hidden"); });
        box.appendChild(el("div", { class: "sec" }, [head, body]));
      });
    },
    transformSection(sel) {
      const body = el("div", { class: "sec-body" });
      // Tipo do elemento — conversível a qualquer momento
      const typeSel = el("select", { class: "row-select" });
      [["counter", "🔢 Contador"], ["text", "🅣 Texto livre"], ["image", "🖼 Imagem"], ["timer", "⏱ Timer"], ["group", "🗂 Grupo"]].forEach(([v, n]) => {
        const o = el("option", { value: v, text: n });
        if ((sel.type || "counter") === v) o.selected = true;
        typeSel.appendChild(o);
      });
      typeSel.addEventListener("change", async () => {
        try {
          Store.setCounters((await API.post("/counter/type", { id: sel.id, type: typeSel.value })).counters);
          Store.emit("selection");   // re-renderiza canvas, árvore e propriedades
          toast(`Convertido para ${typeSel.options[typeSel.selectedIndex].text}`);
        } catch (e) { toast(e.message); }
      });
      body.appendChild(row("Tipo", typeSel));

      // Grupo pai — coloca/tira o elemento de dentro de um grupo
      const parentSel = el("select", { class: "row-select" });
      parentSel.appendChild(el("option", { value: "", text: "— nenhum (canvas) —" }));
      Store.counters
        .filter((g) => g.type === "group" && g.id !== sel.id && !isDescendant(g.id, sel.id))
        .forEach((g) => {
          const o = el("option", { value: g.id, text: "🗂 " + g.name });
          if ((sel.parent || "") === g.id) o.selected = true;
          parentSel.appendChild(o);
        });
      parentSel.addEventListener("change", async () => {
        try {
          Store.setCounters((await API.post("/counter/parent", { id: sel.id, parent: parentSel.value })).counters);
          Store.emit("selection");
          toast(parentSel.value ? "Movido para dentro do grupo" : "Movido para o canvas");
          this._pushHistoryNow();
        } catch (e) { toast(e.message); }
      });
      body.appendChild(row("Grupo (pai)", parentSel));

      // Efeito ao mudar o valor DESTE elemento (herda o global se não definido)
      const globalFx = Store.theme.effect || "pop";
      const globalName = (FX.byId(globalFx) || {}).name || globalFx;
      const fxCur = (sel.style && sel.style.effect) || "";
      const fxSel = el("select", { class: "row-select" });
      [["", `Global (${globalName})`], ["none", "— sem animação —"], ...FX.list.map((e) => [e.id, e.name])].forEach(([v, n]) => {
        const o = el("option", { value: v, text: n }); if (v === fxCur) o.selected = true; fxSel.appendChild(o);
      });
      fxSel.addEventListener("change", () => this.patchStyle(sel.id, { effect: fxSel.value || null })); // "" = herda o global
      const fxTest = el("button", {
        class: "icon-btn", type: "button", title: "Testar o efeito no canvas", text: "▶",
        onclick: () => {
          const id = fxSel.value || globalFx;
          if (id === "none") { toast("Sem animação selecionada."); return; }
          const n = this.counterElById(sel.id);
          if (n) FX.trigger(n, id);
        },
      });
      body.appendChild(row("Efeito", el("div", { class: "row-ctl" }, [fxSel, fxTest])));

      const eff = (sel.style && sel.style.font_size != null) ? sel.style.font_size : (Store.theme.font_size || 48);
      const parentEl = sel.parent ? elById(sel.parent) : null;
      const inAutoGroup = !!(parentEl && !(parentEl.style && parentEl.style.group_free));
      if (inAutoGroup) {
        body.appendChild(el("div", { class: "hk-note", text: "📌 Posição controlada pelo grupo (layout automático). Para x/y livres, ative \"Posição livre\" no grupo pai." }));
      } else {
        body.appendChild(numRow("X", Math.round(sel.x), 0, CW(), "px", "pos-x", (v) => this.setPosition(sel.id, { x: v })));
        body.appendChild(numRow("Y", Math.round(sel.y), 0, CH(), "px", "pos-y", (v) => this.setPosition(sel.id, { y: v })));
      }
      body.appendChild(numRow("Tamanho", Math.round(eff), 12, 300, "px", "size", (v) => this.patchStyle(sel.id, { font_size: v })));
      const lockIn = el("input", { type: "checkbox", class: "switch" }); lockIn.checked = !!sel.locked;
      lockIn.addEventListener("change", () => this.setLock(sel.id, lockIn.checked));
      body.appendChild(el("label", { class: "row row-toggle" }, [el("span", { class: "row-label", text: "Bloquear" }), lockIn]));
      body.appendChild(el("div", { class: "row-actions" }, [
        el("button", { class: "btn btn-ghost sm", type: "button", text: "⧉ Duplicar", onclick: () => this.duplicate(sel.id) }),
        el("button", { class: "btn btn-ghost sm danger", type: "button", text: "🗑 Excluir", onclick: () => this.del(sel.id) }),
      ]));
      const head = el("button", { class: "sec-head", type: "button" }, [el("span", { text: "Transformar" }), el("span", { class: "sec-caret", text: "▾" })]);
      head.addEventListener("click", () => { head.classList.toggle("collapsed"); body.classList.toggle("hidden"); });
      return el("div", { class: "sec" }, [head, body]);
    },
    updateTransformInputs(c) {
      const set = (role, v) => { const a = this.propsCtx.querySelector(`[data-role="${role}"]`), b = this.propsCtx.querySelector(`[data-role="${role}-n"]`); if (a) a.value = v; if (b) b.value = v; };
      set("pos-x", Math.round(c.x)); set("pos-y", Math.round(c.y));
      const eff = (c.style && c.style.font_size != null) ? c.style.font_size : (Store.theme.font_size || 48); set("size", Math.round(eff));
    },

    /* ---------------------------------------------------------- mutações */
    patchTheme(o) { Store.setTheme({ ...Store.theme, ...o }); Object.assign(this._pendingTheme, o); this._flushDebounced(); this._historyDebounced(); },
    patchStyle(id, o) {
      const c = Store.counters.find((x) => x.id === id); if (!c) return; c.style = c.style || {};
      for (const k in o) { if (o[k] === null) delete c.style[k]; else c.style[k] = o[k]; }
      Store.emit("counters"); const p = this._pendingStyles[id] || (this._pendingStyles[id] = {}); Object.assign(p, o); this._flushDebounced(); this._historyDebounced();
    },
    setPosition(id, patch) {
      const c = Store.counters.find((x) => x.id === id); if (!c) return;
      if ("x" in patch) c.x = patch.x; if ("y" in patch) c.y = patch.y;
      Store.emit("counters"); this._pendingPos[id] = { x: Math.round(c.x), y: Math.round(c.y) }; this._flushDebounced(); this._historyDebounced();
    },
    _flush() {
      if (Object.keys(this._pendingTheme).length) { const p = this._pendingTheme; this._pendingTheme = {}; API.post("/theme", p).catch(() => {}); }
      for (const id in this._pendingStyles) { const style = this._pendingStyles[id]; delete this._pendingStyles[id]; API.post("/counter/style", { id, style, merge: true }).catch(() => {}); }
      for (const id in this._pendingPos) { const { x, y } = this._pendingPos[id]; delete this._pendingPos[id]; API.post("/counter/position", { id, x, y }).catch(() => {}); }
    },
    restoreSelected(id) { const c = Store.counters.find((x) => x.id === id); if (c) c.style = {}; Store.emit("counters"); API.post("/counter/style", { id, style: {}, merge: false }).catch(() => {}); this.renderProps(); this._pushHistoryNow(); },

    applyPreset(p) { this.patchTheme({ ...PRESET_EXTRAS, ...p.theme }); this._flush(); this.renderProps(); toast(`Preset "${p.name}" aplicado`); },
    exportTheme() { const blob = new Blob([JSON.stringify(Store.theme, null, 2)], { type: "application/json" }); const a = el("a", { href: URL.createObjectURL(blob), download: "theme.json" }); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href); },
    importTheme(e) { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const t = JSON.parse(rd.result); Store.setTheme({ ...Store.theme, ...t }); API.post("/theme", t).catch(() => {}); this.renderProps(); this._pushHistoryNow(); toast("Tema importado"); } catch { toast("Arquivo inválido"); } e.target.value = ""; }; rd.readAsText(f); },
    async resetTheme() { try { const d = await API.post("/theme/reset"); Store.setTheme(d.theme); this.renderProps(); this._pushHistoryNow(); toast("Tema restaurado"); } catch (e) { toast(e.message); } },

    /* ---------------------------------------------------------- histórico */
    _snapshot() { return { theme: { ...Store.theme }, styles: Object.fromEntries(Store.counters.map((c) => [c.id, { ...(c.style || {}) }])), pos: Object.fromEntries(Store.counters.map((c) => [c.id, { x: c.x, y: c.y }])) }; },
    _pushHistoryNow() {
      if (this._applying) return; const snap = this._snapshot(), s = JSON.stringify(snap);
      if (this._history[this._hi] && JSON.stringify(this._history[this._hi]) === s) return;
      this._history = this._history.slice(0, this._hi + 1); this._history.push(snap); if (this._history.length > 60) this._history.shift();
      this._hi = this._history.length - 1; this._updateUndo();
    },
    undo() { if (this._hi > 0) { this._hi--; this._applySnap(this._history[this._hi]); toast("Desfeito"); } },
    redo() { if (this._hi < this._history.length - 1) { this._hi++; this._applySnap(this._history[this._hi]); toast("Refeito"); } },
    _applySnap(snap) {
      this._applying = true;
      Store.setTheme({ ...snap.theme });
      Store.counters.forEach((c) => { c.style = { ...(snap.styles[c.id] || {}) }; if (snap.pos[c.id]) { c.x = snap.pos[c.id].x; c.y = snap.pos[c.id].y; } });
      Store.emit("counters");
      API.post("/theme", snap.theme).catch(() => {});
      Store.counters.forEach((c) => { API.post("/counter/style", { id: c.id, style: c.style, merge: false }).catch(() => {}); if (snap.pos[c.id]) API.post("/counter/position", { id: c.id, x: Math.round(c.x), y: Math.round(c.y) }).catch(() => {}); });
      this.renderProps(); this._updateUndo(); this._applying = false;
    },
    _updateUndo() { $("#undo").disabled = this._hi <= 0; $("#redo").disabled = this._hi >= this._history.length - 1; },
  };

  /* ---------------------------------------------- renderizador de controles */
  function swatchButton(getColor, alpha, onPick) {
    const fill = el("span", { class: "swatch-fill" });
    const sw = el("button", { class: "swatch", type: "button" }, [fill]);
    const paint = (c) => (fill.style.background = c); paint(getColor());
    sw.addEventListener("click", () => ColorPicker.open({ anchor: sw, color: getColor(), alpha, onChange: (out) => { paint(out); onPick(out); } }));
    return sw;
  }
  const row = (label, ctl) => el("div", { class: "row" }, [el("span", { class: "row-label", text: label }), ctl]);
  const rowCol = (label, kids) => el("div", { class: "row row-col" }, [el("span", { class: "row-label", text: label }), ...kids]);
  function numRow(label, val, min, max, unit, role, onInput) {
    const slider = el("input", { type: "range", min, max, value: val, class: "row-range", dataset: { role } });
    const num = el("input", { type: "number", min, max, value: val, class: "row-num", dataset: { role: role + "-n" } });
    slider.addEventListener("input", () => { num.value = slider.value; onInput(Number(slider.value)); });
    num.addEventListener("input", () => { let v = Number(num.value); if (!isNaN(v)) { v = clamp(Math.round(v), min, max); slider.value = v; onInput(v); } });
    return row(label, el("div", { class: "row-ctl" }, [slider, num, el("span", { class: "row-unit", text: unit })]));
  }

  function renderControl(spec, ctx) {
    const { key, label, type } = spec;
    if (type === "color" || type === "colorAlpha") {
      const alpha = type === "colorAlpha", def = alpha ? "rgba(0,0,0,0.5)" : "#000000";
      const sw = swatchButton(() => ctx.get(key) || def, alpha, (out) => ctx.setPatch({ [key]: out }));
      if (!spec.clearable) return row(label, sw);
      const clr = el("button", { class: "icon-btn", type: "button", title: "Remover", text: "×", onclick: () => { ctx.setPatch({ [key]: "" }); sw.querySelector(".swatch-fill").style.background = "transparent"; } });
      return row(label, el("div", { class: "row-ctl" }, [sw, clr]));
    }
    if (type === "font") {
      const cur = ctx.get(key) || FONTS[0][0];
      const sel = el("select", { class: "row-select" });
      FONTS.forEach(([v, n]) => { const o = el("option", { value: v, text: n }); if (v === cur) o.selected = true; sel.appendChild(o); });
      const prev = el("span", { class: "font-preview", text: "AaBbCc 123" }); prev.style.fontFamily = cur;
      sel.addEventListener("change", () => { prev.style.fontFamily = sel.value; ctx.setPatch({ [key]: sel.value }); });
      return rowCol(label, [sel, prev]);
    }
    if (type === "weight") {
      const cur = String(ctx.get(key) || 800); const wrap = el("div", { class: "weights" });
      ["100", "200", "300", "400", "500", "600", "700", "800", "900"].forEach((w) => {
        const b = el("button", { class: "wbtn" + (w === cur ? " active" : ""), type: "button", text: w }); b.style.fontWeight = w;
        b.addEventListener("click", () => { $$(".wbtn", wrap).forEach((x) => x.classList.remove("active")); b.classList.add("active"); ctx.setPatch({ [key]: w }); });
        wrap.appendChild(b);
      });
      return rowCol(label, [wrap]);
    }
    if (type === "range") {
      const isFloat = spec.step && spec.step < 1;
      const val = Number(ctx.get(key) ?? 0);
      const slider = el("input", { type: "range", min: spec.min, max: spec.max, step: spec.step || 1, value: val, class: "row-range" });
      const num = el("input", { type: "number", min: spec.min, max: spec.max, step: spec.step || 1, value: val, class: "row-num" });
      const unit = el("span", { class: "row-unit", text: spec.unit || "" });
      const fix = (v) => (isFloat ? Math.round(v * 10) / 10 : Math.round(v));
      slider.addEventListener("input", () => { num.value = slider.value; ctx.setPatch({ [key]: fix(Number(slider.value)) }); });
      num.addEventListener("input", () => { let v = Number(num.value); if (!isNaN(v)) { v = clamp(fix(v), spec.min, spec.max); slider.value = v; ctx.setPatch({ [key]: v }); } });
      return row(label, el("div", { class: "row-ctl" }, [slider, num, unit]));
    }
    if (type === "effect") {
      // opções vêm da biblioteca de efeitos (aba 🎬 VFX)
      const cur = ctx.get("effect") ?? (ctx.get("value_animation") === false ? "none" : "pop");
      const sel = el("select", { class: "row-select" });
      [["none", "— sem animação —"], ...FX.list.map((e) => [e.id, e.name])].forEach(([v, n]) => {
        const o = el("option", { value: v, text: n }); if (v === cur) o.selected = true; sel.appendChild(o);
      });
      sel.addEventListener("change", () => ctx.setPatch({ effect: sel.value }));
      return row(label, sel);
    }
    if (type === "select") {
      const cur = ctx.get(key); const sel = el("select", { class: "row-select" });
      spec.options.forEach(([v, n]) => { const o = el("option", { value: v, text: n }); if (v === cur) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => ctx.setPatch({ [key]: sel.value }));
      return row(label, sel);
    }
    if (type === "segmented") {
      const cur = ctx.get(key); const wrap = el("div", { class: "seg seg-full" });
      spec.options.forEach(([v, n]) => { const b = el("button", { class: v === cur ? "active" : "", type: "button", text: n }); b.addEventListener("click", () => { $$("button", wrap).forEach((x) => x.classList.remove("active")); b.classList.add("active"); ctx.setPatch({ [key]: v }); }); wrap.appendChild(b); });
      return row(label, wrap);
    }
    if (type === "shadow") {
      const kind = spec.kind, map = SHADOWS[kind], cur = ctx.get(key), mk = shadowKey(kind, cur);
      const sel = el("select", { class: "row-select" });
      if (!mk) sel.appendChild(el("option", { value: "__custom", text: "Personalizado", selected: true }));
      const opts = kind === "card" ? [["none", "Nenhuma"], ["soft", "Suave"], ["medium", "Média"], ["strong", "Forte"]] : [["none", "Nenhuma"], ["soft", "Suave"], ["strong", "Forte"]];
      opts.forEach(([k, n]) => { const o = el("option", { value: k, text: n }); if (mk === k) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => { if (sel.value !== "__custom") ctx.setPatch({ [key]: map[sel.value] }); });
      return row(label, sel);
    }
    if (type === "border") {
      const cur = parseBorder(ctx.get("card_border")); let hex = cur.hex;
      const wr = el("input", { type: "range", min: 0, max: 8, step: 1, value: cur.width, class: "row-range small" });
      const compose = () => { const w = Number(wr.value); ctx.setPatch({ card_border: w > 0 ? `${w}px solid ${hex}` : "0px solid transparent" }); };
      const sw = swatchButton(() => hex, false, (out) => { hex = out; compose(); });
      wr.addEventListener("input", compose);
      return row(label, el("div", { class: "row-ctl" }, [wr, sw]));
    }
    if (type === "toggle") {
      const input = el("input", { type: "checkbox", class: "switch" }); input.checked = !!ctx.get(key);
      input.addEventListener("change", () => ctx.setPatch({ [key]: input.checked }));
      return el("label", { class: "row row-toggle" }, [el("span", { class: "row-label", text: label }), input]);
    }
    return row(label, el("span", { text: String(ctx.get(key)) }));
  }

  /* =================================================================
     HOTKEYS — modal de atalhos globais (captura + conflitos)
     ================================================================= */
  // Usa a TECLA FÍSICA (e.code) -> token canônico, igual ao evdev no backend.
  const CODE_MAP = { Equal: "equal", Minus: "minus", Space: "space", Enter: "enter", Escape: "escape", Tab: "tab", Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", BracketLeft: "leftbrace", BracketRight: "rightbrace", Semicolon: "semicolon", Quote: "apostrophe", Comma: "comma", Period: "dot", Slash: "slash", Backslash: "backslash", Backquote: "grave" };
  function codeToToken(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
    if (/^Numpad/.test(code)) return "numpad" + code.slice(6).toLowerCase();
    return CODE_MAP[code] || code.toLowerCase();
  }
  function comboFromEvent(e) {
    const code = e.code || "";
    if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(code)) return null;
    const mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("meta");
    const tok = codeToToken(code);
    if (!tok) return null;
    return [...mods, tok].join("+");
  }
  const KEY_DISPLAY = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta", space: "Space", enter: "Enter", escape: "Esc", tab: "Tab", equal: "=", minus: "-", numpadadd: "Num +", numpadsubtract: "Num −", numpadmultiply: "Num *", numpaddivide: "Num /", numpadenter: "Num Enter", up: "↑", down: "↓", left: "←", right: "→", pageup: "PgUp", pagedown: "PgDn" };
  function prettyCombo(c) {
    return String(c).split("+").map((p) => {
      p = p.trim();
      if (KEY_DISPLAY[p]) return KEY_DISPLAY[p];
      if (/^numpad\d$/.test(p)) return "Num " + p.slice(6);
      if (/^f\d{1,2}$/.test(p)) return p.toUpperCase();
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(" + ");
  }
  const ACT_LABEL = { inc: "Incrementar", dec: "Decrementar", reset: "Reset" };

  const Hotkeys = {
    data: { enabled: false, bindings: {} },
    status: { available: true, active: false, error: null, backend: null, monitor: false, perm: null },
    devices: [], selectedDevices: [],
    capturing: null, _onKey: null, modal: null,

    onData(d) { if (!d) return; this._apply(d); if (this.isOpen()) { this.render(); this.renderBody(); } },
    onDetected(combo) { this.updateDetected(prettyCombo(combo)); if (this.capturing) this.finishCapture(combo); },
    updateDetected(text) { const d = this.modal && this.modal.querySelector("#hk-detected"); if (d) d.textContent = text; },
    isOpen() { return this.modal && !this.modal.classList.contains("hidden"); },
    _apply(s) { if (!s) return; this.data = { enabled: !!s.enabled, bindings: s.bindings || {} }; this.status = { available: s.available, active: s.active, error: s.error, backend: s.backend, monitor: s.monitor, perm: s.perm }; this.devices = s.devices || []; this.selectedDevices = s.selected_devices || []; },

    async open() {
      this.modal = $("#hotkeys-modal");
      try {
        this._apply(await API.get("/hotkeys"));
      } catch (err) {
        console.error("Falha ao carregar /hotkeys:", err);
        this.status.available = false;
        this.status.error = "Falha ao carregar a lista de dispositivos de hotkeys.";
      }
      this.render();
      this.modal.classList.remove("hidden");
      this.maybeMonitor(true);
    },
    close() {
      this.cancelCapture();
      if (this.modal) this.modal.classList.add("hidden");
      API.post("/hotkeys/monitor", { on: false }).catch(() => {});
    },
    // Só liga o monitor se já houver permissão de leitura — assim nunca captamos
    // teclas antes da hora (ex.: a senha do sudo digitada no campo abaixo).
    maybeMonitor(on) {
      const okPerm = !this.status.perm || !this.status.perm.needs_fix;
      if (on && okPerm) API.post("/hotkeys/monitor", { on: true }).then((s) => { this._apply(s); this.updateDetected("aguardando…"); }).catch(() => {});
      else if (!on) API.post("/hotkeys/monitor", { on: false }).catch(() => {});
    },
    async fixPerms() {
      try {
        const s = await API.post("/hotkeys/fix-permissions", {});
        const fix = s.fix || {};
        this._apply(s);
        this.render();
        toast(fix.ok ? (fix.message || "Permissão corrigida.") : (fix.error || "Não foi possível corrigir automaticamente."));
      } catch (e) { toast(e.message); }
    },

    render() {
      const m = this.modal; m.innerHTML = "";
      const card = el("div", { class: "modal-card" });
      card.appendChild(el("div", { class: "modal-head" }, [
        el("div", {}, [el("h2", { text: "⌨ Hotkeys globais" }), el("p", { class: "modal-sub", text: "Controle os contadores mesmo com o jogo/OBS em foco." })]),
        el("button", { class: "icon-btn", title: "Fechar", text: "×", onclick: () => this.close() }),
      ]));

      const master = el("label", { class: "hk-master" }, [
        (() => { const i = el("input", { type: "checkbox", class: "switch" }); i.checked = this.data.enabled; i.addEventListener("change", () => this.setEnabled(i.checked)); return i; })(),
        el("span", { text: "Ativar hotkeys" }),
      ]);
      const be = this.status.backend;
      const beText = be === "evdev" ? "evdev · Linux X11 e Wayland ✓" : be === "pynput" ? "pynput · Windows/macOS (e Linux X11)" : "indisponível";
      const notes = el("div", { class: "hk-note" });
      notes.appendChild(el("div", { class: "hk-backend", text: "Backend: " + beText }));
      if (!this.status.available) notes.appendChild(el("div", { class: "hk-warn", text: "⚠ " + (this.status.error || "Atalhos globais indisponíveis no servidor.") }));
      else if ((this.data.enabled || this.status.monitor) && !this.status.active && this.status.error) notes.appendChild(el("div", { class: "hk-warn", text: "⚠ " + this.status.error }));
      else if (!this.data.enabled && Object.keys(this.data.bindings || {}).length) {
        notes.appendChild(el("div", { class: "hk-warn", text: "⚠ Você tem atalhos registrados, mas as hotkeys estão DESLIGADAS — ligue \"Ativar hotkeys\" ao lado." }));
      }
      notes.appendChild(el("div", { class: "hk-detect" }, [el("span", { text: "Tecla detectada agora: " }), el("strong", { id: "hk-detected", text: "—" })]));
      notes.appendChild(el("div", { class: "hk-os", text: be === "evdev" ? "No Linux é preciso estar no grupo 'input'. A detecção fica ligada enquanto esta janela está aberta." : "O servidor precisa estar rodando." }));
      card.appendChild(el("div", { class: "modal-toolbar" }, [master, notes]));

      const perm = this.status.perm;
      if (perm && perm.needs_fix) {
        card.appendChild(el("div", { class: "hk-fix" }, [
          el("div", { class: "hk-fix-title", text: "⚠ Sem permissão para ler o teclado" }),
          el("div", { class: "hk-fix-desc", text: "No Linux, o servidor precisa poder ler /dev/input (grupo 'input')." }),
          el("button", { class: "btn btn-secondary sm", type: "button", text: "Corrigir permissões", onclick: () => this.fixPerms() }),
          el("div", { class: "hk-note", text: "Ou manualmente: sudo usermod -aG input $USER (e refaça login)." }),
        ]));
      }

      if (this.status.backend === "evdev") {
        const panelChildren = [el("div", { class: "hk-device-label", text: "Selecione o dispositivo de captura:" })];
        if (this.devices && this.devices.length) {
          const select = el("select", { class: "hk-device-select" });
          const auto = el("option", { value: "", text: "🎹 Todos os teclados (automático — recomendado)" });
          if (!this.selectedDevices.length) auto.selected = true;
          select.appendChild(auto);
          this.devices.forEach((dev) => {
            const name = String(dev.name || "").trim() || "Dispositivo";
            const count = dev.key_count || 0;
            const label = `${name} · ${count} teclas${dev.readable ? "" : " · ⚠ sem permissão"}`;
            const opt = el("option", { value: dev.path, text: label });
            if (this.selectedDevices.includes(dev.path)) opt.selected = true;
            select.appendChild(opt);
          });
          select.addEventListener("change", () => {
            const chosen = select.value ? [select.value] : [];
            this.saveDevices(chosen);
          });
          panelChildren.push(select);
          panelChildren.push(el("div", { class: "hk-note", text: "Selecione o dispositivo cujas teclas devem ser capturadas." }));
        } else {
          panelChildren.push(el("div", { class: "hk-note", text: "Nenhum dispositivo evdev detectado. Reinicie o servidor e verifique se o processo tem acesso aos dispositivos de entrada." }));
        }
        panelChildren.push(el("button", { class: "btn btn-secondary sm", type: "button", onclick: () => this.refreshDevices(), text: "Atualizar lista" }));
        card.appendChild(el("div", { class: "hk-device-panel" }, panelChildren));
      }

      card.appendChild(el("div", { class: "hk-body", id: "hk-body" }));
      m.appendChild(card);
      m.onclick = (e) => { if (e.target === m) this.close(); };
      this.renderBody();
    },

    renderBody() {
      const body = this.modal.querySelector("#hk-body"); if (!body) return; body.innerHTML = "";
      // Texto e imagem não têm ações; contadores e timers têm.
      const bindable = Store.counters.filter((c) => !c.type || c.type === "counter" || c.type === "timer");
      if (!bindable.length) { body.appendChild(el("div", { class: "hk-empty", text: "Crie um contador ou timer primeiro para configurar atalhos." })); return; }
      bindable.forEach((c) => {
        const binds = this.data.bindings[c.id] || {};
        const block = el("div", { class: "hk-block" }, [el("div", { class: "hk-block-name", text: (TYPE_ICON[c.type] ? TYPE_ICON[c.type] + " " : "") + c.name })]);
        const acts = c.type === "timer"
          ? [["inc", "▶⏸ Iniciar/Pausar"], ["reset", "↺ Zerar"]]
          : [["inc", "Incrementar"], ["dec", "Decrementar"], ["reset", "Reset"]];
        acts.forEach(([act, label]) => {
          const cur = binds[act] || "";
          const btn = el("button", { class: "hk-capture" + (cur ? " set" : ""), type: "button", text: cur ? prettyCombo(cur) : "definir atalho" });
          btn.addEventListener("click", () => this.startCapture(btn, c.id, act));
          const keys = el("div", { class: "hk-keys" }, [btn]);
          if (cur) { const clr = el("button", { class: "icon-btn hk-clear", title: "Limpar", text: "×" }); clr.addEventListener("click", () => this.setBinding(c.id, act, "")); keys.appendChild(clr); }
          block.appendChild(el("div", { class: "hk-row" }, [el("span", { class: "hk-label", text: label }), keys]));
        });
        body.appendChild(block);
      });
    },

    startCapture(btn, id, action) {
      this.cancelCapture();
      this.capturing = { btn, id, action };
      btn.classList.add("capturing"); btn.textContent = "Pressione uma combinação…";
      this._onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Escape") { this.cancelCapture(); this.renderBody(); return; }
        if (e.key === "Backspace" || e.key === "Delete") { const { id, action } = this.capturing; this.cancelCapture(); this.setBinding(id, action, ""); return; }
        const combo = comboFromEvent(e); if (!combo) return;
        this.finishCapture(combo);
      };
      window.addEventListener("keydown", this._onKey, true);
    },
    cancelCapture() {
      if (this._onKey) { window.removeEventListener("keydown", this._onKey, true); this._onKey = null; }
      if (this.capturing) this.capturing.btn.classList.remove("capturing");
      this.capturing = null;
    },
    finishCapture(combo) {
      const { id, action } = this.capturing; this.cancelCapture();
      const conflict = this.findConflict(combo, id, action);
      if (conflict) {
        const cname = (Store.counters.find((c) => c.id === conflict.id) || {}).name || "outro";
        if (!confirm(`⚠ ${prettyCombo(combo)} já é usado por "${cname}" (${ACT_LABEL[conflict.action]}).\nSubstituir?`)) { this.renderBody(); return; }
        this.setBinding(conflict.id, conflict.action, "", true).then(() => this.setBinding(id, action, combo));
        return;
      }
      this.setBinding(id, action, combo);
    },
    findConflict(combo, id, action) {
      for (const cid in this.data.bindings) { const acts = this.data.bindings[cid]; for (const act in acts) { if (acts[act] === combo && !(cid === id && act === action)) return { id: cid, action: act }; } }
      return null;
    },
    async setBinding(id, action, keys, silent) {
      try {
        const s = await API.post("/hotkeys/binding", { id, action, keys });
        this._apply(s);
        // Definiu um atalho com a chave mestra desligada? Liga sozinho —
        // ninguém registra um atalho para ele NÃO funcionar.
        if (keys && !this.data.enabled) {
          const s2 = await API.post("/hotkeys", { enabled: true });
          this._apply(s2);
          this.render();
          toast("Hotkeys ativadas automaticamente ✓");
          return;
        }
        if (!silent) this.renderBody();
      }
      catch (e) { toast(e.message); }
    },
    async saveDevices(paths) {
      try {
        const s = await API.post("/hotkeys/devices", { devices: paths });
        this._apply(s);
        this.render();
        toast("Dispositivos atualizados.");
      } catch (e) {
        toast(e.message);
      }
    },
    async setEnabled(enabled) {
      try { const s = await API.post("/hotkeys", { enabled }); this._apply(s); this.render(); if (enabled) toast(this.status.active ? "Hotkeys ativas" : "Hotkeys habilitadas"); }
      catch (e) { toast(e.message); }
    },
    async refreshDevices() {
      try {
        const s = await API.get("/hotkeys");
        this._apply(s);
        this.render();
        toast("Lista de dispositivos atualizada.");
      } catch (e) {
        toast(e.message);
      }
    },
  };

  /* =================================================================
     VFX — presets de efeitos de mudança de valor (aba 🎬)
     ================================================================= */
  const fxSlug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  const FX = {
    list: [], styleEl: null, draftEl: null, modal: null,
    ensureStyles() {
      if (!this.styleEl) { this.styleEl = el("style", { id: "fx-styles" }); document.head.appendChild(this.styleEl); }
      if (!this.draftEl) { this.draftEl = el("style", { id: "fx-draft" }); document.head.appendChild(this.draftEl); }
    },
    onData(list) {
      this.list = Array.isArray(list) ? list : [];
      this.ensureStyles();
      this.styleEl.textContent = this.list.map((e) => e.css).join("\n\n");
      this.renderGrid();
      if (document.body.dataset.mode === "editor") Editor.renderProps(); // atualiza o select de animação
    },
    async load() { try { this.onData((await API.get("/effects")).effects); } catch (_) {} },
    byId(id) { return this.list.find((e) => e.id === id); },
    trigger(elm, id) {
      Array.from(elm.classList).forEach((cl) => { if (cl.indexOf("fx-") === 0) elm.classList.remove(cl); });
      void elm.offsetWidth;
      elm.classList.add("fx-" + id);
    },
    stage(big) {
      const value = el("span", { class: "value", text: "42" });
      const root = el("div", { class: "fx-target" + (big ? " big" : "") }, [el("span", { class: "label", text: "KILLS" }), value]);
      const wrap = el("div", { class: "fx-stage" }, [root]);
      return { wrap, root, value };
    },
    renderGrid() {
      const grid = $("#vfx-grid"); if (!grid) return; grid.innerHTML = "";
      this.list.forEach((fx) => {
        const st = this.stage(false);
        const test = () => { st.value.textContent = String((parseInt(st.value.textContent, 10) || 0) + 1); this.trigger(st.root, fx.id); };
        st.wrap.style.cursor = "pointer"; st.wrap.title = "Clique para testar"; st.wrap.addEventListener("click", test);
        grid.appendChild(el("div", { class: "fx-card" }, [
          el("div", { class: "fx-card-head" }, [
            el("span", { class: "fx-name", text: fx.name }),
            fx.builtin ? el("span", { class: "fx-tag", text: "padrão" }) : el("span", { class: "fx-tag custom", text: "seu" }),
          ]),
          st.wrap,
          el("div", { class: "fx-actions" }, [
            el("button", { class: "btn btn-ghost sm", type: "button", text: "▶ Testar", onclick: test }),
            el("button", { class: "btn btn-ghost sm", type: "button", text: "✏ Editar", onclick: () => this.openEditor(fx) }),
            el("button", { class: "btn btn-ghost sm danger", type: "button", title: "Excluir", text: "🗑", onclick: () => this.remove(fx) }),
          ]),
        ]));
      });
      if (!this.list.length) grid.appendChild(el("div", { class: "hk-empty", text: "Nenhum efeito. Use ↺ Restaurar padrões." }));
    },
    template(slug) {
      return `/* A classe .fx-${slug} é aplicada ao elemento quando o valor muda.\n   Alvos: o card inteiro (.fx-${slug}) ou só o número (.fx-${slug} .value).\n   Variáveis do tema disponíveis: var(--accent), var(--text-shadow), ... */\n.fx-${slug} .value {\n  animation: ${slug} 0.5s ease;\n}\n@keyframes ${slug} {\n  0%   { transform: scale(1); }\n  50%  { transform: scale(1.35); color: var(--accent); }\n  100% { transform: scale(1); }\n}\n`;
    },
    openEditor(fx) {
      this.closeEditor();
      const isNew = !fx;
      const slug0 = isNew ? "meu-efeito" : fx.id;
      const name = el("input", { class: "pf-name", maxlength: 60, value: isNew ? "" : fx.name, placeholder: "ex.: Explosão" });
      const css = el("textarea", { class: "fx-css", spellcheck: "false" });
      css.value = isNew ? this.template(slug0) : fx.css;
      const st = this.stage(true);
      const err = el("div", { class: "pf-err" });
      const currentSlug = () => (isNew ? (fxSlug(name.value) || slug0) : fx.id);
      const test = () => {
        // aplica o CSS do rascunho e dispara no palco
        this.draftEl.textContent = css.value;
        st.value.textContent = String((parseInt(st.value.textContent, 10) || 0) + 1);
        this.trigger(st.root, currentSlug());
      };
      st.wrap.style.cursor = "pointer"; st.wrap.addEventListener("click", test);
      // novo efeito: renomear atualiza a classe no template automaticamente
      if (isNew) {
        let lastSlug = slug0;
        name.addEventListener("input", () => {
          const ns = fxSlug(name.value) || "meu-efeito";
          if (ns !== lastSlug) { css.value = css.value.split(lastSlug).join(ns); lastSlug = ns; }
        });
      }
      const save = async () => {
        try {
          const d = await API.post("/effects/save", { id: isNew ? null : fx.id, name: name.value.trim(), css: css.value });
          this.onData(d.effects); this.closeEditor(); toast(`Efeito "${d.effect.name}" salvo`);
        } catch (e) { err.textContent = e.message; }
      };
      const modal = el("div", { class: "modal" });
      modal.appendChild(el("div", { class: "modal-card fx-modal" }, [
        el("div", { class: "modal-head" }, [
          el("div", {}, [el("h2", { text: isNew ? "Novo efeito" : `Editar: ${fx.name}` }),
            el("p", { class: "modal-sub", text: "CSS puro — a classe .fx-<id> é aplicada quando o valor muda." })]),
          el("button", { class: "icon-btn", title: "Fechar", text: "×", onclick: () => this.closeEditor() }),
        ]),
        el("div", { class: "fx-editor-body" }, [
          el("label", { class: "pf-field" }, [el("span", { text: "Nome do efeito" }), name]),
          el("label", { class: "pf-field" }, [el("span", { text: "CSS do efeito" }), css]),
          st.wrap,
          err,
          el("div", { class: "pf-actions" }, [
            el("button", { class: "btn btn-ghost", type: "button", text: "▶ Testar", onclick: test }),
            el("button", { class: "btn btn-ghost", type: "button", text: "Cancelar", onclick: () => this.closeEditor() }),
            el("button", { class: "btn btn-primary", type: "button", text: "Salvar efeito", onclick: save }),
          ]),
        ]),
      ]));
      modal.onclick = (e) => { if (e.target === modal) this.closeEditor(); };
      document.body.appendChild(modal); this.modal = modal;
      name.focus();
    },
    closeEditor() { if (this.modal) { this.modal.remove(); this.modal = null; } if (this.draftEl) this.draftEl.textContent = ""; },
    async remove(fx) {
      if (!confirm(`Excluir o efeito "${fx.name}"?${fx.builtin ? "\n(É um padrão — dá para recuperar em ↺ Restaurar padrões.)" : ""}`)) return;
      try { const d = await API.post("/effects/delete", { id: fx.id }); this.onData(d.effects); } catch (e) { toast(e.message); }
    },
    async restore() {
      try { const d = await API.post("/effects/reset"); this.onData(d.effects); toast("Efeitos padrão restaurados"); } catch (e) { toast(e.message); }
    },
    init() {
      const nb = $("#fx-new"); if (nb) nb.addEventListener("click", () => this.openEditor(null));
      const rb = $("#fx-restore"); if (rb) rb.addEventListener("click", () => this.restore());
      this.load();
    },
  };

  /* =================================================================
     ESTATÍSTICAS — win rate, gráfico por sessão e sequências
     ================================================================= */
  const Stats = {
    modal: null, data: { events: [], started: 0 },
    isOpen() { return !!(this.modal && document.body.contains(this.modal)); },
    async open() {
      try { this.data = await API.get("/stats"); } catch (e) { toast(e.message); return; }
      this.render();
    },
    close() { if (this.modal) { this.modal.remove(); this.modal = null; } },
    async refresh() {
      if (!this.isOpen()) return;
      try { this.data = await API.get("/stats"); this.renderBody(); } catch (_) {}
    },
    counterEvents(id) {
      return (this.data.events || []).filter((e) => e.counter_id === id && ["inc", "dec", "reset", "set"].includes(e.action));
    },
    streaks(evts) {
      let cur = 0, best = 0;
      evts.forEach((e) => { if (e.action === "inc") { cur++; if (cur > best) best = cur; } else cur = 0; });
      return { cur, best };
    },
    sparkline(evts, current) {
      const vals = evts.length ? [Number(evts[0].before) || 0, ...evts.map((e) => Number(e.after) || 0)] : [current, current];
      const w = 150, h = 36, min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
      const pts = vals.map((v, i) => `${((i / (vals.length - 1 || 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("class", "spark");
      const pl = document.createElementNS(NS, "polyline");
      pl.setAttribute("points", pts); pl.setAttribute("fill", "none");
      svg.appendChild(pl);
      return svg;
    },
    render() {
      this.close();
      const m = el("div", { class: "modal" });
      m.appendChild(el("div", { class: "modal-card stats-card" }, [
        el("div", { class: "modal-head" }, [
          el("div", {}, [el("h2", { text: "📊 Estatísticas da sessão" }), el("p", { class: "modal-sub", id: "st-sub" })]),
          el("button", { class: "icon-btn", title: "Fechar", text: "×", onclick: () => this.close() }),
        ]),
        el("div", { class: "stats-body", id: "stats-body" }),
      ]));
      m.onclick = (e) => { if (e.target === m) this.close(); };
      document.body.appendChild(m); this.modal = m;
      this.renderBody();
    },
    renderBody() {
      const body = this.modal.querySelector("#stats-body"); if (!body) return; body.innerHTML = "";
      const sub = this.modal.querySelector("#st-sub");
      const d = new Date((this.data.started || 0) * 1000);
      const p = (n) => String(n).padStart(2, "0");
      sub.textContent = `Sessão iniciada às ${p(d.getHours())}:${p(d.getMinutes())} · o histórico zera quando o servidor reinicia`;
      const counters = Store.counters.filter((c) => !c.type || c.type === "counter");
      body.appendChild(this.winrateCard(counters));
      const grid = el("div", { class: "stats-grid" });
      counters.forEach((c) => {
        const evts = this.counterEvents(c.id);
        const incs = evts.filter((e) => e.action === "inc").length;
        const decs = evts.filter((e) => e.action === "dec").length;
        const st = this.streaks(evts);
        const cardEl = el("div", { class: "stat-card" }, [
          el("div", { class: "st-name", text: c.name }),
          el("div", { class: "st-val", text: String(c.value) }),
          el("div", { class: "st-meta", text: `nesta sessão: +${incs} · −${decs}` }),
          el("div", { class: "st-meta", text: `sequência de "+": atual ${st.cur} · melhor ${st.best}` }),
        ]);
        cardEl.appendChild(this.sparkline(evts, c.value));
        grid.appendChild(cardEl);
      });
      if (!counters.length) grid.appendChild(el("div", { class: "hk-empty", text: "Nenhum contador neste perfil." }));
      body.appendChild(grid);
    },
    winrateCard(counters) {
      // A escolha V/D fica no TEMA (por perfil) — assim o overlay no OBS
      // também enxerga, e os macros %winrate% funcionam em qualquer navegador.
      const guess = (re) => (counters.find((c) => re.test(c.name)) || {}).id || "";
      const mkSel = (cur, ph) => {
        const s = el("select", { class: "row-select" });
        s.appendChild(el("option", { value: "", text: ph }));
        counters.forEach((c) => { const o = el("option", { value: c.id, text: c.name }); if (c.id === cur) o.selected = true; s.appendChild(o); });
        return s;
      };
      const wSel = mkSel(Store.theme.winrate_w || guess(/vit[óo]|win|ganh/i), "— vitórias —");
      const lSel = mkSel(Store.theme.winrate_l || guess(/derrot|loss|lose|perd/i), "— derrotas —");
      const out = el("div", { class: "wr-out" });
      const update = (persist) => {
        if (persist && (wSel.value !== Store.theme.winrate_w || lSel.value !== Store.theme.winrate_l)) {
          API.post("/theme", { winrate_w: wSel.value, winrate_l: lSel.value }).catch(() => {});
        }
        const w = Store.counters.find((c) => c.id === wSel.value);
        const l = Store.counters.find((c) => c.id === lSel.value);
        out.innerHTML = "";
        if (!w || !l) { out.appendChild(el("span", { class: "st-meta", text: "Escolha os contadores de vitória e derrota para calcular." })); return; }
        const total = w.value + l.value;
        const pct = total ? (w.value / total) * 100 : 0;
        out.appendChild(el("span", { class: "wr-big", text: total ? pct.toFixed(1).replace(".", ",") + "%" : "—" }));
        out.appendChild(el("span", { class: "st-meta", text: total ? ` de win rate · ${w.value}V ${l.value}D (${total} jogos)` : " ainda sem jogos registrados" }));
      };
      wSel.addEventListener("change", () => update(true));
      lSel.addEventListener("change", () => update(true));
      const cardEl = el("div", { class: "stat-card wr-card" }, [
        el("div", { class: "st-name", text: "🏆 Win rate" }),
        el("div", { class: "wr-row" }, [wSel, el("span", { class: "tb-x", text: "×" }), lSel]),
        out,
        el("div", { class: "st-meta", text: "Dica: use %winrate%, %wins%, %losses% e %games% num elemento de Texto para mostrar isso no overlay." }),
      ]);
      update(false);
      return cardEl;
    },
  };

  /* =================================================================
     TEMA DO PAINEL — dark/light × verde/roxo/vermelho
     ================================================================= */
  const UITheme = {
    THEMES: [
      ["dark-green", "🌑 Verde escuro"], ["dark-purple", "🌑 Roxo escuro"], ["dark-red", "🌑 Vermelho escuro"],
      ["light-green", "☀️ Verde claro"], ["light-purple", "☀️ Roxo claro"], ["light-red", "☀️ Vermelho claro"],
    ],
    init() {
      const sel = $("#ui-theme-select"); if (!sel) return;
      const cur = document.documentElement.dataset.theme || "dark-green";
      this.THEMES.forEach(([v, n]) => { const o = el("option", { value: v, text: n }); if (v === cur) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => {
        document.documentElement.dataset.theme = sel.value;
        try { localStorage.setItem("obsco.uitheme", sel.value); } catch (_) {}
      });
    },
  };

  /* =================================================================
     PERFIS — seletor no topbar (contadores/tema/hotkeys por perfil)
     ================================================================= */
  const Profiles = {
    list: ["default"], active: "default", el: null,
    init() {
      this.el = $("#profile-select"); if (!this.el) return;
      this.el.addEventListener("change", () => this.onChange());
      API.get("/profiles").then((d) => this.onData(d)).catch(() => {});
    },
    onData(d) { if (!d) return; this.list = d.profiles || ["default"]; this.active = d.active || "default"; this.render(); },
    render() {
      if (!this.el) return; this.el.innerHTML = "";
      this.list.forEach((p) => { const o = el("option", { value: p, text: "Perfil: " + (p === "default" ? "padrão" : p) }); if (p === this.active) o.selected = true; this.el.appendChild(o); });
      this.el.appendChild(el("option", { value: "__new", text: "＋ Novo perfil…" }));
      if (this.list.length > 1) this.el.appendChild(el("option", { value: "__del", text: "🗑 Excluir perfil…" }));
    },
    async onChange() {
      const v = this.el.value;
      if (v === "__new") {
        this.render();
        this.openNewModal();
        return;
      }
      if (v === "__del") {
        this.render();
        const others = this.list.filter((p) => p !== "default" && p !== this.active);
        if (!others.length) { toast("Só é possível excluir perfis inativos (e nunca o padrão)."); return; }
        const name = prompt(`Qual perfil excluir? (${others.join(", ")})`); if (!name) return;
        if (!confirm(`Excluir o perfil "${name}"? Os arquivos dele serão apagados.`)) return;
        try { const d = await API.post("/profiles/delete", { name: name.trim() }); this.onData(d); toast(`Perfil "${name}" excluído`); }
        catch (e) { toast(e.message); }
        return;
      }
      if (v !== this.active) {
        try { const d = await API.post("/profiles/switch", { name: v }); this.onData(d); toast(`Perfil "${d.active}" ativo`); }
        catch (e) { toast(e.message); this.render(); }
      }
    },
    async openNewModal() {
      let templates = [];
      try { templates = (await API.get("/profiles/templates")).templates || []; } catch (_) {}
      const name = el("input", { class: "pf-name", maxlength: 40, placeholder: "ex.: Ranqueada 2026" });
      const sel = el("select", { class: "row-select" });
      sel.appendChild(el("option", { value: "", text: "Cópia do perfil atual" }));
      templates.forEach((t) => sel.appendChild(el("option", { value: t.id, text: t.label })));
      sel.addEventListener("change", () => { const t = templates.find((x) => x.id === sel.value); if (t && !name.dataset.touched) name.value = t.name; });
      name.addEventListener("input", () => { name.dataset.touched = "1"; });
      const err = el("div", { class: "pf-err", text: "" });
      const modal = el("div", { class: "modal" });
      const create = async () => {
        const nm = name.value.trim();
        if (!nm) { err.textContent = "Dê um nome ao perfil."; name.focus(); return; }
        try {
          const d = await API.post("/profiles/create", { name: nm, template: sel.value || null });
          const s = await API.post("/profiles/switch", { name: d.profile });
          this.onData(s); modal.remove();
          toast(`Perfil "${d.profile}" criado e ativado`);
        } catch (e) { err.textContent = e.message; }
      };
      modal.appendChild(el("div", { class: "modal-card pf-card" }, [
        el("div", { class: "modal-head" }, [
          el("div", {}, [el("h2", { text: "Novo perfil" }), el("p", { class: "modal-sub", text: "Contadores, tema e atalhos independentes." })]),
          el("button", { class: "icon-btn", title: "Fechar", text: "×", onclick: () => modal.remove() }),
        ]),
        el("div", { class: "pf-body" }, [
          el("label", { class: "pf-field" }, [el("span", { text: "Começar com" }), sel]),
          el("label", { class: "pf-field" }, [el("span", { text: "Nome do perfil" }), name]),
          err,
          el("div", { class: "pf-actions" }, [
            el("button", { class: "btn btn-ghost", type: "button", text: "Cancelar", onclick: () => modal.remove() }),
            el("button", { class: "btn btn-primary", type: "button", text: "Criar perfil", onclick: create }),
          ]),
        ]),
      ]));
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      name.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
      document.body.appendChild(modal);
      name.focus();
    },
  };

  /* =================================================================
     Modos + init
     ================================================================= */
  function setupModes() {
    const btns = $$(".mode-btn"), views = { control: $("#view-control"), editor: $("#view-editor"), vfx: $("#view-vfx") };
    document.body.dataset.mode = "control";
    btns.forEach((b) => b.addEventListener("click", () => {
      const mode = b.dataset.mode; btns.forEach((x) => x.classList.toggle("active", x === b));
      Object.entries(views).forEach(([k, v]) => v.classList.toggle("hidden", k !== mode));
      document.body.dataset.mode = mode;
      if (mode === "editor") Editor.onShow();
      else if (mode === "control") setTimeout(() => Control.scalePreview(), 20);
    }));
  }
  function setupOverlayLink() {
    const url = `${location.origin}/overlay`;
    const u = $("#overlay-url"); if (u) u.textContent = url;
    const o = $("#open-overlay"); if (o) o.href = url;
    const c = $("#copy-overlay"); if (c) c.addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); toast("Link do overlay copiado!"); } catch { toast(url); } });
  }
  function init() {
    Control.init(); setupModes(); setupOverlayLink(); Profiles.init(); UITheme.init(); FX.init(); UserPresets.load();
    const hk = $("#open-hotkeys"); if (hk) hk.addEventListener("click", () => Hotkeys.open());
    const st = $("#open-stats"); if (st) st.addEventListener("click", () => Stats.open());
    Store.on("counters", () => { if (Hotkeys.isOpen()) Hotkeys.renderBody(); Stats.refresh(); });
    // Tick dos cronômetros no Controle e no canvas do Editor
    setInterval(() => {
      $$(".ci-timer").forEach((n) => { const it = n.closest("[data-id]"); if (it) n.textContent = fmtTime(Timers.secs(it.dataset.id)); });
      $$('#canvas-counters .counter[data-type="timer"] .value').forEach((n) => {
        const r = n.closest(".counter"); if (r) n.textContent = fmtTime(Timers.secs(r.dataset.id));
      });
    }, 300);
    Live.connect();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
