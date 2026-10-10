import { describe, expect, it } from "vitest";
import {
  LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS,
} from "./databaseStreamStore.ts";
import { MAX_FRAGMENT_RECORDS } from "../stream/databaseBackup.ts";

describe("local backup database stream constants", () => {
  it("shares the canonical streamed-fragment record bound", () => {
    expect(MAX_FRAGMENT_RECORDS).toBe(256);
    expect(LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS).toBe(
      MAX_FRAGMENT_RECORDS,
    );
  });

  it("bounds each upload request below the fragment limit", () => {
    expect(LOCAL_BACKUP_DATABASE_STREAM_MAX_REQUEST_RECORDS).toBeLessThan(
      LOCAL_BACKUP_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
    );
  });
});
