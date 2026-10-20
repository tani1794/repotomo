/* RepoTomo 画面の動き */
(function () {
  "use strict";
  const S = window.RepoStore, E = window.RepoEngine, X = window.RepoExport;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mk = (s) => esc(s).replace(/\[\[(.+?)\]\]/g, '<mark class="hl">$1</mark>');
  const plain = (s) => String(s || "").replace(/\[\[|\]\]/g, "");
  const inViewer = !!(window.claude && typeof window.claude.use === "function");
  const COLORS = ["#2c6e72", "#5b56a8", "#c79a2e", "#b4566a", "#3f7f4a", "#4f6475"];
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* ================= 通知 ================= */
  function toast(msg, ms) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, ms || 3600);
  }
  window.RepoTomoToast = toast;

  function notify(text, opts) {
    const st = S.state;
    st.notes.unshift({ id: S.newId("n"), text, at: new Date().toISOString(), read: false });
    st.notes = st.notes.slice(0, 60);
    S.save();
    toast(text);
    renderBell();
    try {
      if ("Notification" in window && Notification.permission === "granted") new Notification("RepoTomo", { body: text, tag: (opts && opts.tag) || undefined });
    } catch (e) { /* 通知が使えない環境 */ }
  }
  function renderBell() {
    const unread = S.state.notes.filter((n) => !n.read).length;
    const b = $("#bellBadge"); b.textContent = unread; b.hidden = unread === 0;
    $("#notes").innerHTML = S.state.notes.length ? S.state.notes.map((n) => `<li>${esc(n.text)}<small>${esc(fmtDateTime(n.at))}</small></li>`).join("") : '<li class="muted">通知はまだありません</li>';
  }
  function fmtDateTime(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  $("#bellBtn").addEventListener("click", () => {
    const d = $("#drawer"); d.hidden = !d.hidden;
    if (!d.hidden) { S.state.notes.forEach((n) => (n.read = true)); S.save(); renderBell(); }
  });
  $("#closeDrawer").addEventListener("click", () => ($("#drawer").hidden = true));

  /* ================= 背景・マーカー・出現アニメ ================= */
  const markObs = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("on"); markObs.unobserve(e.target); } }), { threshold: 0.9, rootMargin: "0px 0px -8% 0px" });
  function observeMarks(root) { $$("mark.hl:not(.on), .hl:not(.on)", root).forEach((m) => markObs.observe(m)); }

  const revObs = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("reveal-anim"); revObs.unobserve(e.target); } }), { threshold: 0.12 });
  function observeReveal(nodes) {
    const h = window.innerHeight;
    nodes.forEach((n) => { if (n.getBoundingClientRect().top > h) revObs.observe(n); });
  }

  const toneObs = new IntersectionObserver((ents) => {
    ents.forEach((e) => {
      if (!e.isIntersecting) return;
      const tone = e.target.dataset.tone;
      document.documentElement.style.setProperty("--page-bg", `var(--tone-${tone})`);
      $$(".nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id));
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  $$(".band").forEach((b) => toneObs.observe(b));

  /* パステルの多角形アート
     ・背景：ボロノイ分割（細胞のような多角形）
     ・ヒーロー：ローポリ（三角形の面）
     色は白＋パステルで、時間・カーソル・スクロールに合わせて少しずつ変わる。
     動き：ウェーブ（波打つ）／ばらける（クリックで散らばる）／マグネット（カーソルに吸い寄せられる） */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const Art = { mode: "wave", hue: 220, px: -9999, py: -9999, active: false, burstId: 0, bx: 0, by: 0, lastY: window.scrollY };
  const hsl = (h, l, a) => `hsla(${((h % 360) + 360) % 360}, 80%, ${l}%, ${a == null ? 1 : a})`;
  window.addEventListener("pointermove", (e) => { Art.px = e.clientX; Art.py = e.clientY; Art.active = true; Art.hue += 0.12; }, { passive: true });
  document.addEventListener("pointerleave", () => (Art.active = false));
  window.addEventListener("blur", () => (Art.active = false));
  window.addEventListener("pointerdown", (e) => { Art.burstId++; Art.bx = e.clientX; Art.by = e.clientY; }, { passive: true });
  window.addEventListener("scroll", () => { const y = window.scrollY; Art.hue += (y - Art.lastY) * 0.05; Art.lastY = y; }, { passive: true });
  $$(".art-ctrl button").forEach((b) => b.addEventListener("click", () => {
    Art.mode = b.dataset.mode;
    $$(".art-ctrl button").forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
  }));

  function makeSeeds(list) { return list.map(([x, y]) => ({ bx: x, by: y, x, y, vx: 0, vy: 0, ph: Math.random() * Math.PI * 2, h: Math.random() * 90 - 45 })); }
  function stepSeeds(set, t, lx, ly, active) {
    const R = set.R || 200, burst = set.burstSeen !== Art.burstId;
    if (burst) set.burstSeen = Art.burstId;
    for (const s of set.seeds) {
      const amp = Art.mode === "wave" ? set.amp : set.amp * .35;
      let tx = s.bx + Math.sin(t * .7 + s.ph + s.by * .012) * amp;
      let ty = s.by + Math.cos(t * .6 + s.ph + s.bx * .009) * amp * .8;
      if (active) {
        const dx = lx - s.x, dy = ly - s.y, d = Math.hypot(dx, dy) + .01;
        if (d < R) {
          const f = 1 - d / R;
          if (Art.mode === "magnet") { tx += dx * f * .6; ty += dy * f * .6; }
          else if (Art.mode === "scatter") { tx -= dx / d * f * 80; ty -= dy / d * f * 80; }
          else { tx += -dy / d * f * 26; ty += dx / d * f * 26; }
        }
      }
      if (burst && Art.mode === "scatter" && set.local) {
        const p = set.local(Art.bx, Art.by), dx = s.x - p[0], dy = s.y - p[1], d = Math.hypot(dx, dy) + .01;
        if (d < R * 1.6) { const f = (1 - d / (R * 1.6)) * 26; s.vx += dx / d * f + (Math.random() - .5) * 8; s.vy += dy / d * f + (Math.random() - .5) * 8; }
      }
      s.vx = (s.vx + (tx - s.x) * .05) * .86; s.vy = (s.vy + (ty - s.y) * .05) * .86;
      s.x += s.vx; s.y += s.vy;
    }
  }
  function clip(poly, mx, my, nx, ny) {
    const out = [];
    for (let k = 0; k < poly.length; k++) {
      const P = poly[k], Q = poly[(k + 1) % poly.length];
      const dp = (P[0] - mx) * nx + (P[1] - my) * ny, dq = (Q[0] - mx) * nx + (Q[1] - my) * ny;
      if (dp <= 0) out.push(P);
      if ((dp <= 0) !== (dq <= 0)) { const u = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * u, P[1] + (Q[1] - P[1]) * u]); }
    }
    return out;
  }
  function voronoiCells(seeds, W, H) {
    return seeds.map((a, i) => {
      let poly = [[-2, -2], [W + 2, -2], [W + 2, H + 2], [-2, H + 2]];
      for (let j = 0; j < seeds.length && poly.length > 2; j++) {
        if (j === i) continue; const b = seeds[j];
        poly = clip(poly, (a.x + b.x) / 2, (a.y + b.y) / 2, b.x - a.x, b.y - a.y);
      }
      return poly;
    });
  }
  function fitCanvas(cv, w, h) { const dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); return c; }

  // 背景：ボロノイ
  const BG = (function () {
    const cv = $("#geo"); let ctx, W, H, set;
    function init() {
      W = window.innerWidth; H = window.innerHeight; ctx = fitCanvas(cv, W, H);
      const n = Math.max(26, Math.min(90, Math.round(W * H / 18000))), pts = [];
      for (let i = 0; i < n; i++) pts.push([Math.random() * (W + 120) - 60, Math.random() * (H + 120) - 60]);
      set = { seeds: makeSeeds(pts), amp: 26, R: 220, local: (x, y) => [x, y] };
    }
    function draw(t) {
      stepSeeds(set, t, Art.px, Art.py, Art.active);
      const cells = voronoiCells(set.seeds, W, H);
      ctx.clearRect(0, 0, W, H);
      cells.forEach((poly, i) => {
        if (poly.length < 3) return;
        const s = set.seeds[i], d = Art.active ? Math.hypot(s.x - Art.px, s.y - Art.py) : 1e9;
        const near = Math.max(0, 1 - d / 260);
        ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]); for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k][0], poly[k][1]); ctx.closePath();
        ctx.fillStyle = hsl(Art.hue + s.h + (s.y / H) * 50, 92 - near * 8, .42 + near * .3); ctx.fill();
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3; ctx.stroke();
      });
    }
    return { init, draw };
  })();

  // ヒーロー：ローポリ
  function lowPoly(cv, opts) {
    let ctx, W, H, set, cols, rows, tris = [];
    function init() {
      const r = cv.getBoundingClientRect(); W = r.width || 400; H = r.height || 300; ctx = fitCanvas(cv, W, H);
      cols = opts.cols || 12; rows = Math.max(5, Math.round(cols * H / W));
      const pts = [], gw = (W + 80) / cols, gh = (H + 80) / rows;
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
        const edge = i === 0 || j === 0 || i === cols || j === rows;
        pts.push([-40 + i * gw + (edge ? 0 : (Math.random() - .5) * gw * .7), -40 + j * gh + (edge ? 0 : (Math.random() - .5) * gh * .7)]);
      }
      set = { seeds: makeSeeds(pts), amp: opts.amp || 10, R: 150, local: (x, y) => { const b = cv.getBoundingClientRect(); return [x - b.left, y - b.top]; } };
      tris = [];
      const id = (i, j) => j * (cols + 1) + i;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const fl = (i + j) % 2, off = [Math.random() - .5, Math.random() - .5];
        if (fl) { tris.push([id(i, j), id(i + 1, j), id(i, j + 1), off]); tris.push([id(i + 1, j), id(i + 1, j + 1), id(i, j + 1), [-off[0], -off[1]]]); }
        else { tris.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), off]); tris.push([id(i, j), id(i + 1, j + 1), id(i, j + 1), [-off[0], -off[1]]]); }
      }
    }
    function draw(t, progress) {
      const b = cv.getBoundingClientRect();
      const lx = Art.px - b.left, ly = Art.py - b.top, inside = Art.active && lx > -60 && ly > -60 && lx < W + 60 && ly < H + 60;
      stepSeeds(set, t, lx, ly, inside);
      ctx.clearRect(0, 0, W, H);
      const P = set.seeds, pr = progress == null ? 1 : progress, ease = 1 - Math.pow(1 - pr, 3);
      for (const [a, c, d, off] of tris) {
        const A = P[a], B = P[c], C = P[d];
        const cx = (A.x + B.x + C.x) / 3, cy = (A.y + B.y + C.y) / 3;
        const z = (s) => Math.sin(s.bx * .018 + t * 1.1) * Math.cos(s.by * .022 + t * .9) * 40;
        const ux = B.x - A.x, uy = B.y - A.y, uz = z(B) - z(A), vx = C.x - A.x, vy = C.y - A.y, vz = z(C) - z(A);
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz) || 1;
        const shade = Math.abs((nx * -.4 + ny * -.5 + nz * .77) / nl);
        const near = inside ? Math.max(0, 1 - Math.hypot(cx - lx, cy - ly) / 170) : 0;
        const L = 79 + shade * 14 - near * 8;
        const dx = (1 - ease) * off[0] * W * 1.2, dy = (1 - ease) * off[1] * H * 1.2;
        ctx.globalAlpha = .25 + .75 * ease;
        ctx.beginPath(); ctx.moveTo(A.x + dx, A.y + dy); ctx.lineTo(B.x + dx, B.y + dy); ctx.lineTo(C.x + dx, C.y + dy); ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle = hsl(Art.hue + (cx / W) * 100 + (cy / H) * 40, L);
        ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    return { init, draw };
  }
  const HERO = lowPoly($("#poly"), { cols: 12, amp: 10 });

  (function loop() {
    let t0 = performance.now();
    BG.init(); HERO.init();
    let resizeT;
    window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { BG.init(); HERO.init(); if (reduceMotion) frame(performance.now()); }, 150); });
    function frame(now) {
      const t = reduceMotion ? 0 : (now - t0) / 1000;
      if (!document.hidden) { BG.draw(t); HERO.draw(t); }
      if (!reduceMotion) { Art.hue += .04; requestAnimationFrame(frame); }
    }
    requestAnimationFrame(frame);
    if (reduceMotion) window.addEventListener("scroll", () => frame(performance.now()), { passive: true });
  })();

  /* 読み込み中：パステルの三角形が四方から流れ込んで組み上がる */
  const Op = (function () {
    const box = $("#opart"), cv = $("#opartCanvas");
    const art = lowPoly(cv, { cols: 14, amp: 14 });
    let raf = 0, shownAt = 0, depth = 0;
    function draw(now) {
      const p = Math.min(1, (now - shownAt) / 900);
      art.draw((now - shownAt) / 1000, reduceMotion ? 1 : p);
      if (!reduceMotion) raf = requestAnimationFrame(draw);
    }
    function origin(el) {
      if (!el || !el.getBoundingClientRect) { box.style.setProperty("--ox", "50%"); box.style.setProperty("--oy", "50%"); return; }
      const r = el.getBoundingClientRect();
      box.style.setProperty("--ox", `${Math.round(r.left + r.width / 2)}px`); box.style.setProperty("--oy", `${Math.round(r.top + r.height / 2)}px`);
    }
    return {
      show(kind, text, el) {
        depth++;
        $("#opartKind").textContent = kind || "読み込み中"; $("#opartText").textContent = text || "読み込み中…";
        if (depth > 1) return;
        origin(el); box.hidden = false; art.init(); shownAt = performance.now();
        cancelAnimationFrame(raf); raf = requestAnimationFrame(draw);
        requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("in")));
      },
      text(t) { $("#opartText").textContent = t; },
      async hide(minMs) {
        depth = Math.max(0, depth - 1); if (depth) return;
        const left = (minMs == null ? 900 : minMs) - (performance.now() - shownAt);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        box.classList.remove("in");
        await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 760));
        if (!depth) { box.hidden = true; cancelAnimationFrame(raf); }
      }
    };
  })();

  /* ================= 講義 ================= */
  function allLectures() { return window.REPOTOMO_LECTURES.concat(S.state.lectures || []); }
  function getLecture(id) { return allLectures().find((l) => l.id === id); }
  function lecLabel(l) { return `${l.subject ? l.subject + " " : ""}第${l.no || "?"}回 ${l.title}`; }

  function renderLibrary() {
    const lecs = allLectures();
    const subs = Array.from(new Set(lecs.map((l) => l.subject).filter(Boolean)));
    const sf = $("#subjectFilter"), cur = sf.value;
    sf.innerHTML = '<option value="">すべての科目</option>' + subs.map((s) => `<option${s === cur ? " selected" : ""}>${esc(s)}</option>`).join("");
    $("#subjectList").innerHTML = subs.map((s) => `<option value="${esc(s)}">`).join("");
    const list = lecs.filter((l) => !sf.value || l.subject === sf.value);
    $("#libGrid").innerHTML = list.map((l) => `
      <article class="lec" data-id="${esc(l.id)}" data-color="${esc(l.color || "user")}">
        <span class="shape" aria-hidden="true"></span>
        <span class="lec-no">${esc(l.subject || "科目未設定")} · 第${esc(l.no || "?")}回${l.user ? " · 追加した資料" : ""}</span>
        <span class="lec-title">${esc(l.title)}</span>
        <span class="tags">${(l.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>
        <span class="lec-actions">
          <button class="btn small" type="button" data-act="deck">スライドで見る</button>
          <button class="btn small ghost" type="button" data-act="use">レポートに使う</button>
          ${l.user ? '<button class="btn small ghost danger" type="button" data-act="del">削除</button>' : ""}
        </span>
        <span class="confirm" data-confirm hidden>この講義を削除しますか？ <button class="btn small danger" type="button" data-act="del-yes">削除する</button><button class="btn small ghost" type="button" data-act="del-no">やめる</button></span>
      </article>`).join("");
    $$(".lec", $("#libGrid")).forEach((card) => card.addEventListener("click", onLecClick));
    observeReveal($$(".lec"));
    $("#statLectures").textContent = lecs.length;
    // セレクト
    const opts = lecs.map((l) => `<option value="${esc(l.id)}">${esc(lecLabel(l))}</option>`).join("");
    const d = $("#deckSelect"), dv = d.value; d.innerHTML = opts; if (dv && getLecture(dv)) d.value = dv;
    const a = $("#assistLecture"), av = a.value; a.innerHTML = '<option value="">（選ばない）</option>' + opts; if (av && getLecture(av)) a.value = av;
  }
  $("#subjectFilter").addEventListener("change", renderLibrary);

  async function onLecClick(ev) {
    const card = ev.currentTarget, id = card.dataset.id;
    const act = ev.target.closest("[data-act]") ? ev.target.closest("[data-act]").dataset.act : "deck";
    if (act === "deck") { openDeck(id); $("#deck").scrollIntoView({ behavior: "smooth" }); }
    else if (act === "use") { $("#assistLecture").value = id; curDoc = null; updateSrcNote(); $("#assist").scrollIntoView({ behavior: "smooth" }); }
    else if (act === "del") { card.querySelector("[data-confirm]").hidden = false; }
    else if (act === "del-no") { card.querySelector("[data-confirm]").hidden = true; }
    else if (act === "del-yes") {
      S.state.lectures = S.state.lectures.filter((l) => l.id !== id);
      await S.deleteLectureText(id); S.save(); renderLibrary(); toast("講義を削除しました");
      if ($("#deckSelect").value === id || !getLecture($("#deckSelect").value)) openDeck(window.REPOTOMO_LECTURES[0].id);
    }
  }

  // ドロップ領域
  function bindDrop(zone, input, onFile) {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); input.value = ""; });
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
    zone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  }
  // ページ全体へのドロップ → 講義として追加
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { if (!e.target.closest(".drop")) { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) addLectureFromFile(f, $("#libDrop")); } });

  async function addLectureFromFile(file, zone) {
    zone && zone.classList.add("busy");
    Op.show("読み込み中", `「${file.name}」を読み込んでいます`, zone);
    try {
      const doc = await E.readFile(file, (i, n) => Op.text(`読み込み中… ${i} / ${n} ページ`));
      Op.text("大学名・先生の名前を伏せています");
      doc.pages.forEach((p) => (p.text = E.mask(p.text)));
      const lec = lectureFromDoc(doc);
      S.state.lectures.push(lec);
      await S.putLectureText(lec.id, E.joinText(doc));
      Op.text("スライドを作っています");
      S.save(); renderLibrary(); openDeck(lec.id);
      await Op.hide(1200);
      toast(`「${lec.title}」をライブラリに追加しました`);
      return { lec, doc };
    } catch (e) {
      await Op.hide(0);
      console.error(e); toast(e && e.message ? e.message : "読み込めませんでした。PDFかテキストファイルか確認してください。", 5000);
      return null;
    } finally { zone && zone.classList.remove("busy"); }
  }

  function lectureFromDoc(doc) {
    const a = E.offlineAnalyze(doc, {});
    const noM = (a.lectureTitle.match(/第(\d+)回/) || [])[1];
    const title = a.lectureTitle.replace(/^第\S+回\s*/, "") || doc.name.replace(/\.[^.]+$/, "");
    return {
      id: S.newId("u"), user: true, color: "user",
      subject: a.subject || "追加した資料", no: noM ? Number(noM) : (S.state.lectures.length + 1), title: title.slice(0, 40),
      tags: a.keyConcepts.map((k) => k.term).slice(0, 6).concat(a.keywords.slice(0, 3)),
      keyPoints: a.keyConcepts.slice(0, 5).map((k) => `${k.term}：[[${k.explain}]]`),
      slides: [{ type: "title", kicker: a.subject || "講義資料", title: title.slice(0, 40), sub: a.overview }].concat(E.offlineSlides(doc)).concat(a.assignment ? [{ type: "task", title: "課題", body: a.assignment.text || "資料の課題を確認してください", due: a.assignment.deadline }] : []),
      createdAt: new Date().toISOString()
    };
  }
  bindDrop($("#libDrop"), $("#libFile"), (f) => addLectureFromFile(f, $("#libDrop")));

  /* ================= スライド ================= */
  let deck = { lec: null, i: 0, timer: null, busy: false };
  const fxName = () => S.state.settings.fx || "slide";

  function slideHTML(s, idx, total) {
    let i = 0; const b = () => `class="b" style="--i:${i++}"`;
    const deco = '<span class="s-deco" aria-hidden="true"></span>';
    const pageNo = `<span class="s-page">${idx + 1} / ${total}</span>`;
    switch (s.type) {
      case "title":
        return `<div class="slide is-title">${deco}<p class="s-kicker" ${b()}>${esc(s.kicker || "")}</p><h3 ${b()}>${mk(s.title)}</h3><p class="s-sub" ${b()}>${mk(s.sub || "")}</p>${pageNo}</div>`;
      case "flow":
        return `<div class="slide">${deco}<h3 ${b()}>${mk(s.title)}</h3><div class="s-flow">${s.steps.map((st) => `<div ${b()}><b>${esc(st.h)}</b><span>${mk(st.t)}</span></div>`).join("")}</div>${s.note ? `<p class="s-note" ${b()}>${mk(s.note)}</p>` : ""}${pageNo}</div>`;
      case "grid":
        return `<div class="slide">${deco}<h3 ${b()}>${mk(s.title)}</h3><div class="s-grid${s.cells.length === 3 ? " three" : ""}">${s.cells.map((c) => `<div ${b()}><b>${esc(c.h)}</b><span>${mk(c.t)}</span></div>`).join("")}</div>${pageNo}</div>`;
      case "compare":
        return `<div class="slide">${deco}<h3 ${b()}>${mk(s.title)}</h3><div class="s-compare">${[s.left, s.right].map((side) => `<div ${b()}><h4>${esc(side.h)}</h4><ul>${side.items.map((it) => `<li>${mk(it)}</li>`).join("")}</ul></div>`).join("")}</div>${pageNo}</div>`;
      case "table":
        return `<div class="slide">${deco}<h3 ${b()}>${mk(s.title)}</h3><table class="s-table" ${b()}><thead><tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((c) => `<td>${mk(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>${pageNo}</div>`;
      case "task":
        return `<div class="slide">${deco}<p class="s-kicker" ${b()}>ASSIGNMENT</p><h3 ${b()}>${mk(s.title)}</h3><div class="s-task" ${b()}>${mk(s.body)}</div>${s.due ? `<p class="s-due" ${b()}>締切 ${esc(s.due)}</p>` : ""}${pageNo}</div>`;
      default:
        return `<div class="slide">${deco}<h3 ${b()}>${mk(s.title)}</h3><ul>${(s.items || s.points || []).map((it) => `<li ${b()}>${mk(it)}</li>`).join("")}</ul>${pageNo}</div>`;
    }
  }

  function openDeck(id) {
    const lec = getLecture(id) || window.REPOTOMO_LECTURES[0];
    deck.lec = lec; deck.i = 0;
    $("#deckSelect").value = lec.id;
    $("#deckHeading").textContent = lecLabel(lec);
    const stage = $("#stage");
    stage.className = "stage fx-" + fxName();
    stage.innerHTML = slideHTML(lec.slides[0], 0, lec.slides.length);
    const sl = stage.firstElementChild; sl.classList.add("building");
    observeMarks(stage);
    setTimeout(() => $$("mark.hl", stage).forEach((m) => m.classList.add("on")), 600);
    $("#dots").innerHTML = lec.slides.map((_, i) => `<button type="button" aria-label="${i + 1}枚目"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("");
    $$("#dots button").forEach((btn, i) => btn.addEventListener("click", () => go(i)));
    $("#pageNo").textContent = `1 / ${lec.slides.length}`;
    $("#keyPoints").innerHTML = (lec.keyPoints || []).map((p) => `<div class="point">${mk(p)}</div>`).join("");
    observeMarks($("#keyPoints")); observeReveal($$(".point"));
  }

  function go(n) {
    const lec = deck.lec; if (!lec || deck.busy) return;
    const total = lec.slides.length;
    n = (n + total) % total; if (n === deck.i) return;
    const dir = n > deck.i ? "r" : "l";
    const stage = $("#stage"), old = stage.lastElementChild;
    stage.insertAdjacentHTML("beforeend", slideHTML(lec.slides[n], n, total));
    const nu = stage.lastElementChild;
    nu.classList.add("enter-" + dir);
    deck.busy = true;
    void nu.offsetWidth;
    requestAnimationFrame(() => {
      nu.classList.remove("enter-" + dir); nu.classList.add("building");
      if (old) old.classList.add(dir === "r" ? "leave-l" : "leave-r");
    });
    setTimeout(() => { if (old) old.remove(); deck.busy = false; $$("mark.hl", nu).forEach((m) => m.classList.add("on")); }, 720);
    deck.i = n;
    $$("#dots button").forEach((b, i) => b.setAttribute("aria-current", i === n ? "true" : "false"));
    $("#pageNo").textContent = `${n + 1} / ${total}`;
  }
  $("#prevSlide").addEventListener("click", () => go(deck.i - 1));
  $("#nextSlide").addEventListener("click", () => go(deck.i + 1));
  $("#deckSelect").addEventListener("change", (e) => openDeck(e.target.value));
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    $$(".seg button").forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
    S.state.settings.fx = b.dataset.fx; S.save();
    $("#stage").className = "stage fx-" + b.dataset.fx;
  }));
  $("#playSlide").addEventListener("click", () => {
    const btn = $("#playSlide");
    if (deck.timer) { clearInterval(deck.timer); deck.timer = null; btn.setAttribute("aria-label", "自動再生"); btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'; return; }
    deck.timer = setInterval(() => go(deck.i + 1), 5200);
    btn.setAttribute("aria-label", "一時停止"); btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
  });
  $("#fullSlide").addEventListener("click", async () => {
    const st = $("#stage");
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await st.requestFullscreen(); }
    catch (e) { toast("この環境では全画面にできません。スマホは横向きにすると大きく表示されます。"); }
  });
  document.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const r = $("#deck").getBoundingClientRect();
    if (r.top > window.innerHeight * .6 || r.bottom < window.innerHeight * .3) return;
    if (e.key === "ArrowRight") { go(deck.i + 1); e.preventDefault(); }
    if (e.key === "ArrowLeft") { go(deck.i - 1); e.preventDefault(); }
  });
  (function swipe() {
    const st = $("#stage"); let x0 = null, y0 = null;
    st.addEventListener("pointerdown", (e) => { x0 = e.clientX; y0 = e.clientY; });
    st.addEventListener("pointerup", (e) => {
      if (x0 == null) return; const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(deck.i + (dx < 0 ? 1 : -1));
    });
  })();

  /* ================= レポート作成アシスタント ================= */
  let curDoc = null, analysis = null, proposals = [], chosen = null, ctl = null, lastCond = null;

  function setStep(n) { $$("#stepsNav li").forEach((li, i) => li.classList.toggle("on", i <= n)); }
  function updateSrcNote() {
    const id = $("#assistLecture").value;
    if (curDoc) $("#srcNote").textContent = `読み込み済み：${curDoc.name}（${curDoc.pages.length}ページ）`;
    else if (id) $("#srcNote").textContent = `ライブラリの「${lecLabel(getLecture(id))}」を使います`;
    else $("#srcNote").textContent = "資料をアップロードするか、講義を選んでください。";
  }
  $("#assistLecture").addEventListener("change", () => { curDoc = null; updateSrcNote(); });
  bindDrop($("#assistDrop"), $("#assistFile"), async (f) => {
    const r = await addLectureFromFile(f, $("#assistDrop"));
    if (r) { curDoc = r.doc; curDoc.lectureId = r.lec.id; $("#assistLecture").value = r.lec.id; updateSrcNote(); setStep(1); }
  });

  async function docFromLecture(lec) {
    let text = lec.user ? await S.getLectureText(lec.id) : "";
    let pages;
    if (text) pages = text.split(/\n(?=第|課題)/).map((t, i) => ({ no: i + 1, text: t }));
    else {
      pages = lec.slides.map((s, i) => {
        const parts = [plain(s.title || "")];
        if (s.sub) parts.push(plain(s.sub));
        (s.items || s.points || []).forEach((x) => parts.push(plain(x)));
        (s.steps || []).forEach((x) => parts.push(`${x.h}：${plain(x.t)}`));
        (s.cells || []).forEach((x) => parts.push(`${x.h}：${plain(x.t)}`));
        if (s.left) [s.left, s.right].forEach((sd) => { parts.push(sd.h); sd.items.forEach((x) => parts.push(plain(x))); });
        (s.rows || []).forEach((r) => parts.push(r.map(plain).join(" / ")));
        if (s.type === "task") parts.push(`${s.body}\n〆切は、${(s.due || "").replace(/^\d{4}-(\d{2})-(\d{2})\s*/, (m, mo, d) => `${Number(mo)}月${Number(d)}日 `)}`);
        if (i === 0) parts.unshift(`${lec.subject} 第${lec.no}回 ${lec.title}`);
        return { no: i + 1, text: parts.join("\n") };
      });
      if (lec.facts && lec.facts.length) pages.push({ no: pages.length + 1, text: "配布記事の要点\n" + lec.facts.join("\n") });
    }
    return { name: lecLabel(lec), kind: "text", pages, pdf: null, lectureId: lec.id, lec };
  }

  function getCond() {
    return {
      type: $("#condType").value,
      chars: Math.max(200, Math.min(4000, Number($("#condChars").value) || 1000)),
      topic: $("#condTopic").value.trim(),
      experience: $("#condExp").value.trim(),
      rules: { student: $("#ruleStudent").checked, soft: $("#ruleSoft").checked, sourceOnly: $("#ruleSourceOnly").checked, feel: $("#ruleFeel").checked }
    };
  }

  function stepItem(title) {
    const li = document.createElement("li");
    li.className = "run"; li.innerHTML = `<span class="st" aria-hidden="true"></span><div><b>${esc(title)}</b><small></small></div>`;
    $("#thinkList").appendChild(li);
    return {
      done(msg) { li.className = "done"; li.querySelector("small").textContent = msg || ""; },
      err(msg) { li.className = "err"; li.querySelector("small").textContent = msg || ""; }
    };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  $("#runAnalyze").addEventListener("click", runAnalyze);
  $("#stopAnalyze").addEventListener("click", () => { if (ctl) ctl.abort(); });

  async function runAnalyze() {
    const lecId = $("#assistLecture").value;
    if (!curDoc && !lecId) { toast("先に資料をアップロードするか、講義を選んでください"); return; }
    const btn = $("#runAnalyze"); btn.disabled = true;
    ctl = new AbortController();
    const cond = getCond(); lastCond = cond;
    $("#panelThink").hidden = false; $("#thinkList").innerHTML = ""; $("#panelThink").classList.add("busy");
    Op.show("分析の準備中", "資料を読み込んでいます", btn);
    ["#panelResult", "#panelProposals", "#panelDraft"].forEach((s) => ($(s).hidden = true));
    setStep(2);
    $("#panelThink").scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      let s = stepItem("資料のテキストを取り出す");
      const doc = curDoc || await docFromLecture(getLecture(lecId));
      const text = E.joinText(doc);
      await wait(250); s.done(`${doc.pages.length}ページ・${text.length.toLocaleString()}文字を読み取りました`);

      s = stepItem("大学名・先生の名前を伏せる");
      doc.pages.forEach((p) => (p.text = E.mask(p.text)));
      await wait(200); s.done("伏せ字にしてから分析します");

      await Op.hide(1300);
      s = stepItem("見出し・キーワード・概念を拾う");
      const off = E.offlineAnalyze(doc, {});
      if (doc.lec && !doc.lec.user) {
        const L = doc.lec;
        off.subject = L.subject; off.lectureTitle = `第${L.no}回 ${L.title}`;
        off.overview = (L.slides[0] && L.slides[0].sub ? L.slides[0].sub + "。" : "") + (L.keyPoints || []).slice(0, 2).map(plain).join("");
        off.flow = L.slides.slice(1).map((x) => plain(x.title)).filter((t) => t !== "課題");
        if (L.facts) off.facts = L.facts.map((f) => f.replace(/^講義で配布された記事（[^）]+）より：/, ""));
      }
      await wait(250); s.done(`概念：${off.keyConcepts.map((k) => k.term).slice(0, 6).join("、") || "（見つかりませんでした）"}`);

      s = stepItem("課題文と締切を探す");
      await wait(200);
      s.done(off.assignment ? `課題：${off.assignment.text.slice(0, 60)}${off.assignment.text.length > 60 ? "…" : ""}${off.assignment.deadline ? "／締切：" + off.assignment.deadline : ""}` : "課題文は見つかりませんでした");

      let result = null;
      if (E.AI.kind !== "none") {
        s = stepItem("Claudeが資料全体を読み、構造化する");
        try {
          let images = [];
          if (doc.pdf && E.AI.imageMax) { images = await E.pageImages(doc, E.AI.imageMax); }
          const t0 = Date.now();
          const tick = setInterval(() => { const sm = $("#thinkList").lastElementChild.querySelector("small"); sm.textContent = `考えています… ${Math.round((Date.now() - t0) / 1000)}秒${images.length ? `（記事などの画像${images.length}枚も読んでいます）` : ""}`; }, 1000);
          try { result = await E.AI.json(E.analysisPrompt(E.joinText(doc), cond, off), { images, signal: ctl.signal }); }
          finally { clearInterval(tick); }
          if (!result || !Array.isArray(result.proposals)) throw { code: "invalid_json" };
          result.engine = "ai"; result.keywords = off.keywords;
          s.done(`主題：${result.lectureTitle || ""}／概念${(result.keyConcepts || []).length}個・レポート案${result.proposals.length}つ`);
          // ライブラリのスライドをAIの要約で更新
          const lec = getLecture(doc.lectureId);
          if (lec && lec.user && Array.isArray(result.slides) && result.slides.length) {
            lec.slides = [{ type: "title", kicker: result.subject || lec.subject, title: (result.lectureTitle || lec.title).replace(/^第\S+回\s*/, ""), sub: result.overview || "" }]
              .concat(result.slides.map((x) => ({ type: "points", title: x.title, items: (x.points || []).map((p, i) => i === 0 ? `[[${p}]]` : p) })))
              .concat(result.assignment && result.assignment.text ? [{ type: "task", title: "課題", body: result.assignment.text, due: result.assignment.deadline || "" }] : []);
            lec.keyPoints = (result.keyConcepts || []).slice(0, 5).map((k) => `${k.term}：[[${k.explain}]]`);
            lec.tags = (result.keyConcepts || []).map((k) => k.term).slice(0, 6);
            if (result.subject) lec.subject = result.subject;
            S.save(); renderLibrary();
          }
        } catch (e) {
          if (e && e.code === "cancelled" || (e && e.name === "AbortError")) { s.err("止めました"); throw e; }
          s.err(aiErrorText(e) + " → オフライン分析で続けます");
          result = null;
        }
      }
      if (!result) {
        s = stepItem("辞書と照合して、レポート案を組み立てる");
        result = off; result.proposals = E.offlineProposals(off, cond);
        await wait(300); s.done("レポート案を3つ作りました");
      } else {
        s = stepItem("レポート案を確認する"); await wait(200); s.done("企業の具体例と体験談のアイデアを添えました");
      }
      if (cond.topic && result.assignment) result.assignment.text = result.assignment.text || cond.topic;
      analysis = result; proposals = result.proposals.slice(0, 3);
      renderResult(); renderProposals(); setStep(3);
      $("#panelResult").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      if (!(e && (e.code === "cancelled" || e.name === "AbortError"))) { console.error(e); toast("分析の途中で止まりました。もう一度お試しください。"); }
    } finally { btn.disabled = false; $("#panelThink").classList.remove("busy"); if (!$("#opart").hidden) Op.hide(0); }
  }

  function aiErrorText(e) {
    const c = e && e.code;
    return ({ not_granted: "Claudeの利用が許可されませんでした", rate_limited: "混み合っています", prompt_too_large: "資料が長すぎます", invalid_json: "AIの返答を読み取れませんでした", bad_key: "APIキーが正しくありません", api_error: "APIの呼び出しに失敗しました", refused: "この内容には答えられませんでした" })[c] || "AIを使えませんでした";
  }

  function parseDeadline(str) {
    if (!str) return null;
    const m = String(str).match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})|(\d{1,2})月\s*(\d{1,2})日/);
    if (!m) return null;
    const now = new Date();
    let y = m[1] ? Number(m[1]) : now.getFullYear(), mo = Number(m[2] || m[4]), d = Number(m[3] || m[5]);
    if (!m[1] && mo < now.getMonth() + 1 - 6) y++;
    const t = (String(str).match(/(\d{1,2}):(\d{2})/) || [])[0] || "22:00";
    return { date: `${y}-${pad(mo)}-${pad(d)}`, time: t.length === 4 ? "0" + t : t };
  }

  function renderResult() {
    const a = analysis;
    const dl = a.assignment && parseDeadline(a.assignment.deadline);
    $("#resultBox").innerHTML = `
      <div class="r-block"><h4>講義</h4><p><b>${esc(a.subject || "")}</b> ${esc(a.lectureTitle || "")}</p><p>${mk(a.overview || "")}</p></div>
      ${a.flow && a.flow.length ? `<div class="r-block"><h4>講義の流れ</h4><p>${a.flow.map(esc).join(" → ")}</p></div>` : ""}
      <div class="r-block"><h4>重要な概念</h4><div class="concepts">${(a.keyConcepts || []).map((k) => `<div><b>${esc(k.term)}</b><span>${esc(k.explain)}</span></div>`).join("") || '<p class="muted">見つかりませんでした</p>'}</div></div>
      ${a.assignment && a.assignment.text ? `<div class="r-block"><h4>課題</h4><p><mark class="hl">${esc(a.assignment.text)}</mark></p>${a.assignment.deadline ? `<p>締切：<b>${esc(a.assignment.deadline)}</b> ${dl ? '<button class="btn small" type="button" id="addDeadline">カレンダーに登録</button>' : ""}</p>` : ""}</div>` : ""}
      ${a.facts && a.facts.length ? `<div class="r-block"><h4>資料にある具体的な事実</h4><ul>${a.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      ${a.engine === "offline" ? '<p class="muted small">オフライン分析の結果です。Claudeが使える環境では、記事の画像も読んだ詳しい分析になります。</p>' : ""}`;
    $("#panelResult").hidden = false;
    observeMarks($("#panelResult"));
    const add = $("#addDeadline");
    if (add) add.addEventListener("click", () => {
      addEvent({ title: `${a.assignment.company ? a.assignment.company + "の" : ""}レポート提出`, subject: a.subject || "", date: dl.date, time: dl.time, color: COLORS[2] });
      add.disabled = true; add.textContent = "登録しました";
    });
  }

  function renderProposals() {
    $("#proposals").innerHTML = proposals.map((p, i) => `
      <article class="prop" data-i="${i}">
        <span class="lab">${esc(p.angle || "案" + (i + 1))}</span>
        <h4>${esc(p.title)}</h4>
        ${p.companyExample ? `<p><b>企業の例：</b>${esc(p.company ? p.company + "／" : "")}${esc(p.companyExample)}</p>` : ""}
        ${p.experienceIdea ? `<p><b>体験談：</b>${esc(p.experienceIdea)}</p>` : ""}
        ${p.outline ? `<ol>${p.outline.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` : ""}
        <button class="btn primary small" type="button">この案で${lastCond.chars}字の下書きを作る</button>
      </article>`).join("");
    $$(".prop button").forEach((b) => b.addEventListener("click", () => makeDraft(Number(b.closest(".prop").dataset.i))));
    $("#panelProposals").hidden = false;
    observeReveal($$(".prop"));
  }

  async function makeDraft(i) {
    chosen = proposals[i];
    $$(".prop").forEach((p, j) => p.classList.toggle("sel", j === i));
    const cond = getCond(); lastCond = cond;
    $("#panelDraft").hidden = false; setStep(4);
    $("#draftTitle").value = chosen.title; $("#draftBody").value = ""; $("#draftNote").textContent = "";
    $("#panelDraft").scrollIntoView({ behavior: "smooth", block: "start" });
    if (analysis.engine === "ai" && E.AI.kind !== "none") {
      $("#draftBody").value = "書いています…";
      ctl = new AbortController();
      try {
        const txt = await E.AI.text(E.draftPrompt(analysis, chosen, cond), { signal: ctl.signal, onText: ({ text }) => { setDraftText(text); } });
        setDraftText(txt);
        $("#draftNote").textContent = "AIの下書きです。【 】の部分や体験談を自分の事実に直してから提出してください。";
      } catch (e) {
        if (e && e.text) setDraftText(e.text);
        $("#draftNote").textContent = aiErrorText(e) + "。テンプレート下書きに切り替えます。";
        const d = E.offlineDraft(analysis, chosen, cond); $("#draftTitle").value = d.title; $("#draftBody").value = d.body;
      }
    } else {
      const d = E.offlineDraft(analysis, chosen, cond);
      $("#draftTitle").value = d.title; $("#draftBody").value = d.body; $("#draftNote").textContent = d.note;
    }
    updateCount();
  }
  function setDraftText(t) {
    const lines = String(t).split("\n");
    if (/^タイトル[:：]/.test(lines[0])) { $("#draftTitle").value = lines[0].replace(/^タイトル[:：]\s*/, ""); lines.shift(); }
    $("#draftBody").value = lines.join("\n").replace(/^\n+/, "");
    updateCount();
  }
  function updateCount() {
    const n = X.countChars($("#draftBody").value), target = (lastCond && lastCond.chars) || 1000;
    const c = $("#charCount"); c.textContent = `${n}字 / 目標${target}字`;
    c.classList.toggle("warn", n < target * .9 || n > target * 1.15);
  }
  $("#draftBody").addEventListener("input", updateCount);
  $("#regenDraft").addEventListener("click", () => { if (chosen) makeDraft(proposals.indexOf(chosen)); });
  $("#copyDraft").addEventListener("click", async () => {
    const t = $("#draftTitle").value + "\n\n" + $("#draftBody").value;
    try { await navigator.clipboard.writeText(t); toast("コピーしました"); }
    catch (e) { $("#draftBody").select(); toast("本文を選択しました。コピーしてください。"); }
  });

  function currentDraftReport() {
    const lec = getLecture($("#assistLecture").value);
    return { title: $("#draftTitle").value.trim() || "無題のレポート", body: $("#draftBody").value, subject: (analysis && analysis.subject) || (lec && lec.subject) || "", lectureId: lec ? lec.id : null };
  }
  $("#saveDraft").addEventListener("click", () => {
    const r = currentDraftReport();
    if (!r.body.trim()) { toast("本文が空です"); return; }
    const folderId = $("#saveFolder").value || S.state.folders[0].id;
    const now = new Date().toISOString();
    S.state.reports.unshift(Object.assign(r, { id: S.newId("r"), folderId, createdAt: now, updatedAt: now }));
    S.save(); renderFolders(); renderHero();
    const d = new Date();
    notify(`${d.getMonth() + 1}/${d.getDate()} ${r.subject || "レポート"} レポート作成完了`);
  });
  $("#exportDocx").addEventListener("click", (e) => exportDocx(currentDraftReport(), e.currentTarget));
  $("#exportXlsx").addEventListener("click", (e) => exportXlsx(currentDraftReport(), e.currentTarget));

  async function withOp(kind, text, el, build) {
    Op.show(kind, text, el);
    try { const v = await build(); await Op.hide(1100); return v; } catch (e) { await Op.hide(0); throw e; }
  }
  async function exportDocx(rep, el) {
    try {
      const blob = await withOp("Wordに書き出し中", "Wordファイルを組み立てています", el, () => X.buildDocx(rep, { date: ymd(new Date()) }));
      const r = await X.saveFile(X.safeName(rep.title) + ".docx", blob);
      if (r === "saved") toast("Wordファイルを書き出しました");
    } catch (e) { toast(e.message || "書き出せませんでした"); }
  }
  async function exportXlsx(rep, el) {
    try {
      const f = S.state.folders.find((x) => x.id === rep.folderId);
      const blob = await withOp("Excelに書き出し中", "Excelファイルを組み立てています", el, () => X.buildXlsx([X.reportSheet(rep, f ? f.name : "")]));
      const r = await X.saveFile(X.safeName(rep.title) + ".xlsx", blob);
      if (r === "saved") toast("Excelファイルを書き出しました");
    } catch (e) { toast(e.message || "書き出せませんでした"); }
  }

  // エンジン表示・APIキー
  async function setupEngine() {
    await E.AI.detect();
    $("#engineLabel").textContent = E.AI.label();
    $("#apiKeyBox").hidden = inViewer;
    try { $("#apiKey").value = localStorage.getItem("repotomo:apikey") || ""; $("#apiModel").value = localStorage.getItem("repotomo:model") || "claude-sonnet-5-5"; } catch (e) { /* ignore */ }
  }
  $("#saveKey").addEventListener("click", async () => {
    try {
      const k = $("#apiKey").value.trim();
      if (k) localStorage.setItem("repotomo:apikey", k); else localStorage.removeItem("repotomo:apikey");
      localStorage.setItem("repotomo:model", $("#apiModel").value.trim() || "claude-sonnet-5-5");
    } catch (e) { toast("このブラウザでは保存できませんでした"); }
    await setupEngine(); toast(E.AI.kind === "api" ? "APIキーを保存しました" : "APIキーを削除しました");
  });

  /* ================= フォルダ ================= */
  let curFolder = "all";
  function renderFolders() {
    const st = S.state;
    const count = (id) => st.reports.filter((r) => id === "all" || r.folderId === id).length;
    $("#folderList").innerHTML = [{ id: "all", name: "すべて" }].concat(st.folders).map((f) =>
      `<li><button type="button" data-id="${esc(f.id)}"${curFolder === f.id ? ' aria-current="true"' : ""}><span class="fi"><i aria-hidden="true"></i><span>${esc(f.name)}</span></span><span class="n">${count(f.id)}</span></button></li>`).join("");
    $$("#folderList button").forEach((b) => b.addEventListener("click", () => { curFolder = b.dataset.id; renderFolders(); }));
    const opts = st.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
    ["#saveFolder", "#modalFolder"].forEach((s) => { const el = $(s), v = el.value; el.innerHTML = opts; if (v) el.value = v; });
    const list = st.reports.filter((r) => curFolder === "all" || r.folderId === curFolder).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const cf = st.folders.find((f) => f.id === curFolder);
    const tools = curFolder === "all" ? "" : `<div class="lec-actions"><button class="btn small ghost" type="button" id="folderXlsx">このフォルダをExcelで書き出す</button><button class="btn small ghost danger" type="button" id="folderDel">フォルダを削除</button></div>`;
    $("#reportList").innerHTML = tools + (list.length ? list.map((r) => `
      <button class="rep" type="button" data-id="${esc(r.id)}">
        <b>${esc(r.title)}</b><span class="meta">${esc((r.updatedAt || "").slice(0, 10))} · ${X.countChars(r.body)}字</span>
        <p>${esc((r.subject ? r.subject + "｜" : "") + r.body.replace(/\s+/g, " ").slice(0, 120))}</p>
      </button>`).join("") : '<p class="empty">まだレポートがありません。レポート作成アシスタントで下書きを作り、「フォルダに保存」を押すとここに入ります。</p>');
    $$(".rep").forEach((b) => b.addEventListener("click", () => openReport(b.dataset.id)));
    const fx = $("#folderXlsx");
    if (fx) fx.addEventListener("click", async () => {
      try { const blob = await withOp("Excelに書き出し中", `「${cf.name}」をまとめています`, fx, () => X.buildXlsx([X.folderSheet(list, cf.name)])); const r = await X.saveFile(X.safeName(cf.name) + ".xlsx", blob); if (r === "saved") toast("Excelに書き出しました"); } catch (e) { toast(e.message || "書き出せませんでした"); }
    });
    const fd = $("#folderDel");
    if (fd) fd.addEventListener("click", () => {
      if (list.length) { toast("中にレポートがあるフォルダは削除できません。先に別のフォルダへ移してください。"); return; }
      if (st.folders.length <= 1) { toast("フォルダは1つ以上必要です"); return; }
      st.folders = st.folders.filter((f) => f.id !== curFolder); curFolder = "all"; S.save(); renderFolders(); toast("フォルダを削除しました");
    });
    $("#statReports").textContent = st.reports.length;
  }
  $("#newFolderForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#newFolderName").value.trim(); if (!name) return;
    const f = { id: S.newId("f"), name }; S.state.folders.push(f); curFolder = f.id;
    $("#newFolderName").value = ""; S.save(); renderFolders(); toast(`フォルダ「${name}」を作りました`);
  });

  let openId = null;
  function openReport(id) {
    const r = S.state.reports.find((x) => x.id === id); if (!r) return;
    openId = id;
    $("#modalTitle").value = r.title; $("#modalBody").value = r.body; $("#modalFolder").value = r.folderId;
    $("#modalMeta").textContent = `${r.subject || ""}　作成 ${(r.createdAt || "").slice(0, 10)}　${X.countChars(r.body)}字`;
    $("#modalConfirm").hidden = true; $("#modal").hidden = false; $("#modalTitle").focus();
  }
  function closeModal() { $("#modal").hidden = true; openId = null; }
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
  function modalRep() { const r = S.state.reports.find((x) => x.id === openId); return Object.assign({}, r, { title: $("#modalTitle").value, body: $("#modalBody").value, folderId: $("#modalFolder").value }); }
  $("#modalSave").addEventListener("click", () => {
    const r = S.state.reports.find((x) => x.id === openId); if (!r) return;
    Object.assign(r, modalRep(), { updatedAt: new Date().toISOString() }); S.save(); renderFolders(); toast("保存しました");
  });
  $("#modalDocx").addEventListener("click", (e) => exportDocx(modalRep(), e.currentTarget));
  $("#modalXlsx").addEventListener("click", (e) => exportXlsx(modalRep(), e.currentTarget));
  $("#modalDelete").addEventListener("click", () => ($("#modalConfirm").hidden = false));
  $("#modalDeleteNo").addEventListener("click", () => ($("#modalConfirm").hidden = true));
  $("#modalDeleteYes").addEventListener("click", () => {
    S.state.reports = S.state.reports.filter((x) => x.id !== openId); S.save(); closeModal(); renderFolders(); renderHero(); toast("レポートを削除しました");
  });

  /* ================= カレンダー ================= */
  const today = new Date();
  let calY = today.getFullYear(), calM = today.getMonth(), pickColor = COLORS[0];
  function renderColors() {
    $("#colorPick").innerHTML = COLORS.map((c) => `<button type="button" role="radio" aria-checked="${c === pickColor}" aria-label="色 ${c}" style="background:${c}" data-c="${c}"></button>`).join("");
    $$("#colorPick button").forEach((b) => b.addEventListener("click", () => { pickColor = b.dataset.c; renderColors(); }));
  }
  function renderCalendar() {
    $("#calMonth").textContent = `${calY}年 ${calM + 1}月`;
    const first = new Date(calY, calM, 1), start = new Date(calY, calM, 1 - first.getDay());
    const evs = S.state.events;
    let html = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const key = ymd(d), out = d.getMonth() !== calM, isToday = key === ymd(today);
      const list = evs.filter((e) => e.date === key);
      html += `<button type="button" class="day${out ? " out" : ""}${isToday ? " today" : ""}" data-date="${key}" aria-label="${d.getMonth() + 1}月${d.getDate()}日${list.length ? "、予定" + list.length + "件" : ""}"><span class="dn">${d.getDate()}</span>${list.map((e) => `<span class="ev${e.done ? " done" : ""}" style="background:${esc(e.color)}">${esc(e.title)}</span>`).join("")}</button>`;
    }
    $("#calGrid").innerHTML = html;
    $$(".day").forEach((b) => b.addEventListener("click", () => { $("#taskDate").value = b.dataset.date; $("#taskTitle").focus(); }));
    renderUpcoming(); renderHero();
  }
  function dueTime(e) { const [y, m, d] = e.date.split("-").map(Number); const [hh, mm] = (e.time || "23:59").split(":").map(Number); return new Date(y, m - 1, d, hh, mm); }
  function renderUpcoming() {
    const now = new Date();
    const list = S.state.events.slice().sort((a, b) => dueTime(a) - dueTime(b)).filter((e) => !e.done || dueTime(e) > new Date(now - 7 * 864e5));
    $("#upcoming").innerHTML = '<h3 class="h3">予定一覧</h3>' + (list.length ? list.map((e) => {
      const left = Math.ceil((dueTime(e) - now) / 864e5);
      const when = e.done ? "完了" : left < 0 ? "期限切れ" : left === 0 ? "今日" : `あと${left}日`;
      return `<div class="up${e.done ? " done" : ""}" data-id="${esc(e.id)}"><span class="bar" style="background:${esc(e.color)}"></span><div><b>${esc(e.title)}</b><small>${esc(e.date.slice(5).replace("-", "/"))} ${esc(e.time || "")}・${esc(e.subject || "")}・${when}</small></div>
        <div class="acts"><button type="button" data-a="done">${e.done ? "戻す" : "完了"}</button><a href="${esc(X.googleLink(e))}" target="_blank" rel="noopener">Google</a><button type="button" data-a="del">削除</button></div></div>`;
    }).join("") : '<p class="empty">予定はまだありません</p>');
    $$("#upcoming .up").forEach((row) => row.addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-a]"); if (!a) return;
      const e = S.state.events.find((x) => x.id === row.dataset.id); if (!e) return;
      if (a.dataset.a === "done") e.done = !e.done;
      if (a.dataset.a === "del") S.state.events = S.state.events.filter((x) => x.id !== e.id);
      S.save(); renderCalendar();
    }));
    $("#statTasks").textContent = S.state.events.filter((e) => !e.done).length;
  }
  function addEvent(ev) {
    const e = Object.assign({ id: S.newId("e"), done: false }, ev);
    S.state.events.push(e); S.save();
    const d = dueTime(e); calY = d.getFullYear(); calM = d.getMonth();
    renderCalendar();
    notify(`${d.getMonth() + 1}/${d.getDate()} ${e.subject ? e.subject + " " : ""}「${e.title}」を予定に登録しました`);
  }
  $("#calPrev").addEventListener("click", () => { calM--; if (calM < 0) { calM = 11; calY--; } renderCalendar(); });
  $("#calNext").addEventListener("click", () => { calM++; if (calM > 11) { calM = 0; calY++; } renderCalendar(); });
  $("#taskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    addEvent({ title: $("#taskTitle").value.trim(), date: $("#taskDate").value, time: $("#taskTime").value || "23:59", subject: $("#taskSubject").value.trim(), color: pickColor });
    $("#taskTitle").value = "";
  });
  $("#exportIcs").addEventListener("click", async () => {
    try { const blob = await withOp("カレンダーに書き出し中", "予定をカレンダー形式にしています", $("#exportIcs"), async () => new Blob([X.buildIcs(S.state.events.filter((e) => !e.done))], { type: "text/calendar" })); const r = await X.saveFile("RepoTomo予定.ics", blob); if (r === "saved") toast(".icsファイルを書き出しました。カレンダーアプリで開くと取り込めます。"); }
    catch (e) { toast("ここでは.icsを書き出せません。各予定の「Google」ボタンから追加してください。"); }
  });
  $("#enableNotify").addEventListener("click", async () => {
    try {
      if (!("Notification" in window)) throw 0;
      const p = await Notification.requestPermission();
      toast(p === "granted" ? "ブラウザ通知をオンにしました" : "ブラウザ通知は許可されませんでした。画面内の通知は届きます。");
    } catch (e) { toast("この環境ではブラウザ通知を使えません。画面内の通知（ベル）でお知らせします。"); }
  });

  function checkReminders() {
    const now = new Date(), st = S.state;
    st.events.filter((e) => !e.done).forEach((e) => {
      const ms = dueTime(e) - now; if (ms < 0) return;
      const days = Math.floor(ms / 864e5);
      const stage = ms < 6 * 36e5 ? "6h" : days === 0 ? "0d" : days === 1 ? "1d" : days <= 3 ? "3d" : null;
      if (!stage) return;
      const key = `${e.id}:${stage}`; if (st.notified[key]) return;
      st.notified[key] = true;
      const d = dueTime(e);
      const label = { "6h": "まもなく締切", "0d": "今日が締切", "1d": "明日が締切", "3d": `締切まであと${days}日` }[stage];
      notify(`${label}：${d.getMonth() + 1}/${d.getDate()} ${e.time || ""} ${e.subject ? e.subject + " " : ""}${e.title}`, { tag: key });
    });
    S.save();
  }

  /* ================= ヒーロー・フッター ================= */
  function renderHero() {
    const now = new Date();
    const next = S.state.events.filter((e) => !e.done && dueTime(e) > now).sort((a, b) => dueTime(a) - dueTime(b))[0];
    if (next) {
      const d = dueTime(next), h = Math.round((d - now) / 36e5);
      $("#nextDueTitle").textContent = next.title;
      $("#nextDueLeft").textContent = `${d.getMonth() + 1}/${d.getDate()} ${next.time || ""} ・ あと${h >= 48 ? Math.floor(h / 24) + "日" : h + "時間"}`;
    } else { $("#nextDueTitle").textContent = "締切のある予定はありません"; $("#nextDueLeft").textContent = "カレンダーから追加できます"; }
    $("#statReports").textContent = S.state.reports.length;
  }
  $("#backupBtn").addEventListener("click", async () => {
    try { const r = await X.saveFile(`RepoTomo_backup_${ymd(new Date())}.json`, new Blob([S.exportBackup()], { type: "application/json" })); if (r === "saved") toast("バックアップを書き出しました"); }
    catch (e) { toast("書き出せませんでした"); }
  });
  $("#restoreFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { S.importBackup(await f.text()); renderAll(); toast("バックアップから戻しました"); } catch (err) { toast(err.message || "読み込めませんでした"); }
    e.target.value = "";
  });

  function renderAll() {
    renderLibrary(); renderFolders(); renderColors(); renderCalendar(); renderBell(); renderHero(); updateSrcNote();
    const fx = fxName(); $$(".seg button").forEach((x) => x.setAttribute("aria-checked", x.dataset.fx === fx ? "true" : "false"));
    if (!deck.lec || !getLecture(deck.lec.id)) openDeck(window.REPOTOMO_LECTURES[window.REPOTOMO_LECTURES.length - 1].id);
    $("#storageNote").textContent = S.mode === "account" ? "データはあなたのClaudeアカウントに保存されています。" : "データはこのブラウザに保存されています。別の端末に移すときはバックアップを使ってください。";
    if (inViewer) $("#exportIcs").hidden = true;
  }

  /* ================= 起動 ================= */
  $("#taskDate").value = ymd(today);
  renderAll();
  observeMarks(document); observeReveal($$(".panel, .sec-head"));
  setupEngine();
  S.init().then(() => { renderAll(); checkReminders(); setInterval(checkReminders, 60000); });
})();
