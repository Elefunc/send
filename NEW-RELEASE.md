# New Release

Release `@elefunc/send` from a fresh `/tmp` clone of `Elefunc/send`.

Do not publish from this local `cli/` directory. Do not reuse local `out/`. GitHub assets must be freshly built in the release clone.

## Prereqs

- WSL2
- `bun`, `gh`, `git`, `rsync`, `tar`
- `powershell.exe`, `wslpath`, `cs`
- Azure Trusted Signing auth already works
- Bun npm auth already works
- run this from the local `cli/` source tree you want to release
- local `cli/package.json` is already bumped to the new version

Preflight:

```bash
gh auth status
az account show --output none
bun pm whoami
```

If `bun pm whoami` fails, fix Bun/npm auth before continuing.

## Vars

```bash
export VERSION=0.1.37
export PREV_VERSION=0.1.36
export SRC_DIR="$(pwd)"
export REL_DIR=/tmp/send-release-$VERSION
export NOTES=/tmp/send-release-$VERSION-notes.md
export WIN_STAGE=/mnt/c/Users/cetin/AppData/Local/Temp/send-release-$VERSION-winstage
export WIN_PS1=/mnt/c/Users/cetin/AppData/Local/Temp/send-release-win-build.ps1
```

## Main Path

```bash
rm -rf "$REL_DIR"
gh repo clone Elefunc/send "$REL_DIR" -- --depth=1

rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude out \
  --exclude downloads \
  --exclude 'Acuity Brands.7z' \
  "$SRC_DIR"/ "$REL_DIR"/

cd "$REL_DIR"
bun install --no-save
bun run typecheck
bun test

git status --short
git add -A
git commit -m "Release v$VERSION"

bun run build:standalone_all
./out/send-linux-x64 --help

bun publish --access public
bun pm view @elefunc/send version --json

git push origin master
git tag "v$VERSION"
git push origin "v$VERSION"
```

Release notes:

```bash
cat > "$NOTES" <<EOF
- TUI `--filter` now matches the web app `#filter` behavior and is preserved in TUI invite/rejoin links.
- Bun `1.3.12` UDP `recv ECONNREFUSED` no longer crashes active sessions.
- TUI sessions now advertise `send-tui` instead of `send-cli`.

**Full Changelog**: https://github.com/Elefunc/send/compare/v$PREV_VERSION...v$VERSION
EOF
```

Create the GitHub release with only the 16 binaries:

```bash
find out -maxdepth 1 -type f \
  \( -name 'send-darwin-*' -o -name 'send-linux-*' -o -name 'send-windows-*.exe' \) \
  -printf '%f\n' | sort

gh release create "v$VERSION" \
  out/send-darwin-* \
  out/send-linux-* \
  out/send-windows-*.exe \
  --repo Elefunc/send \
  --title "v$VERSION" \
  --notes-file "$NOTES"

gh release view "v$VERSION" --repo Elefunc/send
```

Expected assets: 16 total.

- 4 Darwin
- 8 Linux
- 4 Windows `.exe`

## Windows Fallback

Use this only if the Windows phase of `bun run build:standalone_all` hangs or fails from the `/tmp` clone.

Because these fallback builds happen entirely in Windows temp storage, sign them directly with `cs`. Do not bounce them back through `sign-pe-from-wsl.sh`.

Export the committed release tree to Windows storage:

```bash
rm -rf "$WIN_STAGE"
mkdir -p "$WIN_STAGE/out"
git -C "$REL_DIR" archive HEAD | tar -xmf - -C "$WIN_STAGE"
```

Build the 4 Windows targets from native Windows Bun:

```bash
cat > "$WIN_PS1" <<'EOF'
param(
  [Parameter(Mandatory=$true)][string]$RepoRoot,
  [Parameter(Mandatory=$true)][string]$Outfile,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$env:SEND_STANDALONE_WINDOWS_BRIDGE = '1'
Remove-Item Env:SEND_STANDALONE_SKIP_WINDOWS_SIGN -ErrorAction SilentlyContinue
Set-Location $RepoRoot
& bun run .\scripts\build-standalone.ts --outfile $Outfile --target $Target
exit $LASTEXITCODE
EOF

for target in \
  bun-windows-x64 \
  bun-windows-x64-baseline \
  bun-windows-x64-modern \
  bun-windows-arm64
do
  base="send-${target#bun-}"
  powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$WIN_PS1")" \
    -RepoRoot "$(wslpath -w "$WIN_STAGE")" \
    -Outfile "$(wslpath -w "$WIN_STAGE/out/$base")" \
    -Target "$target"
done
```

Sign, verify, and copy the Windows binaries back into the release clone:

```bash
cs \
  "$(wslpath -w "$WIN_STAGE/out/send-windows-x64.exe")" \
  "$(wslpath -w "$WIN_STAGE/out/send-windows-x64-baseline.exe")" \
  "$(wslpath -w "$WIN_STAGE/out/send-windows-x64-modern.exe")" \
  "$(wslpath -w "$WIN_STAGE/out/send-windows-arm64.exe")"

for exe in "$WIN_STAGE/out"/send-windows-*.exe
do
  powershell.exe -NoProfile -Command "\$sig = Get-AuthenticodeSignature -LiteralPath '$(wslpath -w "$exe" | sed "s/'/''/g")'; if (\$sig.Status -ne 'Valid') { Write-Error ('Authenticode status: ' + \$sig.Status + ' ' + \$sig.StatusMessage); exit 1 }"
done

cp -f "$WIN_STAGE/out"/send-windows-*.exe "$REL_DIR/out"/
```

Then rerun the GitHub release step from `"$REL_DIR"`.

## Notes

- Keep `out/` out of the git commit. Build after the commit.
- `bun run build:standalone_all` now signs Windows release assets inline by staging them in writable Windows temp first.
- `bun publish --access public` should be run interactively.
- `403 ... You cannot publish over the previously published versions` means npm already has that version.
- Upload only binaries. Do not upload `send-windows-x64.extracted.png` or any other extra files.
- Final links:
  - `https://www.npmjs.com/package/@elefunc/send/v/$VERSION`
  - `https://github.com/Elefunc/send/releases/tag/v$VERSION`
