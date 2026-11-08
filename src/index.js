const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") ctx.waitUntil(fetchTop20AndStore(env));
    if (event.cron === "0 0 * * *") {
      ctx.waitUntil(fetchAllAndStore(env));
      ctx.waitUntil(fetchMemosAndStore(env)); // Also fetch memos daily
    }
    // Run memos every 15 mins
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(fetchMemosAndStore(env)); 
    }
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

    if (url.pathname === "/api/export") {
      const { results } = await env.DB.prepare("SELECT address, amount FROM holders ORDER BY amount DESC").all();
      let csv = "Address,RawAmount,FormattedAmount\n";
      for (const row of results) csv += `${row.address},${row.amount},${(row.amount / 1000000).toFixed(2)}\n`;
      return new Response(csv, { headers: { ...corsHeaders, "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=sfm_holders.csv" } });
    }

    if (url.pathname === "/api/refresh") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.REFRESH_SECRET}`) return json({ error: "Unauthorized" }, 401);
      try { return json(await fetchTop20AndStore(env)); } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname.startsWith("/api/wallet/")) {
      const address = url.pathname.split("/").pop();
      const { results } = await env.DB.prepare("SELECT * FROM holders WHERE address = ?").bind(address).all();
      if (results.length === 0) return json({ error: "Wallet not found" }, 404);
      return json({ status: "ok", wallet: results[0] });
    }

    if (url.pathname === "/api/prove") {
      const address = url.searchParams.get("address");
      const minAmount = parseFloat(url.searchParams.get("min") || "1");
      if (!address) return json({ error: "Missing address" }, 400);

      const proof = await calculateProof(env, address, minAmount);
      if (proof.status === "failed") return json(proof);

      // Check credits balance
      const { results: credits } = await env.DB.prepare("SELECT * FROM credits WHERE address = ?").bind(address).all();
      proof.credit_balance = credits[0]?.balance || 0;

      return json(proof);
    }

    // NEW: CLAIM ENDPOINT
    if (url.pathname === "/api/claim" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: "Invalid JSON body" }, 400); }
      
      const address = body.address;
      const minAmount = parseFloat(body.min || "1");
      if (!address) return json({ error: "Missing address" }, 400);

      const proof = await calculateProof(env, address, minAmount);
      if (proof.status === "failed") return json({ error: "Not eligible for credits", reason: proof.message }, 400);

      const now = Math.floor(Date.now() / 1000);
      
      // Check existing credits and cooldown (24h = 86400s)
      const { results: current } = await env.DB.prepare("SELECT * FROM credits WHERE address = ?").bind(address).all();
      const lastClaimed = current[0]?.last_claimed_at || 0;
      
      if (now - lastClaimed < 86400) {
        const hoursLeft = ((86400 - (now - lastClaimed)) / 3600).toFixed(1);
        return json({ error: "Cooldown active", message: `You can claim again in ${hoursLeft} hours.`, current_balance: current[0].balance }, 429);
      }

      // Calculate earned credits (e.g., Score / 100)
      const score = parseFloat(proof.holder_score);
      const earned = score / 10; // Adjusted ratio for the new math
      const newBalance = (current[0]?.balance || 0) + earned;

      // Update Balance
      await env.DB.prepare("INSERT OR REPLACE INTO credits (address, balance, last_claimed_at) VALUES (?, ?, ?)")
        .bind(address, newBalance, now).run();
      // Log transaction
      await env.DB.prepare("INSERT INTO transactions (from_address, to_address, amount, tx_type, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("SYSTEM_MINT", address, earned, "claim", now).run();

      return json({
        status: "success",
        message: `Successfully claimed ${earned.toFixed(2)} credits!`,
        credits_earned: earned.toFixed(2),
        new_balance: newBalance.toFixed(2)
      });
    }

    // LEADERBOARD ENDPOINT
    if (url.pathname === "/api/leaderboard") {
      const { results } = await env.DB.prepare("SELECT address, balance FROM credits ORDER BY balance DESC LIMIT 10").all();
      return json({ status: "ok", leaderboard: results });
    }

    // TRANSFER ENDPOINT — DISABLED (requires wallet signature auth)
    if (url.pathname === "/api/transfer" && request.method === "POST") {
      return json({ 
        error: "Not implemented", 
        message: "Transfer endpoint requires wallet signature authentication (Solana ed25519 verify) which is not yet implemented. Please use the /api/claim endpoint for now." 
      }, 501);
    }
    
    // (Disabled code below for reference)
    if (false) {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: "Invalid JSON" }, 400); }
      
      const from = body.from;
      const to = body.to;
      const amount = parseFloat(body.amount);

      if (!from || !to || isNaN(amount) || amount <= 0) return json({ error: "Missing or invalid parameters" }, 400);
      if (from === to) return json({ error: "Cannot transfer to yourself" }, 400);

      // Check sender balance
      const { results: sender } = await env.DB.prepare("SELECT balance FROM credits WHERE address = ?").bind(from).all();
      const senderBalance = sender[0]?.balance || 0;

      if (senderBalance < amount) return json({ error: "Insufficient credits" }, 400);

      const now = Math.floor(Date.now() / 1000);

      // Execute atomic transfer
      await env.DB.batch([
        env.DB.prepare("UPDATE credits SET balance = balance - ? WHERE address = ?").bind(amount, from),
        env.DB.prepare("INSERT OR IGNORE INTO credits (address, balance) VALUES (?, 0)").bind(to),
        env.DB.prepare("UPDATE credits SET balance = balance + ? WHERE address = ?").bind(amount, to),
        env.DB.prepare("INSERT INTO transactions (from_address, to_address, amount, tx_type, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(from, to, amount, "transfer", now)
      ]);

      return json({ status: "success", message: `Successfully transferred ${amount} credits.` });
    }

    // WHALE ACTIVITY ENDPOINT
    if (url.pathname === "/api/whales/activity") {
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);

      // Find each address's most recent snapshot and their earliest snapshot in the window
      const { results } = await env.DB.prepare(`
        SELECT 
          address,
          MAX(CASE WHEN snapshot_at >= ? THEN amount END) as current_amount,
          MIN(CASE WHEN snapshot_at >= ? THEN amount END) as earliest_amount,
          MAX(snapshot_at) as last_seen
        FROM snapshots
        WHERE snapshot_at >= ?
        GROUP BY address
        HAVING current_amount != earliest_amount
        ORDER BY ABS(current_amount - earliest_amount) DESC
        LIMIT 20
      `).bind(cutoff, cutoff, cutoff).all();

      const movements = results.map(r => ({
        address: r.address,
        current_balance: (r.current_amount / 1000000).toFixed(2),
        previous_balance: (r.earliest_amount / 1000000).toFixed(2),
        delta: ((r.current_amount - r.earliest_amount) / 1000000).toFixed(2),
        direction: r.current_amount > r.earliest_amount ? "BUY" : "SELL",
        last_updated: r.last_seen
      }));

      return json({ 
        status: "ok", 
        window_hours: hours,
        count: movements.length, 
        movements 
      });
    }

    // MEMOS ENDPOINT
    if (url.pathname === "/api/memos") {
      const { results } = await env.DB.prepare("SELECT * FROM memos ORDER BY block_time DESC LIMIT 50").all();
      return json({ status: "ok", count: results.length, memos: results });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// Helper to calculate proof (reused in /prove and /claim)
async function calculateProof(env, address, minAmount) {
  const { results: breaks } = await env.DB.prepare("SELECT MAX(snapshot_at) as break_time FROM snapshots WHERE address = ? AND amount < ?").bind(address, minAmount).all();
  const lastBreak = breaks[0]?.break_time;

  let query = "SELECT MIN(snapshot_at) as start_time, COUNT(*) as snapshots FROM snapshots WHERE address = ? AND amount >= ?";
  let params = [address, minAmount];
  if (lastBreak) { query += " AND snapshot_at > ?"; params.push(lastBreak); }

  const { results: starts } = await env.DB.prepare(query).bind(...params).all();
  const startTime = starts[0]?.start_time;

  if (!startTime) return { status: "failed", message: "Currently not holding the minimum amount", address };

  const { results: current } = await env.DB.prepare("SELECT amount FROM holders WHERE address = ?").bind(address).all();
  if (!current[0] || current[0].amount < minAmount) return { status: "failed", message: "Sold recently", address };

  const now = Math.floor(Date.now() / 1000);
  const durationSeconds = now - startTime;
  const durationDays = durationSeconds / 86400;
  const currentAmount = current[0].amount / 1000000; 
  // NEW MATH: Math.sqrt(Tokens) * Days
  const score = (Math.sqrt(currentAmount) * durationDays).toFixed(2);

  return {
    status: "proven",
    address: address,
    current_balance: currentAmount,
    duration_hours: (durationSeconds / 3600).toFixed(2),
    duration_days: durationDays.toFixed(2),
    holder_score: score
  };
}

async function fetchTop20AndStore(env) {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const payload = { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [MINT_ADDRESS, { commitment: "confirmed" }] };
  const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Helius error`);
  const data = await response.json();
  if (data.error) throw new Error(`RPC error`);

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
}

