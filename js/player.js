/* =========================================================
   MikuQuiz · js/player.js  (vista del JUGADOR que se une)
   - Pide código + nombre personalizable (color y emoji)
   - Espera en lobby hasta que el creador dé START
   - Responde: +5 acierto, −4 fallo + penalización 5 s
   - Ve puntajes, robos y el resultado final
   ========================================================= */

const PlayerGame = {
  client: null,
  me: { name: "", color: "#39C5BB", emoji: "🎤" },
  scores: [],
  target: 100,
  qIndex: -1,
  total: 0,
  answered: false,
  myScore: 0,
  blocked: false,
  stream: null,        // pantalla compartida (video)
  pendingCall: null,   // llamada del creador esperando aceptación

  join(code) {
    const st = this;
    this.client = new Client(code, {
      onOpen() {
        document.getElementById("join-status").textContent = "🟢 Conectado · esperando al creador...";
        st.client.send({ t: "join", name: st.me.name, color: st.me.color, emoji: st.me.emoji });
      },
      onData(m) { st.handle(m); },
      onClose() {
        const e = document.getElementById("player-view");
        if (e) e.innerHTML = `<div class="card end-box"><h1>🔌 Desconectado</h1>
          <p style="color:#bfe9e5;margin:12px 0">El creador cerró la sala o perdió conexión.</p>
          <button class="btn" onclick="goHome()">🏠 Volver al inicio</button></div>`;
      },
      onError(err) {
        const s = document.getElementById("join-status");
        if (s) { s.textContent = "❌ No se encontró la sala. Revisa el código."; s.style.color = "#ff6b6b"; }
      }
    });
  },

  handle(m) {
    switch (m.t) {
      case "lobby":
        if (m.theme) applyTheme(m.theme);
        renderPlayerLobby(m.players);
        break;
      case "start":
        if (m.theme) applyTheme(m.theme);
        this.target = m.target;
        renderPlayerGameShell();
        break;
      case "q":
        this.qIndex = m.index; this.total = m.total; this.answered = false;
        renderPlayerQuestion(m);
        this.sendView("answering", null);
        break;
      case "res": {
        this.myScore = m.score;
        renderPlayerResult(m);
        break;
      }
      case "steal":
        renderStealToast(m);
        break;
      case "scores":
        this.scores = m.scores; this.target = m.target;
        renderPlayerScores(m.scores, m.target);
        break;
      case "tick": {
        const el = document.getElementById("p-timer");
        if (el) { el.textContent = fmtTime(m.left); el.classList.toggle("low", m.left <= 30); }
        break;
      }
      case "end":
        renderPlayerEnd(m);
        break;
      case "blocked":
        this.applyBlocked(m);
        break;
      case "needscreen":
        toast("🔒 El creador exige pantalla compartida para responder. Pulsa 🖥️ Cámara anti-trampas");
        break;
      case "points":
        this.myScore = m.score;
        const ps = document.getElementById("p-score");
        if (ps) ps.textContent = m.score;
        toast((m.delta > 0 ? "➕ +" : "➖ −") + Math.abs(m.delta) + " pts de " + m.by + " (total " + m.score + ")");
        break;
      case "error":
        alert(m.msg);
        this.client.destroy(); goHome();
        break;
    }
  },

  answer(choice) {
    if (this.blocked || this.answered) return;
    this.answered = true;
    this.client.send({ t: "answer", qIndex: this.qIndex, choice });
  },

  /* avisa al creador lo que ve/hace este jugador (para la cámara) */
  sendView(st, picked) {
    this.client.send({ t: "view", q: this.qIndex, picked: picked == null ? null : picked, st: st });
  },

  applyBlocked(m) {
    this.blocked = m.blocked;
    let o = document.getElementById("blocked-overlay");
    if (m.blocked) {
      if (!o) {
        o = document.createElement("div");
        o.className = "blocked-overlay";
        o.id = "blocked-overlay";
        document.body.appendChild(o);
      }
      const motive = m.reason ? "te bloqueó por " + m.reason : "te ha bloqueado por inactivo";
      o.innerHTML = `<div class="blocked-icon">🚫</div>
        <div class="blocked-msg">${esc(m.by)} ${esc(motive)}</div>
        <div class="blocked-sub">Ya no puedes responder.<br>Espera a que el creador te desbloquee...</div>`;
    } else if (o) {
      o.remove();
      toast("Has sido desbloqueado ✅");
    }
  },

  destroy() {
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.client) { this.client.destroy(); this.client = null; }
  }
};

