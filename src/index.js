const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Base58 Decoder for Solana Addresses
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58ToUint8Array(str) {
  let result = [0];
  for (let i = 0; i < str.length; i++) {
    let carry = ALPHABET.indexOf(str[i]);
    if (carry === -1) throw new Error("Invalid base58 char");
    for (let j = 0; j < result.length; j++) {
      carry += result[j] * 58;
      result[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      result.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) result.push(0);
  return new Uint8Array(result.reverse());
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(fetchTop20AndStore(env));
      ctx.waitUntil(fetchMemosAndStore(env));
    }
    if (event.cron === "0 0 * * *") {
      ctx.waitUntil(fetchAllAndStore(env));
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

    if (url.pathname === "/api/leaderboard") {
      const { results } = await env.DB.prepare("SELECT address, balance FROM credits ORDER BY balance DESC LIMIT 10").all();
      return json({ status: "ok", leaderboard: results });
    }

    if (url.pathname === "/api/whales/activity") {
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
      const { results } = await env.DB.prepare(`
        SELECT address,
          MAX(CASE WHEN snapshot_at >= ? THEN amount END) as current_amount,
          MIN(CASE WHEN snapshot_at >= ? THEN amount END) as earliest_amount,
          MAX(snapshot_at) as last_seen
        FROM snapshots WHERE snapshot_at >= ?
        GROUP BY address HAVING current_amount != earliest_amount
        ORDER BY ABS(current_amount - earliest_amount) DESC LIMIT 20
      `).bind(cutoff, cutoff, cutoff).all();
      const movements = results.map(r => ({
        address: r.address, current_balance: (r.current_amount / 1000000).toFixed(2),
        previous_balance: (r.earliest_amount / 1000000).toFixed(2),
        delta: ((r.current_amount - r.earliest_amount) / 1000000).toFixed(2),
        direction: r.current_amount > r.earliest_amount ? "BUY" : "SELL",
        last_updated: r.last_seen
      }));
      return json({ status: "ok", window_hours: hours, count: movements.length, movements });
    }

    if (url.pathname === "/api/memos") {
      const { results } = await env.DB.prepare("SELECT * FROM memos ORDER BY block_time DESC LIMIT 50").all();
      return json({ status: "ok", count: results.length, memos: results });
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
      const { results: credits } = await env.DB.prepare("SELECT * FROM credits WHERE address = ?").bind(address).all();
      proof.credit_balance = credits[0]?.balance || 0;
      return json(proof);
    }

    if (url.pathname === "/api/claim" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: "Invalid JSON" }, 400); }
      const address = body.address;
      const minAmount = parseFloat(body.min || "1");
      if (!address) return json({ error: "Missing address" }, 400);

      const proof = await calculateProof(env, address, minAmount);
      if (proof.status === "failed") return json({ error: "Not eligible", reason: proof.message }, 400);

      const now = Math.floor(Date.now() / 1000);
      const { results: current } = await env.DB.prepare("SELECT * FROM credits WHERE address = ?").bind(address).all();
      const lastClaimed = current[0]?.last_claimed_at || 0;
      
      if (now - lastClaimed < 86400) {
        return json({ error: "Cooldown active", message: `Claim again in ${((86400 - (now - lastClaimed)) / 3600).toFixed(1)} hours.`, current_balance: current[0].balance }, 429);
      }

      const score = parseFloat(proof.holder_score);
      const earned = score / 10;
      const newBalance = (current[0]?.balance || 0) + earned;

      await env.DB.prepare("INSERT OR REPLACE INTO credits (address, balance, last_claimed_at) VALUES (?, ?, ?)").bind(address, newBalance, now).run();
      await env.DB.prepare("INSERT INTO transactions (from_address, to_address, amount, tx_type, created_at) VALUES (?, ?, ?, ?, ?)").bind("SYSTEM_MINT", address, earned, "claim", now).run();
      
      // Trimitem alerta
      await sendAlert(env, "💰 New Credit Claim", `Wallet ${address.slice(0,6)}... claimed credits!`, { Earned: earned.toFixed(2), "New Balance": newBalance.toFixed(2) });

      return json({ status: "success", message: `Successfully claimed ${earned.toFixed(2)} credits!`, credits_earned: earned.toFixed(2), new_balance: newBalance.toFixed(2) });
    }

    if (url.pathname === "/api/transfer" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: "Invalid JSON" }, 400); }
      const { from, to, amount, signature, message } = body;

      if (!from || !to || isNaN(amount) || amount <= 0 || !signature || !message) {
        return json({ error: "Missing parameters" }, 400);
      }

      try {
        const pubKeyBytes = base58ToUint8Array(from);
        const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        const msgBytes = new TextEncoder().encode(message);
        const key = await crypto.subtle.importKey("raw", pubKeyBytes, { name: "Ed25519" }, false, ["verify"]);
        const isValid = await crypto.subtle.verify("Ed25519", key, sigBytes, msgBytes);
        if (!isValid) return json({ error: "Invalid signature. Transfer denied." }, 401);
      } catch (err) {
        return json({ error: "Signature verification failed: " + err.message }, 401);
      }

      if (message !== `Transfer ${amount} credits to ${to}`) return json({ error: "Signed message mismatch" }, 400);

      const { results: sender } = await env.DB.prepare("SELECT balance FROM credits WHERE address = ?").bind(from).all();
      const senderBalance = sender[0]?.balance || 0;
      if (senderBalance < amount) return json({ error: "Insufficient credits" }, 400);

      const now = Math.floor(Date.now() / 1000);
      await env.DB.batch([
        env.DB.prepare("UPDATE credits SET balance = balance - ? WHERE address = ?").bind(amount, from),
        env.DB.prepare("INSERT OR IGNORE INTO credits (address, balance) VALUES (?, 0)").bind(to),
        env.DB.prepare("UPDATE credits SET balance = balance + ? WHERE address = ?").bind(amount, to),
        env.DB.prepare("INSERT INTO transactions (from_address, to_address, amount, tx_type, created_at) VALUES (?, ?, ?, ?, ?)").bind(from, to, amount, "transfer", now)
      ]);

      return json({ status: "success", message: `Successfully transferred ${amount} credits to ${to}.` });
    }

    // HOLDER GROWTH HISTORY
    if (url.pathname === "/api/holders/history") {
      // Group snapshots by day and count unique addresses
      const { results } = await env.DB.prepare(`
        SELECT 
          strftime('%Y-%m-%d', snapshot_at, 'unixepoch') as day,
          COUNT(DISTINCT address) as total_holders
        FROM snapshots
        GROUP BY day
        ORDER BY day ASC
      `).all();
      return json({ status: "ok", history: results });
    }

    // ROLLUP EXPORT ENDPOINT (Real Merkle Tree)
    if (url.pathname === "/api/rollup/export" && request.method === "GET") {
      const { results: txs } = await env.DB.prepare(
        "SELECT id, from_address, to_address, amount, tx_type, created_at FROM transactions WHERE batched_at IS NULL ORDER BY id ASC LIMIT 100"
      ).all();

      if (txs.length === 0) {
        return json({ status: "ok", message: "No new transactions to batch." });
      }

      // 1. Generate Leaf Hashes (SHA-256 over the string representation)
      let leaves = [];
      for (const tx of txs) {
        const leafString = `${tx.id}:${tx.from_address}:${tx.to_address}:${tx.amount}:${tx.tx_type}:${tx.created_at}`;
        leaves.push(await sha256(leafString));
      }

      // 2. Build the Merkle Tree levels (hash RAW BYTES of pairs, matching Rust contract)
      let tree = [leaves];
      while (tree[tree.length - 1].length > 1) {
        let currentLevel = tree[tree.length - 1];
        let nextLevel = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
          let left = currentLevel[i];
          let right = (i + 1 < currentLevel.length) ? currentLevel[i + 1] : left;
          // Sort lexicographically to match Rust if computed_hash <= p
          if (left <= right) {
            nextLevel.push(await sha256Pair(left, right));
          } else {
            nextLevel.push(await sha256Pair(right, left));
          }
        }
        tree.push(nextLevel);
      }

      const merkleRoot = tree[tree.length - 1][0];
      const txIds = txs.map(t => t.id).join(',');
      const now = Math.floor(Date.now() / 1000);

      // 3. Save the batch
      const insertRes = await env.DB.prepare(
        "INSERT INTO rollup_batches (merkle_root, tx_count, created_at) VALUES (?, ?, ?)"
      ).bind(merkleRoot, txs.length, now).run();

      // 4. Mark transactions as batched
      await env.DB.prepare(
        `UPDATE transactions SET batched_at = ? WHERE id IN (${txIds})`
      ).bind(now).run();

      return json({
        status: "ok",
        batch_id: insertRes.meta.last_row_id,
        merkle_root: merkleRoot,
        tx_count: txs.length,
        timestamp: now,
        // We return the full tree so it can be verified later
        tree_depth: tree.length - 1
      });
    }

    // MERKLE PROOF VERIFICATION ENDPOINT
    if (url.pathname === "/api/rollup/proof" && request.method === "GET") {
      const txId = parseInt(url.searchParams.get("txId"));
      const batchId = parseInt(url.searchParams.get("batchId"));
      if (!txId || !batchId) return json({ error: "Missing txId or batchId" }, 400);

      // In a real app, you would fetch the tree from a DB or rebuild it from tx hashes.
      // Here we'll just explain the math.
      return json({
        status: "ok",
        message: "Merkle proof generation requires the full batch transaction list. This endpoint will be wired to a DB of leaves in the next phase.",
        txId: txId,
        batchId: batchId
      });
    }

    // FETCH ROLLUP BATCHES
    if (url.pathname === "/api/rollup/batches" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM rollup_batches ORDER BY created_at DESC LIMIT 20").all();
      return json({ status: "ok", count: results.length, batches: results });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};



