!ifndef HAEJEOK_INSTALLED_APP_NAME_INCLUDED
!define HAEJEOK_INSTALLED_APP_NAME_INCLUDED

; Accept a LANGID independently of NSIS's installer UI languages.
!macro HaejeokGetAppDisplayName output language
  Push $1
  IntOp $1 ${language} & 0x03ff
  ${If} $1 = 0x0012 ; LANG_KOREAN
    StrCpy ${output} "해적리스"
  ${Else}
    StrCpy ${output} "${PRODUCTNAME}"
  ${EndIf}
  Pop $1
!macroend

; Localize only the display name; registry keys and install paths stay stable.
!macro HaejeokWriteInstalledAppName language
  Push $0
  !insertmacro HaejeokGetAppDisplayName $0 ${language}
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "$0"
  Pop $0
!macroend

!endif
