# Local embedding loop: run 100 items, kill server, repeat until done.
# Usage: pwsh scripts\local_embed_loop.ps1

$py = Join-Path (Get-Location).Path '.venv\Scripts\python.exe'
$worker = Join-Path (Get-Location).Path 'scripts\embed_worker_sqlite_vec.py'
$server = 'D:\llama-lora-embed\build\bin\Release\llama-server.exe'
$model = 'D:\models\qwen3-embedding-0.6b-q8_0.gguf'
$endpoint = 'http://127.0.0.1:8081/v1/embeddings'
$batchPerRound = 100
$logFile = Join-Path (Resolve-Path 'workspace/90_logs/embedding_workers').Path 'local_loop.log'

$round = 0
while ($true) {
    $round++
    $roundStart = Get-Date

    # Start llama-server
    $srv = Start-Process -FilePath $server -ArgumentList @(
        '-m', $model, '--embedding', '--host', '127.0.0.1', '--port', '8081',
        '-ngl', '99', '-b', '2048', '-ub', '2048', '--pooling', 'last', '--embd-normalize', '2'
    ) -WindowStyle Hidden -PassThru

    # Wait for server ready
    $ready = $false
    for ($w = 0; $w -lt 30; $w++) {
        Start-Sleep -Seconds 2
        try {
            $body = '{"model":"qwen3-embedding-0.6b","input":"ok"}'
            $r = Invoke-WebRequest -Method Post -Uri $endpoint -ContentType 'application/json' -Body $body -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        $msg = "[$(Get-Date -Format 'HH:mm:ss')] round $round : server failed to start, retrying..."
        Add-Content $logFile $msg -ErrorAction SilentlyContinue
        Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        continue
    }

    # Run worker
    $env:PYTHONUNBUFFERED = '1'
    $workerProc = Start-Process -FilePath $py -ArgumentList @(
        $worker, '--provider', 'local', '--model', 'qwen3-embedding-0.6b',
        '--endpoint', $endpoint, '--claim-any-provider', '--claim-any-model',
        '--limit', "$batchPerRound", '--batch-size', '1', '--timeout', '300'
    ) -WorkingDirectory (Get-Location).Path -NoNewWindow -Wait -PassThru

    # Kill server
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue

    $elapsed = ((Get-Date) - $roundStart).TotalSeconds
    $msg = "[$(Get-Date -Format 'HH:mm:ss')] round $round done in $([math]::Round($elapsed,1))s"
    Add-Content $logFile $msg -ErrorAction SilentlyContinue
    Write-Output $msg

    # Check if any local pending left
    $check = & $py -c @"
import sqlite3
c=sqlite3.connect('workspace/07_rag_embedding/stores/qwen_persona_rag.sqlite')
print(c.execute("select count(*) from embedding_jobs where status='pending'").fetchone()[0])
"@
    if ($check.Trim() -eq '0') {
        $doneMsg = "[$(Get-Date -Format 'HH:mm:ss')] ALL DONE. total rounds: $round"
        Add-Content $logFile $doneMsg -ErrorAction SilentlyContinue
        Write-Output $doneMsg
        break
    }

    Start-Sleep -Seconds 3
}
