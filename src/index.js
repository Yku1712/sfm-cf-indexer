const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("SFM Indexer API\n\nEndpoints:\n- /api/holders?limit=N\n- /api/health\n- /api/refresh\n- /api/prove?address=ADDRESS&min=AMOUNT\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/api/health") {
      const now = Math.floor(Date.now() / 1000);
      const { results: latest } = await env.DB.prepare("SELECT MAX(updated_at) as last_update, COUNT(*) as total FROM holders").all();
      return json({
        status: "ok",
        mint: MINT_ADDRESS,
        latest_update: latest[0]?.last_update || null,
        last_update_age_sec: latest[0]?.last_update ? now - latest[0].last_update : null,
        total_holders_stored: latest[0]?.total || 0,
      });
    }

    if (url.pathname === "/api/holders") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 1000);
      const { results } = await env.DB.prepare("SELECT * FROM holders ORDER BY amount DESC LIMIT ?").bind(limit).all();
      return json({ mint: MINT_ADDRESS, count: results.length, holders: results });
    }

    if (url.pathname === "/api/prove") {
      const address = url.searchParams.get("address");
      const minAmount = parseFloat(url.searchParams.get("min") || "1");
      
      if (!address) return json({ error: "Missing ?address= parameter" }, 400);

      // Find first and last time they held this amount
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) as snapshots_held, MIN(snapshot_at) as first_seen, MAX(snapshot_at) as last_seen FROM snapshots WHERE address = ? AND amount >= ?"
      ).bind(address, minAmount).all();

      const data = results[0];
      if (data.snapshots_held === 0) {
        return json({ status: "failed", message: "Address has never held this minimum amount", address, min_amount: minAmount });
      }

      const durationSeconds = data.last_seen - data.first_seen;
      return json({
        status: "proven",
        address: address,
        min_amount_held: minAmount,
        first_seen_at: data.first_seen,
        last_seen_at: data.last_seen,
        duration_seconds: durationSeconds,
        duration_hours: (durationSeconds / 3600).toFixed(2),
        snapshots_held: data.snapshots_held
      });
    }

    if (url.pathname === "/api/refresh") {
      try {
        const result = await fetchAndStore(env);
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response("Not found\n", { status: 404 });
  },
};

async function fetchAndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const payload = {
    jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts",
    params: [MINT_ADDRESS, { commitment: "confirmed" }],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);

    const now = Math.floor(Date.now() / 1000);
    const holdersStmts = [];
    const snapshotStmts = [];

    for (const acc of data.result.value) {
      const amt = parseFloat(acc.amount);
      // 1. Update live holders
      holdersStmts.push(env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES (?, ?, ?)").bind(acc.address, amt, now));
      // 2. Save historical snapshot
      snapshotStmts.push(env.DB.prepare("INSERT OR REPLACE INTO snapshots (address, amount, snapshot_at) VALUES (?, ?, ?)").bind(acc.address, amt, now));
    }

    if (holdersStmts.length > 0) await env.DB.batch(holdersStmts);
    if (snapshotStmts.length > 0) await env.DB.batch(snapshotStmts);

    return { status: "ok", count: holdersStmts.length, rpc: "helius" };
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });
}