async function fetchMemosAndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  
  // 1. Get recent signatures for the mint
  const sigPayload = {
    jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
    params: [MINT_ADDRESS, { limit: 20 }] // Fetch last 20 txs
  };

  const sigRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sigPayload) });
  if (!sigRes.ok) throw new Error("Failed to fetch signatures");
  const sigData = await sigRes.json();
  
  if (!sigData.result) return { status: "ok", count: 0 };

  let memoCount = 0;
  const stmts = [];

  for (const sigInfo of sigData.result) {
    // Check if we already processed this signature
    const { results: existing } = await env.DB.prepare("SELECT signature FROM memos WHERE signature = ?").bind(sigInfo.signature).all();
    if (existing.length > 0) continue; // Skip already processed

    // Fetch the full transaction to find memos
    const txPayload = {
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
    };
    
    const txRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(txPayload) });
    if (!txRes.ok) continue;
    const txData = await txRes.json();
    
    if (!txData.result) continue;
    
    const instructions = txData.result.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.program === "spl-memo" && typeof ix.parsed === "string") {
        // We found a memo!
        const wallet = txData.result.transaction.message.accountKeys[0]?.pubkey || "unknown";
        const blockTime = txData.result.blockTime;
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO memos (signature, wallet, memo, block_time) VALUES (?, ?, ?, ?)")
          .bind(sigInfo.signature, wallet, ix.parsed, blockTime));
        memoCount++;
      }
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  return { status: "ok", mode: "memos", count: memoCount };
}

async function fetchAllAndStore(env) {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const now = Math.floor(Date.now() / 1000);
  let page = 1;
  let hasMore = true;
  let totalStored = 0;

  while (hasMore) {
    const payload = { jsonrpc: "2.0", id: "1", method: "getTokenAccounts", params: { mint: MINT_ADDRESS, page: page, limit: 1000 } };
    const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) break;
    const data = await response.json();
    if (!data.result || !data.result.token_accounts || data.result.token_accounts.length === 0) break;

    const holdersStmts = [];
    const snapshotStmts = [];
    for (const acc of data.result.token_accounts) {
      if (acc.amount > 0) {
        holdersStmts.push(env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES (?, ?, ?)").bind(acc.owner, acc.amount, now));
        snapshotStmts.push(env.DB.prepare("INSERT OR REPLACE INTO snapshots (address, amount, snapshot_at) VALUES (?, ?, ?)").bind(acc.owner, acc.amount, now));
      }
    }
    if (holdersStmts.length > 0) await env.DB.batch(holdersStmts);
    if (snapshotStmts.length > 0) await env.DB.batch(snapshotStmts);
    totalStored += holdersStmts.length;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }
  return { status: "ok", mode: "full_sweep", count: totalStored };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
