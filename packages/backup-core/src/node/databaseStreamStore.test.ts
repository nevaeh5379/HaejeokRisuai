import { describe, expect, it } from "vitest";
import {
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS,
  LOCAL_BACKUP_DATABASE_STREAM_VERSION,
} from "./databaseStreamStore";
import {
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  PORTABLE_DATABASE_STREAM_VERSION,
} from "../streamFormat";

describe("local backup database stream constants", () => {
  it("shares the canonical streamed-fragment record bound", () => {
    expect(PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS).toBe(256);
    expect(LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS).toBe(
      PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
    );
  });

  it("keeps the node stream version aligned with the portable stream format", () => {
    expect(PORTABLE_DATABASE_STREAM_VERSION).toBe(1);
    expect(LOCAL_BACKUP_DATABASE_STREAM_VERSION).toBe(
      PORTABLE_DATABASE_STREAM_VERSION,
    );
  });

  it("bounds each upload request below the fragment limit", () => {
    expect(LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS).toBeLessThan(
      LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
    );
  });
});
