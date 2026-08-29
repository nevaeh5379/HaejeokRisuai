const fs = require('fs');
const path = require('path');
const fflate = require('fflate');
const { Unpackr } = require('msgpackr/index-no-eval');
const { OracleStorage } = require('./oracleStorage.cjs');
const { loadOracleEnvFile, readOracleConfigFromEnv } = require('./storageDriver.cjs');
const { splitCharacter, splitChat, splitMessage } = require('./postgresRelationalCodec.cjs');

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords: false,
});

const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);

/**
 * Decodes RisuAI database buffer (compressed or raw msgpack).
 */
function decodeRisuDb(data) {
    let isCompressed = true;
    for (let i = 0; i < magicCompressedHeader.length; i++) {
        if (data[i] !== magicCompressedHeader[i]) {
            isCompressed = false;
            break;
        }
    }
    if (isCompressed) {
        const raw = data.slice(magicCompressedHeader.length);
        const decompressed = fflate.decompressSync(raw);
        return unpackr.decode(decompressed);
    }

    let isRaw = true;
    for (let i = 0; i < magicHeader.length; i++) {
        if (data[i] !== magicHeader[i]) {
            isRaw = false;
            break;
        }
    }
    if (isRaw) {
        const raw = data.slice(magicHeader.length);
        return unpackr.decode(raw);
    }

    return unpackr.decode(data);
}

/**
 * Streaming parser for RisuAI .bin backup archive files (> 2GB safe).
 */
function parseBackupArchive(filePath) {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Backup file not found at: ${resolvedPath}`);
    }

    const fd = fs.openSync(resolvedPath, 'r');
    const stat = fs.fstatSync(fd);
    let offset = 0;
    const lenBuf = Buffer.alloc(4);
    let dbData = null;
    let entryCount = 0;
    try {
        while (offset < stat.size) {
            if (offset + 4 > stat.size) break;
            const bytesRead = fs.readSync(fd, lenBuf, 0, 4, offset);
            if (bytesRead < 4) break;
            offset += 4;
            const nameLen = lenBuf.readUInt32LE(0);
            if (nameLen === 0 || nameLen > 1024 * 1024) break;

            const nameBuf = Buffer.alloc(nameLen);
            fs.readSync(fd, nameBuf, 0, nameLen, offset);
            offset += nameLen;
            const entryName = nameBuf.toString('utf8');
            entryCount++;

            fs.readSync(fd, lenBuf, 0, 4, offset);
            offset += 4;
            const dataLen = lenBuf.readUInt32LE(0);

            if (entryName === 'database.risudat') {
                dbData = Buffer.alloc(dataLen);
                fs.readSync(fd, dbData, 0, dataLen, offset);
            }
            offset += dataLen;
        }
    } finally {
        fs.closeSync(fd);
    }

    if (!dbData) {
        throw new Error(`database.risudat not found inside archive: ${resolvedPath}`);
    }
    return { dbData, entryCount, fileSize: stat.size };
}

/**
 * Uploads a RisuAI backup .bin file to Oracle Database.
 */
async function syncBackupToOracle(backupPath, options = {}) {
    if (options.envPath) {
        loadOracleEnvFile(options.envPath);
    } else {
        loadOracleEnvFile();
    }

    const config = readOracleConfigFromEnv();
    if (!config.user || !config.password || !config.tnsAlias) {
        throw new Error('Oracle DB credentials not found. Please set ORACLE_USER, ORACLE_PASSWORD, ORACLE_TNS_ALIAS or configure .env.oracle');
    }

    console.log('[Oracle Sync] Connecting to Oracle Database:', {
        user: config.user,
        tns: config.tnsAlias,
        walletPath: config.walletPath || '(default)',
    });

    const storage = new OracleStorage({
        user: config.user,
        password: config.password,
        tnsAlias: config.tnsAlias,
        walletPath: config.walletPath,
        walletPassword: config.walletPassword,
        poolMax: options.poolMax || 10,
        enabled: true,
    });

    await storage.initialize();
    console.log('[Oracle Sync] OracleStorage initialized successfully.');

    console.log(`[Oracle Sync] Parsing backup archive: ${backupPath}...`);
    const { dbData, entryCount, fileSize } = parseBackupArchive(backupPath);
    const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);
    console.log(`[Oracle Sync] Archive parsed (${sizeMb} MB, ${entryCount} total entries).`);

    console.log('[Oracle Sync] Decoding database.risudat...');
    const db = decodeRisuDb(new Uint8Array(dbData));
    const charCount = db.characters?.length || 0;
    console.log(`[Oracle Sync] Decoded ${charCount} characters.`);

    const rootKeys = Object.keys(db).filter(k => !['characters'].includes(k));
    const rootUpserts = rootKeys.map(k => ({ key: k, value: db[k] }));

    const allChars = (db.characters || []).map((char, i) => ({
        id: char.chaId || `char-${i}`,
        position: i,
        data: char,
    }));

    const allChatsForSync = [];
    const allMessagesForSync = [];
    for (const char of db.characters || []) {
        if (char.chats) {
            for (let j = 0; j < char.chats.length; j++) {
                const c = char.chats[j];
                allChatsForSync.push({
                    id: c.id || `chat-${j}`,
                    characterId: char.chaId,
                    position: j,
                    data: c,
                });
                if (c.message) {
                    for (let k = 0; k < c.message.length; k++) {
                        allMessagesForSync.push({
                            id: c.message[k].id || `msg-${k}`,
                            chatId: c.id,
                            position: k,
                            data: c.message[k],
                        });
                    }
                }
            }
        }
    }

    console.log(`[Oracle Sync] Payload summary: ${allChars.length} characters, ${allChatsForSync.length} chats, ${allMessagesForSync.length} messages, ${rootUpserts.length} settings`);

    if (options.dryRun) {
        console.log('[Oracle Sync] --dry-run specified. Skipping DB sync.');
        await storage.close();
        return { dryRun: true, characters: allChars.length, chats: allChatsForSync.length, messages: allMessagesForSync.length };
    }

    const currentMeta = await storage.getState();
    console.log('[Oracle Sync] Current Oracle DB meta:', currentMeta);

    const syncPayload = {
        baseRevision: currentMeta.revision,
        replaceAll: options.replaceAll !== false,
        root: {
            upserts: rootUpserts,
            deletes: [],
        },
        characters: allChars,
        characterIds: allChars.map(c => c.id),
        chats: allChatsForSync,
        chatManifests: [],
        messages: allMessagesForSync,
        messageManifests: [],
    };

    console.log('[Oracle Sync] Executing storage.sync() against Oracle Database...');
    const startTime = Date.now();
    const onProgress = (info) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (info.stage === 'bulk_insert') {
            const pct = Math.round((info.current / info.total) * 100);
            process.stdout.write(`\r⏳ [${elapsed}s] ${info.table}: ${info.current} / ${info.total} (${pct}%)        `);
            if (info.current >= info.total) console.log();
        } else {
            console.log(`\n⏳ [${elapsed}s] [${info.percent || 0}%] ${info.message}`);
        }
    };

    const result = await storage.sync(syncPayload, { onProgress });
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 Real Oracle sync SUCCESS! Result:`, result, `(took ${duration}s)\n`);

    if (options.shallowVerify !== false) {
        console.log('[Oracle Sync] Testing loadStartupData() from Oracle DB...');
        const loaded = await storage.loadStartupData();
        console.log(`[Oracle Sync] Verification succeeded! Loaded characters: ${loaded.characters?.length}, Revision: ${loaded.revision}`);
    }

    await storage.close();
    console.log('[Oracle Sync] Connection closed cleanly.');
    return result;
}

