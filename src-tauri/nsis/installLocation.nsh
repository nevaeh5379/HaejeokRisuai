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
!macroend