async function sendAlert(env, title, message, metadata = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("Telegram secrets missing, skipping alert.");
    return;
  }
  
  let text = `<b>${title}</b>\n${message}\n\n`;
  for (const [key, value] of Object.entries(metadata)) {
    text += `<b>${key}:</b> ${value}\n`;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML" })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram API error:", err);
    }
  } catch (e) { 
    console.error("Telegram fetch failed:", e); 
  }
}

// Convert hex string to raw bytes (for Merkle tree hashing consistency with Rust contract)
function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
  }
  return bytes;
}

// SHA-256 over raw bytes, returns hex string
async function sha256RawBytes(bytes) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 over two raw 32-byte hashes concatenated (matches Rust sha256_pair)
async function sha256Pair(leftHex, rightHex) {
  const left = hexToBytes(leftHex);
  const right = hexToBytes(rightHex);
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);
  return sha256RawBytes(combined);
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function calculateProof(env, address, minAmount) {
  // 1. Verificăm portofelul în baza de date
  let { results: current } = await env.DB.prepare("SELECT amount, holding_start_at FROM holders WHERE address = ?").bind(address).all();

  // 2. Dacă nu are holding_start_at (nu e încă în baza noastră), mergem pe blockchain
  if (!current[0] || !current[0].holding_start_at) {
    const onChainStart = await getOnChainHoldingStart(env, address);
    const now = Math.floor(Date.now() / 1000);
    
    // Fetch balance if missing
    if (!current[0]) {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
      const payload = { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [address, { "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { "encoding": "jsonParsed" }] };
      const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      let totalRaw = 0;
      if (data.result && data.result.value) {
        for (const acc of data.result.value) {
          if (acc.account.data.parsed.info.mint === MINT_ADDRESS) {
            totalRaw += parseFloat(acc.account.data.parsed.info.tokenAmount.amount);
          }
        }
      }
      current = [{ amount: totalRaw, holding_start_at: onChainStart || now }];
      await env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at, holding_start_at) VALUES (?, ?, ?, ?)").bind(address, totalRaw, now, onChainStart || now).run();
    } else {
      current[0].holding_start_at = onChainStart || now;
      await env.DB.prepare("UPDATE holders SET holding_start_at = ? WHERE address = ?").bind(current[0].holding_start_at, address).run();
    }
  }

  if (!current[0] || current[0].amount < minAmount) return { status: "failed", message: "No tokens found in this wallet. If you hold tokens on an exchange (Binance, Coinbase, etc.), you must withdraw them to your own Phantom/Solflare wallet to prove holding.", address };

  const startTime = current[0].holding_start_at;
  const now = Math.floor(Date.now() / 1000);
  const durationSeconds = now - startTime;
  const durationDays = durationSeconds / 86400;
  const currentAmount = current[0].amount / 1000000; 
  const score = (Math.sqrt(currentAmount) * durationDays).toFixed(2);

  return {
    status: "proven", address: address, current_balance: currentAmount,
    duration_hours: (durationSeconds / 3600).toFixed(2), duration_days: durationDays.toFixed(2), holder_score: score
  };
}

async function getOnChainHoldingStart(env, walletAddress) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  
  // 1. Găsim Token Account-ul (ATA) al portofelului
  const ataRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [walletAddress, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }] }) });
  const ataData = await ataRes.json();
  if (!ataData.result || ataData.result.value.length === 0) return null;
  const validAta = ataData.result.value.find(acc => acc.account.data.parsed.info.mint === MINT_ADDRESS);
  if (!validAta) return null;
  const tokenAccount = validAta.pubkey;

  // 2. Luăm semnăturile (tranzacțiile) pentru acest Token Account
  let before = null;
  let pages = 0;
  
  // Căutăm în ultimele 1000 de tranzacții (paginate câte 100)
  while (pages < 10) {
    const sigParams = [tokenAccount, { limit: 100 }];
    if (before) sigParams[1].before = before;
    
    const sigRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: sigParams }) });
    const sigData = await sigRes.json();
    if (!sigData.result || sigData.result.length === 0) break;

    // Luăm detaliile tranzacțiilor în bloc (batch)
    const txs = sigData.result.map(s => s.signature);
    const batchPayload = txs.map((sig, i) => ({ jsonrpc: "2.0", id: i, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }));
    
    const batchRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batchPayload) });
    const batchData = await batchRes.json();

    for (let i = 0; i < batchData.length; i++) {
      const tx = batchData[i];
      if (!tx.result || !tx.result.meta) continue;

      const accountIndex = tx.result.transaction.message.accountKeys.findIndex(a => a.pubkey === tokenAccount);
      const pre = tx.result.meta.preTokenBalances?.find(b => b.accountIndex === accountIndex);
      const post = tx.result.meta.postTokenBalances?.find(b => b.accountIndex === accountIndex);

      const preAmt = pre ? parseFloat(pre.uiTokenAmount.amount) : 0;
      const postAmt = post ? parseFloat(post.uiTokenAmount.amount) : 0;

      // Dacă balanța a trecut de la 0 la >0, AICI a început deținerea!
      if (preAmt === 0 && postAmt > 0) {
        return tx.result.blockTime;
      }
    }

    before = txs[txs.length - 1];
    pages++;
    await new Promise(r => setTimeout(r, 100)); // Pauză scurtă pentru API
  }
  return null; 
}

