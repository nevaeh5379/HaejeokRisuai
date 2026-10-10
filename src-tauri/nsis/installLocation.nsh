; Resolve a previous install only when its recorded uninstaller still exists.
; Keep the reinstall page's $R0-$R9 and working registers intact.
!macro HaejeokInstallLocationFunctions
Function GetPreviousInstallLocation
  Push $0
  Push $1
  Push $2
  StrCpy $4 ""

  ; Prefer the actual uninstaller's parent over a stale InstallLocation value.
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "UninstallString"
  StrCpy $1 $0 1
  ${If} $1 == '$\"'
    StrCpy $0 $0 "" 1
    ${StrLoc} $1 $0 '$\"' '>'
    ${If} $1 != ""
      StrCpy $0 $0 $1
      ${If} ${FileExists} "$0"
        ${GetParent} $0 $4
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; This key is independent of the publisher. Tauri records it with quotes.
  ${If} $4 == ""
    ReadRegStr $0 SHCTX "${UNINSTKEY}" "InstallLocation"
    StrCpy $1 $0 1
    StrCpy $2 $0 1 -1
    ${If} $1 == '$\"'
    ${AndIf} $2 == '$\"'
      StrLen $1 $0
      IntOp $1 $1 - 2
      StrCpy $0 $0 $1 1
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\uninstall.exe"
      StrCpy $4 $0
    ${EndIf}
  ${EndIf}

  ${If} $4 == ""
    ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\uninstall.exe"
      StrCpy $4 $0
    ${EndIf}
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $0 SHCTX "Software\aiclient\${PRODUCTNAME}" ""
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\uninstall.exe"
      StrCpy $4 $0
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
  ; Missing optional registry values must not taint the next ExecWait.
  ClearErrors
FunctionEnd

Function RememberPreviousInstallation
  Call GetPreviousInstallLocation
  StrCpy $PreviousInstallDir $4
  ReadRegStr $PreviousMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $PreviousMainBinaryName == ""
    StrCpy $PreviousMainBinaryName "${MAINBINARYNAME}.exe"
  ${EndIf}
  ClearErrors
FunctionEnd

; Return the uninstaller exit code in $0; do not remove user data on /UPDATE.
Function UninstallPreviousNsisInstallation
  Push $R1
  Call GetPreviousInstallLocation
  ${If} $4 == ""
    StrCpy $0 2
    Pop $R1
    Return
  ${EndIf}
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $R1 == ""
    StrCpy $R1 '$\"$4\uninstall.exe$\"'
  ${EndIf}
  ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|}
  ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|}
  ${IfThen} ${Silent} ${|} StrCpy $R1 "$R1 /S" ${|}
  StrCpy $R1 "$R1 _?=$4"
  ClearErrors
  ExecWait '$R1' $0
  ${If} ${Errors}
    StrCpy $0 2
  ${EndIf}
  ${If} $0 = 0
  ${AndIf} ${FileExists} "$4\$PreviousMainBinaryName"
    StrCpy $0 2
  ${EndIf}
  ${If} $0 = 0
    ; _?= runs in place, so delete the old uninstaller after it has exited.
    Delete "$4\uninstall.exe"
    RMDir "$4"
  ${EndIf}
  Pop $R1
  ClearErrors
FunctionEnd
!macroend

; Based on Tauri's SetShortcutTarget in utils.nsh. Keep the existing link's
; arguments and metadata, but relocate its working directory and icon too.
!macro HaejeokSetShortcutTarget shortcut target
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READWRITE})'
      ${IShellLink::SetPath} $0 '(w "${target}")'
      ${IShellLink::SetWorkingDirectory} $0 '(w "$INSTDIR")'
      ${IShellLink::SetIconLocation} $0 '(w "${target}", 0)'
      ${IPersistFile::Save} $1 '("${shortcut}",1)'
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend
