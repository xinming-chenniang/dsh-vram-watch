param(
    [double]$Interval = 2,
    [double]$IdleInterval = 10,
    [double]$PdhEvery = 20,
    [double]$IdleAfter = 120
)

# dsh-vram-watch 采样器：一条长驻进程，按行往 stdout 写 JSON 样本。
# 上层（lib/sampler.js）逐行解析；不要在这里打印别的东西，否则会被当成坏行丢掉。
#
# 实测（2026-11-15，本机 RTX 2060 SUPER / Win11 26220）：
#   nvidia-smi       ~50 ms/次 → 每 tick 采
#   Get-Counter      ~1000 ms/次（PDH 查询本身的固定开销，和 counter 个数无关）→ 每 PdhEvery 秒采
#   所以「共享显存 / 全进程显存」只能低频，GPU 总量与算力进程走 nvidia-smi。
# 兼容：Windows PowerShell 5.1 与 pwsh 7 都实测可用。

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
$hasSmi = Test-Path $smi
$totalMiB = 0
if ($hasSmi) {
    $raw = & $smi --query-gpu=memory.total --format=csv,noheader,nounits
    foreach ($r in @($raw)) { if ($r -match '^\s*(\d+)') { $totalMiB = [double]$matches[1]; break } }
}

$out = [Console]::Out
$meta = [ordered]@{
    type     = 'meta'
    total    = $totalMiB
    interval = $Interval
    pdhEvery = $PdhEvery
    smi      = $hasSmi
    host     = $PSVersionTable.PSVersion.ToString()
}
$out.WriteLine(($meta | ConvertTo-Json -Compress))
$out.Flush()

function ToNum([string]$s) {
    if ([string]::IsNullOrWhiteSpace($s) -or $s -match 'N/?A') { return $null }
    $v = 0.0
    if ([double]::TryParse($s.Trim(), [ref]$v)) { return $v } else { return $null }
}

$prevDed = $null
$prevSha = $null
$prevProcs = @{}
$lastPdh = [datetime]::MinValue
$lastActive = Get-Date
$first = $true

while ($true) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $now = Get-Date
    $util = $null; $temp = $null; $power = $null; $smiUsed = $null
    $procs = @{}

    if ($hasSmi) {
        $line = (& $smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,memory.used --format=csv,noheader,nounits | Select-Object -First 1)
        if ($line) {
            $f = $line -split ','
            $util = ToNum $f[0]
            $temp = ToNum $f[1]
            $power = ToNum $f[2]
            $smiUsed = ToNum $f[3]
        }
        foreach ($row in @(& $smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits)) {
            $g = $row -split ','
            if ($g.Count -lt 3) { continue }
            $pn = $g[1].Trim()
            $v = ToNum $g[2]
            if (-not $pn -or $null -eq $v) { continue }
            $pn = $pn -replace '\.exe$', ''
            if ($procs.ContainsKey($pn)) { $procs[$pn] += $v } else { $procs[$pn] = $v }
        }
    }

    $pdhFresh = $false
    if (($now - $lastPdh).TotalSeconds -ge $PdhEvery) {
        $c = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage', '\GPU Adapter Memory(*)\Shared Usage', '\GPU Process Memory(*)\Dedicated Usage'
        if ($c -and $c.CounterSamples) {
            $adapter = @($c.CounterSamples | Where-Object { $_.Path -match 'adapter memory' })
            $dedVal = ($adapter | Where-Object { $_.Path -match 'dedicated usage' } | Sort-Object CookedValue -Descending | Select-Object -First 1).CookedValue
            $shaVal = ($adapter | Where-Object { $_.Path -match 'shared usage' } | Sort-Object CookedValue -Descending | Select-Object -First 1).CookedValue
            if ($null -ne $dedVal) { $prevDed = [math]::Round($dedVal / 1MB) }
            if ($null -ne $shaVal) { $prevSha = [math]::Round($shaVal / 1MB) }
            $pdhProcs = @{}
            foreach ($s in @($c.CounterSamples | Where-Object { $_.Path -match 'process memory' -and $_.CookedValue -gt 0 })) {
                $pidText = ($s.InstanceName -split '_')[1]
                if (-not ($pidText -match '^\d+$')) { continue }
                $procId = [int]$pidText
                $pn = $null
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) { $pn = $proc.ProcessName } else { $pn = "pid$procId" }
                $mib = [math]::Round($s.CookedValue / 1MB)
                if ($pdhProcs.ContainsKey($pn)) { $pdhProcs[$pn] += $mib } else { $pdhProcs[$pn] = $mib }
            }
            $prevProcs = $pdhProcs
            $pdhFresh = $true
            $lastPdh = $now
        }
    }

    foreach ($k in $prevProcs.Keys) {
        if ($procs.ContainsKey($k)) { if ($prevProcs[$k] -gt $procs[$k]) { $procs[$k] = $prevProcs[$k] } }
        else { $procs[$k] = $prevProcs[$k] }
    }
    if ($procs.Count -eq 0) { $procs = $prevProcs.Clone() }

    $active = ($null -ne $util -and $util -ge 10) -or ($null -ne $prevDed -and $prevDed -ge 1500)
    if ($active) { $lastActive = $now }

    $sample = [ordered]@{
        type  = 's'
        t     = $now.ToString('yyyy-MM-dd HH:mm:ss')
        ded   = $prevDed
        sha   = $prevSha
        smi   = $smiUsed
        util  = $util
        temp  = $temp
        power = $power
        procs = $procs
        pdh   = $pdhFresh
    }
    $out.WriteLine(($sample | ConvertTo-Json -Compress -Depth 4))
    $out.Flush()

    $idleLong = ($now - $lastActive).TotalSeconds -ge $IdleAfter
    $target = if ($idleLong) { $IdleInterval } else { $Interval }
    if ($idleLong -and (($now - $lastPdh).TotalSeconds -lt $PdhEvery * 3)) { $target = $IdleInterval }
    $remain = $target - $sw.Elapsed.TotalSeconds
    if ($remain -gt 0) { Start-Sleep -Milliseconds ([int]($remain * 1000)) }
    $first = $false
}
