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
        st.players.set(conn, { name: hello.name, color: hello.color, emoji: hello.emoji, score: 0, answered: false });
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
    return [...this.players.values()].map(p => ({ name: p.name, color: p.color, emoji: p.emoji, score: p.score }));
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
    if (msg.t === "answer" && this.started) {
      const p = this.players.get(conn);
      const q = this.questions[this.qIndex];
      if (!p || !q || p.answered || msg.qIndex !== this.qIndex) return;

      p.answered = true;
      const ok = msg.choice === q.correct;
      const before = p.score;
      p.score = Math.max(0, p.score + (ok ? 5 : -4));

      let steal = null;
      // Robo: al cruzar cada múltiplo de 15 puntos, roba al líder
      if (Math.floor(p.score / STEAL_EVERY) > Math.floor(before / STEAL_EVERY)) {
        steal = this.doSteal(p);
      }

      this.host.send(conn, { t: "res", ok, gain: ok ? 5 : -4, correct: q.correct, score: p.score, steal });
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
  addQuestion(text, img, answers, correct) {
    this.questions.push({ text, img: img || DEFAULT_BANNER(), answers, correct });
    renderHostQuestions(this);
    const btn = document.getElementById("btn-start");
    if (btn && this.host) btn.disabled = !(this.questions.length > 0 && !this.started);
  },
  removeQuestion(i) {
    this.questions.splice(i, 1);
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
    this.players.forEach(p => p.answered = false);
    this.host.broadcast({
      t: "q", index: this.qIndex, total: this.questions.length,
      q: { text: q.text, img: q.img, answers: q.answers }
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
      <h2 class="title">➕ Agregar pregunta</h2>
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
    st.addQuestion(text, img, answers, st.pickIndex);
    document.getElementById("q-text").value = "";
    [0,1,2,3].forEach(i => document.getElementById("ans-"+i).value = "");
    toast("¡Pregunta agregada! ➕");
  };

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

  renderHostQuestions(st);
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

function renderHostQuestions(st) {
  const list = document.getElementById("q-list");
  if (!list) return;
  list.innerHTML = st.questions.map((q, i) => `
    <div class="q-item">
      <img src="${esc(q.img)}" onerror="this.src='${DEFAULT_ICON()}'">
      <span><b>#${i+1}</b> · ${esc(q.text)}</span>
      <button data-i="${i}" title="Eliminar">🗑️</button>
    </div>`).join("");
  list.querySelectorAll("button").forEach(b => b.onclick = () => st.removeQuestion(+b.dataset.i));
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
          <button class="btn" id="btn-next">⏭️ Siguiente pregunta</button>
          <button class="btn danger" id="btn-end">🏁 Terminar partida</button>
        </div>
        <div class="log" id="host-log"></div>
      </div>
    </div>
  </div>`;
  document.getElementById("btn-next").onclick = () => st.next();
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
