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
      const call = this.host.peer.call(conn.peer, new MediaStream());
      call.on("stream", (remote) => {
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

function renderHostPlayers(st) {
  const box = document.getElementById("host-players");
  if (!box) return;
  document.getElementById("host-count").textContent = st.players.size;
  box.innerHTML = [...st.players.values()].map(p => `
    <div class="player-chip"><span class="dot" style="background:${p.color}"></span>
      <span>${p.emoji}</span><b>${esc(p.name)}</b></div>`).join("")
    || `<div class="hint">Esperando jugadores... comparte el código 🎵</div>`;
}
HostGame.refreshPlayers = function(){ renderHostPlayers(this); };

function clearForm() {
  const st = HostGame;
  if (!document.getElementById("q-text")) return;
  document.getElementById("q-text").value = "";
  [0,1,2,3].forEach(i => document.getElementById("ans-"+i).value = "");
  st.editing = null;
  document.getElementById("btn-add-q").textContent = "➕ Agregar pregunta";
  document.getElementById("btn-cancel-edit").classList.add("hidden");
}
function loadIntoForm(q, i) {
  const st = HostGame;
  document.getElementById("q-text").value = q.text;
  document.getElementById("q-img").value = q.img;
  const pv = document.getElementById("q-preview");
  if (pv) { pv.src = q.img; pv.classList.remove("hidden"); }
  [0,1,2,3].forEach(k => document.getElementById("ans-"+k).value = q.answers[k]);
  st.pickIndex = q.correct;
  document.querySelectorAll(".pick-correct").forEach(x => x.classList.toggle("on", +x.dataset.i === q.correct));
  document.querySelectorAll(".answer-row input").forEach((inp, k) => inp.classList.toggle("correct", k === q.correct));
  st.editing = i;
  document.getElementById("btn-add-q").textContent = "💾 Guardar cambios";
  document.getElementById("btn-cancel-edit").classList.remove("hidden");
  document.getElementById("q-text").focus();
  toast("Editando pregunta #" + (i+1) + " ✏️");
}

/* ================= 🎥 CÁMARA DEL CREADOR ================= */
function openMonitor(st) {
  closeMonitor();
  const d = document.createElement("div");
  d.className = "modal-overlay";
  d.id = "monitor-modal";
  d.innerHTML = `<div class="modal-card" style="max-width:780px">
    <h2 class="title">🎥 Cámara · pantallas de los jugadores</h2>
    <div class="hint">Mira en vivo qué responde cada jugador. Toca las tarjetas para bloquear o dar/quitar puntos.</div>
    <button class="btn small ghost" id="btn-req-screen" style="margin-top:10px">🔒 Exigir pantalla para responder: NO</button>
    <div id="monitor-grid"></div>
    <div class="row" style="margin-top:14px"><button class="btn small ghost" id="btn-close-monitor">Cerrar</button></div>
  </div>`;
  document.body.appendChild(d);
  d.querySelector("#btn-close-monitor").onclick = closeMonitor;
  d.onclick = e => { if (e.target === d) closeMonitor(); };
  const rb = d.querySelector("#btn-req-screen");
  rb.textContent = "🔒 Exigir pantalla para responder: " + (st.requireScreen ? "SÍ" : "NO");
  rb.classList.toggle("ghost", !st.requireScreen);
  rb.onclick = () => {
    st.requireScreen = !st.requireScreen;
    rb.textContent = "🔒 Exigir pantalla para responder: " + (st.requireScreen ? "SÍ" : "NO");
    rb.classList.toggle("ghost", !st.requireScreen);
    toast(st.requireScreen
      ? "Modo anti-trampas ON: sin pantalla compartida nadie puede responder 🔒"
      : "Exigencia de pantalla desactivada");
  };
  renderMonitor(st);
}
function closeMonitor() { const m = document.getElementById("monitor-modal"); if (m) m.remove(); }

function viewStatus(p) {
  if (p.blocked) return ["🚫 bloqueado", "m-blocked"];
  if (!p.view || p.view.q == null) return ["⏳ esperando", ""];
  if (p.view.q !== HostGame.qIndex) return ["⏳ esperando", ""];
  if (p.view.st === "sharing") return ["🖥️ compartiendo pantalla", "m-ok"];
  if (p.view.st === "share-ended") return ["🖫 pantalla NO compartida", "m-warn"];
  if (p.view.st === "penalty") return ["⏳ penalización 5s", "m-warn"];
  if (p.view.st === "ok") return ["✅ acertó", "m-ok"];
  if (p.view.st === "picked") return ["✍️ ya eligió", ""];
  if (p.view.st === "wait") return ["⏳ esperando siguiente", ""];
  return ["✍️ respondiendo...", ""];
}

function getViewInfo(st, p) {
  const [stxt, scls] = viewStatus(p);
  const pickedTxt = (p.view && p.view.picked != null && p.curAnswers)
    ? esc(p.curAnswers[p.view.picked]) : "— sin respuesta —";
  return { stxt, scls, pickedTxt };
}

/* helper: bloquear pidiendo motivo */
function blockFlow(st, conn, p) {
  if (p.blocked) { st.unblockPlayer(conn); return; }
  const r = prompt("Motivo del bloqueo para " + p.name + ":\n(lo que escribas se lo mostrará)", "inactividad");
  if (r === null) return;
  st.blockPlayer(conn, r);
}

function renderMonitor(st) {
  const g = document.getElementById("monitor-grid");
  if (!g) return;
  const ps = [...st.players.entries()];
  g.innerHTML = ps.length ? ps.map(([conn, p]) => {
    const inf = getViewInfo(st, p);
    const hasVideo = st.streams.has(p.name);
    return `<div class="mon-card ${p.blocked ? 'mon-blocked' : ''} ${hasVideo ? 'mon-has-video' : ''}">
      <div class="mon-head"><span class="dot" style="background:${p.color}"></span><span>${p.emoji}</span>
        <b>${esc(p.name)}</b><span class="pts">${p.score} pts</span></div>
      <div class="mon-screen">
        <video class="mon-video" data-vid="${esc(p.name)}" autoplay playsinline muted></video>
        <div class="mon-nostream">Sin pantalla compartida<br><span style="font-size:11px">(abajo se ve lo que selecciona)</span></div>
        <div class="hint" style="margin-top:6px">Pregunta ${p.view && p.view.q != null ? p.view.q + 1 : "—"}/${st.questions.length} · selección:</div>
        <div class="mon-answer">${inf.pickedTxt}</div>
        <div class="mon-status ${inf.scls}">${inf.stxt}</div>
      </div>
      <div class="row mon-btns">
        <button class="btn small ghost" data-watch="${esc(p.name)}">${hasVideo ? "🖥️ Viendo" : "🖥️ Pantalla"}</button>
        <button class="btn small ghost" data-big="${esc(p.name)}">🔍 Grande</button>
        <button class="btn small ${p.blocked ? '' : 'danger'}" data-blk="${esc(p.name)}">${p.blocked ? "✅ Desbloquear" : "🚫 Bloquear"}</button>
        <button class="btn small" data-give="${esc(p.name)}">➕ Puntos</button>
        <button class="btn small secondary" data-take="${esc(p.name)}">➖ Quitar</button>
      </div>
    </div>`;
  }).join("") : `<div class="hint">No hay jugadores en la sala.</div>`;

  attachMonStreams();
  const byName = n => ps.find(([, p]) => p.name === n);
  g.querySelectorAll("[data-watch]").forEach(b => b.onclick = () => {
    const found = byName(b.dataset.watch);
    if (found) st.watchPlayer(found[0], found[1].name);
  });
  g.querySelectorAll("[data-big]").forEach(b => b.onclick = () => openBigView(st, b.dataset.big));
  g.querySelectorAll("[data-blk]").forEach(b => b.onclick = () => {
    const found = byName(b.dataset.blk);
    if (found) blockFlow(st, found[0], found[1]);
  });
  g.querySelectorAll("[data-give]").forEach(b => b.onclick = () => {
    const found = byName(b.dataset.give);
    if (found) askPoints(st, found[1], found[0], 1);
  });
  g.querySelectorAll("[data-take]").forEach(b => b.onclick = () => {
    const found = byName(b.dataset.take);
    if (found) askPoints(st, found[1], found[0], -1);
  });
}

/* conecta los videos con las pantallas recibidas */
function attachMonStreams() {
  document.querySelectorAll("video[data-vid]").forEach(v => {
    const s = HostGame.streams.get(v.dataset.vid);
    if (s && v.srcObject !== s) v.srcObject = s;
  });
}

/* ---------- 🔍 vista grande de un jugador ---------- */
function openBigView(st, name) {
  closeBigView();
  st.bigView = name;
  const d = document.createElement("div");
  d.className = "modal-overlay";
  d.id = "bigview-modal";
  d.innerHTML = `<div class="modal-card" style="max-width:920px">
    <h2 class="title">🔍 ${esc(name)} — vista grande</h2>
    <video id="bigvideo" autoplay playsinline muted></video>
    <div id="bigview-nostream" class="hint" style="margin:8px 0">Pulsa "🖥️ Pedir pantalla" para ver en vivo lo que hace (ratón, ventanas...). En celular verás solo lo que selecciona.</div>
    <div id="bigview-info"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn small" id="bv-watch">🖥️ Pedir pantalla</button>
      <button class="btn small ${st.players.size && [...st.players.values()].find(p=>p.name===name)?.blocked ? '' : 'danger'}" id="bv-block">🚫 Bloquear</button>
      <button class="btn small" id="bv-give">➕ Puntos</button>
      <button class="btn small secondary" id="bv-take">➖ Quitar</button>
      <button class="btn small ghost" id="bv-close">Cerrar</button>
    </div></div>`;
  document.body.appendChild(d);
  d.onclick = e => { if (e.target === d) closeBigView(); };
  d.querySelector("#bv-close").onclick = () => { st.bigView = null; closeBigView(); };
  d.querySelector("#bv-watch").onclick = () => {
    const found = [...st.players.entries()].find(([, p]) => p.name === name);
    if (found) st.watchPlayer(found[0], name);
  };
  d.querySelector("#bv-block").onclick = () => {
    const found = [...st.players.entries()].find(([, p]) => p.name === name);
    if (found) blockFlow(st, found[0], found[1]);
  };
  d.querySelector("#bv-give").onclick = () => {
    const found = [...st.players.entries()].find(([, p]) => p.name === name);
    if (found) askPoints(st, found[1], found[0], 1);
  };
  d.querySelector("#bv-take").onclick = () => {
    const found = [...st.players.entries()].find(([, p]) => p.name === name);
    if (found) askPoints(st, found[1], found[0], -1);
  };
  refreshBigView(st);
}
function closeBigView() { const m = document.getElementById("bigview-modal"); if (m) m.remove(); }

function refreshBigView(st) {
  const d = document.getElementById("bigview-modal");
  if (!d || !st.bigView) return;
  const name = st.bigView;
  const found = [...st.players.entries()].find(([, p]) => p.name === name);
  const v = d.querySelector("#bigvideo");
  const s = st.streams.get(name);
  if (s && v && v.srcObject !== s) v.srcObject = s;
  const ns = d.querySelector("#bigview-nostream");
  if (ns) ns.style.display = s ? "none" : "block";
  const info = d.querySelector("#bigview-info");
  if (info && found) {
    const p = found[1];
    const inf = getViewInfo(st, p);
    info.innerHTML = `<div class="hint">Pregunta ${p.view && p.view.q != null ? p.view.q + 1 : "—"}/${st.questions.length} · selección: <b style="color:#eafcff">${inf.pickedTxt}</b> · <span class="mon-status ${inf.scls}">${inf.stxt}</span> · <b style="color:var(--gold)">${p.score} pts</b>${p.blocked ? " · 🚫 bloqueado" : ""}</div>`;
  }
}

function askPoints(st, p, conn, sign) {
  const v = prompt((sign > 0 ? "¿Cuántos puntos DARLE a " : "¿Cuántos puntos QUITARLE a ") + p.name + "?", "5");
  if (v === null) return;
  const n = Math.max(0, Math.min(500, parseInt(v) || 0));
  if (n) st.adjustPoints(conn, sign * n);
}

function loadPacks() {
  try { return JSON.parse(localStorage.getItem("mikuquiz_packs") || "{}"); } catch (e) { return {}; }
}

function renderPackBar(st) {
  const el = document.getElementById("pack-bar");
  if (!el) return;
  if (st.currentPack && st.packs[st.currentPack]) {
    const pk = st.packs[st.currentPack];
    el.innerHTML = `<div class="pack-active">📦 <b>${esc(pk.name)}</b> · ${pk.questions.length}/${st.MAX_PACK} preguntas
      <button class="btn small ghost" id="btn-close-pack">Salir del pack</button></div>`;
    el.querySelector("#btn-close-pack").onclick = () => {
      st.currentPack = null;
      renderPackBar(st);
      toast("Pack cerrado (las preguntas siguen en el editor)");
    };
  } else {
    el.innerHTML = `<div class="hint">Sin pack activo: las preguntas se guardan solo en el borrador. Crea un pack para guardarlas, jugarlas y descargarlas.</div>`;
  }
}

/* ---------- modal: agregar pack (cargar / descargar / borrar / importar) ---------- */
function openPackModal(st) {
  closePackModal();
  const d = document.createElement("div");
  d.className = "modal-overlay";
  d.id = "pack-modal";
  d.innerHTML = `<div class="modal-card">
    <h2 class="title">📥 Agregar pack</h2>
    <div id="pack-modal-list"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn small" id="btn-import-pack">📂 Importar archivo .json</button>
      <button class="btn small ghost" id="btn-close-modal">Cerrar</button>
    </div>
    <input type="file" id="pack-file" accept=".json,application/json" style="display:none">
    <div class="hint">Usa "🎮 Jugar" para poner las preguntas del pack en la partida, o "📥 Descargar" para guardar el archivo y compartirlo.</div>
  </div>`;
  document.body.appendChild(d);
  renderPackModalList(st);
  d.querySelector("#btn-close-modal").onclick = closePackModal;
  d.onclick = e => { if (e.target === d) closePackModal(); };
  d.querySelector("#btn-import-pack").onclick = () => d.querySelector("#pack-file").click();
  d.querySelector("#pack-file").onchange = e => { if (e.target.files[0]) importPackFile(e.target.files[0]); };
}
function closePackModal() { const m = document.getElementById("pack-modal"); if (m) m.remove(); }

function renderPackModalList(st) {
  const box = document.getElementById("pack-modal-list");
  if (!box) return;
  const names = Object.keys(st.packs);
  box.innerHTML = names.length ? names.map(n => {
    const pk = st.packs[n];
    return `<div class="pack-row">
      <div style="flex:1;min-width:120px"><b>${esc(pk.name)}</b><div class="hint">${pk.questions.length}/${st.MAX_PACK} preguntas</div></div>
      <button class="btn small" data-load="${esc(n)}">🎮 Jugar</button>
      <button class="btn small secondary" data-dl="${esc(n)}">📥 Descargar</button>
      <button class="btn small danger" data-del="${esc(n)}">🗑️</button>
    </div>`;
  }).join("") : `<div class="hint">No tienes packs guardados todavía. Crea uno con "📦 Crear pack".</div>`;
  box.querySelectorAll("[data-load]").forEach(b => b.onclick = () => { st.loadPack(b.dataset.load); closePackModal(); });
  box.querySelectorAll("[data-dl]").forEach(b => b.onclick = () => downloadPack(b.dataset.dl));
  box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    if (confirm("¿Borrar el pack \"" + b.dataset.del + "\"?")) { st.deletePack(b.dataset.del); renderPackModalList(st); }
  });
}

