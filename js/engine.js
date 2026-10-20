/*
 * RepoTomo 分析エンジン
 *  - 資料の読み込み（PDF・テキスト）と匿名化
 *  - オフライン分析（キーワード・課題・締切の検出、テンプレート下書き）
 *  - AI分析（Claude）：アーティファクトでは Claude の sample 機能、
 *    GitHub版では自分の Claude API キーを使用
 */
(function () {
  const PDF_VER = "3.11.174";
  const WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_VER}/pdf.worker.min.js`;
  let pdfReady = false;

  /* ---------------- 読み込み ---------------- */
  function setupPdf() {
    if (pdfReady) return;
    if (!window.pdfjsLib) throw new Error("PDFを読む部品を読み込めませんでした。通信状況を確認して、ページを再読み込みしてください。");
    try {
      const blob = new Blob([`importScripts("${WORKER_URL}");`], { type: "text/javascript" });
      window.pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
    }
    pdfReady = true;
  }

  async function readFile(file, onProgress) {
    const name = file.name || "資料";
    if (/\.pdf$/i.test(name) || file.type === "application/pdf") {
      setupPdf();
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        let line = "", out = [];
        for (const it of tc.items) {
          line += it.str;
          if (it.hasEOL) { out.push(line); line = ""; } else if (it.str && !/\s$/.test(it.str)) { /* keep */ }
        }
        if (line) out.push(line);
        const text = out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
        pages.push({ no: i, text });
        onProgress && onProgress(i, pdf.numPages);
      }
      return { name, kind: "pdf", pages, pdf };
    }
    const text = await file.text();
    const pages = text.split(/\f|\n{3,}/).map((t, i) => ({ no: i + 1, text: t.trim() })).filter((p) => p.text);
    return { name, kind: "text", pages, pdf: null };
  }

  // 文字の少ないページ（記事の画像など）をJPEGにする → AIに画像として渡す
  async function pageImages(doc, max) {
    if (!doc.pdf || !max) return [];
    const cands = doc.pages.filter((p) => p.text.replace(/\s/g, "").length < 60).map((p) => p.no);
    const pick = cands.slice(-max);
    const out = [];
    for (const no of pick) {
      const page = await doc.pdf.getPage(no);
      const vp = page.getViewport({ scale: 1.4 });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
      if (blob) out.push(blob);
    }
    return out;
  }

  /* ---------------- 匿名化 ---------------- */
  const JP = "\\u4E00-\\u9FFF\\u3040-\\u309F\\u30A0-\\u30FF";
  function mask(text, extraWords) {
    let t = String(text || "");
    const names = new Set((extraWords || []).map((s) => s.trim()).filter(Boolean));
    // 「担当：山田太郎」「講師：山田 太郎」「教授 山田太郎」などから名前を拾う
    const re = new RegExp(`(担当教員|担当|講師|教員|指導教員)[ \\t　]*[:：][ \\t　]*([${JP}]{1,4})[ 　]?([${JP}]{0,4})`, "g");
    t.replace(re, (m, role, a, b) => { names.add(a + b); if (b) names.add(a); return m; });
    t = t.replace(re, (m, role) => `${role}：●●`);
    // 「山田 太郎 先生」「山田教授」
    t = t.replace(new RegExp(`([\\u4E00-\\u9FFF]{1,4}[ 　]?[\\u4E00-\\u9FFF]{0,3})[ 　]?(先生|教授|准教授)`, "g"), (m, n, role) => { if (n.length >= 2) names.add(n.replace(/[\\s　]/g, "")); return "●●" + role; });
    for (const n of names) {
      if (n.length < 2) continue;
      t = t.replace(new RegExp(n.split("").join("[\\s　]?"), "g"), "●●");
    }
    // 大学名
    t = t.replace(/[\u4E00-\u9FFF\u30A0-\u30FFA-Za-z]{1,10}大学(院)?/g, "〇〇大学");
    t = t.replace(/(University of [A-Z][a-z]+|[A-Z][a-z]+ University)/g, "〇〇 University");
    // メールアドレス
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "（メールアドレス）");
    return t;
  }

  /* ---------------- オフライン分析 ---------------- */
  // よく出てくる学術用語の辞書（科目を問わず使えるように幅広く）
  const DICT = [
    ["SWOT", /SWOT/i, "SWOT分析", "内部の強み・弱みと、外部の機会・脅威を整理する方法"],
    ["クロスSWOT", /クロス\s*SWOT|Cross\s*SWOT/i, "クロスSWOT", "強み・弱みと機会・脅威を掛け合わせて打ち手を考える"],
    ["3C", /3C|３C/, "3C分析", "自社・競合・顧客の3つから環境を分析する"],
    ["4P", /4P|４P|マーケティング・ミックス/, "4P", "製品・価格・流通・販促の組み合わせ"],
    ["4C", /4C|４C|Customer Value/i, "4C", "顧客にとっての価値・負担・入手のしやすさ・コミュニケーション"],
    ["STP", /STP|セグメンテーション|ターゲティング|ポジショニング/, "STP", "市場を分け、狙う相手を決め、立ち位置を定める"],
    ["ポジショニングマップ", /ポジショニングマップ/, "ポジショニングマップ", "差別化できる2つの軸で競合との位置を比べる"],
    ["パーチェス・ファネル", /Purchase Funnel|パーチェス/i, "パーチェス・ファネル", "認知から購入までの段階"],
    ["アンゾフ", /アンゾフ/, "アンゾフ・マトリクス", "製品と市場の新旧で成長の方向を考える"],
    ["PPM", /PPM|プロダクト・ポートフォリオ/, "PPM", "市場成長率と相対シェアで事業を4つに分ける"],
    ["ファイブフォース", /ファイブフォース|5フォース/, "ファイブフォース分析", "業界の競争を5つの力で捉える"],
    ["バリューチェーン", /価値連鎖|バリューチェーン/, "価値連鎖", "企業の活動を主活動と支援活動に分けて見る"],
    ["USP", /USP/, "USP", "選ばれる決め手となる独自の売り"],
    ["Value", /Value|バリュー/, "Value（顧客価値）", "お客様の期待を金銭化した値"],
    ["1ページメモ", /1ページメモ|ワンページメモ|1-page memo/i, "1ページメモ", "目的・背景・結論・理由を1枚にまとめる書き方"],
    ["マーケティング・リサーチ", /マーケティング・リサーチ|リサーチ/, "マーケティング・リサーチ", "意思決定のために情報を体系的・客観的に集めて分析する"],
    ["1次・2次データ", /[12１２]次データ/, "1次データ・2次データ", "目的のために集めるデータと、すでにあるデータ"],
    ["定量・定性", /定量|定性/, "定量調査・定性調査", "数字で確かめる調査と、理由や気持ちを深く聞く調査"],
    ["尺度", /名義尺度|順序尺度|間隔尺度|比率尺度/, "測定尺度", "名義・順序・間隔・比率の4つ"],
    ["仮説検定", /仮説検定|帰無仮説/, "仮説検定", "差がないという仮説を棄却して差を確かめる"],
    ["流通", /流通/, "流通", "生産と消費の分離をつなぐ活動"],
    ["商業者", /商業者|卸売|小売/, "商業者の役割", "取引数の節約や品揃えの形成"],
    ["需要と供給", /需要|供給/, "需要と供給", "価格によって買いたい量と売りたい量が調整される"],
    ["均衡価格", /均衡/, "市場均衡", "需要曲線と供給曲線が交わる点"],
    ["市場メカニズム", /市場メカニズム|資源配分/, "市場メカニズム", "価格がシグナルとなって資源が配分される"],
    ["外部性", /外部性|公共財|情報の非対称性/, "市場の失敗", "市場だけではうまくいかない場面"],
    ["フローチャート", /フローチャート/, "フローチャート", "処理の流れを記号でわかりやすく示す図"],
    ["パス", /絶対パス|相対パス/, "絶対パスと相対パス", "ファイルの場所の書き方"],
    ["CUI/GUI", /CUI|GUI/, "CUIとGUI", "文字で命令する操作と、画面の絵で操作するインターフェース"],
    ["戦略", /戦略/, "戦略と戦術", "長期的に一貫した資源配分と、短期の対応策"]
  ];

  const STOP = new Set("こと もの ため よう これ それ あれ 場合 以下 以上 方法 必要 重要 可能 自分 我々 今回 今後 現在 ページ スライド 講義 資料 課題 参考 出典 例 ex Ver".split(" "));

  function joinText(doc) { return doc.pages.map((p) => p.text).join("\n"); }

  function offlineAnalyze(doc, cond) {
    const text = joinText(doc);
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    // 科目名
    const subj = (text.match(new RegExp(`([${JP}・A-Za-z]{2,16}(論|学|概論|演習|入門|デザイン|基礎))`)) || [])[1] || "";
    // 回と題名
    let lecTitle = "";
    const m = text.match(/第\s*([0-9０-９一二三四五六七八九十]+)\s*回目?\s*[:：]?\s*([^\n]{2,40})/);
    if (m) lecTitle = `第${m[1]}回 ${m[2].trim()}`;
    // 見出し（短い行で、ページの先頭にあるもの）
    const heads = [];
    doc.pages.forEach((p) => {
      const first = (p.text.split("\n").find((l) => l.trim().length >= 3) || "").trim();
      if (first && first.length <= 28 && !/^\d+$/.test(first) && !heads.includes(first)) heads.push(first);
    });
    // 辞書にある概念
    const concepts = [];
    for (const [, re, term, explain] of DICT) {
      const hit = (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
      if (hit) concepts.push({ term, explain, hit });
    }
    concepts.sort((a, b) => b.hit - a.hit);
    // 頻出語（カタカナ語・漢字の熟語）
    const freq = {};
    (text.match(new RegExp(`[\\u30A0-\\u30FF]{3,}|[\\u4E00-\\u9FFF]{2,6}`, "g")) || []).forEach((w) => {
      if (STOP.has(w)) return; freq[w] = (freq[w] || 0) + 1;
    });
    const keywords = Object.entries(freq).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w]) => w);
    // 課題と締切
    let assignment = null;
    const am = text.match(/課題\s*\n?([\s\S]{10,260}?(述べよ|述べる|論ぜよ|説明せよ|書きなさい|書いてください|してください|せよ)[。.]?)/);
    const dm = text.match(/(〆切|締切|締め切り|提出期限)[^0-9０-９]{0,6}([0-9０-９]{1,2})月\s*([0-9０-９]{1,2})日[^0-9]{0,8}([0-9]{1,2}[:：][0-9]{2})?/);
    if (am || dm) {
      const at = am ? am[1].replace(/\s+/g, "").replace(/^(課題[:：]?)+/, "") : "";
      const cm = at.match(/^(.{2,24}?)(の事業|の事業戦略|の戦略|のマーケティング|について)/);
      assignment = {
        text: at,
        deadline: dm ? `${toHalf(dm[2])}月${toHalf(dm[3])}日${dm[4] ? " " + dm[4].replace("：", ":") : ""}` : "",
        company: cm ? cm[1] : ""
      };
    }
    // 数字の入った事実（記事などから）
    const facts = lines.filter((l) => /[0-9０-９]+(億|万|%|％|店|人|年|割)/.test(l) && l.length > 12 && l.length < 90).slice(0, 6);
    return {
      engine: "offline",
      subject: subj || (cond && cond.subjectHint) || "",
      lectureTitle: lecTitle || (heads[0] || doc.name),
      overview: heads.length ? `この資料は「${heads.slice(0, 4).join("」「")}」などを扱っています。` : "見出しを読み取れませんでした。",
      flow: heads.slice(0, 10),
      keyConcepts: concepts.slice(0, 8).map(({ term, explain }) => ({ term, explain })),
      keywords,
      assignment,
      facts
    };
  }
  function toHalf(s) { return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }

  function offlineSlides(doc) {
    return doc.pages.filter((p) => p.text.replace(/\s/g, "").length > 20).slice(0, 40).map((p) => {
      const ls = p.text.split("\n").map((s) => s.trim()).filter((s) => s.length > 1);
      return { type: "points", title: (ls[0] || `p.${p.no}`).slice(0, 40), items: ls.slice(1, 6).map((s) => s.slice(0, 90)) };
    });
  }

  function offlineProposals(a, cond) {
    const c1 = a.keyConcepts[0] ? a.keyConcepts[0].term : (a.keywords[0] || "講義の中心概念");
    const c2 = a.keyConcepts[1] ? a.keyConcepts[1].term : (a.keywords[1] || "もう一つの概念");
    const company = (a.assignment && a.assignment.company) || "身近な企業";
    const exp = cond.experience || "自分が最近した買い物や、よく使うお店・サービス";
    const A = cond.chars;
    const part = (r) => Math.round(A * r / 50) * 50;
    return [
      { title: `${company}を${c1}で整理する`, angle: "フレームワーク分析型", frameworks: [c1, c2], company,
        companyExample: a.assignment && a.assignment.company ? `資料にある${company}の事実（数字や取り組み）を${c1}に当てはめる` : "よく知っている企業を1つ選び、資料の概念に当てはめる",
        experienceIdea: `${exp}を顧客の立場から振り返る`,
        outline: [`序論（${part(.15)}字）：対象と問いを示す`, `本論1（${part(.35)}字）：${c1}で現状を整理`, `本論2（${part(.25)}字）：${c2}で課題を考える`, `結論（${part(.25)}字）：今後の展望と自分の考え`] },
      { title: `自分の体験から${c1}を考える`, angle: "体験から考える型", frameworks: [c1], company,
        companyExample: `体験した店やサービスを具体例にする（${company}と比べてもよい）`,
        experienceIdea: exp,
        outline: [`序論（${part(.15)}字）：受講前の考え`, `本論1（${part(.3)}字）：${c1}の説明`, `本論2（${part(.3)}字）：体験への当てはめ`, `結論（${part(.25)}字）：考えが変わった点と疑問`] },
      { title: `${c1}と${c2}を比べて見えたこと`, angle: "比較・疑問型", frameworks: [c1, c2], company,
        companyExample: `${company}など、1つの例を2つの見方で比べる`,
        experienceIdea: `${exp}で、2つの見方のどちらが当てはまるか`,
        outline: [`序論（${part(.15)}字）：2つの概念と問い`, `本論1（${part(.3)}字）：共通点`, `本論2（${part(.3)}字）：違い`, `結論（${part(.25)}字）：新たな疑問`] }
    ];
  }

  function soft(s, on) { return on ? s : s.replace(/と考えた。/g, "と考える。").replace(/かもしれない。/g, "といえる。"); }

  function offlineDraft(a, prop, cond) {
    const c = prop.frameworks[0] || "講義の概念";
    const c2 = prop.frameworks[1] || "";
    const find = (t) => (a.keyConcepts.find((k) => k.term === t) || {}).explain || "";
    const ex1 = find(c) || "講義で学んだ考え方";
    const ex2 = c2 ? find(c2) : "";
    const company = prop.company || "身近な企業";
    const exp = cond.experience ? cond.experience.replace(/。$/, "") : "【ここに自分の体験を書く：いつ・どこで・何をしたか】";
    const facts = (a.facts || []).filter(Boolean);
    const f1 = facts[0] || `【資料にある${company}の具体的な事実や数字】`;
    const f2 = facts[1] || "";
    const S = cond.rules.soft;
    const target = cond.chars || 1000;
    // 優先順に段落を並べ、目標字数に近づくまで使う
    const core = [
      `私はこれまで、【受講前に考えていたこと】と考えていた。今回の講義では${a.lectureTitle ? "「" + a.lectureTitle + "」として、" : ""}${a.keyConcepts.slice(0, 3).map((k) => k.term).join("、")}などを学んだ。本レポートでは、「${prop.title.replace(/。$/, "")}」という視点から考えたい。`,
      `講義では、${c}について「${ex1}」と学んだ。${c2 && ex2 ? `また、${c2}については「${ex2}」と学んだ。` : ""}この考え方を使うと、ふだん何となく見ている${company}の動きも、整理して見られるのではないかと感じた。`,
      `具体例として、${company}を取り上げる。資料には「${f1}」とあった。これを${c}に当てはめると、【当てはめた結果を2〜3文で】と整理できるかもしれない。`,
      `また、自分の体験として、${exp}。このとき私は【そのときの気持ちや行動】と感じた。講義の考え方で振り返ると、${S ? "この行動にも理由があったのかもしれないと考えた" : "この行動にも理由があったといえる"}。`
    ];
    const extra = [
      f2 ? `さらに資料では「${f2}」とも述べられていた。私はこの点を読んで、【驚いたこと・意外だったこと】と感じた。${c2 ? `${c2}の見方から考えると、【もう一つの見方での整理】ではないかと考えた。` : ""}` : "",
      `この講義を受けて、私の考えは少し変わった。以前は【以前の考え】と思っていたが、今は【今の考え】と考えている。${c}という見方を知ったことで、同じ出来事でも違って見えることがあると感じた。`,
      c2 ? `一方で、${c}と${c2}を比べると、【共通点や違い】があるように感じた。どちらの見方を使うかによって、気づくことが変わるのかもしれない。` : ""
    ].filter(Boolean);
    const closing = `今回の講義を通して、${c}は企業のためだけでなく、私たち消費者の行動を見直すときにも使える見方だと感じた。一方で、【まだ分からないこと・新たな疑問】という疑問も残った。次回以降の講義で、この点をさらに考えていきたい。`;
    const len = (arr) => arr.join("").replace(/\s/g, "").length;
    const paras = core.slice();
    for (const e of extra) { if (len(paras) + len([closing]) >= target * 0.92) break; paras.push(e); }
    paras.push(closing);
    const body = paras.map((p) => soft(p, S)).join("\n");
    return { title: prop.title, body, note: "オフラインのテンプレート下書きです。【 】の部分を自分の言葉に置き換えると、レポートとして完成します（置き換えると字数も目標に近づきます）。" };
  }

  /* ---------------- AI ---------------- */
  const AI = {
    kind: "none",   // "claude" | "api" | "none"
    sample: null,
    imageMax: 0,
    async detect() {
      if (window.claude && typeof window.claude.use === "function") {
        try {
          const s = await window.claude.use("sample");
          if (s) {
            this.sample = s; this.kind = "claude";
            try { const lim = await s.limits(); this.imageMax = lim && lim.images ? Math.min(lim.images.maxCount, 6) : 0; } catch (e) { this.imageMax = 0; }
            return this.kind;
          }
        } catch (e) { /* fallthrough */ }
      }
      const key = getKey();
      this.kind = key ? "api" : "none";
      this.imageMax = key ? 6 : 0;
      return this.kind;
    },
    label() {
      return {
        claude: "Claude（あなたのClaudeアカウントで分析します。最初の1回だけ許可を求められます）",
        api: "Claude API（保存したAPIキーで分析します）",
        none: "オフライン分析（キーワード・課題・締切を自動で検出し、テンプレート下書きを作ります）"
      }[this.kind];
    },
    async json(prompt, opts) {
      if (this.kind === "claude") return this.sample.json(prompt, { images: opts.images, signal: opts.signal, modelTier: "default" });
      if (this.kind === "api") { const t = await apiCall(prompt, opts); return parseJson(t); }
      throw { code: "none" };
    },
    async text(prompt, opts) {
      if (this.kind === "claude") { const r = await this.sample(prompt, { onText: opts.onText, signal: opts.signal, cache: false }); return r.text; }
      if (this.kind === "api") return apiCall(prompt, opts);
      throw { code: "none" };
    }
  };

  function getKey() { try { return localStorage.getItem("repotomo:apikey") || ""; } catch (e) { return ""; } }
  function getModel() { try { return localStorage.getItem("repotomo:model") || "claude-sonnet-5-5"; } catch (e) { return "claude-sonnet-5-5"; } }

  function parseJson(t) {
    try { return JSON.parse(t); } catch (e) { /* tolerant */ }
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) { /* next */ } }
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw { code: "invalid_json", text: t };
  }

  async function blobToB64(b) {
    const buf = new Uint8Array(await b.arrayBuffer()); let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function apiCall(prompt, opts) {
    const content = [];
    for (const b of (opts.images || [])) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await blobToB64(b) } });
    content.push({ type: "text", text: prompt });
    const stream = !!opts.onText;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": getKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: getModel(), max_tokens: 6000, stream, messages: [{ role: "user", content }] })
    });
    if (!res.ok) { const t = await res.text(); throw { code: res.status === 401 ? "bad_key" : "api_error", message: t.slice(0, 300) }; }
    if (!stream) { const j = await res.json(); return (j.content || []).map((c) => c.text || "").join(""); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", text = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try { const ev = JSON.parse(line.slice(5)); if (ev.type === "content_block_delta" && ev.delta && ev.delta.text) { text += ev.delta.text; opts.onText({ text, delta: ev.delta.text }); } } catch (e) { /* skip */ }
      }
    }
    return text;
  }

  function rulesText(cond) {
    const r = [];
    if (cond.rules.student) r.push("書き手は大学生。社会人や経営者のような立場・分析の仕方・言い回しは使わない。");
    if (cond.rules.soft) r.push("「〜することで、〜なる。」のような断定的な因果の言い切りは使わない。「〜と考えた」「〜かもしれない」「〜のではないか」で結ぶ。");
    if (cond.rules.feel) r.push("「〜と感じた」「〜と考えた」を中心に書く。");
    if (cond.rules.sourceOnly) r.push("講義資料に書かれている情報だけを使い、外部の知識・数字・企業情報は持ち込まない。");
    else r.push("企業の具体例は、広く知られている事実だけを使い、数字は資料にあるものだけを使う。不確かなことは書かない。");
    return r.map((s) => "- " + s).join("\n");
  }

  function analysisPrompt(docText, cond, offline) {
    return `あなたは大学生のレポート作成を手伝うチューターです。以下は今日の講義資料から抽出したテキストです（大学名・教員名は伏せてあります）。画像が添付されている場合は、資料内の記事のページです。
手順を追って分析してください：(1)講義の主題と流れを把握 (2)重要な概念を選び、学生にわかる言葉で説明 (3)課題文と締切を探す (4)資料にある具体的な事実・数字を拾う (5)復習用スライドを作る (6)レポート案を3つ考える。

【条件】
- レポートの種類：${{ assignment: "資料の課題に答える", reflection: "感想・考えたこと", analysis: "企業や事例の分析" }[cond.type]}
- 文字数：${cond.chars}字
- テーマ・課題文：${cond.topic || "（資料から探す）"}
- 学生の体験：${cond.experience || "（なし。体験談のアイデアを提案する）"}
${rulesText(cond)}

【返す形式】JSONだけを返す。
{
 "subject": "科目名",
 "lectureTitle": "第◯回 講義タイトル",
 "overview": "講義の要約（3文）",
 "flow": ["講義の流れを順に（5〜8項目）"],
 "keyConcepts": [{"term": "概念", "explain": "1〜2文の説明"}],
 "assignment": {"text": "課題文", "deadline": "締切", "company": "対象企業"} または null,
 "facts": ["資料にある具体的な事実・数字（最大8）"],
 "slides": [{"title": "スライド見出し", "points": ["要点", "要点", "要点"]}],
 "proposals": [{"title": "レポート案のタイトル", "angle": "切り口（例：フレームワーク分析型）", "frameworks": ["使う概念"], "company": "取り上げる企業", "companyExample": "企業の具体例（どの事実をどう使うか）", "experienceIdea": "入れると良い体験談の例", "outline": ["序論（◯字）：…", "本論1（◯字）：…", "本論2（◯字）：…", "結論（◯字）：…"]}]
}
keyConceptsは5〜8個、slidesは6〜8枚、proposalsはちょうど3つ。

【参考：自動検出した課題・キーワード】
${JSON.stringify({ assignment: offline.assignment, keywords: offline.keywords })}

【講義資料のテキスト】
${docText.slice(0, 60000)}`;
  }

  function draftPrompt(analysis, prop, cond) {
    return `あなたは大学生のレポート作成を手伝うチューターです。下の分析とレポート案をもとに、学生本人が提出用に手直しできる下書きを書いてください。

【レポート案】
${JSON.stringify(prop)}

【講義の分析】
${JSON.stringify({ subject: analysis.subject, lectureTitle: analysis.lectureTitle, overview: analysis.overview, keyConcepts: analysis.keyConcepts, assignment: analysis.assignment, facts: analysis.facts })}

【条件】
- 本文はおよそ${cond.chars}字（±5%）。だ・である調。見出しは使わず、段落ごとに改行。
- テーマ・課題文：${cond.topic || (analysis.assignment && analysis.assignment.text) || "講義の感想と考察"}
- 学生の体験：${cond.experience || "（なし）"}。体験がない場合は、学生がよくある場面を【 】で囲んだ書き換え用の仮の体験として書く。
- 講義で学んだ概念の名前を正しく使い、資料の事実を1つ以上入れる。
${rulesText(cond)}

【出力】1行目に「タイトル：…」、2行目から本文だけ。マークダウンは使わない。`;
  }

  window.RepoEngine = { readFile, pageImages, mask, joinText, offlineAnalyze, offlineSlides, offlineProposals, offlineDraft, AI, analysisPrompt, draftPrompt, getKey, getModel, DICT };
})();
