class PostgresRevisionConflictError extends Error {
  readonly revision: number;
  constructor(revision?: any) {
    super("PostgreSQL storage revision conflict");
    this.name = "PostgresRevisionConflictError";
    this.revision = revision;
  }
}

class PostgresPayloadError extends Error {
  constructor(message?: any) {
    super(message);
    this.name = "PostgresPayloadError";
  }
}

// 공통 에러 타입 (구현체 무관 및 server.cjs 핸들러 호환)
class StorageRevisionConflictError extends PostgresRevisionConflictError {
  [key: string]: any;

  constructor(revision?: any, message: any = "Storage revision conflict") {
    super(revision);
    this.message = message;
    this.name = "StorageRevisionConflictError";
  }
}

class StoragePayloadError extends PostgresPayloadError {
  [key: string]: any;

  constructor(message?: any) {
    super(message);
    this.name = "StoragePayloadError";
  }
}

export {
  PostgresRevisionConflictError,
  PostgresPayloadError,
  StorageRevisionConflictError,
  StoragePayloadError,
};
