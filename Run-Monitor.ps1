param([switch]$Dashboard)
$ErrorActionPreference = 'Stop'
if ($Dashboard) {
    & node (Join-Path $PSScriptRoot 'dashboard.cjs')
} else {
    & node (Join-Path $PSScriptRoot 'monitor.cjs')
}
exit $LASTEXITCODE
