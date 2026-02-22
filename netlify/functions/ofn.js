import { createClient } from "@supabase/supabase-js";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function cleanStr(s, max = 4000) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, max);
}

function choiceNormalize(c) {
  const x = String(c || "").toLowerCase();
  if (x === "aye" || x === "nay" || x === "abstain") return x;
  return null;
}

function roleFromToken(token) {
  if (token === process.env.PRESIDENCY_PASSWORD) return "presidency";
  if (token === process.env.MEMBER_PASSWORD) return "member";
  if (token === process.env.OBSERVER_PASSWORD) return "observer";
  return null;
}

function countriesForRole(role) {
  const members = (process.env.MEMBER_COUNTRIES || "")
    .split("|").map(s => s.trim()).filter(Boolean);
  const observers = (process.env.OBSERVER_COUNTRIES || "")
    .split("|").map(s => s.trim()).filter(Boolean);

  if (role === "member") return members;
  if (role === "observer") return observers;
  return [];
}

function canVote(role) {
  return role === "member";
}

function isPresidency(role) {
  return role === "presidency";
}

async function getActiveResolution(supabase) {
  const { data, error } = await supabase
    .from("resolutions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  const r = data?.[0];
  if (!r) return { status: "idle" };
  return r;
}

// returns: { [country]: [{rep, choice}, ...] }
async function getVotesMap(supabase, resolutionId) {
  if (!resolutionId) return {};
  const { data, error } = await supabase
    .from("votes")
    .select("country, representative, choice")
    .eq("resolution_id", resolutionId);

  if (error) throw error;

  const map = {};
  for (const v of data || []) {
    if (!map[v.country]) map[v.country] = [];
    map[v.country].push({ rep: v.representative, choice: v.choice });
  }
  return map;
}

async function setResolutionClosed(supabase, resolutionId) {
  const { error } = await supabase
    .from("resolutions")
    .update({ status: "closed", ended_at: new Date().toISOString() })
    .eq("id", resolutionId);

  if (error) throw error;
}

async function postDiscord(webhookUrl, payload) {
  if (!webhookUrl) return false;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

export async function handler(event) {
  try {
    const action = new URL(event.rawUrl).searchParams.get("action") || "ping";
    const body = event.body ? JSON.parse(event.body) : {};

    const token = cleanStr(body.token, 200);
    const country = cleanStr(body.country, 120);
    const representative = cleanStr(body.representative, 40) || "Rep 1";

    const role = roleFromToken(token);
    if (!role) return json(401, { error: "Unauthorized credential." });

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    if (action === "ping") {
      return json(200, { hello: "secure", serverNowMs: Date.now() });
    }

    if (action === "get_state") {
      const resolution = await getActiveResolution(supabase);
      const votes = await getVotesMap(supabase, resolution?.id);

      const members = (process.env.MEMBER_COUNTRIES || "")
        .split("|").map(s => s.trim()).filter(Boolean);
      const observers = (process.env.OBSERVER_COUNTRIES || "")
        .split("|").map(s => s.trim()).filter(Boolean);

      const countriesOrder = [...members, ...observers];

      return json(200, {
        hello: "secure",
        serverNowMs: Date.now(),
        resolution,
        votes,
        countriesOrder,
      });
    }

    if (action === "start_vote") {
      if (!isPresidency(role)) return json(403, { error: "Presidency authority required." });

      const title = cleanStr(body.title, 140);
      const summary = cleanStr(body.summary, 240);
      const resBody = cleanStr(body.body, 6000);

      if (!title || !resBody) return json(400, { error: "Missing title or resolution text." });

      // Close any currently open vote first
      const current = await getActiveResolution(supabase);
      if (current?.status === "open") {
        await setResolutionClosed(supabase, current.id);
      }

      const insert = {
        title,
        summary,
        body: resBody,
        status: "open",
        started_at: new Date().toISOString(),
        ended_at: null,
      };

      const { data, error } = await supabase
        .from("resolutions")
        .insert(insert)
        .select("id")
        .single();

      if (error) throw error;

      return json(200, { ok: true, resolutionId: data.id });
    }

    if (action === "cast_vote") {
      if (!canVote(role)) return json(403, { error: "Observer cannot vote." });

      const allowed = countriesForRole(role);
      if (!allowed.includes(country)) {
        return json(400, { error: "Country binding invalid for this role." });
      }

      const choice = choiceNormalize(body.choice);
      if (!choice) return json(400, { error: "Invalid choice." });

      const current = await getActiveResolution(supabase);
      if (!current?.id || current.status !== "open") {
        return json(409, { error: "No open vote." });
      }

      const upsert = {
        resolution_id: current.id,
        country,
        representative,
        choice,
        updated_at: new Date().toISOString(),
      };

      // Requires the new constraint unique(resolution_id, country, representative)
      const { error } = await supabase
        .from("votes")
        .upsert(upsert, { onConflict: "resolution_id,country,representative" });

      if (error) throw error;

      return json(200, { ok: true });
    }

    if (action === "end_vote") {
      if (!isPresidency(role)) return json(403, { error: "Presidency authority required." });

      const current = await getActiveResolution(supabase);
      if (!current?.id) return json(409, { error: "No vote exists to end." });
      if (current.status !== "open") return json(409, { error: "Vote already closed." });

      await setResolutionClosed(supabase, current.id);

      const votes = await getVotesMap(supabase, current.id);

      const members = (process.env.MEMBER_COUNTRIES || "")
        .split("|").map(s => s.trim()).filter(Boolean);

      // Tally
      let aye = 0, nay = 0, abs = 0, cast = 0;
      const lines = [];

      for (const c of members) {
        const entries = (votes[c] || []).slice().sort((a,b) => a.rep.localeCompare(b.rep));
        if (entries.length === 0) {
          lines.push(`• ${c}: NONE`);
          continue;
        }

        for (const e of entries) {
          cast++;
          if (e.choice === "aye") aye++;
          if (e.choice === "nay") nay++;
          if (e.choice === "abstain") abs++;
        }

        const repLine = entries.map(e => `${e.rep}: ${e.choice.toUpperCase()}`).join(" • ");
        lines.push(`• ${c}: ${repLine}`);
      }

      const content =
        `**OFN Vote Concluded**\n` +
        `**${current.title || "Untitled Resolution"}**\n` +
        (current.summary ? `_${current.summary}_\n` : "") +
        `\n**Result** — Aye: **${aye}**, Nay: **${nay}**, Abstain: **${abs}**, Cast: **${cast}**\n` +
        `\n**Ledger**\n${lines.join("\n")}`;

      const discordWebhook = process.env.DISCORD_WEBHOOK_URL || "";
      const discordPosted = await postDiscord(discordWebhook, { content });

      return json(200, { ok: true, discordPosted });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(500, { error: err?.message || "Server error." });
  }
}
