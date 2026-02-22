// OFN IRP — Client (Tier B: one seat per IP session, server authoritative role)

const CONFIG = {
  POLL_MS: 1500,
  HEARTBEAT_MS: 25000,
};

const $ = (id) => document.getElementById(id);

const ui = {
  pillConn: $("pillConn"),
  pillRole: $("pillRole"),
  pillSeat: $("pillSeat"),

  systemVoice: $("systemVoice"),

  cardAuth: $("cardAuth"),
  pw: $("pw"),
  btnAuth: $("btnAuth"),
  authErr: $("authErr"),

  cardSeat: $("cardSeat"),
  seatHint: $("seatHint"),
  seatSelect: $("seatSelect"),
  seatMeta: $("seatMeta"),
  btnSeat: $("btnSeat"),
  btnRelease: $("btnRelease"),
  seatErr: $("seatErr"),

  cardEnter: $("cardEnter"),
  btnEnter: $("btnEnter"),

  workspace: $("workspace"),
  clock: $("clock"),

  resTitle: $("resTitle"),
  resSummary: $("resSummary"),
  resBody: $("resBody"),
  voteSub: $("voteSub"),
  elapsed: $("elapsed"),

  memberActions: $("memberActions"),
  observerActions: $("observerActions"),
  voteLockNote: $("voteLockNote"),
  btnAye: $("btnAye"),
  btnNay: $("btnNay"),
  btnAbs: $("btnAbs"),

  ledgerList: $("ledgerList"),
  ledgerSub: $("ledgerSub"),
  cAye: $("cAye"),
  cNay: $("cNay"),
  cAbs: $("cAbs"),
  cTot: $("cTot"),

  chamberCanvas: $("chamberCanvas"),

  presidencyTile: $("presidencyTile"),
  voteStatePill: $("voteStatePill"),
  pTitle: $("pTitle"),
  pSummary: $("pSummary"),
  pBody: $("pBody"),
  btnStart: $("btnStart"),
  btnEnd: $("btnEnd"),
  presErr: $("presErr"),

  buildInfo: $("buildInfo"),
};

const state = {
  token: null,
  role: null,             // set by server
  seatId: null,           // integer for members
  seatSessionToken: null, // returned by server
  timeOffsetMs: 0,

  seatCount: 0,
  activeResolution: { status: "idle" },
  pollTimer: null,
  hbTimer: null,
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function speak(line, emphasis = false) {
  const div = document.createElement("div");
  div.className = "voiceLine";
  div.innerHTML = emphasis ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line);
  ui.systemVoice.appendChild(div);
  ui.systemVoice.scrollTop = ui.systemVoice.scrollHeight;
}

function setPill(el, label, value) {
  el.innerHTML = `${label}: <span class="muted">${escapeHtml(value)}</span>`;
}

function setError(el, msg) {
  el.hidden = !msg;
  if (msg) el.textContent = msg;
}

function nowMs() {
  return Date.now() + state.timeOffsetMs;
}

