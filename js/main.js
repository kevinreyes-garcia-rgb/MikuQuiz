/* =========================================================
   MikuQuiz · js/main.js — router + pantalla de inicio
   ========================================================= */

function goHome() {
  PlayerGame.destroy();
  renderHome();
}

function renderHome() {
  app().innerHTML = `
  <div class="hero">
    <img class="icon" src="https://i.ibb.co/SDB1rP4W/images-4.jpg" alt="Miku">
    <h1>MikuQuiz</h1>
    <p>🎤 El quizlet multijugador con temática de Hatsune Miku 🎵</p>
    <img class="banner" src="https://i.ibb.co/0pSkf5WP/images-3.jpg" alt="Hatsune Miku">
  </div>
  <div class="menu">
    <button class="btn" id="btn-create">🎤 Iniciar partida</button>
    <button class="btn secondary" id="btn-join">🎮 Unirse a partida</button>
  </div>
  <div class="card howto" style="max-width:640px;margin:30px auto 0">
    <h3>📖 ¿Cómo funciona?</h3>
    <ul>
      <li>El <b>creador</b> inicia partida, agrega sus preguntas con imagen/banner, elige la respuesta correcta y comparte el <b>código</b>.</li>
      <li>Los jugadores se unen con el código, ponen su <b>nombre personalizable</b> (color + emoji) y esperan el <b>START</b> del creador.</li>
      <li> Correcta <b>+5 pts</b> ·  Incorrecta <b>−4 pts</b> y esperas <b>5 segundos</b>.</li>
      <li> Al conseguir <b>15 puntos</b> robas <b>4 pts</b> al jugador que va en primer lugar.</li>
      <li> Gana quien llegue primero a los puntos meta (máx 9000) o el mejor cuando se acabe el tiempo. ¡Las preguntas se repiten! </li>
    </ul>
  </div>`;

  document.getElementById("btn-create").onclick = startHostFlow;
  document.getElementById("btn-join").onclick = () => renderJoinForm("");
}

/* nombre del creador antes de crear la sala */
function startHostFlow() {
  const saved = loadDraft();
  app().innerHTML = `
  <div class="card" style="max-width:460px;margin:40px auto">
    <h2 class="title">🎤 Crear sala</h2>
    <div class="field"><label>Nombre del creador</label>
      <input id="host-name" placeholder="Ej: Chizu" maxlength="16"></div>
    ${saved && saved.questions && saved.questions.length ? `
      <div class="hint" style="margin:8px 0">💾 Tienes ${saved.questions.length} preguntas guardadas de antes, se cargarán automáticamente.</div>` : ""}
    <button class="btn" id="btn-go" style="width:100%;margin-top:14px">✨ Crear sala</button>
    <button class="btn ghost" id="btn-back" style="width:100%;margin-top:10px">← Volver</button>
  </div>`;
  document.getElementById("btn-go").onclick = () => {
    const n = document.getElementById("host-name").value.trim();
    if (!n) return toast("Pon tu nombre ");
    HostGame.start(n);
  };
  document.getElementById("btn-back").onclick = goHome;
}

/* ---------- decoración: notas musicales flotantes ---------- */
(function floatingNotes(){
  const box = document.getElementById("bg-notes");
  const notes = ["♪","♫","♬","🎵","🎶","❄️","🌸"];
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("span");
    s.textContent = notes[i % notes.length];
    s.style.left = Math.random() * 100 + "vw";
    s.style.animationDuration = (12 + Math.random() * 18) + "s";
    s.style.animationDelay = (-Math.random() * 20) + "s";
    s.style.fontSize = (14 + Math.random() * 22) + "px";
    box.appendChild(s);
  }
})();

renderHome();