/* descarga el pack como archivo .json */
function downloadPack(name) {
  const pk = HostGame.packs[name];
  if (!pk) return;
  const blob = new Blob([JSON.stringify({ app: "MikuQuiz", name: pk.name, questions: pk.questions }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = pk.name.replace(/[^\wáéíóúñüÁÉÍÓÚÑÜ -]/gi, "").trim().replace(/\s+/g, "-") + ".mikuquiz.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Pack descargado 📥");
}

/* importa un pack desde un archivo descargado */
function importPackFile(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.questions) || !d.questions.length) throw 0;
      const name = String(d.name || "Pack importado").slice(0, 30);
      HostGame.packs[name] = { name, questions: d.questions.slice(0, HostGame.MAX_PACK) };
      HostGame.savePacks();
      renderPackModalList(HostGame);
      renderPackBar(HostGame);
      toast("Pack \"" + name + "\" importado 📦");
    } catch (e) { toast("Archivo no válido ❌"); }
  };
  r.readAsText(file);
}

function renderHostQuestions(st) {
  const list = document.getElementById("q-list");
  if (!list) return;
  list.innerHTML = st.questions.map((q, i) => `
    <div class="q-item">
      <img src="${esc(q.img)}" onerror="this.src='${DEFAULT_ICON()}'">
      <span><b>#${i+1}</b> · ${esc(q.text)}</span>
      <button data-e="${i}" title="Editar">✏️</button>
      <button data-d="${i}" title="Eliminar">🗑️</button>
    </div>`).join("");
  list.querySelectorAll("[data-e]").forEach(b => b.onclick = () => loadIntoForm(st.questions[+b.dataset.e], +b.dataset.e));
  list.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { st.removeQuestion(+b.dataset.d); clearForm(); });
  refreshStartBtn(st);
}

