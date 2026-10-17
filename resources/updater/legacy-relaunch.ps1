param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][int]$InstallerPid)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$directory=Join-Path $env:LOCALAPPDATA 'onecode-updater'
[IO.Directory]::CreateDirectory($directory)|Out-Null
$log=Join-Path $directory 'legacy-relaunch.log'
function Write-Diagnostic([string]$message){Add-Content -LiteralPath $log -Value "$([DateTime]::UtcNow.ToString('o')) $message"}
try {
  Write-Diagnostic "waiting for installer pid $InstallerPid"
  $installer=Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue
  if($installer -and -not $installer.WaitForExit(120000)){throw 'Installer did not exit; no restart attempted'}
  $target=[IO.Path]::GetDirectoryName($Executable)
  $guid='7b3f238f-62c9-5e7a-a1d5-02806675d41d'
  $registered=(Get-ItemProperty -LiteralPath "HKCU:\Software\$guid").InstallLocation
  if(-not [string]::Equals($registered,$target,[StringComparison]::OrdinalIgnoreCase)){throw 'Registered installation differs'}
  if((Get-Item -LiteralPath $Executable).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected executable'}
  for($node=Get-Item -LiteralPath $target;$node;$node=$node.Parent){if($node.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected install path'}}
  $version=(Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion
  if($version -ne '0.2.8.5'){throw "Unexpected installed version $version"}
  Start-Sleep -Seconds 3
  $live=@(Get-CimInstance Win32_Process -Filter "Name='OneCode.exe'" | Where-Object {$_.ExecutablePath -eq $Executable})
  if(-not $live.Count){
    $started=Start-Process -FilePath $Executable -ArgumentList '--updated' -WindowStyle Hidden -PassThru
    Write-Diagnostic "installer completed; launched exact installed $version pid $($started.Id)"
  }else{Write-Diagnostic "installer completed; exact installed $version already running"}
  Start-Sleep -Seconds 8
  $live=@(Get-CimInstance Win32_Process -Filter "Name='OneCode.exe'" | Where-Object {$_.ExecutablePath -eq $Executable})
  if(-not $live.Count){throw 'Relaunched app exited'}
  Write-Diagnostic "success: $version survived; processes $($live.Count)"
}catch{Write-Diagnostic "failed: $($_.Exception.Message)";exit 1}