/* ---------- renders ---------- */
const EMOJIS = ["🎤","🎵","🌸","💙","🦋","⭐","🍜","🎮","🎧","🌊"];

function renderJoinForm(code) {
  app().innerHTML = `
  <div class="card" style="max-width:460px;margin:30px auto">
    <h2 class="title">🎮 Unirse a partida</h2>
    <div class="field"><label>Código de sala</label>
      <input id="join-code" placeholder="Ej: K7Q2M" value="${esc(code||"")}" style="text-transform:uppercase"></div>
    <div class="field"><label>Tu nombre</label>
      <input id="join-name" placeholder="Ej: MikuFan2007" maxlength="16"></div>
    <div class="field"><label>Tu color</label>
      <input id="join-color" type="color" value="#39C5BB" style="height:46px;padding:4px"></div>
    <div class="field"><label>Tu emoji</label>
      <div class="emoji-pick" id="emoji-pick">
        ${EMOJIS.map((e,i)=>`<button class="${i===0?'on':''}" data-e="${e}">${e}</button>`).join("")}
      </div></div>
    <div class="hint" style="margin-top:10px">🖥️ Esta sala es <b>anti-trampas</b>: el creador puede pedirte compartir tu pantalla para jugar (se ve solo durante la partida y lo puedes detener al salir).</div>
    <div id="join-status" class="hint" style="margin:14px 0">🟡 Escribe tus datos y entra 🎵</div>
    <button class="btn" id="btn-join" style="width:100%">🚪 Entrar y acepto la cámara anti-trampas 🖥️</button>
    <button class="btn ghost" id="btn-back" style="width:100%;margin-top:10px">← Volver</button>
  </div>`;

  let emoji = EMOJIS[0];
  document.querySelectorAll("#emoji-pick button").forEach(b => b.onclick = () => {
    emoji = b.dataset.e;
    document.querySelectorAll("#emoji-pick button").forEach(x => x.classList.toggle("on", x === b));
  });

  document.getElementById("btn-join").onclick = () => {
    const c = document.getElementById("join-code").value.trim().toUpperCase();
    const n = document.getElementById("join-name").value.trim();
    if (!c) return toast("Pon el código de sala 🔑");
    if (!n) return toast("Pon tu nombre ✍️");
    PlayerGame.me = { name: n, color: document.getElementById("join-color").value, emoji };
    renderPlayerWaiting();
    PlayerGame.join(c);
  };
  document.getElementById("btn-back").onclick = goHome;
}

function renderPlayerWaiting() {
  app().innerHTML = `
  <div id="player-view"><div class="card" style="max-width:560px;margin:40px auto;text-align:center">
    <h2 class="title">🎧 ${esc(PlayerGame.me.emoji)} ${esc(PlayerGame.me.name)}</h2>
    <div id="join-status" style="margin:10px 0;color:#bfe9e5">🟡 Conectando...</div>
    <h2 class="title" style="margin-top:20px">👥 En la sala</h2>
    <div class="players" id="p-lobby"></div>
    <p class="hint" style="margin-top:16px">El creador inicia la partida cuando quiera... 🎵</p>
  </div></div>`;
}

function renderPlayerLobby(players) {
  const box = document.getElementById("p-lobby");
  if (!box) return;
  box.innerHTML = players.map(p => `
    <div class="player-chip"><span class="dot" style="background:${p.color}"></span>
      <span>${p.emoji}</span><b>${esc(p.name)}</b></div>`).join("");
}

function renderPlayerGameShell() {
  document.getElementById("player-view").innerHTML = `
  <div class="card">
    <div class="game-top">
      <div class="my-score">⭐ <span id="p-score">0</span> pts</div>
      <div class="timer" id="p-timer">--:--</div>
      <div class="hint" id="p-qnum"></div>
      <button class="btn small ghost" id="btn-share">🖥️ Cámara anti-trampas (compartir pantalla)</button>
    </div>
    <div class="steal-toast hidden" id="p-steal"></div>
    <div id="p-q"></div>
    <h2 class="title" style="margin-top:20px">📊 Mi puntaje</h2>
    <div class="scoreboard" id="p-scores"></div>
  </div>`;
}

document.addEventListener("click", e => {
  if (e.target && e.target.id === "btn-share") PlayerGame.startShare();
});

