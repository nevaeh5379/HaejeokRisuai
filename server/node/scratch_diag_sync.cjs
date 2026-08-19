const fs = require('fs');
const path = require('path');
const fflate = require('fflate');
const { Unpackr } = require('msgpackr/index-no-eval');
const { OracleStorage } = require('./oracleStorage.cjs');
const { loadOracleEnvFile, readOracleConfigFromEnv } = require('./storageDriver.cjs');
const { splitCharacter, splitChat, splitMessage } = require('./postgresRelationalCodec.cjs');

const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);

function decodeRisuDb(data) {
    const raw = data.slice(magicCompressedHeader.length);
    const decompressed = fflate.decompressSync(raw);
    return unpackr.decode(decompressed);
}

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
    try {
        while (offset < stat.size) {
            if (offset + 4 > stat.size) break;
            fs.readSync(fd, lenBuf, 0, 4, offset);
            offset += 4;
            const nameLen = lenBuf.readUInt32LE(0);
            const nameBuf = Buffer.alloc(nameLen);
            fs.readSync(fd, nameBuf, 0, nameLen, offset);
            offset += nameLen;
            const entryName = nameBuf.toString('utf8');

            fs.readSync(fd, lenBuf, 0, 4, offset);
            offset += 4;
            const dataLen = lenBuf.readUInt32LE(0);

            if (entryName === 'database.risudat') {
                dbData = Buffer.alloc(dataLen);
                fs.readSync(fd, dbData, 0, dataLen, offset);
                break;
            }
            offset += dataLen;
        }
    } finally {
        fs.closeSync(fd);
    }
    return dbData;
}

async function test() {
    loadOracleEnvFile();
    const config = readOracleConfigFromEnv();
    const storage = new OracleStorage({ ...config, enabled: true });
    await storage.initialize();

    const targetFile = process.argv[2] || process.env.RISUAI_BACKUP_PATH;
    if (!targetFile) {
        console.error('Usage: node server/node/scratch_diag_sync.cjs <backup-file.bin>');
        process.exit(1);
    }
    console.log(`Testing with backup file: ${targetFile}`);
    const dbData = parseBackupArchive(targetFile);
    const db = decodeRisuDb(new Uint8Array(dbData));
    console.log(`Decoded: ${db.characters.length} characters`);

    const splitMessages = [];
    for (const char of db.characters) {
        if (char.chats) {
            for (let j = 0; j < char.chats.length; j++) {
                if (char.chats[j].message) {
                    for (let k = 0; k < char.chats[j].message.length; k++) {
                        splitMessages.push(splitMessage({ id: char.chats[j].message[k].id || `m-${k}`, chatId: char.chats[j].id, position: k, data: char.chats[j].message[k] }));
                    }
                }
            }
        }
    }
    console.log(`Total Messages in archive: ${splitMessages.length}`);

    const conn = await storage.pool.getConnection();
    try {
        console.time('500 messages bulk insert');
        const messageColumns = ['chat_id', 'id', 'position', 'role', 'content_text', 'content_binary', 'saying_character_id', 'sent_time', 'sender_name', 'other_user', 'disabled_scope', 'is_comment'];
        await storage._bulkInsertRows(conn, 'chat_messages', messageColumns, splitMessages.slice(0, 500).map(m => m.core));
        console.timeEnd('500 messages bulk insert');
        console.log('500 messages bulk insert test SUCCESS!');
    } finally {
        await conn.rollback();
        await conn.close();
        await storage.pool.close(0);
    }
}

test().catch(console.error);
