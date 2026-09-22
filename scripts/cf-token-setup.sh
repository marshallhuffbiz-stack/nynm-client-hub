#!/usr/bin/env bash
# One-shot Cloudflare Pages token setup for the Relay site lane, run at the keyboard.
# Asks for the API token (pasted, never echoed), verifies it read-only against the
# Cloudflare API (token status, account, Pages projects it can see), then writes
# { "cloudflare": { "apiToken", "accountId" } } into the worker's config.json on the
# VPS with a backup. Nothing is written on this Mac and the token is never printed.
#
#   bash scripts/cf-token-setup.sh
set -u
HOST="${HQ_HOST:-root@5.161.224.224}"
printf 'Paste the Cloudflare API token, then press Return (hidden): '
IFS= read -r -s TOKEN; echo
[ -n "$TOKEN" ] || { echo "FAILED: no token pasted." >&2; exit 1; }

echo "Checking the token..."
V="$(curl -s --max-time 20 https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $TOKEN")"
printf '%s' "$V" | python3 -c 'import sys,json;d=json.load(sys.stdin);ok=d.get("success") and d["result"].get("status")=="active";print("token status:",d.get("result",{}).get("status") or d.get("errors"));sys.exit(0 if ok else 1)' || { echo "FAILED: token not active."; exit 1; }
# A Pages-only token cannot list accounts, so the account id comes from the wrangler
# cache on this Mac (any client site repo has one) or from CF_ACCOUNT_ID.
ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  for f in "/Users/MarshallHuff/New General/mountain-power-wash/.wrangler/cache/wrangler-account.json" "$HOME"/.wrangler/config/*.toml; do
    [ -f "$f" ] || continue
    ACCOUNT_ID="$(grep -o -E '[0-9a-f]{32}' "$f" | head -1)"
    [ -n "$ACCOUNT_ID" ] && break
  done
fi
[ -n "$ACCOUNT_ID" ] || { echo "FAILED: no account id found; rerun with CF_ACCOUNT_ID=<id> in front of the command."; exit 1; }
echo "account id: ${ACCOUNT_ID:0:6}..."
# Plain call, no list options: the Pages endpoint rejects per_page values it dislikes.
P="$(curl -s --max-time 20 "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects" -H "Authorization: Bearer $TOKEN")"
printf '%s' "$P" | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result")
if r is None:
    codes={e.get("code") for e in d.get("errors",[])}
    if codes & {10000,9109,10001,9106}: print("FAILED: the token has no Pages access:",d.get("errors")); sys.exit(1)
    print("Note: could not list projects (",d.get("errors"),"), continuing; the proof upload will settle it.")
else:
    print(f"Pages projects visible: {len(r)}"); [print("  "+p["name"]) for p in r]' || exit 1

echo "Writing the token to the VPS worker config..."
printf '%s\n%s\n' "$TOKEN" "$ACCOUNT_ID" | ssh "$HOST" '
  set -e; C=/home/relay/client-hub/worker/config.json; cp -p $C $C.bak.pre-cloudflare-$(date +%Y%m%d%H%M)
  IFS= read -r t; IFS= read -r a
  T="$t" A="$a" node -e "const fs=require(\"fs\");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,\"utf8\"));c.cloudflare={apiToken:process.env.T,accountId:process.env.A};fs.writeFileSync(p,JSON.stringify(c,null,2)+\"\n\");console.log(\"config keys:\",Object.keys(c.cloudflare).join(\",\"))" $C
  chown relay:relay $C; chmod 600 $C' \
  || { echo "FAILED: the VPS step did not complete. Tell Claude."; exit 1; }
echo "Done. Tell Claude the token is in."