function parseCliArgs() {
    const args = process.argv.slice(2);
    const options = {
        filePath: null,
        envPath: null,
        dryRun: false,
        shallowVerify: true,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--no-shallow') {
            options.shallowVerify = false;
        } else if (arg === '--env' && i + 1 < args.length) {
            options.envPath = args[++i];
        } else if ((arg === '--file' || arg === '-f') && i + 1 < args.length) {
            options.filePath = args[++i];
        } else if (!arg.startsWith('-') && !options.filePath) {
            options.filePath = arg;
        }
    }
    return options;
}

function printUsage() {
    console.log(`
RisuAI Oracle Database Sync Tool
================================
Uploads and synchronizes RisuAI backup archives (.bin) to an Oracle Database.

Usage:
  node server/node/real_oracle_sync.cjs [backup-file.bin] [options]

Options:
  --file, -f <path>    Path to .bin backup archive file
  --env <path>         Path to Oracle .env file (default: .env.oracle or active env)
  --dry-run            Parse and validate archive without executing DB sync
  --no-shallow         Skip post-sync shallow verification test
  --help, -h           Show this help message

Environment Variables:
  ORACLE_USER          Oracle DB username
  ORACLE_PASSWORD      Oracle DB password
  ORACLE_TNS_ALIAS     TNS Alias (from tnsnames.ora)
  ORACLE_WALLET_PATH   Path to Oracle Wallet directory
  RISUAI_BACKUP_PATH   Default backup file path to use if none specified

Examples:
  node server/node/real_oracle_sync.cjs path/to/backup.bin
  node server/node/real_oracle_sync.cjs --file ./my_backup.bin --dry-run
  node server/node/real_oracle_sync.cjs backup.bin --env /path/to/.env.oracle
`);
}

async function main() {
    const opts = parseCliArgs();
    if (opts.help) {
        printUsage();
        process.exit(0);
    }

    const targetFile = opts.filePath || process.env.RISUAI_BACKUP_PATH;
    if (!targetFile) {
        printUsage();
        console.error('Error: Please specify the path to a .bin backup archive file.\n');
        process.exit(1);
    }

    await syncBackupToOracle(targetFile, opts);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('\n❌ FAILED with error:', err);
        process.exit(1);
    });
}

module.exports = {
    decodeRisuDb,
    parseBackupArchive,
    syncBackupToOracle,
};
