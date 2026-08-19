const { OracleStorage } = require('./oracleStorage.cjs');
const { loadOracleEnvFile, readOracleConfigFromEnv } = require('./storageDriver.cjs');

async function verify() {
    loadOracleEnvFile();
    const config = readOracleConfigFromEnv();
    const storage = new OracleStorage({ ...config, poolMax: 5, enabled: true });
    await storage.initialize();

    console.log('--- Real Oracle Cloud Database Verification ---');
    const state = await storage.getState();
    console.log('Database State:', state);

    const conn = await storage.pool.getConnection();
    try {
        const r1 = await conn.execute(`SELECT COUNT(*) AS CNT FROM character_characters`);
        console.log('Characters in DB:', r1.rows[0][0]);

        const r2 = await conn.execute(`SELECT COUNT(*) AS CNT FROM chat_chats`);
        console.log('Chats in DB:', r2.rows[0][0]);

        const r3 = await conn.execute(`SELECT COUNT(*) AS CNT FROM chat_messages`);
        console.log('Messages in DB:', r3.rows[0][0]);

        const r4 = await conn.execute(`SELECT COUNT(*) AS CNT FROM chat_message_prompt_toggles`);
        console.log('Message Prompt Toggles in DB:', r4.rows[0][0]);

        const r5 = await conn.execute(`SELECT COUNT(*) AS CNT FROM system_setting_values`);
        console.log('Setting Values in DB:', r5.rows[0][0]);

        const r6 = await conn.execute(`SELECT id, name FROM character_characters FETCH FIRST 5 ROWS ONLY`);
        console.log('Sample Characters:', r6.rows.map(r => ({ id: r[0], name: r[1] })));
    } finally {
        await conn.close();
    }

    console.log('Testing storage.loadDatabase({ shallow: true })...');
    const loaded = await storage.loadDatabase({ shallow: true });
    console.log('loadDatabase successful! Characters:', loaded.database?.characters?.length, 'Revision:', loaded.revision);

    await storage.close();
    console.log('Verification completed successfully!');
}

verify().catch(console.error);
