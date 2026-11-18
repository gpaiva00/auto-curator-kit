#!/usr/bin/env bash
# Abre um Chrome DEDICADO (perfil separado do seu Chrome do dia a dia) com a porta de depuração só nesta máquina.
# As fontes de navegador (x-feed e instagram-profile) conectam nele via BROWSER_CDP_URL e leem as páginas como uma
# pessoa leria: abrem, esperam, rolam um pouco e leem o que está na tela.
#
# Uso:
#   scripts/chrome-reader.sh [nome] [window|headless|stop]
#   scripts/chrome-reader.sh                  # perfil "default", com janela, porta 9222
#   scripts/chrome-reader.sh astronomia       # perfil separado por projeto: ~/.auto-curator/chrome-astronomia
#   scripts/chrome-reader.sh astronomia headless
#   scripts/chrome-reader.sh astronomia stop  # encerra o Chrome desse perfil
#   scripts/chrome-reader.sh stop             # idem, para o perfil "default"
#
# Porta: vem de BROWSER_CDP_URL (ex.: http://127.0.0.1:9333) ou de CHROME_READER_PORT; padrão 9222.
# Com vários perfis ao mesmo tempo, use uma porta diferente em cada um.
#
# >>> USE UMA CONTA SECUNDÁRIA <<<
# Entre neste Chrome SOMENTE com uma conta de leitura criada para isso, nunca com a sua conta pessoal ou a do perfil
# que você publica. Ler o X e o Instagram por navegador automatizado vai contra os Termos de Uso dessas redes e
# pode levar ao bloqueio da conta usada: por isso a conta secundária. Mantenha o volume baixo (os limites das fontes
# existem para isso) e não use este perfil para mais nada.
#
# Segurança: a porta de depuração dá controle total do navegador. Ela escuta só em 127.0.0.1.
#
# 1ª vez: faça login manualmente na conta de LEITURA e resolva qualquer confirmação de idade ou desafio.
# Depois deixe o Chrome aberto. Fechar o Chrome desliga o leitor; o resto do pipeline segue funcionando.
set -euo pipefail

NAME="default"
MODE="window"
for arg in "$@"; do
  case "$arg" in
    window|headless|stop) MODE="$arg" ;;
    -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) NAME="$arg" ;;
  esac
done
if [[ ! "$NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then echo "Nome de perfil inválido: use letras, números, ponto, hífen ou sublinhado." >&2; exit 1; fi

# Porta: argumento de ambiente BROWSER_CDP_URL > CHROME_READER_PORT > 9222
PORT="${CHROME_READER_PORT:-9222}"
if [[ -n "${BROWSER_CDP_URL:-}" ]]; then
  P="${BROWSER_CDP_URL##*:}"; P="${P%%/*}"
  if [[ "$P" =~ ^[0-9]+$ ]]; then PORT="$P"; fi
fi

PROFILE="${CHROME_READER_PROFILE:-$HOME/.auto-curator/chrome-$NAME}"
CHROME_APP="${CHROME_APP:-/Applications/Google Chrome.app}"
CHROME="$CHROME_APP/Contents/MacOS/Google Chrome"

if [[ "$MODE" == "stop" ]]; then
  if pkill -f -- "--user-data-dir=${PROFILE}"; then echo "Chrome dedicado ($NAME) encerrado."; else echo "Nenhum Chrome dedicado ($NAME) rodando."; fi
  exit 0
fi

if [[ ! -x "$CHROME" ]]; then echo "Google Chrome não encontrado em $CHROME_APP (defina CHROME_APP para outro caminho)." >&2; exit 1; fi
if curl -fs "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Já existe um Chrome com depuração na porta ${PORT}."; exit 0
fi

mkdir -p "$PROFILE" && chmod 700 "$PROFILE"
ARGS=(--remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check)

if [[ "$MODE" == "headless" ]]; then
  # O headless se anuncia como "HeadlessChrome": usa um user agent normal e janela de tamanho real.
  # Sem janela é mais fácil ser barrado e você não vê desafios: prefira o modo com janela.
  VER="$("$CHROME" --version | awk '{print $3}' | cut -d. -f1)"
  ARGS+=(--headless=new --window-size=1366,900
    --user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VER}.0.0.0 Safari/537.36")
  open -n -g -j -a "$CHROME_APP" --args "${ARGS[@]}" about:blank
  echo "Chrome dedicado ($NAME) em modo headless. Perfil: $PROFILE, porta: $PORT."
else
  # Com janela (abre em segundo plano, sem roubar o foco): você vê e resolve login, idade e desafios na hora.
  open -n -g -j -a "$CHROME_APP" --args "${ARGS[@]}" "https://x.com/home" "https://www.instagram.com/"
  echo "Chrome dedicado ($NAME) aberto com janela, em segundo plano. Perfil: $PROFILE, porta: $PORT."
  echo "Entre no X e no Instagram com a conta SECUNDÁRIA de leitura (nunca a sua conta principal)."
fi
echo "No .env do perfil: BROWSER_CDP_URL=http://127.0.0.1:${PORT}"
