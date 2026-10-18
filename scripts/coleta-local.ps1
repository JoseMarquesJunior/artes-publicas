# Plano B ao runner self-hosted: coleta local agendada (Agendador de Tarefas do Windows).
# Faz git pull, roda o coletor só para as fontes bloqueadas no CI e faz commit + push se houve mudança.
# Requisitos: git e node (20+) no PATH; repositório clonado com credenciais salvas (git push sem senha);
# ANTHROPIC_API_KEY opcional no ambiente (sem ela os itens ficam pendentes e o Action classifica depois).
#
# Agendar (PowerShell como administrador, ajuste o caminho):
#   $acao = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\caminho\artes-publicas\scripts\coleta-local.ps1"
#   $gatilho = New-ScheduledTaskTrigger -Daily -At 07:30
#   Register-ScheduledTask -TaskName "artes-publicas coleta local" -Action $acao -Trigger $gatilho -Description "Coleta das fontes bloqueadas no CI"

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $raiz
$log = Join-Path $raiz 'coleta-local.log'
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File -Append -Encoding utf8 $log

git pull --rebase origin main 2>&1 | Out-File -Append -Encoding utf8 $log

$fontes = node -e "const c=require('./scripts/fontes.json');console.log(c.fontes.filter(f=>f.ativo!==false&&f.bloqueadoNoCI).map(f=>f.fonte).join(','))"
if (-not $fontes) { "Nenhuma fonte bloqueada no CI; nada a fazer." | Out-File -Append -Encoding utf8 $log; exit 0 }
"Fontes: $fontes" | Out-File -Append -Encoding utf8 $log

node scripts/fetch.mjs --dias 2 --fontes $fontes 2>&1 | Out-File -Append -Encoding utf8 $log

git diff --quiet -- docs/data
if ($LASTEXITCODE -eq 0) { "Sem mudanças em docs/data." | Out-File -Append -Encoding utf8 $log; exit 0 }
git add -A docs/data
git commit -m "dados: coleta local $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-File -Append -Encoding utf8 $log
git push origin main 2>&1 | Out-File -Append -Encoding utf8 $log
"Enviado." | Out-File -Append -Encoding utf8 $log