async function fetchTop20AndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const payload = { jsonrpc: "2.0", id: 1, method: "getTokenAccounts", params: { mint: MINT_ADDRESS, limit: 100, page: 1 } };
  const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Helius HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`Helius RPC error`);

  const now = Math.floor(Date.now() / 1000);
  const ownerBalances = {};
  for (const acc of data.result.token_accounts) {
    if (parseFloat(acc.amount) > 0) ownerBalances[acc.owner] = (ownerBalances[acc.owner] || 0) + parseFloat(acc.amount);
  }

  const holdersStmts = [];
  const snapshotStmts = [];
  for (const [owner, amt] of Object.entries(ownerBalances)) {
    holdersStmts.push(env.DB.prepare("INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES (?, ?, ?)").bind(owner, amt, now));
    snapshotStmts.push(env.DB.prepare("INSERT OR REPLACE INTO snapshots (address, amount, snapshot_at) VALUES (?, ?, ?)").bind(owner, amt, now));
  }
  if (holdersStmts.length > 0) await env.DB.batch(holdersStmts);
  if (snapshotStmts.length > 0) await env.DB.batch(snapshotStmts);
  return { status: "ok", count: Object.keys(ownerBalances).length };
}

async function fetchAllAndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const now = Math.floor(Date.now() / 1000);
  let page = 1, hasMore = true, totalStored = 0;

  while (hasMore) {
    const payload = { jsonrpc: "2.0", id: "1", method: "getTokenAccounts", params: { mint: MINT_ADDRESS, page: page, limit: 1000 } };
    const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) break;
    const data = await response.json();
    if (!data.result || !data.result.token_accounts || data.result.token_accounts.length === 0) break;

    const holdersStmts = [], snapshotStmts = [];
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