/* ---------- vista de juego del creador ---------- */
function renderHostGame(st) {
  app().innerHTML = `
  <div class="card">
    <div class="game-top">
      <div><h2 class="title" style="margin:0">🎤 Sala ${st.code}</h2>
        <div class="hint">Pregunta <span id="host-qnum"></span> · se repiten en bucle 🔁</div></div>
      <div class="timer" id="host-timer">${fmtTime(st.timeLeft)}</div>
    </div>
    <div id="host-q"></div>
    <div class="host-grid" style="margin-top:18px">
      <div>
        <h2 class="title">📊 Puntajes en vivo</h2>
        <div class="scoreboard" id="host-scores"></div>
      </div>
      <div>
        <h2 class="title">🎛️ Controles</h2>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn" id="btn-monitor">🎥 Cámara (jugadores)</button>
          <button class="btn" id="btn-next">⏭️ Siguiente pregunta</button>
          <button class="btn danger" id="btn-end">🏁 Terminar partida</button>
        </div>
        <div class="log" id="host-log"></div>
      </div>
    </div>
  </div>`;
  document.getElementById("btn-next").onclick = () => st.next();
  document.getElementById("btn-monitor").onclick = () => openMonitor(st);
  document.getElementById("btn-end").onclick = () => {
    const sorted = st.playersList().sort((a,b)=>b.score-a.score);
    st.endGame(sorted.length ? sorted[0].name : "—", "manual");
  };
}

