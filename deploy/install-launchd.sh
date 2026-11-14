#!/usr/bin/env bash
# Gera ~/Library/LaunchAgents/com.auto-curator.<id>.plist a partir de deploy/launchd.plist.template.
# NÃO carrega o job: imprime os comandos para você rodar. Uso: deploy/install-launchd.sh <profile-id>
set -euo pipefail

ID="${1:-}"
if [[ -z "$ID" || "$ID" == "-h" || "$ID" == "--help" ]]; then
  echo "Uso: deploy/install-launchd.sh <profile-id>" >&2
  exit 2
fi
if [[ ! "$ID" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]]; then
  echo "Id inválido: \"$ID\" (use letras minúsculas, números e hífen)." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TEMPLATE="$HERE/launchd.plist.template"
PROFILE_DIR="$REPO/profiles/$ID"

[[ -f "$PROFILE_DIR/profile.json" ]] || { echo "Perfil não encontrado: $PROFILE_DIR/profile.json (crie com: bun run create $ID)" >&2; exit 1; }
[[ -f "$PROFILE_DIR/.env" ]] || echo "Aviso: $PROFILE_DIR/.env não existe; o bot não vai subir sem o token." >&2

BUN="$(command -v bun || true)"
[[ -n "$BUN" ]] || { echo "bun não encontrado no PATH. Instale em https://bun.sh e rode de novo." >&2; exit 1; }

DEST_DIR="$HOME/Library/LaunchAgents"
LABEL="com.auto-curator.$ID"
DEST="$DEST_DIR/$LABEL.plist"
mkdir -p "$DEST_DIR" "$REPO/data/$ID"

PATH_VALUE="$(dirname "$BUN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CONTENT="$(<"$TEMPLATE")"
CONTENT="${CONTENT//\{\{ID\}\}/$ID}"
CONTENT="${CONTENT//\{\{REPO\}\}/$REPO}"
CONTENT="${CONTENT//\{\{BUN\}\}/$BUN}"
CONTENT="${CONTENT//\{\{HOME\}\}/$HOME}"
CONTENT="${CONTENT//\{\{PATH\}\}/$PATH_VALUE}"
printf '%s\n' "$CONTENT" > "$DEST"

if command -v plutil >/dev/null 2>&1; then plutil -lint "$DEST" >/dev/null || { echo "plist inválido: $DEST" >&2; exit 1; }; fi

echo "Criado: $DEST"
echo "Logs:   $REPO/data/$ID/launchd.log"
echo
echo "Antes de carregar, confira: bun run doctor --profile $ID"
echo
echo "Para ligar:"
echo "  launchctl bootstrap gui/$(id -u) \"$DEST\""
echo "Para ver o estado:"
echo "  launchctl print gui/$(id -u)/$LABEL | head -20"
echo "Para desligar:"
echo "  launchctl bootout gui/$(id -u)/$LABEL"
