# Loads WinMirror.cs into this PowerShell process and runs it. Windows PowerShell 5.1 ships with every Windows 10/11,
# so nothing is installed and no separate executable is written to disk.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'WinMirror.cs') -ReferencedAssemblies System.Drawing, System.Core
[WinMirror]::Main()
