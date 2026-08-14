/* ==========================================================================
   TallyUp — Overlay (lógica)
   Somente leitura. Canvas 1920x1080, contadores em posição absoluta.
   Atualização em tempo real via WebSocket.
   ========================================================================== */

(() => {
  "use strict";

  const overlay = document.getElementById("overlay");
  const stageWrap = document.getElementById("stage-wrap");
  const tpl = document.getElementById("counter-template");
  const els = new Map(); // id -> { root, label, value, last }
  let theme = {};

  const px = (v) => (typeof v === "number" ? `${v}px` : v);

  /* ------------------------ variáveis computadas (personalização) ------- */
  const LABEL_DIR = { left: "row", right: "row-reverse", top: "column", bottom: "column-reverse" };
  const ALIGN_ITEMS = { left: "flex-start", center: "center", right: "flex-end" };
  function applyExtraVars(s, get) {
    // gradiente de fundo (2ª cor definida -> linear-gradient)
    const bg2 = get("card_background2");
    if (bg2) {
      const bg = get("card_background") || "rgba(0,0,0,0.55)";
      s.setProperty("--card-bg", `linear-gradient(${Number(get("card_gradient_dir")) || 180}deg, ${bg}, ${bg2})`);
    }
    const w = Number(get("card_width") || 0);
    if (w > 0) s.setProperty("--card-width", w + "px"); else s.removeProperty("--card-width");
    const op = Number(get("opacity"));
    if (!isNaN(op) && op < 100) s.setProperty("--opacity", String(Math.max(0, Math.min(100, op)) / 100)); else s.removeProperty("--opacity");
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

  /* --------------------------------------------------- escala do palco */
  let cw = 1920, ch = 1080; // tamanho do canvas (vem do tema)
  function resizeStage() {
    const scale = Math.min(stageWrap.clientWidth / cw, stageWrap.clientHeight / ch) || 1;
    overlay.style.transform = `scale(${scale})`;
  }
  function applyCanvasSize(t) {
    cw = Number(t.canvas_width) || 1920;
    ch = Number(t.canvas_height) || 1080;
    overlay.style.width = cw + "px";
    overlay.style.height = ch + "px";
    resizeStage();
  }

  /* ------------------------------------------------------------- tema */
  function applyTheme(t) {
    theme = t || {};
    applyCanvasSize(theme);
    const s = document.documentElement.style;
    if (t.font_family) s.setProperty("--font-family", t.font_family);
    if (t.font_size != null) s.setProperty("--font-size", px(t.font_size));
    if (t.font_weight != null) s.setProperty("--font-weight", t.font_weight);
    if (t.letter_spacing != null) s.setProperty("--letter-spacing", px(t.letter_spacing));
    if (t.line_height != null) s.setProperty("--line-height", t.line_height);
    s.setProperty("--font-style", t.italic ? "italic" : "normal");
    s.setProperty("--value-transform", t.text_transform || "none");
    if (t.text_color) s.setProperty("--text-color", t.text_color);
    if (t.label_color) s.setProperty("--label-color", t.label_color);
    if (t.value_color) s.setProperty("--value-color", t.value_color);
    if (t.accent_color) s.setProperty("--accent", t.accent_color);
    if (t.card_background) s.setProperty("--card-bg", t.card_background);
    if (t.card_border) s.setProperty("--card-border", t.card_border);
    if (t.border_radius != null) s.setProperty("--radius", px(t.border_radius));
    if (t.padding != null) s.setProperty("--padding", px(t.padding));
    if (t.shadow) s.setProperty("--shadow", t.shadow);
    if (t.text_shadow) s.setProperty("--text-shadow", t.text_shadow);
    s.setProperty("--label-transform", t.uppercase_labels ? "uppercase" : "none");
    overlay.classList.toggle("no-labels", t.show_labels === false);
    applyExtraVars(s, (k) => t[k]);
    // winrate_w/l podem ter mudado -> reprocessa macros dos textos
    if (lastAll) render(lastAll);
  }

  /* --------------------------------------------- estilo por contador */
  const STYLE_VARS = {
    value_color: "--value-color", label_color: "--label-color", accent_color: "--accent",
    card_background: "--card-bg", card_border: "--card-border", border_radius: "--radius",
    padding: "--padding", font_family: "--font-family", font_size: "--font-size",
    font_weight: "--font-weight", letter_spacing: "--letter-spacing", line_height: "--line-height",
    text_transform: "--value-transform", shadow: "--shadow", text_shadow: "--text-shadow",
  };
  const STYLE_PX = new Set(["border_radius", "padding", "font_size", "letter_spacing"]);
  function applyCounterStyle(el, style) {
    style = style || {};
    el.classList.toggle("no-label", !!style.hide_label);
    // italic é especial (bool -> font-style)
    if ("italic" in style) el.style.setProperty("--font-style", style.italic ? "italic" : "normal");
    else el.style.removeProperty("--font-style");
    for (const key in STYLE_VARS) {
      const varName = STYLE_VARS[key];
      const v = style[key];
      if (v == null || v === "") { el.style.removeProperty(varName); continue; }
      el.style.setProperty(varName, STYLE_PX.has(key) && typeof v === "number" ? v + "px" : v);
    }
    applyExtraVars(el.style, (k) => (k in style && style[k] !== null ? style[k] : theme[k]));
  }

  function place(el, c) {
    el.style.left = (c.x || 0) + "px";
    el.style.top = (c.y || 0) + "px";
    el.style.zIndex = c.order || 0;
  }

  /* ------------------------------------------------- grupos (childs) */
  const GROUP_ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
  function applyGroupVars(el, style) {
    style = style || {};
    el.style.setProperty("--group-dir", style.group_dir === "row" ? "row" : "column");
    el.style.setProperty("--group-gap", (Number(style.group_gap ?? 12) || 0) + "px");
    el.style.setProperty("--group-align", GROUP_ALIGN[style.group_align] || "stretch");
    el.classList.toggle("free", !!style.group_free);
    if (style.group_free) el.style.setProperty("--group-height", (Number(style.group_height) || 300) + "px");
    else el.style.removeProperty("--group-height");
  }

  /* ----------------------------------------- CSS personalizado (por elemento) */
  // Escopa o CSS do usuário para o próprio elemento: declarações soltas aplicam
  // direto no card; seletores são prefixados; "&" aponta para o card em si.
  function scopeCss(id, css) {
    const scope = `.counter[data-id="${id}"]`;
    css = String(css || "").trim();
    if (!css) return "";
    if (css.indexOf("{") === -1) return `${scope} { ${css} }`;
    return css.replace(/(^|\})([^{}]+)\{/g, (m, brace, sel) => {
      const scoped = sel.split(",").map((s) => {
        s = s.trim();
        if (!s) return s;
        if (s.startsWith("@") || /^(from|to|\d+%)$/i.test(s)) return s; // @media/@keyframes e frames
        if (s === "&") return scope;
        if (s.startsWith("&")) return scope + s.slice(1);
        return scope + " " + s;
      }).join(", ");
      return brace + " " + scoped + " {";
    });
  }
  let customStyleEl = null;
  function applyCustomCss(list) {
    if (!customStyleEl) { customStyleEl = document.createElement("style"); customStyleEl.id = "custom-css"; document.head.appendChild(customStyleEl); }
    const txt = (list || [])
      .filter((c) => c.style && c.style.custom_css)
      .map((c) => scopeCss(c.id, c.style.custom_css))
      .join("\n\n");
    if (customStyleEl.textContent !== txt) customStyleEl.textContent = txt;
  }

  /* --------------------------------------------------- efeitos (VFX) */
  let fxStyle = null;
  function applyEffects(list) {
    if (!fxStyle) { fxStyle = document.createElement("style"); fxStyle.id = "fx-styles"; document.head.appendChild(fxStyle); }
    fxStyle.textContent = (list || []).map((e) => e.css).join("\n\n");
  }
  // efeito efetivo: style.effect do elemento > theme.effect > legado value_animation
  function effectFor(c) {
    const id = (c.style && c.style.effect) || theme.effect;
    if (id) return id === "none" ? null : id;
    return theme.value_animation === false ? null : "pop";
  }
  function fxTrigger(root, id) {
    Array.from(root.classList).forEach((cl) => { if (cl.indexOf("fx-") === 0) root.classList.remove(cl); });
    void root.offsetWidth; // força reflow p/ reiniciar a animação
    root.classList.add("fx-" + id);
  }

  /* ------------------------------------------------ macros de texto */
  // %winrate% %wins% %losses% %games% — os contadores V/D vêm do tema
  // (winrate_w / winrate_l); sem configuração, adivinha pelo nome.
  let lastAll = null; // última lista completa recebida (para os macros)
  function byIdOrGuess(id, re) {
    const list = lastAll || [];
    return list.find((c) => c.id === id) ||
           list.find((c) => (!c.type || c.type === "counter") && re.test(c.name)) || null;
  }
  function expandMacros(text) {
    text = String(text ?? "");
    if (text.indexOf("%") === -1) return text;
    const w = byIdOrGuess(theme.winrate_w, /vit[óo]|win|ganh/i);
    const l = byIdOrGuess(theme.winrate_l, /derrot|loss|lose|perd/i);
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

  /* --------------------------------------------------- timer helpers */
  function fmtTime(secs) {
    let s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  // base recebida do servidor + tempo local desde o recebimento (imune a
  // diferenças de relógio; o servidor manda elapsed já calculado até "agora")
  const timerState = (c) => ({ base: Number(c.elapsed) || 0, running: !!c.running, at: Date.now() });
  const timerSecs = (t) => t.base + (t.running ? (Date.now() - t.at) / 1000 : 0);

  /* -------------------------------------------------------- render */
  function setupContent(root, label, value, c) {
    root.dataset.type = c.type || "counter";
    if (c.type === "text") {
      label.style.display = "none";
      value.textContent = expandMacros(c.name);
    } else if (c.type === "image") {
      label.style.display = "none"; value.style.display = "none";
      const img = document.createElement("img");
      img.className = "el-img"; img.alt = c.name; img.draggable = false;
      if (c.src) img.src = c.src;
      root.appendChild(img);
      return img;
    } else if (c.type === "timer") {
      label.textContent = c.name;
      value.textContent = fmtTime(timerSecs(timerState(c)));
    } else {
      label.textContent = c.name;
      value.textContent = c.value;
    }
    return null;
  }

  // A chave estrutural inclui pai e flags de grupo: mudou a árvore -> reconstrói.
  function keyOf(list) {
    return list.map((c) => c.id + ":" + (c.type || "counter") + ":" + (c.parent || "") +
      ":" + ((c.style && c.style.group_free) ? 1 : 0) + ((c.style && c.style.group_title) ? "t" : "")).join("|");
  }
  let lastKey = "";

  // Visível = o próprio elemento E todos os grupos acima dele.
  function visibleTree(all) {
    const byId = new Map(all.map((c) => [c.id, c]));
    return all.filter((c) => {
      let cur = c, hops = 0;
      while (cur) {
        if (!cur.visible) return false;
        cur = cur.parent ? byId.get(cur.parent) : null;
        if (++hops > 50) return false;
      }
      return true;
    });
  }

  function buildNode(c, kidsOf) {
    const root = tpl.content.firstElementChild.cloneNode(true);
    root.dataset.id = c.id;
    const label = root.querySelector(".label");
    const value = root.querySelector(".value");
    let img = null, childBox = null;
    if (c.type === "group") {
      root.dataset.type = "group";
      value.style.display = "none";
      if (c.style && c.style.group_title) { label.textContent = c.name; label.classList.add("group-title"); }
      else label.style.display = "none";
      childBox = document.createElement("div");
      childBox.className = "group-children";
      root.appendChild(childBox);
      applyGroupVars(root, c.style);
    } else {
      img = setupContent(root, label, value, c);
    }
    applyCounterStyle(root, c.style);
    els.set(c.id, { root, label, value, img, last: c.value,
                    timer: c.type === "timer" ? timerState(c) : null });
    const kids = kidsOf.get(c.id) || [];
    if (childBox) kids.forEach((k) => {
      const kn = buildNode(k, kidsOf);
      if (c.style && c.style.group_free) { kn.style.left = (k.x || 0) + "px"; kn.style.top = (k.y || 0) + "px"; }
      childBox.appendChild(kn);
    });
    return root;
  }

  function render(all) {
    lastAll = all || [];
    applyCustomCss(lastAll);
    const list = visibleTree(lastAll);
    const byId = new Map(lastAll.map((c) => [c.id, c]));
    const kidsOf = new Map(); const roots = [];
    list.forEach((c) => {
      if (c.parent) { if (!kidsOf.has(c.parent)) kidsOf.set(c.parent, []); kidsOf.get(c.parent).push(c); }
      else roots.push(c);
    });
    const k = keyOf(list);
    if (k !== lastKey) {
      overlay.innerHTML = ""; els.clear(); lastKey = k;
      roots.forEach((c) => { const n = buildNode(c, kidsOf); place(n, c); overlay.appendChild(n); });
      return;
    }
    list.forEach((c) => {
      const e = els.get(c.id);
      if (!e) return;
      applyCounterStyle(e.root, c.style);
      if (!c.parent) place(e.root, c);
      else {
        const p = byId.get(c.parent);
        if (p && p.style && p.style.group_free) { e.root.style.left = (c.x || 0) + "px"; e.root.style.top = (c.y || 0) + "px"; }
      }
      if (c.type === "group") { applyGroupVars(e.root, c.style); if (c.style && c.style.group_title && e.label.textContent !== c.name) e.label.textContent = c.name; return; }
      if (c.type === "text") { const t = expandMacros(c.name); if (e.value.textContent !== t) e.value.textContent = t; return; }
      if (c.type === "image") { if (e.img && e.img.getAttribute("src") !== c.src) e.img.src = c.src || ""; return; }
      if (c.type === "timer") { e.timer = timerState(c); if (e.label.textContent !== c.name) e.label.textContent = c.name; return; }
      if (e.label.textContent !== c.name) e.label.textContent = c.name;
      if (e.last !== c.value) {
        e.value.textContent = c.value;
        e.last = c.value;
        const fid = effectFor(c);
        if (fid) fxTrigger(e.root, fid);
      }
    });
  }

  // tick dos cronômetros (4x por segundo é suficiente e leve)
  setInterval(() => {
    els.forEach((e) => { if (e.timer) e.value.textContent = fmtTime(timerSecs(e.timer)); });
  }, 250);

  function pop(el) { el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }

  /* ----------------------------------------------------- WebSocket */
  let ws = null, timer = null;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "init") { if (m.effects) applyEffects(m.effects); applyTheme(m.theme); render(m.counters); }
      else if (m.type === "counters") { render(m.data); }
      else if (m.type === "theme") { applyTheme(m.data); }
      else if (m.type === "effects") { applyEffects(m.data); }
    };
    ws.onclose = () => { clearTimeout(timer); timer = setTimeout(connect, 1200); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  // Batimento: o servidor responde "pong"; conexões fantasmas (comuns quando o
  // OBS suspende a renderização) morrem e caem no reconnect em vez de ficarem mudas.
  setInterval(() => { try { if (ws && ws.readyState === 1) ws.send("ping"); } catch (_) {} }, 20000);

  /* -------------------------------------------------------- boot */
  async function boot() {
    resizeStage();
    window.addEventListener("resize", resizeStage);
    try {
      const [t, c, fx] = await Promise.all([
        fetch("/theme").then((r) => r.json()),
        fetch("/counters").then((r) => r.json()),
        fetch("/effects").then((r) => r.json()),
      ]);
      applyEffects(fx.effects); applyTheme(t); render(c.counters);
    } catch (_) {}
    connect();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
