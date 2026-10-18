#!/usr/bin/env bash
# Plano B ao runner self-hosted: coleta local agendada (cron no Linux/macOS).
# Faz git pull, roda o coletor só para as fontes bloqueadas no CI e faz commit + push se houve mudança.
# Requisitos: git e node (20+) no PATH; repositório clonado com credenciais salvas; ANTHROPIC_API_KEY opcional.
#
# Agendar (crontab -e), ajustando o caminho:
#   30 4 * * * /caminho/artes-publicas/scripts/coleta-local.sh >> /caminho/artes-publicas/coleta-local.log 2>&1
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
echo "=== $(date '+%Y-%m-%d %H:%M') ==="

git pull --rebase origin main

FONTES=$(node -e 'const c=require("./scripts/fontes.json");console.log(c.fontes.filter(f=>f.ativo!==false&&f.bloqueadoNoCI).map(f=>f.fonte).join(","))')
if [ -z "$FONTES" ]; then echo "Nenhuma fonte bloqueada no CI; nada a fazer."; exit 0; fi
echo "Fontes: $FONTES"

node scripts/fetch.mjs --dias 2 --fontes "$FONTES"

if git diff --quiet -- docs/data; then echo "Sem mudanças em docs/data."; exit 0; fi
git add -A docs/data
git commit -m "dados: coleta local $(date '+%Y-%m-%d %H:%M')"
git push origin main
echo "Enviado."
