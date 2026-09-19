// Builder for a minimal but structurally valid `.risubackup` local-backup
// fixture used by the e2e suite.
//
// The local backup container format is a flat sequence of framed entries:
//   [u32 LE nameLength][name bytes][u32 LE dataLength][data bytes]...
// The database entry payload ("database.risudat") is the compressed RisuSave
// format: the 11-byte magic header `0 R I S U S A V E \0 8` followed by a
// zlib-deflated msgpackr payload (Packr with `useRecords: false`, exactly like
// src/ts/storage/backup/risuSave.ts and server/node/localBackupFormat.cjs).
//
// The generator runs in Node (Playwright reads the produced file), so it must
// not import app sources — it reproduces the wire format byte-for-byte instead.
// A test in e2e/local-backup.spec.ts additionally guards the format helper by
// round-tripping the decoded backup in the real app code path.
import { deflateSync } from "node:zlib";
import { Packr } from "msgpackr";
import { LEGACY_DATABASE_ENTRY_NAME } from "@risuai/backup-core/entryPolicy";
import { LEGACY_COMPRESSED_DATABASE_HEADER_BYTES } from "@risuai/backup-core/legacyHeaders";

export const COMPRESSED_HEADER = Buffer.from(
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
);

type BackupEntry = { name: string; data: Buffer };

export function frameBackupEntry(entry: BackupEntry): Buffer {
  const nameBytes = Buffer.from(entry.name, "utf8");
  if (nameBytes.length === 0 || nameBytes.length > 1024 * 1024) {
    throw new Error(`Invalid fixture entry name: ${entry.name}`);
  }
  const header = Buffer.alloc(8 + nameBytes.length);
  header.writeUInt32LE(nameBytes.length, 0);
  nameBytes.copy(header, 4);
  header.writeUInt32LE(entry.data.length, 4 + nameBytes.length);
  return Buffer.concat([header, entry.data]);
}

export function encodeFixtureDatabase(database: unknown): Buffer {
  const packr = new Packr({ useRecords: false });
  const packed = packr.encode(database);
  return Buffer.concat([COMPRESSED_HEADER, deflateSync(packed)]);
}

export interface FixtureBackupDatabase {
  username?: string;
  userIcon?: string;
  customBackground?: string;
  didFirstSetup?: boolean;
  language?: string;
  personas?: unknown[];
  selectedPersona?: number;
  characters?: unknown[];
  characterOrder?: unknown[];
  botPresets?: unknown[];
  botPresetsId?: number;
  promptTemplate?: unknown[];
  mainPrompt?: string;
  jailbreak?: string;
  globalNote?: string;
  additionalPrompt?: string;
  supaMemoryPrompt?: string;
  emotionPrompt?: string;
  emotionPrompt2?: string;
  autoSuggestPrompt?: string;
  translatorPrompt?: string;
  instructChatTemplate?: string;
  promptSettings?: unknown;
  formatVersion?: number;
}

/**
 * Builds the exact bytes of a `haejeokrisu_backup_….bin` fixture containing:
 *  - one character with one chat and two messages
 *  - essential profile-image asset entries (a tiny valid PNG) so restore
 *    exercises the asset path normalization as well
 *  - `didFirstSetup: true` so the app boots straight into the main UI after
 *    the restore + reload
 */
export interface TestLocalBackupOptions {
  characterId?: string;
  chatId?: string;
  characterName?: string;
  paddingAssetBytes?: number;
}

export function buildTestLocalBackup(
  options: TestLocalBackupOptions = {},
): Buffer {
  // 1x1 transparent PNG (smallest valid PNG, 67 bytes).
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const characterId =
    options.characterId ?? "aaaaaaaa-1111-4222-8333-444444444444";
  const chatId = options.chatId ?? "bbbbbbbb-1111-4222-8333-444444444444";
  const characterName = options.characterName ?? "Fixture Bot";
  const paddingAssetBytes = options.paddingAssetBytes ?? 0;
  if (
    !Number.isSafeInteger(paddingAssetBytes) ||
    paddingAssetBytes < 0 ||
    paddingAssetBytes > 16 * 1024 * 1024
  ) {
    throw new TypeError(
      "Fixture padding asset size must be between 0 and 16 MiB",
    );
  }

  const database: FixtureBackupDatabase = {
    username: "Backup Tester",
    userIcon: "assets/test-user-icon.png",
    didFirstSetup: true,
    language: "en",
    personas: [
      {
        name: "Backup Tester",
        icon: "",
        personaPrompt: "",
        note: "",
        largePortrait: false,
      },
    ],
    selectedPersona: 0,
    characters: [
      {
        chaId: characterId,
        type: "character",
        name: characterName,
        image: "assets/test-fixture-bot.png",
        firstMessage: "Fixture greeting",
        description: "A character created by the e2e fixture builder.",
        personality: "",
        scenario: "",
        creatorNotes: "",
        systemPrompt: "",
        postHistoryInstructions: "",
        alternativeGreetings: [],
        tags: ["e2e"],
        creator: "e2e",
        chub: { active: false },
        bias: [],
        virtualMemory: [{ title: "note", content: "" }],
        customScripts: [],
        loreBooks: [],
        totalChatLore: [],
        defaultPrompt: "",
        utilityPrompt: "",
        uiDisplayName: "",
        emotionImages: [],
        customBackground: "",
        dataSource: "e2e",
        chats: [
          {
            id: chatId,
            name: "Fixture Chat",
            message: [
              {
                chatId: "m1",
                role: "user",
                data: "Restore test message from the fixture.",
              },
              { chatId: "m2", role: "char", data: "Fixture greeting" },
            ],
            note: "",
            lastDate: Date.now(),
          },
        ],
      },
    ],
    characterOrder: [characterId],
    botPresets: [
      { name: "Fixture Preset", temperature: 0.8 } as unknown as Record<
        string,
        never
      >,
    ],
    botPresetsId: 0,
  };

  const packr = new Packr({ useRecords: false });
  const entries: BackupEntry[] = [
    {
      name: "assets/test-fixture-bot.png",
      data: tinyPng,
    },
    {
      name: "assets/test-user-icon.png",
      data: tinyPng,
    },
    ...(paddingAssetBytes > 0
      ? [
          {
            name: "assets/e2e-padding.bin",
            data: Buffer.alloc(paddingAssetBytes, 0xa5),
          },
        ]
      : []),
    {
      name: LEGACY_DATABASE_ENTRY_NAME,
      data: Buffer.concat([
        COMPRESSED_HEADER,
        deflateSync(packr.encode(database)),
      ]),
    },
  ];

  return Buffer.concat(entries.map(frameBackupEntry));
}
