// OFN IRP — Client

const CONFIG = {
  PASSWORDS: {
    observer: "OBSERVER-ACCESS-2026",
    member: "MEMBER-ACCESS-2026",
    presidency: "PRESIDENCY-ACCESS-2026",
  },

  MEMBER_COUNTRIES: [
    "Falklands",
    "United States of America",
    "Philippines",
    "Union of Columbia",
    "Brazil",
    "Australia",
    "Ireland",
    "Grand Duchy of Luxembourg",
  ],

  OBSERVER_COUNTRIES: [
    "Switzerland (Observer)",
    "Japan (Observer)",
    "Sweden (Observer)",
    "New Zealand (Observer)",
  ],

  POLL_MS: 1500,
};

const $ = (id) => document.getElementById(id);

const ui = {
  pillConn: $("pillConn"),
  pillRole: $("pillRole"),
  pillCountry: $("pillCountry"),

  systemVoice: $("systemVoice"),

  cardAuth: $("cardAuth"),
  pw: $("pw"),
  btnAuth: $("btnAuth"),
  authErr: $("authErr"),

  cardIdentity: $("cardIdentity"),
  identityHint: $("identityHint"),
  countrySelect: $("countrySelect"),
  btnBind: $("btnBind"),
  bindErr: $("bindErr"),

  repRow: $("repRow"),
  repSelect: $("repSelect"),

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
  role: null,
  country: null,
  representative: null,
  token: null,

  activeResolution: null,
  lastResolutionId: null,

  pollTimer: null,
  timeOffsetMs: 0,

  lastStatus: null,
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

function fmtElapsed(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(t / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function nowMs() {
  return Date.now() + state.timeOffsetMs;
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
      ...payload,
      token: state.token,
      country: state.country,
      representative: state.representative,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function showAuth() {
  setAuthMode(true);
  ui.cardAuth.hidden = false;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showIdentity() {
  setAuthMode(true);
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = false;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showEnter() {
  setAuthMode(true);
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = false;
  ui.workspace.hidden = true;
}

function enterDesktop() {
  setAuthMode(false);
  ui.workspace.hidden = false;
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = true;

  startPolling();
}

function fillCountryList(list) {
  ui.countrySelect.innerHTML = "";
  for (const c of list) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    ui.countrySelect.appendChild(opt);
  }
}

function detectRoleFromPassword(pw) {
  if (pw === CONFIG.PASSWORDS.observer) return "observer";
  if (pw === CONFIG.PASSWORDS.member) return "member";
  if (pw === CONFIG.PASSWORDS.presidency) return "presidency";
  return null;
}

async function handleAuth() {
  setError(ui.authErr, "");
  const pw = ui.pw.value.trim();
  const role = detectRoleFromPassword(pw);

  if (!role) {
    setError(ui.authErr, "Credential rejected. Try again carefully.");
    speak("Credential rejected. That phrase is not authorised.");
    speak("I recommend fewer guesses and more accuracy.", true);
    return;
  }

  state.role = role;
  state.token = pw;
  state.country = null;
  state.representative = null;

  setPill(ui.pillRole, "ROLE", role.toUpperCase());
  setPill(ui.pillCountry, "ID", "unbound");

  speak(`Credential accepted. Role: ${role.toUpperCase()}.`, true);

  try {
    const ping = await api("ping", {});
    state.timeOffsetMs = (ping.serverNowMs - Date.now()) || 0;
    setPill(ui.pillConn, "LINK", "secure");
  } catch {
    setPill(ui.pillConn, "LINK", "degraded");
  }

  if (role === "presidency") {
    setPill(ui.pillCountry, "ID", "PRESIDENCY");
    speak("Presidency access does not require country binding.");
    showEnter();
    return;
  }

  if (role === "member") {
    ui.identityHint.textContent = "Hello Representative! May I know what country you are representing today?";
    fillCountryList(CONFIG.MEMBER_COUNTRIES);
    ui.repRow.hidden = false;
  } else {
    ui.identityHint.textContent = "Observer access confirmed. Please declare your observer delegation for this session.";
    fillCountryList(CONFIG.OBSERVER_COUNTRIES);
    ui.repRow.hidden = true;
  }

  showIdentity();
}

function handleBind() {
  setError(ui.bindErr, "");
  const c = ui.countrySelect.value;
  if (!c) {
    setError(ui.bindErr, "Select a delegation to bind.");
    return;
  }

  state.country = c;

  if (state.role === "member") {
    state.representative = ui.repSelect?.value || "Rep 1";
    setPill(ui.pillCountry, "ID", `${c} — ${state.representative}`);
    speak(`Identity bound: ${c} (${state.representative}).`, true);
  } else {
    state.representative = null;
    setPill(ui.pillCountry, "ID", c);
    speak(`Identity bound: ${c}.`, true);
  }

  showEnter();
}

function clearVoteUI() {
  ui.resTitle.textContent = "—";
  ui.resSummary.textContent = "—";
  ui.resBody.textContent = "Awaiting instructions.";
  ui.voteSub.textContent = "No active vote.";
  ui.elapsed.textContent = "00:00";
  ui.voteLockNote.textContent = "";

  ui.ledgerList.innerHTML = "";
  ui.cAye.textContent = "0";
  ui.cNay.textContent = "0";
  ui.cAbs.textContent = "0";
  ui.cTot.textContent = "0";
  ui.ledgerSub.textContent = "Per-country representative votes.";
}

function setResolutionUI(r) {
  if (!r || r.status === "idle") {
    clearVoteUI();
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
  const isObserver = state.role === "observer";
  const isMember = state.role === "member";
  const isPres = state.role === "presidency";

  ui.observerActions.hidden = !isObserver;
  ui.memberActions.hidden = !isMember;

  // ✅ Presidency console ONLY for presidency (and hidden otherwise)
  ui.presidencyTile.hidden = !isPres;

  const canVote = isMember && r && r.status === "open";
  ui.btnAye.disabled = !canVote;
  ui.btnNay.disabled = !canVote;
  ui.btnAbs.disabled = !canVote;

  if (isMember) {
    const id = `${state.country} — ${state.representative || "Rep 1"}`;
    ui.voteLockNote.textContent = canVote ? `Voting as: ${id}` : "Voting is not currently open.";
  }
}

function setLedger(votesMap, countriesOrder) {
  ui.ledgerList.innerHTML = "";

  let aye = 0, nay = 0, abs = 0, cast = 0;

  for (const country of countriesOrder) {
    const entries = votesMap[country] || [];

    for (const e of entries) {
      cast++;
      if (e.choice === "aye") aye++;
      if (e.choice === "nay") nay++;
      if (e.choice === "abstain") abs++;
    }

    const row = document.createElement("div");
    row.className = "ledgerRow";

    if (entries.length === 0) {
      row.innerHTML = `
        <div class="country">${escapeHtml(country)}</div>
        <div class="choice none">NONE</div>
      `;
    } else {
      const chips = entries
        .slice()
        .sort((a,b) => a.rep.localeCompare(b.rep))
        .map(e => `<span class="choice ${escapeHtml(e.choice)}">${escapeHtml(e.rep)}: ${escapeHtml(e.choice.toUpperCase())}</span>`)
        .join(" ");

      row.innerHTML = `
        <div class="country">${escapeHtml(country)}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end">${chips}</div>
      `;
    }

    ui.ledgerList.appendChild(row);
  }

  ui.cAye.textContent = String(aye);
  ui.cNay.textContent = String(nay);
  ui.cAbs.textContent = String(abs);
  ui.cTot.textContent = String(cast);
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

async function cast(choice) {
  if (!state.activeResolution || state.activeResolution.status !== "open") return;
  try {
    await api("cast_vote", { choice });
    speak(`Vote received: ${state.representative} — ${choice.toUpperCase()}.`);
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

async function pollOnce() {
  const data = await api("get_state", {});
  state.activeResolution = data.resolution || { status: "idle" };

  if (data.hello) setPill(ui.pillConn, "LINK", data.hello);

  // if vote just closed -> we immediately clear UI (since backend now blanks fields + votes)
  const curStatus = state.activeResolution?.status || "idle";
  if (state.lastStatus !== curStatus) {
    state.lastStatus = curStatus;
    if (curStatus === "closed") {
      speak("Vote closed. Clearing live view.", true);
    }
  }

  setResolutionUI(state.activeResolution);
  setActionsVisibility(state.activeResolution);

  const order = data.countriesOrder || [];
  setLedger(data.votes || {}, order);

  updateElapsed(state.activeResolution);

  ui.ledgerSub.textContent =
    state.activeResolution?.status === "open"
      ? "Live feed. Updates automatically."
      : "No active vote.";
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollOnce().catch(() => {});
  state.pollTimer = setInterval(() => {
    pollOnce().catch(() => setPill(ui.pillConn, "LINK", "unstable"));
  }, CONFIG.POLL_MS);
}

function tickClock() {
  const d = new Date(nowMs());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  ui.clock.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(tickClock, 500);
tickClock();

(function boot() {
  ui.buildInfo.textContent = `build: ${window.location.host}`;
  setPill(ui.pillConn, "LINK", "negotiating…");
  setPill(ui.pillRole, "ROLE", "unknown");
  setPill(ui.pillCountry, "ID", "unbound");

  speak("Welcome to the OFN Internal Representative Platform.");
  speak("Please provide your access phrase.");

  ui.btnAuth.addEventListener("click", handleAuth);
  ui.pw.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuth(); });

  ui.btnBind.addEventListener("click", handleBind);
  ui.btnEnter.addEventListener("click", enterDesktop);

  ui.btnAye.addEventListener("click", () => cast("aye"));
  ui.btnNay.addEventListener("click", () => cast("nay"));
  ui.btnAbs.addEventListener("click", () => cast("abstain"));

  ui.btnStart.addEventListener("click", startVote);
  ui.btnEnd.addEventListener("click", endVote);

  showAuth();
})();
