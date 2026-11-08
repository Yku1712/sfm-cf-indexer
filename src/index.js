const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    if (url.pathname === "/") return new Response("SFM Indexer API", { headers: corsHeaders });

    if (url.pathname === "/api/health") {
      const now = Math.floor(Date.now() / 1000);
      const { results: latest } = await env.DB.prepare("SELECT MAX(updated_at) as last_update, COUNT(*) as total FROM holders").all();
      return json({ status: "ok", mint: MINT_ADDRESS, latest_update: latest[0]?.last_update || null, total_holders_stored: latest[0]?.total || 0 });
    }

    if (url.pathname === "/api/holders") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 5000);
      const { results } = await env.DB.prepare("SELECT * FROM holders ORDER BY amount DESC LIMIT ?").bind(limit).all();
      return json({ mint: MINT_ADDRESS, count: results.length, holders: results });
    }

    // EXPORT CSV FEATURE
    if (url.pathname === "/api/export") {
      const { results } = await env.DB.prepare("SELECT address, amount FROM holders ORDER BY amount DESC").all();
      let csv = "Address,RawAmount,FormattedAmount\n";
      for (const row of results) {
        csv += `${row.address},${row.amount},${(row.amount / 1000000).toFixed(2)}\n`;
      }
      return new Response(csv, {
        headers: { ...corsHeaders, "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=sfm_holders.csv" }
      });
    }

    // SECURED REFRESH
    if (url.pathname === "/api/refresh") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.REFRESH_SECRET}`) return json({ error: "Unauthorized" }, 401);
      try { return json(await fetchAndStore(env)); } catch (e) { return json({ error: e.message }, 500); }
    }

    // PROOF & SCORE LOGIC
    if (url.pathname === "/api/prove") {
      const address = url.searchParams.get("address");
      const minAmount = parseFloat(url.searchParams.get("min") || "1");
      if (!address) return json({ error: "Missing ?address= parameter" }, 400);

      const { results: breaks } = await env.DB.prepare(
        "SELECT MAX(snapshot_at) as break_time FROM snapshots WHERE address = ? AND amount < ?"
      ).bind(address, minAmount).all();
      const lastBreak = breaks[0]?.break_time;

      let query = "SELECT MIN(snapshot_at) as start_time, COUNT(*) as snapshots FROM snapshots WHERE address = ? AND amount >= ?";
      let params = [address, minAmount];
      if (lastBreak) { query += " AND snapshot_at > ?"; params.push(lastBreak); }

      const { results: starts } = await env.DB.prepare(query).bind(...params).all();
      const startTime = starts[0]?.start_time;

      if (!startTime) return json({ status: "failed", message: "Currently not holding the minimum amount", address });

      const { results: current } = await env.DB.prepare("SELECT amount FROM holders WHERE address = ?").bind(address).all();
      if (!current[0] || current[0].amount < minAmount) return json({ status: "failed", message: "Sold recently", address });

      const now = Math.floor(Date.now() / 1000);
      const durationSeconds = now - startTime;
      const durationDays = durationSeconds / 86400;
      const currentAmount = current[0].amount / 1000000; // Formatted tokens
      
      // SCORE FORMULA: (Tokens held) * (Days held)
      const score = (currentAmount * durationDays).toFixed(2);

      return json({
        status: "proven",
        address: address,
        min_amount_held: minAmount,
        current_balance: currentAmount,
        streak_started_at: startTime,
        duration_hours: (durationSeconds / 3600).toFixed(2),
        duration_days: durationDays.toFixed(2),
        holder_score: score
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

async function fetchAndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const payload = { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [MINT_ADDRESS, { commitment: "confirmed" }] };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`Helius RPC error`);

    const now = Math.floor(Date.now() / 1000);
    const holdersStmts = [];
    const snapshotStmts = [];

    for (const acc of data.result.value) {
      const amt = parseFloat(acc.amount);
      holdersStmts.push(env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES (?, ?, ?)").bind(acc.address, amt, now));
      snapshotStmts.push(env.DB.prepare("INSERT OR REPLACE INTO snapshots (address, amount, snapshot_at) VALUES (?, ?, ?)").bind(acc.address, amt, now));
    }

    if (holdersStmts.length > 0) await env.DB.batch(holdersStmts);
    if (snapshotStmts.length > 0) await env.DB.batch(snapshotStmts);
    return { status: "ok", count: holdersStmts.length };
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
