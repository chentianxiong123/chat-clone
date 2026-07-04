param(
    [string]$QueueRoot = "data\agent_queues\api_allowed_60m",
    [int]$MaxJobs = 20,
    [string]$WorkerName = "claude_worker"
)

$ErrorActionPreference = "Stop"

$resolvedQueue = Resolve-Path -LiteralPath $QueueRoot
$pendingDir = Join-Path $resolvedQueue "pending"
$inProgressDir = Join-Path $resolvedQueue "in_progress"
$doneDir = Join-Path $resolvedQueue "done"
$failedDir = Join-Path $resolvedQueue "failed"
$promptFile = Join-Path $resolvedQueue "PROMPT.md"
$logFile = Join-Path $resolvedQueue "$WorkerName.log"

New-Item -ItemType Directory -Force -Path $pendingDir, $inProgressDir, $doneDir, $failedDir | Out-Null

$processed = 0
$failed = 0

while ($processed -lt $MaxJobs) {
    $job = Get-ChildItem -LiteralPath $pendingDir -Filter "*.job.json" | Sort-Object Name | Select-Object -First 1
    if (-not $job) {
        Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "no pending jobs"
        break
    }

    $inProgressPath = Join-Path $inProgressDir $job.Name
    $jobId = $job.BaseName -replace "\.job$", ""
    $decisionPath = Join-Path $doneDir "$jobId.decision.json"

    Move-Item -LiteralPath $job.FullName -Destination $inProgressPath

    $prompt = @"
你在 Windows 工作区 D:\files\qwen-chat。

只处理这一个 job：
$inProgressPath

输出文件：
$decisionPath

读取说明：
$promptFile

要求：
1. 读取 job JSON。
2. 只判断 candidate_boundaries。
3. 写一个 JSON 对象到输出文件，不要 markdown。
4. 如果没有 candidate_boundaries，写：{"job_id":"...","decisions":[],"extra_cuts":[]}。
5. 如果有 candidate_boundaries，格式：{"job_id":"...","decisions":[{"boundary_id":"...","decision":"cut|keep|uncertain","confidence":0.0,"reason":"不超过30字，不引用原文"}],"extra_cuts":[]}。
6. 不要引用聊天原文。
7. 写完输出文件后，删除这个 in_progress job 文件：$inProgressPath
8. 终端只报告 done。
"@

    try {
        $output = claude --dangerously-skip-permissions -p $prompt
        if (-not (Test-Path -LiteralPath $decisionPath)) {
            throw "decision file was not created"
        }
        Get-Content -Raw -LiteralPath $decisionPath | ConvertFrom-Json | Out-Null
        if (Test-Path -LiteralPath $inProgressPath) {
            Remove-Item -LiteralPath $inProgressPath
        }
        $processed += 1
        Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "done $jobId $output"
    }
    catch {
        $failed += 1
        $failedPath = Join-Path $failedDir $job.Name
        if (Test-Path -LiteralPath $inProgressPath) {
            Move-Item -LiteralPath $inProgressPath -Destination $failedPath -Force
        }
        Add-Content -LiteralPath $logFile -Encoding UTF8 -Value "failed $jobId $($_.Exception.Message)"
    }
}

Write-Output "processed=$processed failed=$failed max=$MaxJobs"
