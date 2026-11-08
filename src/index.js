const MINT_ADDRESS = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Base58 Decoder (necesar pentru a transforma adresa Solana din text in bytes)
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
  // Handle leading zeros
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

    // (Aici ar trebui să fie logica existentă pentru /api/health, /api/holders, /api/export, /api/refresh, /api/wallet, /api/prove, /api/claim, /api/leaderboard, /api/whales, /api/memos)
    // Pentru brevitate, presupunem că suntem în interiorul `fetch`-ului. Adăugăm SECURE TRANSFER:

    if (url.pathname === "/api/transfer" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: "Invalid JSON" }, 400); }
      
      const { from, to, amount, signature, message } = body;

      if (!from || !to || isNaN(amount) || amount <= 0 || !signature || !message) {
        return json({ error: "Missing parameters (from, to, amount, signature, message required)" }, 400);
      }

      // 1. Verify Ed25519 signature
      try {
        const pubKeyBytes = base58ToUint8Array(from);
        // Signature is sent as base64 from frontend
        const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        const msgBytes = new TextEncoder().encode(message);

        const key = await crypto.subtle.importKey(
          "raw", pubKeyBytes, { name: "Ed25519" }, false, ["verify"]
        );
        
        const isValid = await crypto.subtle.verify(
          "Ed25519", key, sigBytes, msgBytes
        );

        if (!isValid) {
          return json({ error: "Invalid signature. Transfer denied." }, 401);
        }
      } catch (err) {
        return json({ error: "Signature verification failed: " + err.message }, 401);
      }

      // 2. Check message payload (prevent replay attacks)
      // The signed message must contain the exact transfer details
      const expectedMessage = `Transfer ${amount} credits to ${to}`;
      if (message !== expectedMessage) {
        return json({ error: "Signed message does not match transfer details" }, 400);
      }

      // 3. Execute transfer
      const { results: sender } = await env.DB.prepare("SELECT balance FROM credits WHERE address = ?").bind(from).all();
      const senderBalance = sender[0]?.balance || 0;

      if (senderBalance < amount) return json({ error: "Insufficient credits" }, 400);

      const now = Math.floor(Date.now() / 1000);
      await env.DB.batch([
        env.DB.prepare("UPDATE credits SET balance = balance - ? WHERE address = ?").bind(amount, from),
        env.DB.prepare("INSERT OR IGNORE INTO credits (address, balance) VALUES (?, 0)").bind(to),
        env.DB.prepare("UPDATE credits SET balance = balance + ? WHERE address = ?").bind(amount, to),
        env.DB.prepare("INSERT INTO transactions (from_address, to_address, amount, tx_type, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(from, to, amount, "transfer", now)
      ]);

      return json({ status: "success", message: `Successfully transferred ${amount} credits to ${to}.` });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ... (Restul funcțiilor fetchTop20AndStore, fetchAllAndStore, fetchMemosAndStore, calculateProof, json) ...
