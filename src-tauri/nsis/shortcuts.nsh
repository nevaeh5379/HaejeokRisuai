!ifndef HAEJEOK_SHORTCUTS_INCLUDED
!define HAEJEOK_SHORTCUTS_INCLUDED

; Preserve existing shortcut names and arguments while relocating their target.
; Match both the previous and current target for reinstalls and binary renames.
; Sets $R0 to 1 when an owned shortcut was found; uses $0-$3 like IsShortcutTarget.
!macro HaejeokUpdateShortcut shortcut
  !insertmacro IsShortcutTarget "${shortcut}" "$PreviousInstallDir\$OldMainBinaryName"
  Pop $0
  ${If} $0 <> 1
    !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
  ${EndIf}
  ${If} $0 = 1
    !insertmacro HaejeokSetShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}
!macroend

!macro HaejeokUpdateShortcuts directory
  !insertmacro HaejeokUpdateShortcut "${directory}\${PRODUCTNAME}.lnk"
  !insertmacro HaejeokUpdateShortcut "${directory}\해적리스.lnk"
!macroend

; Only create a shortcut when the user requested one and its name is available.
; Never replace an unrelated/user-customized link occupying the localized name.
!macro HaejeokCreateShortcut shortcut
  ${IfNot} ${FileExists} "${shortcut}"
    CreateShortcut "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${shortcut}"
  ${EndIf}
!macroend

; Uninstall handles either creation language, regardless of today's UI language.
!macro HaejeokRemoveShortcut shortcut
  !insertmacro IsShortcutTarget "${shortcut}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro UnpinShortcut "${shortcut}"
    Delete "${shortcut}"
  ${EndIf}
!macroend

!macro HaejeokRemoveShortcuts directory
  !insertmacro HaejeokRemoveShortcut "${directory}\${PRODUCTNAME}.lnk"
  !insertmacro HaejeokRemoveShortcut "${directory}\해적리스.lnk"
!macroend

!endif
