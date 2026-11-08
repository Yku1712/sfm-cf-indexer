import requests
import json
import os
import time

MINT = "BwUTq7fS6sfUmHDwAiCQZ3asSiPEapW5zDrsbwtapump"
HELIUS_KEY = os.environ.get("HELIUS_API_KEY")

if not HELIUS_KEY or HELIUS_KEY == "CHEIA_TA_AICI":
    print("EROARE: Trebuie să setezi cheia ta reală de Helius, nu textul 'CHEIA_TA_AICI'.")
    exit(1)

url = f"https://mainnet.helius-rpc.com/?api-key={HELIUS_KEY}"

print("Începem descărcarea tuturor deținătorilor...")
all_holders = []
page = 1

while True:
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": "getTokenAccounts",
        "params": {
            "mint": MINT,
            "page": page,
            "limit": 1000
        }
    }
    
    res = requests.post(url, json=payload)
    
    if not res.ok:
        print(f"\nEROARE de la Helius (HTTP {res.status_code}):")
        print(res.text)
        break

    data = res.json()
    
    if "result" not in data or "token_accounts" not in data["result"]:
        print("\nEroare JSON de la Helius:", data)
        break
        
    accounts = data["result"]["token_accounts"]
    if not accounts:
        break
        
    for acc in accounts:
        all_holders.append({
            "address": acc["owner"],
            "amount": acc["amount"]
        })
    
    print(f"Pagina {page}: Am găsit {len(accounts)} portofele.")
    page += 1
    time.sleep(0.5) # Mică pauză ca să nu lovim rate-limit-ul

print(f"\nTotal portofele găsite: {len(all_holders)}")

if len(all_holders) > 0:
    with open("backfill.sql", "w") as f:
        f.write("DELETE FROM holders;\n")
        now = int(time.time())
        
        for h in all_holders:
            if float(h["amount"]) > 0:
                f.write(f"INSERT OR REPLACE INTO holders (address, amount, updated_at) VALUES ('{h['address']}', {h['amount']}, {now});\n")

    print("Fișierul backfill.sql a fost generat cu succes!")
