const fs = require('fs');
const path = require('path');
const fflate = require('fflate');
const { Unpackr } = require('msgpackr/index-no-eval');
const { AzureStorage } = require('./azureStorage.cjs');
const { loadAzureEnvFile, readAzureConfigFromEnv } = require('./storageDriver.cjs');

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
 * Uploads a RisuAI backup .bin file to Azure SQL Database.
 */
async function syncBackupToAzure(backupPath, options = {}) {
    if (options.envPath) {
        loadAzureEnvFile(options.envPath);
    } else {
        loadAzureEnvFile();
    }

    const config = readAzureConfigFromEnv();
    if (!config.server || !config.database || !config.user || !config.password) {
        throw new Error('Azure SQL DB credentials not found. Please set AZURE_HOST, AZURE_DATABASE, AZURE_USERNAME, AZURE_PASSWORD or configure .env.azure');
    }

    console.log('[Azure Sync] Connecting to Azure SQL Database:', {
        server: config.server,
        database: config.database,
        user: config.user,
    });

    const storage = new AzureStorage({
        server: config.server,
        database: config.database,
        user: config.user,
        password: config.password,
        port: config.port,
        poolMax: options.poolMax || 10,
        enabled: true,
    });

    await storage.initialize();
    console.log('[Azure Sync] AzureStorage initialized successfully.');

    console.log(`[Azure Sync] Parsing backup archive: ${backupPath}...`);
    const { dbData, entryCount, fileSize } = parseBackupArchive(backupPath);
    const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);
    console.log(`[Azure Sync] Archive parsed (${sizeMb} MB, ${entryCount} total entries).`);

    console.log('[Azure Sync] Decoding database.risudat...');
    const db = decodeRisuDb(new Uint8Array(dbData));
    const charCount = db.characters?.length || 0;
    console.log(`[Azure Sync] Decoded ${charCount} characters.`);

    const rootKeys = Object.keys(db).filter((k) => !['characters'].includes(k));
    const rootUpserts = rootKeys.map((k) => ({ key: k, value: db[k] }));

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

    console.log(`[Azure Sync] Payload summary: ${allChars.length} characters, ${allChatsForSync.length} chats, ${allMessagesForSync.length} messages, ${rootUpserts.length} settings`);

    if (options.dryRun) {
        console.log('[Azure Sync] --dry-run specified. Skipping DB sync.');
        await storage.close();
        return { dryRun: true, characters: allChars.length, chats: allChatsForSync.length, messages: allMessagesForSync.length };
    }

    const currentMeta = await storage.getState();
    console.log('[Azure Sync] Current Azure DB meta:', currentMeta);

    const syncPayload = {
        baseRevision: currentMeta.revision,
        replaceAll: options.replaceAll !== false,
        root: {
            upserts: rootUpserts,
            deletes: [],
        },
        characters: allChars,
        characterIds: allChars.map((c) => c.id),
        chats: allChatsForSync,
        chatManifests: [],
        messages: allMessagesForSync,
        messageManifests: [],
    };

    console.log('[Azure Sync] Executing storage.sync() against Azure SQL Database...');
    const startTime = Date.now();
    const onProgress = (info) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`⏳ [${elapsed}s] [${info.stage}] ${info.message}`);
    };

    const result = await storage.sync(syncPayload, { onProgress });
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 Real Azure SQL sync SUCCESS! Result:`, result, `(took ${duration}s)\n`);

    if (options.shallowVerify !== false) {
        console.log('[Azure Sync] Testing loadStartupData() from Azure SQL DB...');
        const loaded = await storage.loadStartupData();
        console.log(`[Azure Sync] Startup verification succeeded! Loaded characters: ${loaded.characters?.length}, Revision: ${loaded.revision}`);
    }

    if (options.fullVerify) {
        console.log('[Azure Sync] Testing exportDatabaseSnapshot() with messages from Azure SQL DB...');
        const fullLoaded = await storage.exportDatabaseSnapshot();
        let totalLoadedChats = 0;
        let totalLoadedMessages = 0;
        for (const c of fullLoaded.database?.characters || []) {
            if (c.chats) {
                totalLoadedChats += c.chats.length;
                for (const ch of c.chats) {
                    if (ch.message) totalLoadedMessages += ch.message.length;
                }
            }
        }
        console.log(`[Azure Sync] Full verification succeeded! Characters: ${fullLoaded.database?.characters?.length}, Chats: ${totalLoadedChats}, Messages: ${totalLoadedMessages}`);
    }

    await storage.close();
    console.log('[Azure Sync] Connection closed cleanly.');
    return result;
}

function parseCliArgs() {
    const args = process.argv.slice(2);
    const options = {
        filePath: null,
        envPath: null,
        dryRun: false,
        shallowVerify: true,
        fullVerify: true,
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
        } else if (arg === '--no-full') {
            options.fullVerify = false;
        } else if (arg === '--env' && i + 1 < args.length) {
            options.envPath = args[++i];
        } else if (!arg.startsWith('-') && !options.filePath) {
            options.filePath = arg;
        }
    }

    return options;
}

if (require.main === module) {
    const options = parseCliArgs();

    if (options.help) {
        console.log(`
RisuAI Real Azure SQL Sync & Verification CLI

Usage:
  node real_azure_sync.cjs [options] [path/to/backup.bin]

Options:
  --dry-run        Parse backup archive and validate payload without writing to Azure SQL
  --no-shallow     Skip post-sync shallow verification
  --no-full        Skip post-sync full verification (with messages)
  --env <path>     Path to custom .env file (default: .env.azure)
  --help, -h       Show this help message

Default backup file search:
  1. CLI argument
  2. Binary1.bin
  3. save/backup.bin
`);
        process.exit(0);
    }

    const defaultCandidates = [
        options.filePath,
        path.join(process.cwd(), 'Binary1.bin'),
        path.join(process.cwd(), 'save', 'backup.bin'),
        path.join(__dirname, '../../Binary1.bin'),
    ].filter(Boolean);

    let backupFile = null;
    for (const candidate of defaultCandidates) {
        if (fs.existsSync(candidate)) {
            backupFile = candidate;
            break;
        }
    }

    if (!backupFile) {
        console.error('Error: No backup .bin file found. Specify path via argument: node real_azure_sync.cjs Binary1.bin');
        process.exit(1);
    }

    syncBackupToAzure(backupFile, options)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('\n❌ Azure SQL Sync failed with error:', err);
            process.exit(1);
        });
}

module.exports = {
    syncBackupToAzure,
    parseBackupArchive,
    decodeRisuDb,
};
