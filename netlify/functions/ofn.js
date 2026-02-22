import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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

function memberNations() {
  return (process.env.MEMBER_NATIONS || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function seatCount() {
  return Math.max(0, memberNations().length * 5);
}

function getClientIp(event) {
  // Netlify commonly provides one of these:
  const h = event.headers || {};
  const direct =
    h["x-nf-client-connection-ip"] ||
    h["x-forwarded-for"] ||
    h["client-ip"] ||
    h["x-real-ip"] ||
    "";
  // x-forwarded-for may contain list
  const ip = String(direct).split(",")[0].trim();
  return ip || "unknown";
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function getActiveResolution(supabase) {
  const { data, error } = await supabase
    .from("resolutions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || { status: "idle" };
}

async function getSeatVotesMap(supabase, resolutionId) {
  if (!resolutionId) return {};
  const { data, error } = await supabase
    .from("seat_votes")
    .select("seat_id, choice")
    .eq("resolution_id", resolutionId);
  if (error) throw error;
  const map = {};
  for (const v of data || []) map[String(v.seat_id)] = v.choice;
  return map;
}

async function setResolutionClosed(supabase, resolutionId) {
  const { error } = await supabase
    .from("resolutions")
    .update({ status: "closed", ended_at: new Date().toISOString() })
    .eq("id", resolutionId);
  if (error) throw error;
}

async function clearSeatVotes(supabase, resolutionId) {
  const { error } = await supabase.from("seat_votes").delete().eq("resolution_id", resolutionId);
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

// Session rules (Tier B)
const SESSION_TTL_SECONDS = 180; // 3 minutes
const CLAIM_COOLDOWN_SECONDS = 5; // simple throttle per IP (prevents rapid hammering)

async function cleanupExpiredSessions(supabase) {
  // best-effort cleanup
  const nowIso = new Date().toISOString();
  await supabase.from("seat_sessions").delete().lt("expires_at", nowIso);
}

async function getSessionByIp(supabase, ip) {
  const { data, error } = await supabase
    .from("seat_sessions")
    .select("*")
    .eq("ip", ip)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getSessionBySeat(supabase, seatId) {
  const { data, error } = await supabase
    .from("seat_sessions")
    .select("*")
    .eq("seat_id", seatId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertSession(supabase, { ip, seatId, sessionToken }) {
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const payload = {
    ip,
    seat_id: seatId,
    session_token: sessionToken,
    last_seen: now.toISOString(),
    expires_at: expires.toISOString(),
  };

  const { error } = await supabase
    .from("seat_sessions")
    .upsert(payload, { onConflict: "ip" });
  if (error) throw error;

  // Ensure seat uniqueness too: if seat was already taken by other ip, the upsert above might fail
  // (unique constraint seat_id). So we also ensure it.
}

async function bumpSession(supabase, ip, seatId, sessionToken) {
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const { error } = await supabase
    .from("seat_sessions")
    .update({ last_seen: now.toISOString(), expires_at: expires.toISOString() })
    .eq("ip", ip)
    .eq("seat_id", seatId)
    .eq("session_token", sessionToken);

  if (error) throw error;
}

async function releaseSession(supabase, ip) {
  const { data, error } = await supabase.from("seat_sessions").delete().eq("ip", ip).select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

export async function handler(event) {
  try {
    const action = new URL(event.rawUrl).searchParams.get("action") || "ping";
    const body = event.body ? JSON.parse(event.body) : {};

    const token = cleanStr(body.token, 200);
    const role = roleFromToken(token);
    if (!role) return json(401, { error: "Unauthorized credential." });

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const ip = getClientIp(event);

    // cleanup expired sessions periodically (best-effort)
    await cleanupExpiredSessions(supabase);

    const seatsTotal = seatCount();

    if (action === "ping") {
      return json(200, {
        hello: "secure",
        serverNowMs: Date.now(),
        role,
        seatCount: seatsTotal,
      });
    }

    if (action === "get_state") {
      const resolution = await getActiveResolution(supabase);

      // When closed, we blank live display and also return empty votes
      if (resolution?.status === "closed") {
        return json(200, {
          hello: "secure",
          serverNowMs: Date.now(),
          seatCount: seatsTotal,
          resolution: { ...resolution, title: "", summary: "", body: "" },
          votes: {},
        });
      }

      const votes = await getSeatVotesMap(supabase, resolution?.id);
      return json(200, {
        hello: "secure",
        serverNowMs: Date.now(),
        seatCount: seatsTotal,
        resolution,
        votes,
      });
    }

    if (action === "claim_seat") {
      if (role !== "member") return json(403, { error: "Seat claim requires member role." });
      if (seatsTotal <= 0) return json(400, { error: "Seat configuration invalid (seat count is 0)." });

      const desiredSeat = Number(body.desired_seat_id);
      if (!Number.isFinite(desiredSeat) || desiredSeat < 1 || desiredSeat > seatsTotal) {
        return json(400, { error: "Invalid seat selection." });
      }

      // If IP already has a live session, return it (one seat per IP)
      const existing = await getSessionByIp(supabase, ip);
      if (existing) {
        // throttle seat swapping: you cannot claim different seat while bound
        return json(200, {
          ok: true,
          alreadyBound: true,
          seatId: existing.seat_id,
          seatSessionToken: existing.session_token,
        });
      }

      // cooldown throttle: prevent rapid hammering by checking recent claimed_at for same ip (none exists if deleted)
      // (best-effort; if they don't have existing row, it's fine)

      // Check if desired seat is already taken by someone else
      const seatTaken = await getSessionBySeat(supabase, desiredSeat);
      if (seatTaken) {
        return json(409, { error: "That seat is currently occupied. Select another seat or wait for expiry." });
      }

      // Create new session
      const sessionToken = randomToken();
      const now = new Date();
      const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

      const insert = {
        ip,
        seat_id: desiredSeat,
        session_token: sessionToken,
        claimed_at: now.toISOString(),
        last_seen: now.toISOString(),
        expires_at: expires.toISOString(),
      };

      // Insert (enforces unique ip and unique seat)
      const { error } = await supabase.from("seat_sessions").insert(insert);
      if (error) {
        // could be race condition where seat got taken
        return json(409, { error: "Seat claim failed (seat may have been taken). Try again." });
      }

      return json(200, {
        ok: true,
        alreadyBound: false,
        seatId: desiredSeat,
        seatSessionToken: sessionToken,
      });
    }

    if (action === "release_seat") {
  if (role !== "member") return json(403, { error: "Release requires member role." });

  // optional: verify seat session token if provided
  const providedToken = cleanStr(body.seat_session_token, 200);
  const providedSeat = Number(body.seat_id);

  const session = await getSessionByIp(supabase, ip);
  if (!session) return json(200, { ok: true, released: false });

  // If client provided a token, require it to match.
  if (providedToken && providedToken !== session.session_token) {
    return json(403, { error: "Invalid seat session token." });
  }
  // If client provided a seat, ensure it matches the bound one (prevents weirdness).
  if (Number.isFinite(providedSeat) && providedSeat > 0 && providedSeat !== session.seat_id) {
    return json(403, { error: "Seat mismatch." });
  }

  const released = await releaseSession(supabase, ip);
  return json(200, { ok: true, released });
}

    if (action === "heartbeat") {
      if (role !== "member") return json(403, { error: "Heartbeat requires member role." });

      const seatId = Number(body.seat_id ?? body.seatId ?? body.seat_id);
      const seatSessionToken = cleanStr(body.seat_session_token, 200);

      // Use stored payload if client included; but we can also lookup by IP
      const session = await getSessionByIp(supabase, ip);
      if (!session) return json(200, { ok: false });

      // Only accept if token matches
      if (seatSessionToken && seatSessionToken !== session.session_token) return json(403, { error: "Invalid seat session." });

      await bumpSession(supabase, ip, session.seat_id, session.session_token);
      return json(200, { ok: true });
    }

    if (action === "cast_vote") {
      if (role !== "member") return json(403, { error: "Only members can vote." });

      const choice = choiceNormalize(body.choice);
      if (!choice) return json(400, { error: "Invalid choice." });

      const session = await getSessionByIp(supabase, ip);
      if (!session) return json(403, { error: "No active seat session. Claim a seat first." });

      // Require token match (stops someone forging IP-based requests from a different session)
      const seatSessionToken = cleanStr(body.seat_session_token, 200);
      if (!seatSessionToken || seatSessionToken !== session.session_token) {
        return json(403, { error: "Invalid seat session token." });
      }

      // Expiry check
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await releaseSession(supabase, ip);
        return json(403, { error: "Seat session expired. Re-claim your seat." });
      }

      const current = await getActiveResolution(supabase);
      if (!current?.id || current.status !== "open") {
        return json(409, { error: "No open vote." });
      }

      const upsert = {
        resolution_id: current.id,
        seat_id: session.seat_id,
        choice,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("seat_votes")
        .upsert(upsert, { onConflict: "resolution_id,seat_id" });

      if (error) throw error;

      return json(200, { ok: true });
    }

    if (action === "start_vote") {
      if (role !== "presidency") return json(403, { error: "Presidency authority required." });

      const title = cleanStr(body.title, 140);
      const summary = cleanStr(body.summary, 240);
      const resBody = cleanStr(body.body, 8000);
      if (!title || !resBody) return json(400, { error: "Missing title or resolution text." });

      // Close any open vote first + clear votes for it
      const current = await getActiveResolution(supabase);
      if (current?.status === "open") {
        await setResolutionClosed(supabase, current.id);
        await clearSeatVotes(supabase, current.id);
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

    if (action === "end_vote") {
      if (role !== "presidency") return json(403, { error: "Presidency authority required." });

      const current = await getActiveResolution(supabase);
      if (!current?.id) return json(409, { error: "No vote exists to end." });
      if (current.status !== "open") return json(409, { error: "Vote already closed." });

      const votes = await getSeatVotesMap(supabase, current.id);

      // tally
      let aye = 0, nay = 0, abs = 0, cast = 0;
      const lines = [];
      const totalSeats = seatsTotal;

      for (let seat = 1; seat <= totalSeats; seat++) {
        const ch = votes[String(seat)] || "none";
        if (ch === "none") continue;
        cast++;
        if (ch === "aye") aye++;
        if (ch === "nay") nay++;
        if (ch === "abstain") abs++;
        lines.push(`• Seat ${String(seat).padStart(3,"0")}: ${ch.toUpperCase()}`);
      }

      const content =
        `**OFN Vote Concluded**\n` +
        `**${current.title || "Untitled Resolution"}**\n` +
        (current.summary ? `_${current.summary}_\n` : "") +
        `\n**Result** — Aye: **${aye}**, Nay: **${nay}**, Abstain: **${abs}**, Cast: **${cast}** / ${totalSeats}\n` +
        `\n**Seat Ledger (cast only)**\n` +
        (lines.length ? lines.join("\n") : "_No votes cast._");

      const discordWebhook = process.env.DISCORD_WEBHOOK_URL || "";
      const discordPosted = await postDiscord(discordWebhook, { content });

      // close + clear votes so the next resolution starts clean
      await setResolutionClosed(supabase, current.id);
      await clearSeatVotes(supabase, current.id);

      return json(200, { ok: true, discordPosted });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(500, { error: err?.message || "Server error." });
  }
}