function renderHostQuestion(st) {
  const q = st.questions[st.qIndex];
  const el = document.getElementById("host-q");
  if (!el) return;
  document.getElementById("host-qnum").textContent = `${st.qIndex+1}/${st.questions.length}`;
  el.innerHTML = `
    <div class="q-card">
      <img class="q-img" src="${esc(q.img)}" onerror="this.src='${DEFAULT_BANNER()}'">
      <div class="q-text">${esc(q.text)}</div>
      ${q.answers.map((a,i)=>`<button class="opt ${i===q.correct?'right':''}" disabled>${esc(a)} ${i===q.correct?'✅':''}</button>`).join("")}
    </div>`;
}

function renderHostScores(st, list) {
  const box = document.getElementById("host-scores");
  if (!box) return;
  const leader = list.length ? list[0].name : null;
  box.innerHTML = list.map(p => {
    const isLeader = p.name === leader && p.score > 0;
    const won = p.score >= st.settings.target;
    return `<div class="sb-row ${isLeader?'leader':''}">
      <span class="dot" style="background:${p.color}"></span><span>${p.emoji}</span>
      <b>${esc(p.name)}</b>
      ${p.blocked?'<span class="badge first" style="background:#ff6b6b">🚫</span>':''}
      ${won?'<span class="badge win">🏆 GANÓ</span>':isLeader?'<span class="badge first">👈 va en 1er lugar</span>':''}
      <span class="pts">${p.score} pts</span></div>`;
  }).join("") || `<div class="hint">Sin jugadores aún</div>`;
}