function renderPlayerQuestion(m) {
  const q = m.q;
  const el = document.getElementById("p-q");
  if (!el) return;
  document.getElementById("p-qnum").textContent = `Pregunta ${m.index+1}/${m.total}`;
  document.getElementById("p-steal").classList.add("hidden");
  el.innerHTML = `
    <div class="q-card">
      <img class="q-img" src="${esc(q.img)}" onerror="this.src='${themeIcon()}'">
      <div class="q-text">${esc(q.text)}</div>
      ${q.answers.map((a,i)=>`<button class="opt" data-i="${i}">${esc(a)}</button>`).join("")}
      <div class="feedback" id="p-feedback"></div>
    </div>`;
  el.querySelectorAll(".opt").forEach(b => b.onclick = () => {
    el.querySelectorAll(".opt").forEach(x => x.disabled = true);
    b.classList.add("wrong");
    PlayerGame.answer(+b.dataset.i);
    PlayerGame.sendView("picked", +b.dataset.i);
  });
}

function renderPlayerResult(m) {
  const fb = document.getElementById("p-feedback");
  const el = document.getElementById("p-q");
  if (!fb || !el) return;
  document.getElementById("p-score").textContent = m.score;

  el.querySelectorAll(".opt").forEach((b,i) => {
    b.disabled = true;
    if (i === m.correct) b.classList.add("right");
  });

  if (m.ok) {
    fb.className = "feedback good";
    fb.textContent = `✅ ¡Correcto! +5 pts (total ${m.score})`;
    PlayerGame.sendView("ok", null);
  } else {
    fb.className = "feedback bad";
    fb.textContent = `❌ Incorrecto · −4 pts (total ${m.score})`;
    PlayerGame.sendView("penalty", null);
    // penalización: esperar 5 segundos antes de poder seguir
    showPenalty();
    setTimeout(() => PlayerGame.sendView("wait", null), 5000);
  }
}

function showPenalty() {
  const d = document.createElement("div");
  d.className = "penalty";
  d.innerHTML = `<div style="font-size:22px;font-weight:800">⏳ ¡Incorrecto! Espera 5 segundos...</div>
    <div class="num">5</div><div style="color:#bfe9e5">Prepárate para la siguiente pregunta 🎵</div>`;
  document.body.appendChild(d);
  let n = 5;
  const iv = setInterval(() => {
    n--;
    const num = d.querySelector(".num");
    if (num) num.textContent = n;
    if (n <= 0) { clearInterval(iv); d.remove(); }
  }, 1000);
}

function renderStealToast(m) {
  const t = document.getElementById("p-steal");
  if (!t) return;
  t.classList.remove("hidden");
  t.textContent = `🔥 ¡${m.stealer} robó ${m.amount} pts a ${m.victim}!`;
  setTimeout(() => t.classList.add("hidden"), 5000);
}

function renderPlayerScores(scores, target) {
  const box = document.getElementById("p-scores");
  if (!box) return;
  // privacidad: cada jugador solo ve sus propios puntos
  const mine = scores.filter(p => p.name === PlayerGame.me.name);
  const won = mine.length && mine[0].score >= target;
  box.innerHTML = mine.map(p => `<div class="sb-row ${won?'leader':''}">
      <span class="dot" style="background:${p.color}"></span><span>${p.emoji}</span>
      <b>${esc(p.name)}</b>
      ${won?'<span class="badge win">🏆 ¡LLEGASTE A LA META!</span>':''}
      <span class="pts">${p.score} pts</span></div>`).join("")
    || `<div class="hint">Aún no tienes puntos — ¡responde! 🎵</div>`;
}

function renderPlayerEnd(m) {
  const iWon = m.winner === PlayerGame.me.name;
  document.getElementById("player-view").innerHTML = `
  <div class="card end-box">
    <div class="trophy">${iWon ? "🏆" : "🎵"}</div>
    <h1>${iWon ? "¡GANASTE!" : esc(m.winner) + " ganó"}</h1>
    <p style="color:#bfe9e5">${m.reason==='meta' ? '🎯 Llegó a la meta de puntos' : m.reason==='tiempo' ? '⏱️ Se acabó el tiempo' : '🏁 El creador terminó la partida'}</p>
    <div class="scoreboard" style="max-width:420px;margin:18px auto;text-align:left">
      ${m.scores.map((p,i)=>`<div class="sb-row ${i===0?'leader':''}">
        <span>${i===0?'🥇':i===1?'🥈':i===2?'🥉':'🎵'}</span>
        <span class="dot" style="background:${p.color}"></span><span>${p.emoji}</span>
        <b>${esc(p.name)}</b><span class="pts">${p.score} pts</span></div>`).join("")}
    </div>
    <button class="btn" onclick="goHome()" style="max-width:300px;margin:0 auto">🏠 Volver al inicio</button>
  </div>`;
}
