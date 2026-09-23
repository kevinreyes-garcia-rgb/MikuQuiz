/* =========================================================
   MikuQuiz · js/host.js  (vista del CREADOR de la sala)
   - Crea la sala, muestra código, recibe jugadores
   - Editor de preguntas (texto + imagen/banner, 4 respuestas, 1 correcta)
   - Config: duración del quiz y puntos meta (máx 9000)
   - Inicia y termina la partida, panel en vivo de puntajes
   - Robo de puntos al cruzar cada múltiplo de 15
   ========================================================= */

function DEFAULT_BANNER() { return themeBanner(); }
function DEFAULT_ICON()   { return themeIcon(); }
const MAX_TARGET     = 9000;
const STEAL_EVERY    = 15;   // cada 15 puntos -> robo
const STEAL_AMOUNT   = 4;    // puntos robados al líder

const HostGame = {
  code: null,
  vocaloid: "miku",
  host: null,
  autoT: null,
  me: "",
  players: new Map(),   // conn -> {name, color, emoji, score, answered}
  questions: [],
  settings: { minutes: 5, target: 100 },
  started: false,
  qIndex: 0,
  timeLeft: 0,
  timerId: null,
  pickIndex: 0,         // respuesta correcta seleccionada en el editor

  /* ---------- iniciar vista ---------- */
  start(name) {
    this.me = name;
    this.code = makeCode();
    renderHostLobby(this);
    const st = this;
    this.host = new Host(this.code, {
      onOpen() {
        document.getElementById("host-status").textContent = "🟢 Sala lista · comparte el código";
        const btn = document.getElementById("btn-start");
        if (btn) btn.disabled = !(st.questions.length > 0);
      },
      onJoin(conn, hello) {
        if (st.started) { // partida en curso: no entrar
          st.host.send(conn, { t: "error", msg: "La partida ya empezó 😅" });
          setTimeout(() => st.host.kick(conn), 600);
          return;
        }
        st.players.set(conn, { name: hello.name, color: hello.color, emoji: hello.emoji, score: 0, answered: false, blocked: false, view: null });
        st.refreshPlayers();
        st.broadcastLobby();
      },
      onData(conn, msg) { st.handleData(conn, msg); },
      onLeave(conn) {
        st.players.delete(conn);
        st.refreshPlayers();
        st.broadcastLobby();
        st.broadcastScores();
      },
      onError(err) {
        if (err.type === "unavailable-id") { // código ocupado, regenerar
          st.code = makeCode(); st.start(name); return;
        }
        toast("Error de conexión: " + err.type);
      }
    });
  },

  playersList() {
    return [...this.players.values()].map(p => ({ name: p.name, color: p.color, emoji: p.emoji, score: p.score, blocked: !!p.blocked }));
  },

  broadcastLobby() {
    this.host.broadcast({ t: "lobby", players: this.playersList(), theme: this.vocaloid });
  },

  /* Teto: cuando TODOS han respondido, pasa sola a la siguiente */
  checkAutoNext() {
    if (!THEMES[this.vocaloid].autoNext || !this.started) return;
    if (this.players.size === 0) return;
    const all = [...this.players.values()].every(p => p.answered);
    if (!all) return;
    clearTimeout(this.autoT);
    this.autoT = setTimeout(() => { if (this.started) this.next(); }, 2500);
  },

  /* ---------- mensajes de jugadores ---------- */
  handleData(conn, msg) {
    if (!msg) return;
    if (msg.t === "view") {   // el jugador reporta su pantalla (para la cámara)
      const p = this.players.get(conn);
      if (p) { p.view = msg; this.renderMon(); }
      return;
    }
    if (msg.t === "answer" && this.started) {
      const p = this.players.get(conn);
      const q = this.questions[this.qIndex];
      if (!p || !q || p.answered || p.blocked || msg.qIndex !== this.qIndex) return;

      // 🔒 modo anti-trampas: sin pantalla compartida no se responde
      if (this.requireScreen && !(p.view && p.view.st === "sharing")) {
        this.host.send(conn, { t: "needscreen" });
        p.answered = true;              // pierde esta pregunta
        this.checkAutoNext();
        return;
      }

      p.answered = true;
      if (p.curCorrect == null) return;
      const ok = msg.choice === p.curCorrect;
      const before = p.score;
      p.score = Math.max(0, p.score + (ok ? 5 : -4));

      let steal = null;
      // Robo: al cruzar cada múltiplo de 15 puntos, roba al líder
      if (Math.floor(p.score / STEAL_EVERY) > Math.floor(before / STEAL_EVERY)) {
        steal = this.doSteal(p);
      }

      this.host.send(conn, { t: "res", ok, gain: ok ? 5 : -4, correct: p.curCorrect, score: p.score, steal });
      this.broadcastScores();
      this.checkAutoNext();

      // ¿alguien llegó a la meta?
      const winner = [...this.players.values()].find(pl => pl.score >= this.settings.target);
      if (winner) this.endGame(winner.name, "meta");
    }
  },

  doSteal(stealer) {
    // víctima = el que más puntos tenga (que no sea el ladrón)
    let victim = null, best = -1;
    this.players.forEach((pl) => {
      if (pl !== stealer && pl.score > best) { best = pl.score; victim = pl; }
    });
    if (!victim || best <= 0) return null;
    const amount = Math.min(STEAL_AMOUNT, victim.score);
    victim.score -= amount;
    stealer.score += amount;
    const event = { stealer: stealer.name, victim: victim.name, amount };
    this.host.broadcast({ t: "steal", ...event });
    logLine(`🔥 ${stealer.name} robó ${amount} pts a ${victim.name}`);
    return event;
  },

  broadcastScores() {
    const list = this.playersList().sort((a, b) => b.score - a.score);
    this.host.broadcast({ t: "scores", scores: list, target: this.settings.target });
    renderHostScores(this, list);
  },

  /* ---------- preguntas ---------- */
  editing: null,   // índice de la pregunta que se está editando
  requireScreen: false,    // 🔒 si es true, sin pantalla compartida no se puede responder
  streams: new Map(),      // nombre -> MediaStream (pantalla del jugador)
  bigView: null,           // nombre del jugador en vista grande
  packs: loadPacks(),      // packs guardados { nombre: {name, questions[]} }
  currentPack: null,       // pack activo (las preguntas se guardan ahí)
  MAX_PACK: 60,            // máximo de preguntas por pack

  savePacks() { try { localStorage.setItem("mikuquiz_packs", JSON.stringify(this.packs)); } catch (e) {} },

  /* cualquier cambio en el editor se sincroniza con el pack activo */
  syncPack() {
    if (this.currentPack && this.packs[this.currentPack]) {
      if (this.packs[this.currentPack].questions.length > this.MAX_PACK)
        this.packs[this.currentPack].questions = this.packs[this.currentPack].questions.slice(0, this.MAX_PACK);
      this.packs[this.currentPack].questions = JSON.parse(JSON.stringify(this.questions));
      this.savePacks();
    }
    renderPackBar(this);
  },

  createPack(name) {
    name = (name || "").trim().slice(0, 30);
    if (!name) return toast("Pon un nombre al pack ✍️");
    if (this.packs[name]) return toast("Ya existe un pack con ese nombre ❌");
    this.packs[name] = { name, questions: JSON.parse(JSON.stringify(this.questions)) };
    this.currentPack = name;
    this.savePacks();
    renderPackBar(this);
    toast("Pack \"" + name + "\" creado 📦");
  },

  loadPack(name) {
    const pk = this.packs[name];
    if (!pk) return;
    this.questions = JSON.parse(JSON.stringify(pk.questions));
    this.currentPack = name;
    this.editing = null;
    renderHostQuestions(this);
    renderPackBar(this);
    clearForm();
    toast("Pack \"" + name + "\" cargado 🎮");
  },

  deletePack(name) {
    delete this.packs[name];
    if (this.currentPack === name) this.currentPack = null;
    this.savePacks();
    renderPackBar(this);
  },

  /* ---------- 🎥 cámara: vigilar, bloquear y dar/quitar puntos ---------- */
  blockPlayer(conn, reason) {
    const p = this.players.get(conn);
    if (!p || p.blocked) return;
    reason = (reason || "").trim() || "inactividad";
    p.blocked = true;
    p.answered = true;                 // no cuenta para la pregunta actual
    this.host.send(conn, { t: "blocked", by: this.me, blocked: true, reason: reason });
    logLine("🚫 " + p.name + " bloqueado por: " + reason);
    this.broadcastScores();
    this.checkAutoNext();
    this.renderMon();
  },
  unblockPlayer(conn) {
    const p = this.players.get(conn);
    if (!p || !p.blocked) return;
    p.blocked = false;
    p.answered = false;
    this.host.send(conn, { t: "blocked", by: this.me, blocked: false });
    logLine("✅ " + p.name + " desbloqueado");
    this.broadcastScores();
    this.renderMon();
  },
  adjustPoints(conn, delta) {
    const p = this.players.get(conn);
    if (!p) return;
    p.score = Math.max(0, p.score + delta);
    this.host.send(conn, { t: "points", delta: delta, score: p.score, by: this.me });
    logLine((delta > 0 ? "➕ +" : "➖ −") + Math.abs(delta) + " pts a " + p.name + " (total " + p.score + ")");
    this.broadcastScores();
    const winner = [...this.players.values()].find(pl => pl.score >= this.settings.target);
    if (winner) this.endGame(winner.name, "meta");
    this.renderMon();
  },
  renderMon() {
    if (document.getElementById("monitor-modal")) renderMonitor(this);
    refreshBigView(this);
  },

  /* 🖥️ llama al jugador para ver su pantalla en vivo */
  watchPlayer(conn, name) {
    if (this.streams.has(name)) { toast("Ya estás viendo la pantalla de " + name); return; }
    try {
      // pista de video real (canvas negro): sin ella el navegador no negocia el video
      const call = this.host.peer.call(conn.peer, makeBlackStream());
      call.on("stream", (remote) => {
        remote.getVideoTracks().forEach(t => t.onended = () => {
          this.streams.delete(name); this.renderMon();
        });
        this.streams.set(name, remote);
        this.renderMon();
      });
      call.on("close", () => { this.streams.delete(name); this.renderMon(); });
      call.on("error", () => { this.streams.delete(name); toast("No se pudo ver la pantalla de " + name); });
      toast("Pidiendo pantalla de " + name + " 🖥️ (el jugador debe aceptar)");
    } catch (e) { toast("No se pudo conectar la videollamada ❌"); }
  },

  addQuestion(text, img, answers, correct) {
    if (this.currentPack && this.packs[this.currentPack]
        && this.packs[this.currentPack].questions.length >= this.MAX_PACK) {
      return toast("El pack llegó al máximo de " + this.MAX_PACK + " preguntas 📦");
    }
    this.questions.push({ text, img: img || DEFAULT_BANNER(), answers, correct });
    this.syncPack();
    renderHostQuestions(this);
    const btn = document.getElementById("btn-start");
    if (btn && this.host) btn.disabled = !(this.questions.length > 0 && !this.started);
  },
  updateQuestion(i, text, img, answers, correct) {
    this.questions[i] = { text, img: img || DEFAULT_BANNER(), answers, correct };
    this.editing = null;
    this.syncPack();
    renderHostQuestions(this);
  },
  removeQuestion(i) {
    this.questions.splice(i, 1);
    if (this.editing === i) this.editing = null;
    this.syncPack();
    renderHostQuestions(this);
  },

  /* ---------- partida ---------- */
  begin() {
    if (this.questions.length === 0) return;
    this.started = true;
    this.qIndex = 0;
    this.timeLeft = this.settings.minutes * 60;
    this.players.forEach(p => p.answered = false);
    this.host.broadcast({ t: "start", target: this.settings.target, theme: this.vocaloid });
    this.sendQuestion();
    renderHostGame(this);
    this.timerId = setInterval(() => {
      this.timeLeft--;
      this.host.broadcast({ t: "tick", left: this.timeLeft });
      const el = document.getElementById("host-timer");
      if (el) { el.textContent = fmtTime(this.timeLeft); el.classList.toggle("low", this.timeLeft <= 30); }
      if (this.timeLeft <= 0) {
        const sorted = this.playersList().sort((a, b) => b.score - a.score);
        this.endGame(sorted.length ? sorted[0].name : "—", "tiempo");
      }
    }, 1000);
  },

  sendQuestion() {
    const q = this.questions[this.qIndex];
    this.players.forEach((p, conn) => {
      p.answered = false;
      const order = shuffleIdx(q.answers.length);       // orden distinto por jugador
      p.curAnswers = order.map(i => q.answers[i]);      // lo que ve este jugador
      p.curCorrect = order.indexOf(q.correct);          // dónde quedó la correcta
      this.host.send(conn, {
        t: "q", index: this.qIndex, total: this.questions.length,
        q: { text: q.text, img: q.img, answers: p.curAnswers }
      });
    });
    renderHostQuestion(this);
  },

  next() {
    if (!this.started) return;
    clearTimeout(this.autoT);
    this.qIndex = (this.qIndex + 1) % this.questions.length; // se repiten
    this.sendQuestion();
    this.broadcastScores();
  },

  endGame(winnerName, reason) {
    if (!this.started && reason !== "meta") { this.cleanup(); goHome(); return; }
    this.started = false;
    clearInterval(this.timerId);
    const sorted = this.playersList().sort((a, b) => b.score - a.score);
    this.host.broadcast({ t: "end", winner: winnerName, reason, scores: sorted });
    renderHostEnd(this, winnerName, reason, sorted);
  },

  cleanup() {
    clearInterval(this.timerId);
    clearTimeout(this.autoT);
    if (this.host) this.host.destroy();
    this.host = null;
    this.players.clear();
  }
};

