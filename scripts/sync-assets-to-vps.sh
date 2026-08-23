#!/usr/bin/env bash
# Keep the VPS worker's brand kits + render skills fresh from this Mac.
# The VPS (root@5.161.224.224) runs the Relay drafting worker as user `relay`;
# brands/templates edited on the Mac must reach /home/relay/.claude or VPS
# renders drift off-brand. Incremental rsync — cheap enough to run hourly.
# Installed as a Mac cron (see SETUP.md "VPS worker"); safe to run by hand.
set -Eeuo pipefail

KEY="${HOME}/.ssh/id_ed25519"
DEST="root@5.161.224.224"

# ALERTING (added 2026-08-23). Before this the script printed exactly one line ever
# ("assets synced to VPS") and `set -e` killed it silently on a failed rsync/ssh, so a
# failed run and a good run looked identical in the log: the VPS could drift stale for
# days unnoticed. Every failure now prints an explicit FAILED line AND pushes to the
# phone on the same ntfy topic the Relay worker and postiz-monitor.sh already use.
PUSH_URL="https://ntfy.sh/nynm-relay-90299f6d"
push_phone() {
  local title="$1" body="$2" priority="${3:-high}" tags="${4:-warning}"
  curl -s -m 10 -H "Title: $title" -H "Priority: $priority" -H "Tags: $tags" -d "$body" "$PUSH_URL" >/dev/null 2>&1 \
    || echo "$(date -u +%FT%TZ) push_phone FAILED: $title"
}

# STEP names whichever transfer is in flight so the alert says WHAT broke, not just that
# something did. The ERR trap catches every rsync/ssh non-zero exit (set -E propagates it
# into RS()); `|| true` guarded commands are exempt, same as under set -e.
STEP="startup"
on_fail() {
  local code=$1
  local mark=""
  [ "${TEST_FAIL:-0}" = "1" ] && mark=" (TEST_FAIL drill, not a real outage)"
  echo "$(date -u +%FT%TZ) FAILED (exit $code): $STEP$mark"
  push_phone "Asset sync FAILED$mark" "sync-assets-to-vps.sh exited $code during: $STEP. The VPS worker's brands/skills are stale, renders will drift off-brand until this is fixed.$mark" "high" "warning"
  exit "$code"
}
trap 'on_fail $?' ERR

RS() {
  # TEST_FAIL=1 aims the transfer at TEST-NET-1 (192.0.2.1, unroutable by definition) to
  # prove the alert branch really fires. Testing only, never set in normal operation.
  if [ "${TEST_FAIL:-0}" = "1" ]; then
    rsync -az -e "ssh -o BatchMode=yes -o ConnectTimeout=5" /dev/null "root@192.0.2.1:/tmp/asset-sync-test-fail"
    return
  fi
  rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15" "$@"
}

# Brands: skip bulky per-post output archives (videos/flyers renders) but keep the
# flyer HTML/JSON sources the drain uses for rotation.
STEP="rsync brands -> /home/relay/.claude/brands/"
RS --exclude 'videos/' --exclude 'flyers/' --exclude '_compare/' --exclude '_screenshots/' --exclude '.DS_Store' \
   "$HOME/.claude/brands/" "$DEST:/home/relay/.claude/brands/"
for slug in the-o eats-on-601; do
  RS --include '*/' --include '*.html' --include '*.json' --include '*.md' --exclude '*' \
     "$HOME/.claude/brands/$slug/flyers/" "$DEST:/home/relay/.claude/brands/$slug/flyers/" 2>/dev/null || true
done

# Render/draft skills the drain invokes (node_modules and Python venvs are
# platform-specific — the VPS builds its own).
STEP="rsync skills -> /home/relay/.claude/skills/"
RS --exclude '.venv/' --exclude '.git/' --exclude '.pytest_cache/' --exclude 'node_modules/' --exclude '.DS_Store' \
   "$HOME/.claude/skills/branded-social-post" "$HOME/.claude/skills/imagery" \
   "$HOME/.claude/skills/chatgpt-image" "$HOME/.claude/skills/image2" \
   "$HOME/.claude/skills/branded-collateral" "$HOME/.claude/skills/nynm-design" \
   "$HOME/.claude/skills/post" \
   "$DEST:/home/relay/.claude/skills/"

STEP="ssh chown relay:relay /home/relay/.claude"
ssh -i "$KEY" -o BatchMode=yes "$DEST" 'chown -R relay:relay /home/relay/.claude'
echo "$(date -u +%FT%TZ) assets synced to VPS"

# ---------------------------------------------------------------------------
# OFF-BOX BACKUP PULL (added 2026-08-23, reliability audit)
#
# Everything above pushes Mac -> VPS. This pulls the other way, and it is the only
# thing that makes the VPS nightly fleet snapshot an actual backup: hub.db, the cfsync
# ledger, the Fan Cam leads and the GDT CRM snapshot all live on one disk on one box
# until a copy exists somewhere else. That somewhere else is this Mac.
#
# Two deliberate differences from the pushes above:
#   1. NO --delete. The VPS prunes at 14 days, and a mirrored delete would mean a wiped
#      VPS directory wipes the only surviving copy. This side only ever accumulates.
#   2. It is not allowed to fill this disk. The Mac hit 100% full on 8/22 and sat at 99%
#      when this was written, and the snapshot is ~34 MB a night (about 480 MB at the
#      14-day steady state). Under the floor the pull is skipped loudly rather than
#      becoming the job that finishes the disk off.
PULL_DEST="${VPS_FLEET_BACKUP_DIR:-$HOME/Backups/vps-fleet}"
MIN_FREE_MB="${VPS_FLEET_MIN_FREE_MB:-2048}"

STEP="preflight free space for the backup pull"
mkdir -p "$PULL_DEST"
FREE_MB=$(df -Pk "$PULL_DEST" | awk 'NR==2 {print int($4/1024)}')

if [ "${FREE_MB:-0}" -lt "$MIN_FREE_MB" ]; then
  # Not an ERR-trap failure: the pushes above all succeeded, and taking the whole sync
  # down would stop brand assets reaching the VPS over a disk problem. Loud, and skipped.
  echo "$(date -u +%FT%TZ) SKIPPED backup pull: only ${FREE_MB}MB free at $PULL_DEST (floor ${MIN_FREE_MB}MB)"
  push_phone "VPS backup pull SKIPPED" \
    "Only ${FREE_MB}MB free on the Mac (floor ${MIN_FREE_MB}MB), so tonight's VPS fleet backup was NOT pulled off-box. The VPS snapshot is still the only copy. Free space on the Mac." \
    "high" "warning"
else
  STEP="rsync pull /opt/hq/backups/fleet/ -> $PULL_DEST"
  rsync -az -e "ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15" \
    "$DEST:/opt/hq/backups/fleet/" "$PULL_DEST/"
  PULLED=$(find "$PULL_DEST" -type f | wc -l | tr -d ' ')
  echo "$(date -u +%FT%TZ) VPS fleet backup pulled: $PULLED file(s), $(du -sh "$PULL_DEST" | cut -f1) at $PULL_DEST (${FREE_MB}MB free)"
fi