function renderHostEnd(st, winner, reason, scores) {
  app().innerHTML = `
  <div class="card end-box">
    <div class="trophy">🏆</div>
    <h1>${esc(winner)} ${reason==='meta' ? 'llegó a la meta 🎯' : reason==='tiempo' ? 'ganó por tiempo ⏱️' : 'es el ganador 🎉'}</h1>
    <div class="scoreboard" style="max-width:420px;margin:18px auto;text-align:left">
      ${scores.map((p,i)=>`<div class="sb-row ${i===0?'leader':''}">
        <span>${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎵'}</span>
        <span class="dot" style="background:${p.color}"></span><span>${p.emoji}</span>
        <b>${esc(p.name)}</b><span class="pts">${p.score} pts</span></div>`).join("")}
    </div>
    <div class="row" style="max-width:420px;margin:0 auto">
      <button class="btn" id="btn-again">🔄 Nueva sala</button>
      <button class="btn ghost" id="btn-home">🏠 Inicio</button>
    </div>
  </div>`;
  document.getElementById("btn-again").onclick = () => { st.cleanup(); startHostFlow(); };
  document.getElementById("btn-home").onclick = () => { st.cleanup(); goHome(); };
}

/* ---------- helpers ---------- */
function fmtTime(s){ const m=Math.floor(s/60),ss=s%60; return `${m}:${String(ss).padStart(2,"0")}`; }
function esc(s){ return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function app(){ return document.getElementById("app"); }
function toast(msg){ const t=document.createElement("div"); t.className="steal-toast"; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2600); }
function logLine(msg){ const log=document.getElementById("host-log"); if(log){ const d=document.createElement("div");
  d.textContent=msg; log.prepend(d); } }
function saveDraft(d){ try{ localStorage.setItem("mikuquiz_draft", JSON.stringify(d)); }catch(e){} }
function loadDraft(){ try{ return JSON.parse(localStorage.getItem("mikuquiz_draft")||"null"); }catch(e){ return null; } }
