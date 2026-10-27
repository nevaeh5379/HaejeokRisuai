import type {
  SqlCommit as ProtocolSqlCommit,
  SqlPresetUpsert as ProtocolSqlPresetUpsert,
} from "../src/sqlCommit.ts";
import type { botPreset } from "./database.ts";

/** Preset rows are typed by the app's botPreset shape at the storage boundary. */
export type SqlPresetUpsert = ProtocolSqlPresetUpsert<botPreset>;
export type SqlCommit = ProtocolSqlCommit<botPreset>;
