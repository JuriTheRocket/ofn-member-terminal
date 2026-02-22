// OFN Member Terminal — Client
// Note: Password checks here are UI-level only. Real authority is enforced server-side in the Netlify function.

const CONFIG = {
  // These are *client* passwords for the UI. Server-side will verify using Netlify env vars too.
  // Change them here AND in Netlify env vars (OBSERVER_PASSWORD, MEMBER_PASSWORD, PRESIDENCY_PASSWORD).
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

  feedList: $("feedList"),
  buildInfo: $("buildInfo"),
};

const state = {
  role: null,      // "observer" | "member" | "presidency"
  country: null,   // string or null
  token: null,     // password used (sent to server for verification)
  activeResolution: null,
  lastResolutionId: null,
  pollTimer: null,
  timeOffsetMs: 0, // server time offset if provided
};

state.clearTimeout = null;

// ---------- System voice ----------
function speak(line, emphasis = false) {
  const div = document.createElement("div");
  div.className = "voiceLine";
  div.innerHTML = emphasis ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line);
  ui.systemVoice.appendChild(div);
  ui.systemVoice.scrollTop = ui.systemVoice.scrollHeight;
}

function feed(line, tag = "SYSTEM") {
  const div = document.createElement("div");
  div.className = "feedItem";
  div.innerHTML = `<strong>${escapeHtml(tag)}</strong> — ${escapeHtml(line)}`;
  ui.feedList.prepend(div);
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
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
      role: state.role,
      country: state.country,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---------- UI flows ----------
function showAuth() {
  ui.cardAuth.hidden = false;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showIdentity() {
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = false;
  ui.cardEnter.hidden = true;
  ui.workspace.hidden = true;
}

function showEnter() {
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = false;
  ui.workspace.hidden = true;
}

function enterDesktop() {
  ui.workspace.hidden = false;
  ui.cardAuth.hidden = true;
  ui.cardIdentity.hidden = true;
  ui.cardEnter.hidden = true;

  feed("Session entered voting desktop.", "ACCESS");
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

// ---------- Auth ----------
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
    setError(ui.authErr, "Credential rejected. Try again, carefully.");
    speak("Credential rejected. That was not one of the authorized phrases.");
    speak("I recommend fewer guesses and more accuracy.", true);
    return;
  }

  state.role = role;
  state.token = pw;

  setPill(ui.pillRole, "ROLE", role.toUpperCase());

  speak(`Credential accepted. Role inferred: ${role.toUpperCase()}.`, true);

  // Ping server to confirm backend is alive & get time offset
  try {
    const ping = await api("ping", {});
    state.timeOffsetMs = (ping.serverNowMs - Date.now()) || 0;
    setPill(ui.pillConn, "LINK", "secure");
    feed("Backend link established.", "LINK");
  } catch (e) {
    setPill(ui.pillConn, "LINK", "degraded");
    feed("Backend link degraded — some actions may fail.", "LINK");
  }

  if (role === "presidency") {
    state.country = null;
    setPill(ui.pillCountry, "ID", "PRESIDENCY");
    speak("Presidency access does not require country binding.");
    speak("Proceed to the secure desktop when ready.");
    showEnter();
    return;
  }

  // Need country binding
  if (role === "member") {
    ui.identityHint.textContent = "Hello Representative! May I know what country you are representing today?";
    fillCountryList(CONFIG.MEMBER_COUNTRIES);
  } else {
    ui.identityHint.textContent = "Observer access confirmed. Please declare your observer delegation for this session.";
    fillCountryList(CONFIG.OBSERVER_COUNTRIES);
  }

  showIdentity();
}

function handleBind() {
  setError(ui.bindErr, "");
  const c = ui.countrySelect.value;
  if (!c) {
    setError(ui.bindErr, "Select a country to bind.");
    return;
  }
  state.country = c;
  setPill(ui.pillCountry, "ID", c);
  speak(`Identity bound: ${c}.`, true);
  speak("Proceed to the secure desktop.");
  showEnter();
}

// ---------- Voting UI ----------
function setResolutionUI(r) {
  if (!r || r.status === "idle") {
    ui.resTitle.textContent = "—";
    ui.resSummary.textContent = "—";
    ui.resBody.textContent = "Awaiting instructions.";
    ui.voteSub.textContent = "No active vote.";
    ui.elapsed.textContent = "00:00";
    ui.voteLockNote.textContent = "";
    ui.voteStatePill.textContent = "STATE: idle";
    ui.voteStatePill.className = "pill warn";
    return;
  }

  ui.resTitle.textContent = r.title || "Untitled Resolution";
  ui.resSummary.textContent = r.summary || "No summary provided.";
  ui.resBody.textContent = r.body || "";
  ui.voteSub.textContent = r.status === "open"
    ? "Voting is OPEN. Cast your position."
    : "Voting is CLOSED. Awaiting publication.";

  ui.voteStatePill.textContent = `STATE: ${r.status}`;
  ui.voteStatePill.className = r.status === "open" ? "pill" : "pill warn";
}

function setActionsVisibility(r) {
  const isObserver = state.role === "observer";
  const isMember = state.role === "member";
  const isPres = state.role === "presidency";

  ui.observerActions.hidden = !isObserver;
  ui.memberActions.hidden = !isMember;

  ui.presidencyTile.hidden = !isPres;

  const canVote = isMember && r && r.status === "open";
  ui.btnAye.disabled = !canVote;
  ui.btnNay.disabled = !canVote;
  ui.btnAbs.disabled = !canVote;

  if (isMember) {
    ui.voteLockNote.textContent = canVote ? `Your delegation: ${state.country}` : "Voting is not currently open.";
  }
}

function setLedger(votesMap, countriesOrder) {
  ui.ledgerList.innerHTML = "";

  let aye=0, nay=0, abs=0, tot=0;

  for (const country of countriesOrder) {
    const choice = votesMap[country] || "none";
    if (choice !== "none") tot++;
    if (choice === "aye") aye++;
    if (choice === "nay") nay++;
    if (choice === "abstain") abs++;

    const row = document.createElement("div");
    row.className = "ledgerRow";
    row.innerHTML = `
      <div class="country">${escapeHtml(country)}</div>
      <div class="choice ${escapeHtml(choice)}">${escapeHtml(choice.toUpperCase())}</div>
    `;
    ui.ledgerList.appendChild(row);
  }

  ui.cAye.textContent = String(aye);
  ui.cNay.textContent = String(nay);
  ui.cAbs.textContent = String(abs);
  ui.cTot.textContent = String(tot);
}

function updateElapsed(r) {
  if (!r?.started_at || r.status === "idle") {
    ui.elapsed.textContent = "00:00";
    return;
  }

  const startMs = new Date(r.started_at).getTime();

  // If closed, freeze at ended_at (if available), otherwise freeze at "now"
  const endMs = r.status === "closed"
    ? (r.ended_at ? new Date(r.ended_at).getTime() : nowMs())
    : nowMs();

  ui.elapsed.textContent = fmtElapsed(endMs - startMs);
}

// ---------- Actions ----------
async function cast(choice) {
  if (!state.activeResolution || state.activeResolution.status !== "open") return;
  try {
    await api("cast_vote", { choice });
    feed(`Vote recorded for ${state.country}: ${choice.toUpperCase()}`, "VOTE");
    speak(`Vote received: ${state.country} — ${choice.toUpperCase()}.`);
  } catch (e) {
    feed(`Vote failed: ${e.message}`, "ERROR");
    speak(`Vote rejected: ${e.message}`, true);
  }
}

// If vote just transitioned to closed, schedule UI clear
if (state.activeResolution?.status === "closed") {
  if (!state.clearTimeout) {
    state.clearTimeout = setTimeout(() => {
      // Only clear if still closed (avoid clearing a new vote)
      if (state.activeResolution?.status === "closed") {
        state.activeResolution = { status: "idle" };
        setResolutionUI(state.activeResolution);
        setActionsVisibility(state.activeResolution);
        ui.ledgerList.innerHTML = "";
        ui.cAye.textContent = "0";
        ui.cNay.textContent = "0";
        ui.cAbs.textContent = "0";
        ui.cTot.textContent = "0";
        feed("Vote concluded. Resolution view cleared.", "SYSTEM");
      }
      state.clearTimeout = null;
    }, 6000);
  }
} else {
  if (state.clearTimeout) {
    clearTimeout(state.clearTimeout);
    state.clearTimeout = null;
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
    const out = await api("start_vote", { title, summary, body });
    feed(`Vote initiated: ${out.resolutionId}`, "PRESIDENCY");
    speak("Voting procedure initiated.", true);
    speak("All delegations may now register their position.");
  } catch (e) {
    setError(ui.presErr, e.message);
    feed(`Start vote failed: ${e.message}`, "ERROR");
  }
}

async function endVote() {
  setError(ui.presErr, "");
  try {
    const out = await api("end_vote", {});
    feed(`Vote ended. Discord publication: ${out.discordPosted ? "YES" : "NO"}`, "PRESIDENCY");
    speak("Voting procedure terminated.", true);
    speak(out.discordPosted ? "Results have been transmitted." : "Results could not be transmitted.");
  } catch (e) {
    setError(ui.presErr, e.message);
    feed(`End vote failed: ${e.message}`, "ERROR");
  }
}

// ---------- Poll loop ----------
async function pollOnce() {
  const data = await api("get_state", {});
  state.activeResolution = data.resolution || { status: "idle" };

  if (data.hello) {
    // connectivity hint
    setPill(ui.pillConn, "LINK", data.hello);
  }

  // Speak when resolution changes
  const rid = state.activeResolution?.id || null;
  if (rid && rid !== state.lastResolutionId) {
    state.lastResolutionId = rid;
    speak("New procedural object detected.", true);
    speak(`Resolution loaded: ${state.activeResolution.title || "Untitled"}`);
    feed(`New resolution loaded: ${state.activeResolution.title || "Untitled"}`, "SYSTEM");
  }
  if (!rid) state.lastResolutionId = null;

  setResolutionUI(state.activeResolution);
  setActionsVisibility(state.activeResolution);

  const order = data.countriesOrder || [];
  setLedger(data.votes || {}, order);
  updateElapsed(state.activeResolution);

  ui.ledgerSub.textContent = state.activeResolution?.status === "open"
    ? "Live feed. Entries update automatically."
    : "Ledger locked to final state.";
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollOnce().catch(() => {});
  state.pollTimer = setInterval(() => {
    pollOnce().catch((e) => {
      setPill(ui.pillConn, "LINK", "unstable");
    });
  }, CONFIG.POLL_MS);
}

// ---------- Clock ----------
function tickClock(){
  const d = new Date(nowMs());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  ui.clock.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(tickClock, 500);
tickClock();

// ---------- Boot ----------
(function boot(){
  ui.buildInfo.textContent = `build: ${window.location.host}`;
  setPill(ui.pillConn, "LINK", "negotiating…");
  setPill(ui.pillRole, "ROLE", "unknown");
  setPill(ui.pillCountry, "ID", "unbound");

  speak("Terminal boot sequence initiated…");
  speak("If you are authorized, you will proceed. If you are not… you will still proceed, just less far.");
  speak("Provide your access phrase.");

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
