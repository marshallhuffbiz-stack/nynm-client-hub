#!/usr/bin/env bash
# Keep the VPS worker's brand kits + render skills fresh from this Mac.
# The VPS (root@5.161.224.224) runs the Relay drafting worker as user `relay`;
# brands/templates edited on the Mac must reach /home/relay/.claude or VPS
# renders drift off-brand. Incremental rsync — cheap enough to run hourly.
# Installed as a Mac cron (see SETUP.md "VPS worker"); safe to run by hand.
set -euo pipefail

KEY="${HOME}/.ssh/id_ed25519"
DEST="root@5.161.224.224"
RS() { rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15" "$@"; }

# Brands: skip bulky per-post output archives (videos/flyers renders) but keep the
# flyer HTML/JSON sources the drain uses for rotation.
RS --exclude 'videos/' --exclude 'flyers/' --exclude '_compare/' --exclude '_screenshots/' --exclude '.DS_Store' \
   "$HOME/.claude/brands/" "$DEST:/home/relay/.claude/brands/"
for slug in the-o eats-on-601; do
  RS --include '*/' --include '*.html' --include '*.json' --include '*.md' --exclude '*' \
     "$HOME/.claude/brands/$slug/flyers/" "$DEST:/home/relay/.claude/brands/$slug/flyers/" 2>/dev/null || true
done

# Render/draft skills the drain invokes (node_modules and Python venvs are
# platform-specific — the VPS builds its own).
RS --exclude '.venv/' --exclude '.git/' --exclude '.pytest_cache/' --exclude 'node_modules/' --exclude '.DS_Store' \
   "$HOME/.claude/skills/branded-social-post" "$HOME/.claude/skills/imagery" \
   "$HOME/.claude/skills/chatgpt-image" "$HOME/.claude/skills/image2" \
   "$HOME/.claude/skills/branded-collateral" "$HOME/.claude/skills/nynm-design" \
   "$HOME/.claude/skills/post" \
   "$DEST:/home/relay/.claude/skills/"

ssh -i "$KEY" -o BatchMode=yes "$DEST" 'chown -R relay:relay /home/relay/.claude'
echo "$(date -u +%FT%TZ) assets synced to VPS"
