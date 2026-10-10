!ifndef HAEJEOK_INSTALLED_APP_NAME_INCLUDED
!define HAEJEOK_INSTALLED_APP_NAME_INCLUDED

; Localize only the display name; registry keys and install paths stay stable.
; Accept a LANGID so this works independently of NSIS's installer UI languages.
!macro HaejeokWriteInstalledAppName language
  Push $1
  IntOp $1 ${language} & 0x03ff
  ${If} $1 = 0x0012 ; LANG_KOREAN
    WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "해적리스"
  ${Else}
    WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  ${EndIf}
  Pop $1
!macroend

!endif