function fmtElapsed(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function setAuthMode(on) {
  document.body.classList.toggle("authMode", !!on);
}

function apiUrl(action) {
  const u = new URL("/.netlify/functions/ofn", window.location.origin);
  u.searchParams.set("action", action);
  return u.toString();
}

async function api(action, payload = {}) {
  const res = await fetch(apiUrl(action), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: state.token,
      seat_id: state.seatId,
      seat_session_token: state.seatSessionToken,
      ...payload,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ----- UI flow -----
function showAuth() {
  setAuthMode(true);
  ui.cardAuth.hidden = false;
  ui.cardSeat.hidden = true;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showSeat() {
  setAuthMode(true);
  ui.cardAuth.hidden = true;
  ui.cardSeat.hidden = false;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showEnter() {
  setAuthMode(true);
  ui.cardAuth.hidden = true;
  ui.cardSeat.hidden = true;
  ui.cardEnter.hidden = false;
  ui.workspace.hidden = true;
}

function enterDesktop() {
  setAuthMode(false);
  ui.workspace.hidden = false;
  ui.cardAuth.hidden = true;
  ui.cardSeat.hidden = true;
  ui.cardEnter.hidden = true;

  startPolling();
  startHeartbeat();
}

// ----- Seat select -----
function fillSeatList(count) {
  ui.seatSelect.innerHTML = "";
  for (let i = 1; i <= count; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Seat ${String(i).padStart(3, "0")}`;
    ui.seatSelect.appendChild(opt);
  }
}

async function handleAuth() {
  setError(ui.authErr, "");
  const pw = ui.pw.value.trim();
  if (!pw) {
    setError(ui.authErr, "Enter an access phrase.");
    return;
  }

  state.token = pw;

  speak("Verifying credentials…");

  const ping = await api("ping", {});
  state.role = ping.role;
  state.timeOffsetMs = (ping.serverNowMs - Date.now()) || 0;
  state.seatCount = ping.seatCount || 0;

  setPill(ui.pillConn, "LINK", "secure");
  setPill(ui.pillRole, "ROLE", state.role.toUpperCase());

  if (state.role === "presidency") {
    state.seatId = null;
    state.seatSessionToken = null;
    setPill(ui.pillSeat, "SEAT", "—");
    speak("Presidency access confirmed.", true);
    showEnter();
    return;
  }

  if (state.role === "observer") {
    state.seatId = null;
    state.seatSessionToken = null;
    setPill(ui.pillSeat, "SEAT", "—");
    speak("Observer access confirmed. Monitoring only.", true);
    showEnter();
    return;
  }

  // member
  speak("Member access confirmed.", true);
  speak("Please bind to a seat for this session.");
  fillSeatList(state.seatCount);
  ui.seatMeta.textContent = `Seats available: ${state.seatCount}`;
  showSeat();
}

async function claimSeat() {
  setError(ui.seatErr, "");
  const chosen = parseInt(ui.seatSelect.value, 10);
  if (!chosen || chosen < 1) {
    setError(ui.seatErr, "Select a seat.");
    return;
  }

  const out = await api("claim_seat", { desired_seat_id: chosen });
  state.seatId = out.seatId;
  state.seatSessionToken = out.seatSessionToken;

  setPill(ui.pillSeat, "SEAT", `Seat ${String(state.seatId).padStart(3, "0")}`);

  if (out.alreadyBound) {
    speak(`Your connection already holds Seat ${String(out.seatId).padStart(3, "0")}.`, true);
    speak("If you need a different seat, release first.");
  } else {
    speak(`Seat claimed: Seat ${String(out.seatId).padStart(3, "0")}.`, true);
  }

  showEnter();
}

async function releaseSeat() {
  setError(ui.seatErr, "");
  try {
    const out = await api("release_seat", {});
    state.seatId = null;
    state.seatSessionToken = null;
    setPill(ui.pillSeat, "SEAT", "unbound");
    speak(out.released ? "Seat released." : "No active seat to release.");
  } catch (e) {
    setError(ui.seatErr, e.message);
  }
}

// ----- Voting UI -----
function setResolutionUI(r) {
  if (!r || r.status === "idle") {
    ui.resTitle.textContent = "—";
    ui.resSummary.textContent = "—";
    ui.resBody.textContent = "Awaiting instructions.";
    ui.voteSub.textContent = "No active vote.";
    ui.elapsed.textContent = "00:00";
    ui.voteStatePill.textContent = "STATE: idle";
    ui.voteStatePill.className = "pill warn";
    return;
  }

  ui.resTitle.textContent = r.title || "—";
  ui.resSummary.textContent = r.summary || "—";
  ui.resBody.textContent = r.body || "";

  ui.voteSub.textContent =
    r.status === "open"
      ? "Voting is OPEN. Cast your position."
      : "Voting is CLOSED.";

  ui.voteStatePill.textContent = `STATE: ${r.status}`;
  ui.voteStatePill.className = r.status === "open" ? "pill" : "pill warn";
}

function setActionsVisibility(r) {
  const isMember = state.role === "member";
  const isObserver = state.role === "observer";
  const isPres = state.role === "presidency";

  ui.presidencyTile.hidden = !isPres; // server-authoritative role
  ui.memberActions.hidden = !isMember;
  ui.observerActions.hidden = !isObserver;

  const canVote = isMember && state.seatId && state.seatSessionToken && r && r.status === "open";
  ui.btnAye.disabled = !canVote;
  ui.btnNay.disabled = !canVote;
  ui.btnAbs.disabled = !canVote;

  if (isMember) {
    ui.voteLockNote.textContent = canVote
      ? `Voting as: Seat ${String(state.seatId).padStart(3, "0")}`
      : "Voting is not currently open, or your seat is not bound.";
  } else {
    ui.voteLockNote.textContent = "";
  }
}

function updateElapsed(r) {
  if (!r?.started_at || r.status === "idle") {
    ui.elapsed.textContent = "00:00";
    return;
  }
  const startMs = new Date(r.started_at).getTime();
  const endMs =
    r.status === "closed"
      ? (r.ended_at ? new Date(r.ended_at).getTime() : nowMs())
      : nowMs();

  ui.elapsed.textContent = fmtElapsed(endMs - startMs);
}

// votes: { [seatId]: "aye"|"nay"|"abstain" }
function setLedger(votes, seatCount) {
  ui.ledgerList.innerHTML = "";

  let aye=0, nay=0, abs=0, cast=0;

  // build counts + list only for seats that voted (nice & compact)
  const votedSeats = Object.keys(votes || {})
    .map(k => parseInt(k, 10))
    .filter(n => Number.isFinite(n))
    .sort((a,b)=>a-b);

  for (const seatId of votedSeats) {
    const choice = votes[String(seatId)] || "none";
    if (choice !== "none") cast++;
    if (choice === "aye") aye++;
    if (choice === "nay") nay++;
    if (choice === "abstain") abs++;

    const row = document.createElement("div");
    row.className = "ledgerRow";
    row.innerHTML = `
      <div class="seatLabel">Seat ${String(seatId).padStart(3,"0")}</div>
      <div class="choice ${escapeHtml(choice)}">${escapeHtml(choice.toUpperCase())}</div>
    `;
    ui.ledgerList.appendChild(row);
  }

  ui.cAye.textContent = String(aye);
  ui.cNay.textContent = String(nay);
  ui.cAbs.textContent = String(abs);
  ui.cTot.textContent = String(cast);

  drawChamber(votes || {}, seatCount);
}

// Parliament chamber visualization (semi-circle-ish with rows)
function drawChamber(votes, seatCount) {
  const canvas = ui.chamberCanvas;
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // layout: multiple arcs
  const rows = Math.max(4, Math.min(10, Math.round(Math.sqrt(seatCount) / 1.2)));
  const seatRadius = Math.max(2, Math.min(5, Math.floor(cssW / 220)));
  const centerX = cssW / 2;
  const baseY = cssH * 0.92;

  let remaining = seatCount;
  let seatIndex = 1;

  for (let r = 0; r < rows; r++) {
    if (remaining <= 0) break;

    // allocate seats per row (more on outer rows)
    const rowSeats = Math.ceil((seatCount / rows) * (1 + r * 0.12));
    const n = Math.min(remaining, rowSeats);
    remaining -= n;

    const radius = (cssH * 0.18) + r * (seatRadius * 3.3);
    const startAng = Math.PI * 1.05;
    const endAng = Math.PI * 1.95;
    const span = endAng - startAng;

    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const ang = startAng + span * t;

      const x = centerX + Math.cos(ang) * radius;
      const y = baseY + Math.sin(ang) * radius;

      const choice = votes[String(seatIndex)] || "none";
      seatIndex++;

      // choose color
      let fill = "rgba(12,27,58,.18)";          // none
      if (choice === "aye") fill = "rgba(14,159,110,.65)";
      if (choice === "nay") fill = "rgba(225,29,72,.60)";
      if (choice === "abstain") fill = "rgba(180,83,9,.55)";

      ctx.beginPath();
      ctx.arc(x, y, seatRadius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      // subtle outline
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(12,27,58,.10)";
      ctx.stroke();
    }
  }

  // little legend (top-left)
  ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillStyle = "rgba(75,98,143,.95)";
  ctx.fillText("AYE", 10, 16);
  ctx.fillText("NAY", 10, 34);
  ctx.fillText("ABS", 10, 52);
  ctx.fillText("—", 10, 70);

  ctx.fillStyle = "rgba(14,159,110,.65)"; ctx.fillRect(52, 7, 18, 12);
  ctx.fillStyle = "rgba(225,29,72,.60)";  ctx.fillRect(52, 25, 18, 12);
  ctx.fillStyle = "rgba(180,83,9,.55)";   ctx.fillRect(52, 43, 18, 12);
  ctx.fillStyle = "rgba(12,27,58,.18)";   ctx.fillRect(52, 61, 18, 12);
}

// ----- actions -----
async function cast(choice) {
  if (state.role !== "member") return;
  try {
    await api("cast_vote", { choice });
    speak(`Vote recorded: ${choice.toUpperCase()}.`);
  } catch (e) {
    speak(`Vote rejected: ${e.message}`, true);
  }
}

async function startVote() {
  setError(ui.presErr, "");
  const title = ui.pTitle.value.trim();
  const summary = ui.pSummary.value.trim();
  const body = ui.pBody.value.trim();
  if (!title || !body) {
    setError(ui.presErr, "Provide at least a title and full resolution text.");
    return;
  }
  try {
    await api("start_vote", { title, summary, body });
    speak("Voting procedure initiated.", true);
  } catch (e) {
    setError(ui.presErr, e.message);
    speak(`Start failed: ${e.message}`, true);
  }
}

async function endVote() {
  setError(ui.presErr, "");
  try {
    const out = await api("end_vote", {});
    speak("Voting procedure terminated.", true);
    speak(out.discordPosted ? "Results transmitted." : "Transmission failed.");
  } catch (e) {
    setError(ui.presErr, e.message);
    speak(`End failed: ${e.message}`, true);
  }
}

// ----- polling -----
async function pollOnce() {
  const data = await api("get_state", {});
  state.activeResolution = data.resolution || { status: "idle" };
  state.seatCount = data.seatCount || state.seatCount || 0;

  setResolutionUI(state.activeResolution);
  setActionsVisibility(state.activeResolution);

  const votes = data.votes || {};
  setLedger(votes, state.seatCount);

  updateElapsed(state.activeResolution);

  ui.ledgerSub.textContent =
    state.activeResolution?.status === "open"
      ? `Live seat positions • Total seats: ${state.seatCount}`
      : `No active vote • Total seats: ${state.seatCount}`;
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollOnce().catch(() => {});
  state.pollTimer = setInterval(() => {
    pollOnce().catch(() => setPill(ui.pillConn, "LINK", "unstable"));
  }, CONFIG.POLL_MS);
}

// ----- heartbeat (keeps seat session alive) -----
async function heartbeat() {
  if (state.role !== "member") return;
  if (!state.seatId || !state.seatSessionToken) return;
  try {
    const out = await api("heartbeat", {});
    if (!out.ok) return;
  } catch {
    // if seat session expires, we’ll just stop voting ability; user can re-claim
  }
}

function startHeartbeat() {
  if (state.hbTimer) clearInterval(state.hbTimer);
  heartbeat().catch(()=>{});
  state.hbTimer = setInterval(() => heartbeat().catch(()=>{}), CONFIG.HEARTBEAT_MS);
}

// ----- clock -----
function tickClock() {
  const d = new Date(nowMs());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  ui.clock.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(tickClock, 500);
tickClock();

// ----- boot -----
(function boot() {
  ui.buildInfo.textContent = `build: ${window.location.host}`;
  setPill(ui.pillConn, "LINK", "negotiating…");
  setPill(ui.pillRole, "ROLE", "unknown");
  setPill(ui.pillSeat, "SEAT", "unbound");

  speak("Welcome to the OFN Internal Representative Platform.");
  speak("Please provide your access phrase.");

  ui.btnAuth.addEventListener("click", () => handleAuth().catch(e => setError(ui.authErr, e.message)));
  ui.pw.addEventListener("keydown", (e) => { if (e.key === "Enter") ui.btnAuth.click(); });

  ui.btnSeat.addEventListener("click", () => claimSeat().catch(e => setError(ui.seatErr, e.message)));
  ui.btnRelease.addEventListener("click", () => releaseSeat().catch(e => setError(ui.seatErr, e.message)));

  ui.btnEnter.addEventListener("click", enterDesktop);

  ui.btnAye.addEventListener("click", () => cast("aye"));
  ui.btnNay.addEventListener("click", () => cast("nay"));
  ui.btnAbs.addEventListener("click", () => cast("abstain"));

  ui.btnStart.addEventListener("click", startVote);
  ui.btnEnd.addEventListener("click", endVote);

  window.addEventListener("resize", () => {
    // redraw chamber at current votes
    // (poll will redraw soon anyway)
  });

  showAuth();
})();