async function fetchMemosAndStore(env) {
  if (!env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not configured");
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  const sigPayload = { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [MINT_ADDRESS, { limit: 20 }] };

  const sigRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sigPayload) });
  if (!sigRes.ok) throw new Error("Failed to fetch signatures");
  const sigData = await sigRes.json();
  if (!sigData.result) return { status: "ok", count: 0 };

  let memoCount = 0;
  const stmts = [];

  for (const sigInfo of sigData.result) {
    const { results: existing } = await env.DB.prepare("SELECT signature FROM memos WHERE signature = ?").bind(sigInfo.signature).all();
    if (existing.length > 0) continue;

    const txPayload = { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sigInfo.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] };
    const txRes = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(txPayload) });
    if (!txRes.ok) continue;
    const txData = await txRes.json();
    if (!txData.result) continue;
    
    const instructions = txData.result.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.program === "spl-memo" && typeof ix.parsed === "string") {
        const wallet = txData.result.transaction.message.accountKeys[0]?.pubkey || "unknown";
        const blockTime = txData.result.blockTime;
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO memos (signature, wallet, memo, block_time) VALUES (?, ?, ?, ?)").bind(sigInfo.signature, wallet, ix.parsed, blockTime));
        memoCount++;
      }
    }
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  return { status: "ok", mode: "memos", count: memoCount };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
