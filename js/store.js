/*
 * RepoTomo データ保存
 * ・GitHub Pages などで開いたとき：このブラウザの localStorage に保存
 * ・Claude のアーティファクトとして開いたとき：アカウントごとの保存領域（db）に保存
 *   （同じ Claude アカウントなら別の端末からも同じデータが見られます）
 */
(function () {
  const KEY = "repotomo:v1";
  const LEC_PREFIX = "repotomo:lec:";
  const uid8 = () => Math.random().toString(36).slice(2, 10);

  function defaults() {
    return {
      version: 1,
      folders: [
        { id: "f-mkt", name: "マーケティング戦略論" },
        { id: "f-misc", name: "その他" }
      ],
      reports: [
        {
          id: "r-kddi",
          folderId: "f-mkt",
          title: "KDDIの事業戦略に関する分析 ― SWOT分析と顧客視点から考える",
          subject: "マーケティング戦略論",
          lectureId: "mkt-02",
          createdAt: "2026-10-20T11:30:00+09:00",
          updatedAt: "2026-10-20T11:30:00+09:00",
          body: [
            "1. 現状",
            "講義資料のインタビュー記事によると、KDDIは物価の高騰を背景に、既存プランを含めて携帯料金の引き上げに踏み切った。その一方で、衛星経由で通信できる「au Starlink Direct」などの3つの価値に、ポイント還元とエンターテインメントのセットを加え、5つの価値をまとめた「auバリューリンクプラン」を発表している。さらに、ローソンと「Real×Tech LAWSON」を開業するなど、通信以外の分野にも取り組んでいる。",
            "",
            "2. SWOT分析",
            "S（強み）：通信品質の優位性が各種調査で目立つ／新プランが新規契約・機種変更の約6割に選ばれた／Pontaやローソンなど、客との接点が多い",
            "W（弱み）：値上げを機に解約した人もいる／衛星通信は地上の5Gほど速くない／新規事業が通信の大きな利益の陰で軽視されやすい",
            "O（機会）：衛星との直接通信で、圏外の場所が減る可能性／AIの浸透／グーグルやローソンとの協業",
            "T（脅威）：他社も続々と値上げしている／通信分野の物価指数は2020年比で70ほどに下がっていた／海外勢がAIに巨額投資している",
            "",
            "3. 顧客視点（4C）から見た課題",
            "講義で学んだ4Cに当てはめると、Customer Value（顧客にとっての価値）は、山や海でも空が見えればつながる安心感や、混雑していても通信できる点にあると考えた。一方でCost（顧客の負担）は値上げで増えており、利用者が「価値に見合っている」と感じられるかどうかが課題ではないかと感じた。Convenience（入手の容易性）では、ローソンという身近な店舗が客との接点になる可能性がある。ただし、全国1万4000店舗に同じ取り組みを広げられるとは考えていないとも述べられており、どこまで広げられるかは今後の課題だと考えた。",
            "",
            "4. 今後の展望",
            "クロスSWOT分析に当てはめると、通信品質という強みと、衛星通信やAIという機会を組み合わせる「積極攻勢」の方向が考えられる。また、ローソンとの取り組みは、アンゾフ・マトリクスでいう多角化に近いのかもしれない。記事にあるように、新規事業の芽を埋もれさせない体制づくりも、これからの課題の一つではないかと考えた。",
            "",
            "5. 感想と、考えが覆ったこと",
            "私はこれまで、値上げをすれば客が離れてしまうと考えていた。経済学の授業でも、価格が上がると需要量が減る「需要の法則」を学んでいた。しかし記事では、新プランが新規契約と機種変更の約6割に選ばれ、解約もあまり使われていなかった回線が多かったと述べられていた。価格だけでなく、そこに加わる価値によって選ばれ方が変わることもあるのだと感じた。",
            "また、通信会社はスマホの回線を売る会社だと思っていたが、ローソンの店舗でデジタルサイネージやPontaのIDを活用しようとしていることを知り、流通論で学んだ「情報的分離」の話と重なって見えた。さらに、大きな会社ほど新しいことに挑戦しやすいと思っていたが、社長自身が「通信会社はイノベーションが起きづらい」と指摘されると述べていたことは意外だった。大きな利益があるからこそ新しい芽が軽視されやすいという見方は、今まで考えたことがなかった。"
          ].join("\n")
        }
      ],
      events: [
        { id: "e-ohsho", title: "王将フードサービスのレポート提出", subject: "マーケティング戦略論", date: "2026-10-24", time: "22:00", color: "#c79a2e", done: false },
        { id: "e-kddi", title: "KDDIのレポート提出", subject: "マーケティング戦略論", date: "2026-10-17", time: "22:00", color: "#5b56a8", done: true }
      ],
      lectures: [],   // 自分で追加した講義（本文は別保存）
      notes: [],      // 通知の履歴
      notified: {},   // リマインダーを出した記録
      settings: { fx: "slide" }
    };
  }

  const Store = {
    mode: "local",
    state: defaults(),
    _db: null,
    _uid: null,
    _timer: null,
    _listeners: [],

    onChange(fn) { this._listeners.push(fn); },
    _emit() { this._listeners.forEach((fn) => { try { fn(this.state); } catch (e) { console.error(e); } }); },

    async init() {
      // 1) まずはこのブラウザの保存を読む
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) this.state = Object.assign(defaults(), JSON.parse(raw));
      } catch (e) { /* private mode など */ }

      // 2) Claude のアーティファクトなら、アカウントの保存領域に切り替える
      if (window.claude && typeof window.claude.use === "function") {
        try {
          const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
          const id = user ? await user.id() : null;
          if (db && id) {
            this._db = db; this._uid = id; this.mode = "account";
            const snap = await db.doc(`data/users/${id}/state`).get();
            if (snap.exists) {
              const d = snap.data();
              this.state = Object.assign(defaults(), d && d.json ? JSON.parse(d.json) : {});
            }
          }
        } catch (e) { console.warn("db unavailable", e); this.mode = "local"; }
      }
      this._emit();
      return this.state;
    },

    save() {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), 500);
      this._emit();
    },
    async _flush() {
      const json = JSON.stringify(this.state);
      if (this.mode === "account" && this._db) {
        try { await this._db.doc(`data/users/${this._uid}/state`).set({ json, savedAt: new Date().toISOString() }); }
        catch (e) {
          console.warn(e);
          window.RepoTomoToast && window.RepoTomoToast("保存できませんでした。容量がいっぱいの場合は、古い講義やレポートを削除してください。");
        }
      } else {
        try { localStorage.setItem(KEY, json); }
        catch (e) { window.RepoTomoToast && window.RepoTomoToast("このブラウザに保存できませんでした（容量不足か、プライベートモードの可能性があります）。"); }
      }
    },

    // 講義の本文（長いので別に保存）
    async putLectureText(id, text) {
      const t = String(text || "").slice(0, 120000);
      if (this.mode === "account" && this._db) {
        try { await this._db.doc(`data/users/${this._uid}/lec_${id}`).set({ text: t }); return; } catch (e) { console.warn(e); }
      }
      try { localStorage.setItem(LEC_PREFIX + id, t); } catch (e) { /* ignore */ }
    },
    async getLectureText(id) {
      if (this.mode === "account" && this._db) {
        try { const s = await this._db.doc(`data/users/${this._uid}/lec_${id}`).get(); if (s.exists) return s.data().text || ""; } catch (e) { /* fallthrough */ }
      }
      try { return localStorage.getItem(LEC_PREFIX + id) || ""; } catch (e) { return ""; }
    },
    async deleteLectureText(id) {
      if (this.mode === "account" && this._db) { try { await this._db.doc(`data/users/${this._uid}/lec_${id}`).delete(); } catch (e) { /* ignore */ } }
      try { localStorage.removeItem(LEC_PREFIX + id); } catch (e) { /* ignore */ }
    },

    exportBackup() { return JSON.stringify(this.state, null, 2); },
    importBackup(json) {
      const d = JSON.parse(json);
      if (!d || !Array.isArray(d.folders) || !Array.isArray(d.reports)) throw new Error("RepoTomoのバックアップではありません");
      this.state = Object.assign(defaults(), d);
      this.save();
    },
    newId: (p) => `${p}-${Date.now().toString(36)}${uid8()}`
  };

  window.RepoStore = Store;
})();