/* revuelve el orden de las 4 respuestas (Fisher-Yates) */
function shuffleIdx(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================= RENDER (creador) ================= */
function renderHostLobby(st) {
  const saved = loadDraft();
  if (saved) { st.questions = saved.questions || []; st.settings = saved.settings || st.settings; }
  st.pickIndex = 0;

  app().innerHTML = `
  <div class="card">
    <div class="lobby-head">
      <div>
        <h2 class="title">${st.vocaloid === "teto" ? "🥖 Sala Teto de" : "🎤 Sala de"} ${esc(st.me)}</h2>
        <div class="hint">${st.vocaloid === "teto" ? "⚡ Modo Teto: las preguntas avanzan solas cuando todos responden" : "🎵 Modo Miku: tú pasas las preguntas con el botón"}</div>
        <div id="host-status">🟡 Creando sala...</div>
      </div>
      <div style="text-align:center">
        <label style="margin:0">Código de sala</label>
        <div class="code-big">${st.code}</div>
        <button class="btn small secondary" id="btn-copy">📋 Copiar código</button>
      </div>
    </div>

    <h2 class="title" style="margin-top:22px">👥 Jugadores (<span id="host-count">0</span>)</h2>
    <div class="players" id="host-players"></div>

    <div class="q-editor">
      <h2 class="title">📦 Pack de preguntas</h2>
      <div id="pack-bar"></div>
      <div class="row" style="margin:10px 0">
        <button class="btn small" id="btn-new-pack">📦 Crear pack</button>
        <button class="btn small secondary" id="btn-add-pack">📥 Agregar pack</button>
      </div>
      <h2 class="title" style="margin-top:14px">➕ Agregar pregunta</h2>
      <div class="field"><label>Pregunta</label>
        <input id="q-text" placeholder="Ej: ¿En qué año debutó Hatsune Miku? 🎶"></div>
      <div class="field"><label>Imagen / Banner de la pregunta (URL)</label>
        <input id="q-img" placeholder="https://..." value="${DEFAULT_BANNER()}">
        <div class="row" style="margin-top:8px">
          <button class="btn small ghost" id="use-banner">🖼️ Usar banner Miku</button>
          <button class="btn small ghost" id="use-icon">⭐ Usar icon Miku</button>
        </div>
        <img class="q-preview-img hidden" id="q-preview">
        <div class="hint">Pega cualquier URL de imagen, o usa los botones de arriba.</div>
      </div>
      <label>Respuestas (marca la correcta ✅)</label>
      <div class="answers-grid">
        ${[0,1,2,3].map(i=>`
          <div class="answer-row">
            <input id="ans-${i}" placeholder="Respuesta ${i+1}">
            <button class="pick-correct ${i===0?'on':''}" data-i="${i}">✔</button>
          </div>`).join("")}
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="btn-add-q">➕ Agregar pregunta</button>
        <button class="btn ghost hidden" id="btn-cancel-edit">✖ Cancelar edición</button>
      </div>
      <div class="q-list" id="q-list"></div>
    </div>

    <div class="row" style="margin-top:22px">
      <div class="field">
        <label>⏱️ Duración del quiz (minutos)</label>
        <input id="set-min" type="number" min="1" max="120" value="${st.settings.minutes}">
      </div>
      <div class="field">
        <label>🎯 Puntos para ganar (máx ${MAX_TARGET})</label>
        <input id="set-target" type="number" min="5" max="${MAX_TARGET}" value="${st.settings.target}">
      </div>
    </div>
    <div class="hint">✅ Correcta = +5 pts · ❌ Incorrecta = −4 pts y espera 5 s · 🔥 Al llegar a 15 pts robas 4 al líder</div>

    <div class="row" style="margin-top:20px">
      <button class="btn" id="btn-start" disabled>🎮 ¡START!</button>
      <button class="btn danger" id="btn-cancel">✖ Cerrar sala</button>
    </div>
  </div>`;

  // eventos
  document.getElementById("btn-copy").onclick = () => {
    navigator.clipboard?.writeText(st.code);
    toast("¡Código copiado! 📋");
  };
  document.getElementById("use-banner").onclick = () => setQImg(DEFAULT_BANNER());
  document.getElementById("use-icon").onclick = () => setQImg(DEFAULT_ICON());
  function setQImg(url){ document.getElementById("q-img").value = url; previewImg(); }
  function previewImg(){
    const url = document.getElementById("q-img").value.trim();
    const img = document.getElementById("q-preview");
    if (url) { img.src = url; img.classList.remove("hidden"); } else img.classList.add("hidden");
  }
  document.getElementById("q-img").oninput = previewImg;

  document.querySelectorAll(".pick-correct").forEach(b => {
    b.onclick = () => {
      st.pickIndex = +b.dataset.i;
      document.querySelectorAll(".pick-correct").forEach(x => x.classList.toggle("on", +x.dataset.i === st.pickIndex));
      document.querySelectorAll(".answer-row input").forEach((inp, i) => inp.classList.toggle("correct", i === st.pickIndex));
    };
  });

  document.getElementById("btn-add-q").onclick = () => {
    const text = document.getElementById("q-text").value.trim();
    const img = document.getElementById("q-img").value.trim();
    const answers = [0,1,2,3].map(i => document.getElementById("ans-"+i).value.trim());
    if (!text) return toast("Escribe la pregunta ✍️");
    if (answers.some(a => !a)) return toast("Completa las 4 respuestas ✍️");
    if (st.editing != null) {
      const idx = st.editing;
      st.updateQuestion(idx, text, img, answers, st.pickIndex);
      toast("¡Pregunta #" + (idx+1) + " actualizada! 💾");
    } else {
      st.addQuestion(text, img, answers, st.pickIndex);
      toast("¡Pregunta agregada! ➕");
    }
    clearForm();
  };
  document.getElementById("btn-cancel-edit").onclick = () => { clearForm(); toast("Edición cancelada"); };

  document.getElementById("btn-start").onclick = () => {
    const min = Math.max(1, Math.min(120, +document.getElementById("set-min").value || 5));
    const target = Math.max(5, Math.min(MAX_TARGET, +document.getElementById("set-target").value || 100));
    st.settings = { minutes: min, target };
    saveDraft({ questions: st.questions, settings: st.settings });
    st.begin();
  };

  document.getElementById("btn-cancel").onclick = () => {
    st.host && st.host.broadcast({ t: "error", msg: "El creador cerró la sala 👋" });
    st.cleanup(); goHome();
  };

  document.getElementById("btn-new-pack").onclick = () => {
    const name = prompt("Nombre del nuevo pack (máx 60 preguntas):", "Mi pack Miku");
    if (name !== null) st.createPack(name);
  };
  document.getElementById("btn-add-pack").onclick = () => openPackModal(st);
  renderHostQuestions(st);
  renderPackBar(st);
  refreshStartBtn(st);
}

function refreshStartBtn(st) {
  const btn = document.getElementById("btn-start");
  if (btn) btn.disabled = !(st.questions.length > 0 && st.host);
}

f
