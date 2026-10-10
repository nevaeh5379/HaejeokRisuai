# HaejeokRisuai

<img width="100%" src="./public/logo_typo.svg"/>

해적리스는 [Risuai](https://github.com/kwaroran/Risuai) 저장소에서 포크되었습니다. 

## 특징

- 트래픽/메모리 최적화

기존 데이터베이스 구조를 필요한 데이터만 불러오는 방식으로 재설계했습니다.

- 더 많은 편의 기능
- 간편성/접근성

누구나 쉽게 쓸 수 있도록 크로스 플랫폼을 지원하고 있습니다. Tauri 통해 윈도우, macOS, Linux 지원하고 있으며 안드로이드는 capacitor 를 이용해 apk 배포되고 있습니다.

또한, UI 정리 작업하고 있습니다.

## 웹 이용
[risuai.dev](https://risuai.dev) 에 접속하여 바로 해적리스를 이용하실 수 있습니다. 데이터베이스는 sqlite-wasm 사용합니다.

## 설치 방법

### Github Release에 업로드된 설치 파일 이용 (macOS, Linux, Windows, Android)

[이 링크](https://github.com/nevaeh5379/HaejeokRisuai/releases/tag/b7476)에서 최근 빌드 버전에서 찾아볼 수 있습니다.

macOS, Linux, Windows는 arm64과 amd64 아키텍처를 지원합니다.
Android는 arm64만 지원합니다.

### PPA 이용하여 설치 (Debian 계열)

1. 레포스토리 등록

`sudo add-apt-repository ppa:nevaeh5379/haejeok-risuai`

2. 저장소 업데이트

`sudo update`

3. 해적리스 설치

`sudo apt install haejeok-risuai`

스크립트:
```bash
sudo add-apt-repository ppa:nevaeh5379/haejeok-risuai
sudo update
sudo apt install haejeok-risuai
```

### termux 이용하여 서버 열기
자세한 설명은 [Termux 배포 가이드](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/deploy/termux/README.ko.md)를 참고해주세요.

1. pkg 업데이트하기

`pkg update`

2. 해적리스 설치하기

`curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash`

이때 node.js과 postgresql 함께 설치하게 됩니다.

3. 해적리스 서비스 시작하기

`haejeok open`

이 때 브라우저가 자동으로 열립니다.


### 클론하여 설치 (git clone)

현재 리눅스/macOS만 준비되어 있습니다. 윈도우 경우 아직 별도로 준비된 스크립트가 없습니다.

**Docker** 혹은 **podman**이 필요합니다.

1. 클론하기

`git clone https://github.com/nevaeh5379/HaejeokRisuai.git`

2. risuai.sh 이용하여 설치
`./risuai.sh install`

설치가 다 되면 자동으로 서버가 열립니다.

### 기타 (WIP)

현재 문서화 작업하고 있습니다.

## 호환성

기존 [리스](https://github.com/kwaroran/Risuai)에서 백업된 데이터베이스와 플러그인 API V3 호환이 됩니다.

복원 도중에 오류가 날 경우, 플러그인 관련 호환 이슈가 있을 경우 [이슈](https://github.com/nevaeh5379/HaejeokRisuai/issues) 남겨주세요.

다음과 같은 기능들이 호환되지 않거나 제공하지 않습니다.
- 리스 계정 연동
- 플러그인 v2.0
- 플러그인 v2.1

## PR 관련
현재는 PR 관련하여 제한사항이 없습니다. AI로 생성된 코드도 허용됩니다.

## 약관
- [HaejeokRisuai TERMS](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/docs/TERMS.md)
- [HaejeokRisuai PRIVACY](https://github.com/nevaeh5379/HaejeokRisuai/blob/main/docs/PRIVACY.md)
- [업스트림 리스 서비스 약관](https://sv.risuai.xyz/hub/tos)
- [RisuRealm Content Rules](https://realm.risuai.net/help/content-rules)

리스렐름과 리스 계정 서비스는 업스트림 리스 개발자가 관리하고 있으며 저희가 관여하지 않습니다. 해적리스는 리스 계정 서비스 제공하지 않습니다.
