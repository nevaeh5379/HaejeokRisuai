const { OracleStorage } = require('./oracleStorage.cjs');
const { loadOracleEnvFile, readOracleConfigFromEnv } = require('./storageDriver.cjs');

/**
 * CLI utility to inspect and verify Oracle Database state and table records.
 */
async function verifyOracleDatabase(options = {}) {
    if (options.envPath) {
        loadOracleEnvFile(options.envPath);
    } else {
        loadOracleEnvFile();
    }

    const config = readOracleConfigFromEnv();
    if (!config.user || !config.password || !config.tnsAlias) {
        throw new Error('Oracle DB credentials not found. Please set ORACLE_USER, ORACLE_PASSWORD, ORACLE_TNS_ALIAS or configure .env.oracle');
    }

    const storage = new OracleStorage({ ...config, poolMax: 5, enabled: true });
    await storage.initialize();

    console.log('\n========================================');
    console.log('  RisuAI Oracle Database Verification   ');
    console.log('========================================');

    const state = await storage.getState();
    console.log('Database Status:', {
        initialized: state.initialized,
        revision: state.revision,
    });

    const conn = await storage.pool.getConnection();
    try {
        const tables = [
            'system_settings',
            'system_setting_values',
            'character_characters',
            'character_attributes',
            'character_assets',
            'character_lore_entries',
            'chat_chats',
            'chat_attributes',
            'chat_messages',
            'chat_message_attributes',
            'chat_message_prompt_toggles',
            'chat_message_prompt_items',
        ];

        console.log('\nTable Record Counts:');
        console.log('----------------------------------------');
        for (const table of tables) {
            try {
                const res = await conn.execute(`SELECT COUNT(*) AS CNT FROM ${table}`);
                const count = res.rows[0][0];
                console.log(`  • ${table.padEnd(30)}: ${String(count).padStart(8)} rows`);
            } catch (e) {
                console.log(`  • ${table.padEnd(30)}: (Table not accessible / ${e.message})`);
            }
        }

        try {
            const sampleChars = await conn.execute(`SELECT id, name FROM character_characters FETCH FIRST 5 ROWS ONLY`);
            console.log('\nSample Characters:');
            for (const r of sampleChars.rows) {
                console.log(`  • ID: ${r[0]} | Name: ${r[1]}`);
            }
        } catch (e) {}
    } finally {
        await conn.close();
    }

    if (options.shallowVerify !== false) {
        console.log('\nTesting storage.loadDatabase({ shallow: true })...');
        const loaded = await storage.loadDatabase({ shallow: true });
        console.log(`✅ loadDatabase verified! Characters count: ${loaded.database?.characters?.length}, Revision: ${loaded.revision}`);
    }

    await storage.close();
    console.log('\nVerification completed successfully.\n');
}

function parseCliArgs() {
    const args = process.argv.slice(2);
    const options = { envPath: null, shallowVerify: true, help: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--no-shallow') {
            options.shallowVerify = false;
        } else if (arg === '--env' && i + 1 < args.length) {
            options.envPath = args[++i];
        }
    }
    return options;
}

if (require.main === module) {
    const opts = parseCliArgs();
    if (opts.help) {
        console.log(`
Usage:
  node server/node/verifyOracleDatabase.cjs [options]

Options:
  --env <path>    Path to Oracle .env file (default: .env.oracle or current environment)
  --no-shallow    Skip shallow load test
  --help, -h      Show this help message
`);
        process.exit(0);
    }
    verifyOracleDatabase(opts).catch((err) => {
        console.error('\n❌ Verification failed:', err);
        process.exit(1);
    });
}

module.exports = {
    verifyOracleDatabase,
};
