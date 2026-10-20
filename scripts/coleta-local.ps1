# Plano B ao runner self-hosted: coleta local agendada (Agendador de Tarefas do Windows).
# Faz git pull, roda o coletor só para as fontes bloqueadas no CI e faz commit + push se houve mudança.
# Requisitos: git e node (20+) no PATH; repositório clonado com credenciais salvas (git push sem senha);
# ANTHROPIC_API_KEY opcional no ambiente (sem ela os itens ficam pendentes e o Action classifica depois).
#
# Agendar (PowerShell, ajuste o caminho; tarefa do usuário atual, não precisa de administrador):
#   $acao = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\caminho\artes-publicas\scripts\coleta-local.ps1"
#   $gatilho = New-ScheduledTaskTrigger -Daily -At 11:30
#   $opcoes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
#   Register-ScheduledTask -TaskName "artes-publicas coleta local" -Action $acao -Trigger $gatilho -Settings $opcoes -Description "Coleta das fontes bloqueadas no CI"
# (-StartWhenAvailable: se o computador estava desligado às 11:30, roda assim que ligar. O resultado fica em coleta-local.log.)
#
# Atenção (PowerShell 5.1): não use "2>&1" em comandos nativos com $ErrorActionPreference = 'Stop' — o git escreve
# mensagens normais no stderr e o script morreria em silêncio no "git pull". Aqui a saída passa pelo cmd.exe.
#
# Se o Action do GitHub commitou dados enquanto esta coleta rodava, os arquivos são fundidos registro a registro
# (scripts/fundir-dados.mjs) em vez de resolver conflito por linha, que descartava registros.

$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $raiz
# A tarefa agendada herda o PATH do sistema; se o Node não estiver nele, usa o caminho padrão da instalação.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $env:Path += ';C:\Program Files\nodejs' }
$log = Join-Path $raiz 'coleta-local.log'

function Registrar([string] $texto) { $texto | Out-File -Append -Encoding utf8 $log }
function Rodar([string] $comando) {
  # Executa pelo cmd.exe, juntando stdout e stderr sem o PowerShell transformar stderr em erro.
  $saida = cmd /c "$comando 2>&1"
  if ($saida) { $saida | Out-File -Append -Encoding utf8 $log }
  return $LASTEXITCODE
}

Registrar "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Registrar 'git não encontrado no PATH.'; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Registrar 'node não encontrado no PATH nem em C:\Program Files\nodejs.'; exit 1 }

if ((Rodar 'git pull --rebase origin main') -ne 0) { Registrar 'git pull falhou; abortando (resolva o repositório local).'; exit 1 }

$fontes = cmd /c 'node -e "const c=require(''./scripts/fontes.json'');console.log(c.fontes.filter(f=>f.ativo!==false&&f.bloqueadoNoCI).map(f=>f.fonte).join('',''))"'
if (-not $fontes) { Registrar 'Nenhuma fonte bloqueada no CI; nada a fazer.'; exit 0 }
Registrar "Fontes: $fontes"

$codigo = Rodar "node scripts/fetch.mjs --dias 2 --fontes $fontes"
if ($codigo -ne 0) { Registrar "fetch.mjs saiu com código $codigo (ver acima); segue para commitar o que houver." }

cmd /c 'git diff --quiet -- docs/data'
if ($LASTEXITCODE -eq 0) { Registrar 'Sem mudanças em docs/data.'; exit 0 }

# Guarda o resultado desta execução, volta docs/data ao estado do repositório, traz o que chegou de fora e funde.
$novo = Join-Path $env:TEMP 'artes-publicas-novo'
New-Item -ItemType Directory -Force $novo | Out-Null
for ($tentativa = 1; $tentativa -le 3; $tentativa++) {
  Copy-Item (Join-Path $raiz 'docs\data\*.json') $novo -Force
  Rodar 'git checkout -- docs/data' | Out-Null
  if ((Rodar 'git pull --rebase origin main') -ne 0) { Registrar 'git pull falhou antes da fusão; abortando.'; exit 1 }
  Rodar "node scripts/fundir-dados.mjs ""$novo"" docs/data" | Out-Null
  Rodar 'git add -A docs/data' | Out-Null
  if ((Rodar "git commit -m ""dados: coleta local $(Get-Date -Format 'yyyy-MM-dd HH:mm')""") -ne 0) { Registrar 'Nada a commitar após a fusão.'; exit 0 }
  if ((Rodar 'git push origin main') -eq 0) { Registrar 'Enviado.'; exit 0 }
  Registrar "push rejeitado (tentativa $tentativa); refaz a fusão com a base atual."
  Rodar 'git reset --soft HEAD~1' | Out-Null
}
Registrar 'push falhou três vezes; commit fica local.'
exit 1
