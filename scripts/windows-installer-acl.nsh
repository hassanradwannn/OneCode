!macro grantSandboxReadAccess
  ClearErrors
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0
  ${If} ${Errors}
    StrCpy $0 2
  ${EndIf}
  ${If} $0 != 0
    # During an update this runs before any page exists, where Abort ends the installer
    # silently (#1258). Say why, and what usually helps, unless the install is silent.
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Windows could not set the folder access needed to start OneCode safely (icacls exit code $0) for:$\r$\n$INSTDIR$\r$\n$\r$\nIf OneCode is installed in a protected folder such as Program Files, run this installer as administrator."
    ${EndIf}
    SetErrorLevel 2
    Abort "Windows could not set the folder access needed to start OneCode safely."
  ${EndIf}
!macroend

!macro customInit
  # initMultiUser has resolved a previous custom install path by this point.
  # Repair an existing install before an update removes its runnable version.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro grantSandboxReadAccess
  ${EndIf}
!macroend

!macro customInstall
  # Chromium's sandbox needs read and execute access through the app tree.
  # Add one inheritable grant to the final directory without resetting other ACLs.
  !insertmacro grantSandboxReadAccess
  # Windows link tracking follows the old executable into NSIS's temporary
  # old-install folder. keepShortcuts would preserve that now-broken target.
  # Recreate the Start link after the final executable exists, including its AUMI.
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    Delete "$newStartMenuLink"
    # Electron Builder's macro reads the runtime variable, not its macro argument.
    StrCpy $keepShortcuts "false"
    !insertmacro addStartMenuLink "false"
    ${IfNot} ${FileExists} "$newStartMenuLink"
      SetErrorLevel 2
      Abort "Windows could not recreate the OneCode Start-menu shortcut."
    ${EndIf}
    StrCpy $launchLink "$newStartMenuLink"
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${IfNot} ${isNoDesktopShortcut}
    ${AndIf} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
      !insertmacro addDesktopLink "false"
    ${EndIf}
  !endif
  # Older OneCode updaters delegate restart to --force-run. Keep a separate bounded
  # observer alive after NSIS exits, because ExecShellAsUser can silently fail.
  # New bootstraps omit --force-run and own their own checked restart.
  ${If} ${isForceRun}
  ${AndIf} ${Silent}
    System::Call 'kernel32::GetCurrentProcessId() i .r1'
    Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\updater\legacy-relaunch.ps1" -Executable "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -InstallerPid $1'
  ${EndIf}
!macroend
