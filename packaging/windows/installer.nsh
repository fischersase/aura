; Aura NSIS additions (AURA-114).
;
; Before installing, end every running Aura of this user, wherever it was started from. electron-builder only ends
; processes inside the install folder, but up to 0.10.x Aura was a portable .exe (e.g. in Downloads) that starts at
; login. Left running, it keeps the single-instance lock: the freshly installed Aura then hands over to the old one
; and quits, so the user keeps seeing the old version. /T also ends the agent (python.exe) and other child processes.
!macro customInit
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM Aura.exe /FI "PID ne $0" /FI "USERNAME eq %USERNAME%"`
  Pop $1
  Sleep 800
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM Aura.exe /FI "PID ne $0" /FI "USERNAME eq %USERNAME%"`
  Pop $1
  Sleep 1000
!macroend
