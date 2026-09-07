#!/usr/bin/env bash
# Move the uncommittable env files between machines, through git, without ever
# putting a private key in the history.
#
#   ./scripts/secrets-bundle.sh seal     # 4 env files -> secrets.enc  (commit this)
#   ./scripts/secrets-bundle.sh open     # secrets.enc -> 4 env files  (on the laptop)
#   ./scripts/secrets-bundle.sh list     # what a bundle holds, without decrypting to disk
#
# WHY NOT JUST COMMIT THE .env FILES.
#
# Git history is permanent. A key committed once stays in every clone, every
# reflog and every fork, and "we'll remove it later" is a second commit that
# hides nothing. Undoing it properly means rewriting history, force-pushing, and
# rotating every key anyway — at which point rotating was the cheaper path all
# along.
#
# It matters more here than usual because .env.mainnet holds all five SAFE_OWNER
# private keys. A 5-owner Safe exists so that compromising one owner is not
# enough. Five keys in one artefact makes it a 1-of-1, permanently, and no later
# commit takes that back.
#
# WHAT THIS TRADES INSTEAD.
#
# The ciphertext is also permanent once committed. Its whole security is the
# passphrase, so:
#   - use a long random passphrase from a password manager, not something typed
#     from memory;
#   - the passphrase travels by password manager, NEVER through git, chat or
#     email — one short string instead of sixteen keys;
#   - if the passphrase ever leaks, every historical bundle is readable, so treat
#     that as key compromise and rotate.
#
# 600k PBKDF2 iterations because the passphrase is the only thing between the
# ciphertext and the keys.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${REPO}/secrets.enc"
ITER=600000

# The exact set. Adding one here is the only place it needs to be declared.
FILES=(
  ".env"
  ".env.mainnet"
  ".env.docker"
  "packages/web/.env.local"
)

die() { printf '%s\n' "$*" >&2; exit 1; }

# The passphrase reaches openssl through the ENVIRONMENT, never through argv.
# `-pass pass:<value>` would put it in the process table, where any other user on
# the machine can read it with ps. `-pass stdin` is unavailable because stdin is
# already carrying the tar stream.
#
# NUVEM_BUNDLE_PASS may be preset for a scripted run; otherwise it is prompted
# for with echo off. Sealing asks twice, because a typo in a write-only prompt
# produces a bundle that cannot be opened and nothing notices until the other
# machine needs it.
ask_pass() {
  local mode="$1" first second
  if [ -n "${NUVEM_BUNDLE_PASS:-}" ]; then return 0; fi
  [ -t 0 ] || die "No terminal to prompt on. Set NUVEM_BUNDLE_PASS in the environment instead."
  read -rsp "Passphrase: " first; printf '\n' >&2
  [ -n "$first" ] || die "Empty passphrase."
  if [ "$mode" = "seal" ]; then
    read -rsp "Again: " second; printf '\n' >&2
    [ "$first" = "$second" ] || die "They do not match."
    if [ "${#first}" -lt 20 ]; then
      die "That passphrase is ${#first} characters. The ciphertext is permanent once committed, so its whole security is this string — use a long random one from your password manager."
    fi
  fi
  export NUVEM_BUNDLE_PASS="$first"
}

seal() {
  cd "$REPO"
  ask_pass seal
  local missing=()
  for f in "${FILES[@]}"; do [ -f "$f" ] || missing+=("$f"); done
  if [ ${#missing[@]} -gt 0 ]; then
    printf 'Missing, so the bundle would be incomplete:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    die 'Refusing to seal a partial bundle. A partial bundle is worse than none: it looks complete on the other machine.'
  fi

  # tar reads the plaintext and openssl consumes it on a pipe, so no decrypted
  # archive is ever written to disk.
  tar -cf - "${FILES[@]}" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt -pass env:NUVEM_BUNDLE_PASS -out "$BUNDLE"

  chmod 600 "$BUNDLE" 2>/dev/null || true
  printf 'Sealed %s files -> %s (%s bytes)\n' "${#FILES[@]}" "secrets.enc" "$(wc -c < "$BUNDLE" | tr -d ' ')"
  printf '\nCommit it, push, and carry the passphrase in your password manager.\n'
  printf 'Verify before you trust it:  ./scripts/secrets-bundle.sh list\n'
}

open_bundle() {
  cd "$REPO"
  [ -f "$BUNDLE" ] || die "No secrets.enc here. Pull first, or seal one on the other machine."

  local existing=()
  for f in "${FILES[@]}"; do [ -f "$f" ] && existing+=("$f"); done
  if [ ${#existing[@]} -gt 0 ]; then
    printf 'These already exist and would be OVERWRITTEN:\n' >&2
    printf '  %s\n' "${existing[@]}" >&2
    printf 'Move them aside first if they hold anything the bundle does not.\n' >&2
    die 'Refusing to overwrite. Losing a key you had is as bad as never having it.'
  fi

  ask_pass open
  openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -pass env:NUVEM_BUNDLE_PASS -in "$BUNDLE" | tar -xf -
  for f in "${FILES[@]}"; do chmod 600 "$f" 2>/dev/null || true; done

  printf 'Restored:\n'
  printf '  %s\n' "${FILES[@]}"
  printf '\nConfirm git still ignores every one of them:\n'
  for f in "${FILES[@]}"; do
    if git check-ignore -q "$f"; then
      printf '  ignored  %s\n' "$f"
    else
      printf '  NOT IGNORED  %s   <- stop and fix .gitignore before committing anything\n' "$f"
    fi
  done
}

list_bundle() {
  cd "$REPO"
  [ -f "$BUNDLE" ] || die "No secrets.enc here."
  # Names only. Nothing is written to disk and no value is printed.
  ask_pass open
  openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -pass env:NUVEM_BUNDLE_PASS -in "$BUNDLE" | tar -tf -
}

case "${1:-}" in
  seal) seal ;;
  open) open_bundle ;;
  list) list_bundle ;;
  *) die "Usage: $0 {seal|open|list}" ;;
esac
