// OFN IRP — Client

const CONFIG = {
  // UI-side role detection (server also verifies using Netlify env vars)
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
  CLEAR_AFTER_CLOSE_MS: 6000,
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

  feedList: $("feedList"),
  buildInfo: $("buildInfo"),
};

const state = {
  role: null,            // observer | member | presidency
  country: null,         // string or null
  representative: null,  // "Rep 1" ... for members
  token: null,

  activeResolution: null,
  lastResolutionId: null,

  pollTimer: null,
  timeOffsetMs: 0,

  clearTimeout: null,
  lastStatus: null,
};

// ---------- UI helpers ----------
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

function feed(line, tag = "SYSTEM") {
  const div = document.createElement("div");
  div.className = "feedItem";
  div.innerHTML = `<strong>${escapeHtml(tag)}</strong> — ${escapeHtml(line)}`;
  ui.feedList.prepend(div);
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

// ---------- API ----------
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
      representative: state.representative,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---------- flows ----------
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

  const who = state.role === "presidency"
    ? "Presidency session"
    : `${state.country}${state.role === "member" ? ` — ${state.representative}` : ""}`;

  feed(`Entered platform as ${who}.`, "ACCESS");
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

// ---------- auth ----------
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
    speak("If you keep guessing, I will start judging you louder.", true);
    return;
  }

  state.role = role;
  state.token = pw;
  state.country = null;
  state.representative = null;

  setPill(ui.pillRole, "ROLE", role.toUpperCase());
  setPill(ui.pillCountry, "ID", "unbound");

  speak(`Credential accepted. Role: ${role.toUpperCase()}.`, true);

  // Backend link check + time offset
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
    setPill(ui.pillCountry, "ID", "PRESIDENCY");
    speak("Presidency access does not require country binding.");
    speak("Proceed when ready.");
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

  speak("Proceed to the platform.");
  showEnter();
}

// ---------- resolution + ledger ----------
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

  ui.voteSub.textContent =
    r.status === "open"
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
    const id = `${state.country} — ${state.representative || "Rep 1"}`;
    ui.voteLockNote.textContent = canVote ? `Voting as: ${id}` : "Voting is not currently open.";
  }
}

function setLedger(votesMap, countriesOrder) {
  ui.ledgerList.innerHTML = "";

  let aye = 0, nay = 0, abs = 0, cast = 0;

  for (const country of countriesOrder) {
    const entries = votesMap[country] || []; // [{rep, choice}...]

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

  // If closed, freeze timer at ended_at (if present)
  const endMs =
    r.status === "closed"
      ? (r.ended_at ? new Date(r.ended_at).getTime() : nowMs())
      : nowMs();

  ui.elapsed.textContent = fmtElapsed(endMs - startMs);
}

// ---------- actions ----------
async function cast(choice) {
  if (!state.activeResolution || state.activeResolution.status !== "open") return;

  try {
    await api("cast_vote", { choice });
    feed(`Vote recorded: ${state.country} — ${state.representative} = ${choice.toUpperCase()}`, "VOTE");
    speak(`Vote received: ${state.representative} — ${choice.toUpperCase()}.`);
  } catch (e) {
    feed(`Vote failed: ${e.message}`, "ERROR");
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
    const out = await api("start_vote", { title, summary, body });
    feed(`Vote initiated: ${out.resolutionId}`, "PRESIDENCY");
    speak("Voting procedure initiated.", true);
    speak("Delegations may now register their positions.");
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
    speak(out.discordPosted ? "Results transmitted." : "Transmission failed.");
  } catch (e) {
    setError(ui.presErr, e.message);
    feed(`End vote failed: ${e.message}`, "ERROR");
  }
}

// ---------- polling ----------
async function pollOnce() {
  const data = await api("get_state", {});
  state.activeResolution = data.resolution || { status: "idle" };

  if (data.hello) setPill(ui.pillConn, "LINK", data.hello);

  // announce new resolution
  const rid = state.activeResolution?.id || null;
  if (rid && rid !== state.lastResolutionId) {
    state.lastResolutionId = rid;
    speak("New resolution detected.", true);
    speak(`Loaded: ${state.activeResolution.title || "Untitled"}`);
    feed(`New resolution loaded: ${state.activeResolution.title || "Untitled"}`, "SYSTEM");
  }
  if (!rid) state.lastResolutionId = null;

  // Detect status transition to CLOSED and schedule UI clear
  const curStatus = state.activeResolution?.status || "idle";
  if (state.lastStatus !== curStatus) {
    state.lastStatus = curStatus;

    if (curStatus === "closed") {
      feed("Vote closed. Clearing resolution view shortly.", "SYSTEM");
      speak("Vote closed. Stand by.", true);

      if (!state.clearTimeout) {
        state.clearTimeout = setTimeout(() => {
          // only clear if still closed (avoid wiping a newly started vote)
          if (state.activeResolution?.status === "closed") {
            state.activeResolution = { status: "idle" };
            setResolutionUI(state.activeResolution);
            setActionsVisibility(state.activeResolution);

            ui.ledgerList.innerHTML = "";
            ui.cAye.textContent = "0";
            ui.cNay.textContent = "0";
            ui.cAbs.textContent = "0";
            ui.cTot.textContent = "0";

            feed("Resolution view cleared.", "SYSTEM");
          }
          state.clearTimeout = null;
        }, CONFIG.CLEAR_AFTER_CLOSE_MS);
      }
    } else {
      if (state.clearTimeout) {
        clearTimeout(state.clearTimeout);
        state.clearTimeout = null;
      }
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
      : "Ledger locked to final state.";
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollOnce().catch(() => {});
  state.pollTimer = setInterval(() => {
    pollOnce().catch(() => setPill(ui.pillConn, "LINK", "unstable"));
  }, CONFIG.POLL_MS);
}

// ---------- clock ----------
function tickClock() {
  const d = new Date(nowMs());
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  ui.clock.textContent = `${hh}:${mm}:${ss}`;
}
setInterval(tickClock, 500);
tickClock();

// ---------- boot ----------
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
