#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sign-pe-from-wsl.sh <file> [file ...] [--outdir <dir>]

Fallback helper to sign one or more Windows PE files from WSL using cs.

Behavior:
- accept WSL or Windows source paths
- stage each input into writable Windows temp storage
- clear Windows read-only flags on staged files
- sign staged copies with cs using Windows-native paths
- verify Authenticode status and changed hash/size
- overwrite originals by default, or write signed copies into --outdir

Notes:
- primary standalone/release builds now sign in writable Windows temp storage directly
- use this helper for ad-hoc WSL-path files or manual recovery flows
- reject duplicate basenames when --outdir would collide
- keep source files untouched if signing or verification fails
EOF
}

die() {
  printf '[sign-pe] %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

is_windows_path() {
  [[ "$1" =~ ^[A-Za-z]:[\\/].* || "$1" =~ ^\\\\.* ]]
}

to_wsl_path() {
  local path="$1"
  if is_windows_path "$path"; then
    wslpath -u "$path"
  else
    printf '%s\n' "$path"
  fi
}

to_win_path() {
  wslpath -w "$1"
}

ps_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

set_windows_writable() {
  local win_path="$1"
  local quoted
  quoted="$(ps_quote "$win_path")"
  powershell.exe -NoProfile -Command "\$item = Get-Item -LiteralPath '$quoted'; \$item.IsReadOnly = \$false" >/dev/null
}

verify_authenticode() {
  local win_path="$1"
  local quoted
  quoted="$(ps_quote "$win_path")"
  powershell.exe -NoProfile -Command "\$sig = Get-AuthenticodeSignature -LiteralPath '$quoted'; if (\$sig.Status -ne 'Valid') { Write-Error ('Authenticode status: ' + \$sig.Status + ' ' + \$sig.StatusMessage); exit 1 }" >/dev/null
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

OUTDIR=""
declare -a INPUTS=()

while (($#)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --outdir)
      (($# >= 2)) || die "--outdir requires a directory value"
      OUTDIR="$2"
      shift 2
      ;;
    --outdir=*)
      OUTDIR="${1#--outdir=}"
      shift
      ;;
    --)
      shift
      while (($#)); do INPUTS+=("$1"); shift; done
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      INPUTS+=("$1")
      shift
      ;;
  esac
done

((${#INPUTS[@]})) || { usage >&2; exit 2; }

need cs
need powershell.exe
need wslpath
need sha256sum
need stat
need mktemp
need cp
need realpath

local_appdata_win="$(powershell.exe -NoProfile -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r')"
[[ -n "$local_appdata_win" ]] || die "Unable to resolve LOCALAPPDATA from PowerShell"
local_appdata_wsl="$(wslpath -u "$local_appdata_win")"
stage_root="$(mktemp -d "$local_appdata_wsl/Temp/wsl-exe-code-signing.XXXXXX")"
cleanup() { rm -rf "$stage_root"; }
trap cleanup EXIT

outdir_wsl=""
if [[ -n "$OUTDIR" ]]; then
  outdir_wsl="$(to_wsl_path "$OUTDIR")"
  mkdir -p "$outdir_wsl"
fi

declare -a src_wsl_paths=()
declare -a stage_wsl_paths=()
declare -a stage_win_paths=()
declare -a dest_wsl_paths=()
declare -a pre_hashes=()
declare -a pre_sizes=()
declare -A outdir_names=()

for index in "${!INPUTS[@]}"; do
  raw_input="${INPUTS[$index]}"
  src_input_wsl="$(to_wsl_path "$raw_input")"
  [[ -f "$src_input_wsl" ]] || die "Input file not found: $raw_input"
  src_wsl="$(realpath "$src_input_wsl")"
  base_name="$(basename "$src_wsl")"

  if [[ -n "$outdir_wsl" ]]; then
    dest_wsl="$outdir_wsl/$base_name"
    [[ -z "${outdir_names[$base_name]:-}" ]] || die "Duplicate output basename with --outdir: $base_name"
    outdir_names["$base_name"]=1
  else
    dest_wsl="$src_wsl"
  fi

  stage_wsl="$stage_root/${index}-${base_name}"
  cp "$src_wsl" "$stage_wsl"
  stage_win="$(to_win_path "$stage_wsl")"
  set_windows_writable "$stage_win"

  src_wsl_paths+=("$src_wsl")
  stage_wsl_paths+=("$stage_wsl")
  stage_win_paths+=("$stage_win")
  dest_wsl_paths+=("$dest_wsl")
  pre_hashes+=("$(sha256_file "$stage_wsl")")
  pre_sizes+=("$(stat -c '%s' "$stage_wsl")")
done

cs "${stage_win_paths[@]}"

for index in "${!stage_wsl_paths[@]}"; do
  post_hash="$(sha256_file "${stage_wsl_paths[$index]}")"
  post_size="$(stat -c '%s' "${stage_wsl_paths[$index]}")"
  [[ "$post_hash" != "${pre_hashes[$index]}" ]] || die "Signed hash did not change for ${src_wsl_paths[$index]}"
  [[ "$post_size" != "${pre_sizes[$index]}" ]] || die "Signed size did not change for ${src_wsl_paths[$index]}"
  verify_authenticode "${stage_win_paths[$index]}"
done

for index in "${!stage_wsl_paths[@]}"; do
  dest_wsl="${dest_wsl_paths[$index]}"
  mkdir -p "$(dirname "$dest_wsl")"
  if [[ -e "$dest_wsl" && "$dest_wsl" == /mnt/* ]]; then
    set_windows_writable "$(to_win_path "$dest_wsl")"
  fi
  cp -f "${stage_wsl_paths[$index]}" "$dest_wsl"
done

printf 'Signed %d file(s).\n' "${#src_wsl_paths[@]}"
for index in "${!src_wsl_paths[@]}"; do
  printf '  %s -> %s\n' "${src_wsl_paths[$index]}" "${dest_wsl_paths[$index]}"
done
