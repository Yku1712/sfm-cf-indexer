const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndStore(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("SFM Indexer API\n\nEndpoints:\n- /api/holders?limit=N\n- /api/health\n- /api/refresh\n", { headers: { "Content-Type": "text/plain" } });
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
  if (!env.HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY not configured. Run: npx wrangler secret put HELIUS_API_KEY");
  }

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const payload = {
    jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts",
    params: [MINT_ADDRESS, { commitment: "confirmed" }],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Helius HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);
    if (!data.result || !Array.isArray(data.result.value)) throw new Error("Invalid Helius response");

    const now = Math.floor(Date.now() / 1000);
    const stmts = data.result.value.map((acc) =>
      env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES (?, ?, ?)")
        .bind(acc.address, parseFloat(acc.amount), now)
    );

    if (stmts.length > 0) await env.DB.batch(stmts);
    return { status: "ok", count: stmts.length, rpc: "helius" };
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
