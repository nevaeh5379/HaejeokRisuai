-- Risuai Oracle Storage - 전용 사용자 생성 스크립트
-- ADB ADMIN 계정으로 Database Actions SQL Worksheet 또는 SQL*Plus에서 실행하세요.
-- 비밀번호 자리표시자 <RISUAI_PASSWORD>를 강한 비밀번호로 교체하세요.

CREATE USER risuai IDENTIFIED BY "<RISUAI_PASSWORD>";

-- 기본 권한
GRANT CREATE SESSION,
      CREATE TABLE,
      CREATE SEQUENCE,
      CREATE TRIGGER,
      CREATE TYPE,
      CREATE VIEW,
      CREATE PROCEDURE,
      UNLIMITED TABLESPACE
TO risuai;

-- 테이블스페이스 할당량 (UNLIMITED TABLESPACE가 동작하지 않을 경우 명시적 할당)
ALTER USER risuai QUOTA UNLIMITED ON DATA;
ALTER USER risuai QUOTA UNLIMITED ON TEMP;

-- Oracle Text (CTXSYS.CONTEXT 인덱스) 사용 권한
GRANT CTXAPP TO risuai;

-- 사용자 확인
SELECT username, account_status, default_tablespace
FROM dba_users
WHERE username = 'RISUAI';