import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    access,
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const checkoutFiles = [
    "risuai.sh",
    "Dockerfile",
    "docker-compose.rustfs.yml",
    "docker-compose.rustfs.local.yml",
    "docker-compose.rustfs.lan.yml",
    "docker-compose.rustfs.caddy.yml",
    "docker-compose.rustfs.cloudflare.yml",
    "docker-compose.rustfs.dynv6.yml",
    "docker-compose.rustfs.proxy-docker.yml",
    "deploy/rustfs/Caddyfile",
    "deploy/rustfs/update-cloudflare.mjs",
    "deploy/rustfs/update-dynv6.sh",
];

const fixedCredentials = {
    POSTGRES_PASSWORD: "postgres_test_secret",
    RUSTFS_ACCESS_KEY: "risuai-test-access",
    RUSTFS_SECRET_KEY: "rustfs_test_secret",
};

const capturedDockerEnvironment = [
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
    "COMPOSE_ENV_FILES",
    "RISUAI_MODE",
    "RISUAI_DNS_PROVIDER",
    "RISUAI_PROXY_TYPE",
    "RISUAI_PROXY_NETWORK",
    "RISUAI_INSTALLATION_ID",
    "RISUAI_PORT",
    "RISUAI_HTTP_PORT",
    "RISUAI_HTTPS_PORT",
    "RISUAI_MIGRATE_CONCURRENCY",
    "POSTGRES_PASSWORD",
    "RUSTFS_ACCESS_KEY",
    "RUSTFS_SECRET_KEY",
    "RUSTFS_BIND_ADDRESS",
    "RUSTFS_API_PORT",
    "RUSTFS_CONSOLE_PORT",
    "RISUAI_DOMAIN",
    "DYNV6_ZONE",
    "DYNV6_TOKEN",
    "DYNV6_IPV6",
    "DYNV6_TOKEN_FILE",
    "DYNV6_UPDATE_INTERVAL",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_TOKEN",
    "CLOUDFLARE_IPV6",
    "CLOUDFLARE_TOKEN_FILE",
    "CLOUDFLARE_UPDATE_INTERVAL",
];

function fakeDockerSource() {
    return `#!${process.execPath}
const fs = require("node:fs");

const args = process.argv.slice(2);
const environmentKeys = ${JSON.stringify(capturedDockerEnvironment)};
const environment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key] ?? null]));
const composeIndex = args.indexOf("compose");
const composeArgs = composeIndex === -1 ? [] : args.slice(composeIndex + 1);
const knownComposeCommands = new Set([
    "version", "config", "build", "run", "up", "ps", "exec", "logs", "down", "stop", "restart",
]);
const command = composeArgs.find((argument) => knownComposeCommands.has(argument)) ?? null;
const record = { args, compose: composeIndex !== -1, command, env: environment };
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(record) + "\\n");

function exit(code, output = "") {
    if (output) process.stdout.write(output);
    process.exit(code);
}

function services() {
    const result = ["rustfs", "postgres", "risuai"];
    if (process.env.RISUAI_MODE === "domain" || process.env.RISUAI_MODE === "dynv6") result.push("caddy");
    if (process.env.RISUAI_MODE === "dynv6") result.push("dynv6");
    if (process.env.RISUAI_MODE === "domain" && process.env.RISUAI_DNS_PROVIDER === "cloudflare") {
        result.push("cloudflare-ddns");
    }
    return result;
}

function setRunning(running) {
    if (running) fs.writeFileSync(process.env.FAKE_DOCKER_STATE, "running\\n");
    else {
        try { fs.unlinkSync(process.env.FAKE_DOCKER_STATE); } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}

function isRunning() {
    return process.env.FAKE_RUNNING === "1" || fs.existsSync(process.env.FAKE_DOCKER_STATE);
}

if (composeIndex !== -1) {
    if (command === "version") exit(process.env.FAKE_COMPOSE_VERSION_FAIL === "1" ? 1 : 0, "Docker Compose version v2.test\\n");
    if (command === "config") {
        if (process.env.FAKE_COMPOSE_CONFIG_FAIL === "1") exit(1);
        if (composeArgs.includes("--services")) exit(0, services().join("\\n") + "\\n");
        exit(0);
    }
    if (command === "build") exit(process.env.FAKE_COMPOSE_BUILD_FAIL === "1" ? 1 : 0);
    if (command === "run") exit(process.env.FAKE_COMPOSE_RUN_FAIL === "1" ? 1 : 0);
    if (command === "up") {
        if (process.env.FAKE_COMPOSE_UP_FAIL === "1") exit(1);
        setRunning(true);
        exit(0);
    }
    if (command === "down" || command === "stop") {
        setRunning(false);
        exit(0);
    }
    if (command === "restart") {
        setRunning(true);
        exit(0);
    }
    if (command === "exec") exit(process.env.FAKE_READINESS_FAIL === "1" ? 1 : 0);
    if (command === "logs") exit(0, process.env.FAKE_LOG_OUTPUT || "");
    if (command === "ps") {
        if (composeArgs.includes("-q")) {
            const service = composeArgs.at(-1);
            exit(isRunning() ? 0 : 1, isRunning() ? service + "-container-id\\n" : "");
        }
        if (composeArgs.includes("--services")) exit(0, isRunning() ? services().join("\\n") + "\\n" : "");
        exit(0, isRunning() ? services().join("\\n") + "\\n" : "");
    }
    exit(0);
}

if (args[0] === "info") exit(process.env.FAKE_DOCKER_INFO_FAIL === "1" ? 1 : 0);
if (args[0] === "context" && args[1] === "show") exit(0, "default\\n");
if (args[0] === "context" && args[1] === "inspect") exit(0, "unix:///var/run/docker.sock\\n");
if (args[0] === "network" && args[1] === "inspect") exit(process.env.FAKE_NETWORK_MISSING === "1" ? 1 : 0);
if (args[0] === "volume" && args[1] === "inspect") exit(1);
if (args[0] === "image" && args[1] === "inspect") exit(process.env.FAKE_IMAGE_EXISTS === "1" ? 0 : 1);
if (args[0] === "ps") exit(0);
if (args[0] === "inspect") {
    if (args.includes("--format")) exit(0, "none\\n");
    exit(1);
}
exit(0);
`;
}

function fakeDateSource() {
    return `#!${process.execPath}
const fs = require("node:fs");
let current = 1000;
try { current = Number(fs.readFileSync(process.env.FAKE_DATE_STATE, "utf8")) || current; } catch {}
current += 11;
fs.writeFileSync(process.env.FAKE_DATE_STATE, String(current));
process.stdout.write(String(current) + "\\n");
`;
}

function fakeCommandSource(kind) {
    if (kind === "ss") {
        return `#!${process.execPath}\nprocess.stdout.write(process.env.FAKE_SS_OUTPUT || "");\n`;
    }
    if (kind === "ufw") {
        return `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_UFW_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "status") process.stdout.write("Status: inactive\\n");
`;
    }
    return `#!${process.execPath}\nprocess.exit(0);\n`;
}

async function writeExecutable(path, contents) {
    await writeFile(path, contents, { mode: 0o755 });
    await chmod(path, 0o755);
}

async function createFixture(t) {
    const checkout = await mkdtemp(join(tmpdir(), "risuai-installer-test-"));
    t.after(() => rm(checkout, { recursive: true, force: true }));

    for (const relativePath of checkoutFiles) {
        const destination = join(checkout, relativePath);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(repositoryRoot, relativePath), destination);
    }
    await chmod(join(checkout, "risuai.sh"), 0o755);

    const fakeBin = join(checkout, "fake-bin");
    const dockerLog = join(checkout, "docker-calls.jsonl");
    const dockerState = join(checkout, "docker-state");
    const dateState = join(checkout, "date-state");
    const ufwLog = join(checkout, "ufw-calls.jsonl");
    await mkdir(fakeBin);
    await writeExecutable(join(fakeBin, "docker"), fakeDockerSource());
    await writeExecutable(join(fakeBin, "ss"), fakeCommandSource("ss"));
    await writeExecutable(join(fakeBin, "sleep"), fakeCommandSource("sleep"));
    await writeExecutable(join(fakeBin, "date"), fakeDateSource());
    await writeExecutable(join(fakeBin, "ufw"), fakeCommandSource("ufw"));

    const baseEnvironment = { ...process.env };
    for (const key of Object.keys(baseEnvironment)) {
        if (
            key === "DOCKER_HOST" ||
            key === "POSTGRES_PASSWORD" ||
            key === "NO_COLOR" ||
            key.startsWith("COMPOSE_") ||
            key.startsWith("RISUAI_") ||
            key.startsWith("RUSTFS_") ||
            key.startsWith("DYNV6_") ||
            key.startsWith("CLOUDFLARE_") ||
            key.startsWith("FAKE_")
        ) {
            delete baseEnvironment[key];
        }
    }
    Object.assign(baseEnvironment, {
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        NO_COLOR: "1",
        TERM: "dumb",
        LC_ALL: "C",
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_DOCKER_STATE: dockerState,
        FAKE_DATE_STATE: dateState,
        FAKE_UFW_LOG: ufwLog,
    });

    return {
        checkout,
        script: join(checkout, "risuai.sh"),
        dockerLog,
        dockerState,
        environment(overrides = {}) {
            return { ...baseEnvironment, ...overrides };
        },
        async run(args, overrides = {}) {
            return runProcess(join(checkout, "risuai.sh"), args, checkout, {
                ...baseEnvironment,
                ...overrides,
            });
        },
        async dockerCalls() {
            try {
                const contents = await readFile(dockerLog, "utf8");
                return contents
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
            } catch (error) {
                if (error.code === "ENOENT") return [];
                throw error;
            }
        },
        async clearDockerCalls() {
            await writeFile(dockerLog, "");
        },
    };
}

function runProcess(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        const timeout = setTimeout(() => {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {}
            reject(new Error(`timed out running ${command} ${args.join(" ")}`));
        }, 15_000);
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function parseEnv(contents) {
    return Object.fromEntries(
        contents
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const separator = line.indexOf("=");
                assert.notEqual(separator, -1, `invalid env line: ${line}`);
                return [line.slice(0, separator), line.slice(separator + 1)];
            }),
    );
}

async function readSavedEnvironment(fixture) {
    return parseEnv(await readFile(join(fixture.checkout, ".risuai/rustfs.env"), "utf8"));
}

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function permission(path) {
    return (await stat(path)).mode & 0o777;
}

function composeFiles(call) {
    const files = [];
    for (let index = 0; index < call.args.length; index += 1) {
        if (call.args[index] === "-f") files.push(basename(call.args[index + 1]));
    }
    return files;
}

async function installWithoutStarting(fixture, modeArguments, environment = fixedCredentials) {
    return fixture.run(
        ["install", ...modeArguments, "--no-start", "--yes", "--skip-port-check"],
        environment,
    );
}

async function protectedSnapshot(fixture) {
    const state = join(fixture.checkout, ".risuai");
    const result = {};
    for (const name of ["rustfs.env", "dynv6-token", "cloudflare-token"]) {
        const path = join(state, name);
        if (await exists(path)) {
            result[name] = {
                contents: await readFile(path, "utf8"),
                mode: await permission(path),
            };
        } else {
            result[name] = null;
        }
    }
    return result;
}

async function assertNoTransactionDebris(fixture) {
    const names = await readdir(join(fixture.checkout, ".risuai"));
    assert.equal(names.some((name) => name.includes(".new.")), false, names.join(", "));
    assert.equal(names.some((name) => name.includes(".rollback.")), false, names.join(", "));
    assert.equal(names.includes("operation.lock"), false, names.join(", "));
}

test("help and version are side-effect free and do not require Docker", async (t) => {
    const fixture = await createFixture(t);
    for (const [arguments_, output] of [
        [["help"], /Deployment modes:/],
        [["--help"], /Usage:/],
        [["version"], /^risuai\.sh 2\.0\.0 \(configuration schema 2\)$/m],
    ]) {
        const result = await fixture.run(arguments_);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, output);
    }
    assert.deepEqual(await fixture.dockerCalls(), []);
    assert.equal(await exists(join(fixture.checkout, ".risuai")), false);
});

test("non-interactive installs require both a mode and explicit confirmation", async (t) => {
    await t.test("missing mode", async (t) => {
        const fixture = await createFixture(t);
        const result = await fixture.run(["install", "--no-start", "--yes", "--skip-port-check"], fixedCredentials);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /Non-interactive installation requires --mode/);
    });

    await t.test("missing --yes", async (t) => {
        const fixture = await createFixture(t);
        const result = await fixture.run(["install", "--mode", "local", "--no-start", "--skip-port-check"], fixedCredentials);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /No controlling terminal is available for confirmation/);
        assert.equal(await exists(join(fixture.checkout, ".risuai/rustfs.env")), false);
    });
});

test("all deployment variants save isolated, protected no-start configurations", async (t) => {
    const zoneId = "0123456789abcdef0123456789abcdef";
    const variants = [
        {
            name: "local",
            arguments: ["--mode", "local"],
            overlays: ["docker-compose.rustfs.yml", "docker-compose.rustfs.local.yml"],
            saved: { RISUAI_MODE: "local", RISUAI_DNS_PROVIDER: "none", RISUAI_PROXY_TYPE: "none" },
        },
        {
            name: "lan",
            arguments: ["--mode", "lan", "--app-port", "7000"],
            overlays: ["docker-compose.rustfs.yml", "docker-compose.rustfs.lan.yml"],
            saved: { RISUAI_MODE: "lan", RISUAI_DNS_PROVIDER: "none", RISUAI_PROXY_TYPE: "none", RISUAI_PORT: "7000" },
        },
        {
            name: "domain with manual DNS",
            arguments: ["--mode", "domain", "--domain", "Chat.Example.COM.", "--dns-provider", "manual"],
            overlays: ["docker-compose.rustfs.yml", "docker-compose.rustfs.caddy.yml"],
            saved: {
                RISUAI_MODE: "domain",
                RISUAI_DNS_PROVIDER: "manual",
                RISUAI_PROXY_TYPE: "none",
                RISUAI_DOMAIN: "chat.example.com",
            },
        },
        ...[false, true].map((ipv6) => ({
            name: `domain with Cloudflare (${ipv6 ? "IPv4+IPv6" : "IPv4"})`,
            arguments: [
                "--mode",
                "domain",
                "--domain",
                "cf.example.com",
                "--dns-provider",
                "cloudflare",
                "--cloudflare-zone-id",
                zoneId,
                ipv6 ? "--ipv6" : "--no-ipv6",
            ],
            tokenKind: "cloudflare",
            token: `cloudflare-token-${ipv6 ? "v6" : "v4"}`,
            overlays: [
                "docker-compose.rustfs.yml",
                "docker-compose.rustfs.caddy.yml",
                "docker-compose.rustfs.cloudflare.yml",
            ],
            saved: {
                RISUAI_MODE: "domain",
                RISUAI_DNS_PROVIDER: "cloudflare",
                RISUAI_PROXY_TYPE: "none",
                RISUAI_DOMAIN: "cf.example.com",
                CLOUDFLARE_ZONE_ID: zoneId,
                DYNV6_IPV6: String(ipv6),
                CLOUDFLARE_IPV6: String(ipv6),
            },
        })),
        ...[false, true].map((ipv6) => ({
            name: `dynv6 (${ipv6 ? "IPv4+IPv6" : "IPv4"})`,
            arguments: [
                "--mode",
                "dynv6",
                "--domain",
                "chat.dynv6.net",
                ipv6 ? "--ipv6" : "--no-ipv6",
            ],
            tokenKind: "dynv6",
            token: `dynv6-token-${ipv6 ? "v6" : "v4"}`,
            overlays: [
                "docker-compose.rustfs.yml",
                "docker-compose.rustfs.caddy.yml",
                "docker-compose.rustfs.dynv6.yml",
            ],
            saved: {
                RISUAI_MODE: "dynv6",
                RISUAI_DNS_PROVIDER: "none",
                RISUAI_PROXY_TYPE: "none",
                RISUAI_DOMAIN: "chat.dynv6.net",
                DYNV6_IPV6: String(ipv6),
                CLOUDFLARE_IPV6: String(ipv6),
            },
        })),
        {
            name: "host reverse proxy",
            arguments: ["--mode", "proxy", "--proxy-type", "host", "--app-port", "6100"],
            overlays: ["docker-compose.rustfs.yml", "docker-compose.rustfs.local.yml"],
            saved: {
                RISUAI_MODE: "proxy",
                RISUAI_DNS_PROVIDER: "none",
                RISUAI_PROXY_TYPE: "host",
                RISUAI_PORT: "6100",
            },
        },
        {
            name: "Docker reverse proxy",
            arguments: ["--mode", "proxy", "--proxy-type", "docker", "--proxy-network", "reverse_proxy"],
            overlays: ["docker-compose.rustfs.yml", "docker-compose.rustfs.proxy-docker.yml"],
            saved: {
                RISUAI_MODE: "proxy",
                RISUAI_DNS_PROVIDER: "none",
                RISUAI_PROXY_TYPE: "docker",
                RISUAI_PROXY_NETWORK: "reverse_proxy",
            },
        },
    ];

    for (const variant of variants) {
        await t.test(variant.name, async (t) => {
            const fixture = await createFixture(t);
            const arguments_ = [...variant.arguments];
            if (variant.tokenKind) {
                const source = join(fixture.checkout, `${variant.tokenKind}-source-token`);
                await writeFile(source, `${variant.token}\n`, { mode: 0o600 });
                arguments_.push(`--${variant.tokenKind}-token-file`, source);
            }

            const result = await installWithoutStarting(fixture, arguments_);
            assert.equal(result.code, 0, result.stderr);
            assert.match(result.stdout, /configuration is installed but not started/);

            const envPath = join(fixture.checkout, ".risuai/rustfs.env");
            const envText = await readFile(envPath, "utf8");
            const saved = parseEnv(envText);
            assert.equal(saved.RISUAI_CONFIG_VERSION, "2");
            assert.equal(saved.COMPOSE_PROJECT_NAME, "risuai-rustfs");
            assert.match(saved.RISUAI_INSTALLATION_ID, /^[0-9a-f]{32}$/);
            assert.equal(saved.POSTGRES_PASSWORD, fixedCredentials.POSTGRES_PASSWORD);
            assert.equal(saved.RUSTFS_ACCESS_KEY, fixedCredentials.RUSTFS_ACCESS_KEY);
            assert.equal(saved.RUSTFS_SECRET_KEY, fixedCredentials.RUSTFS_SECRET_KEY);
            assert.equal(saved.RUSTFS_BIND_ADDRESS, "127.0.0.1");
            assert.equal(saved.RUSTFS_API_PORT, "9000");
            assert.equal(saved.RUSTFS_CONSOLE_PORT, "9001");
            assert.equal(saved.RISUAI_HTTP_PORT, "80");
            assert.equal(saved.RISUAI_HTTPS_PORT, "443");
            assert.equal(saved.DYNV6_UPDATE_INTERVAL, "300");
            for (const [key, value] of Object.entries(variant.saved)) assert.equal(saved[key], value, key);
            assert.equal(await permission(join(fixture.checkout, ".risuai")), 0o700);
            assert.equal(await permission(envPath), 0o600);

            const dynv6Token = join(fixture.checkout, ".risuai/dynv6-token");
            const cloudflareToken = join(fixture.checkout, ".risuai/cloudflare-token");
            assert.equal(await exists(dynv6Token), variant.tokenKind === "dynv6");
            assert.equal(await exists(cloudflareToken), variant.tokenKind === "cloudflare");
            if (variant.tokenKind) {
                const tokenPath = variant.tokenKind === "dynv6" ? dynv6Token : cloudflareToken;
                assert.equal(await readFile(tokenPath, "utf8"), variant.token);
                assert.equal(await permission(tokenPath), 0o600);
                assert.equal(envText.includes(variant.token), false, "provider tokens must not be written to the env file");
            }

            const calls = await fixture.dockerCalls();
            const prospectiveConfig = calls.find(
                (call) => call.command === "config" && call.args.includes("--quiet") && call.args.includes("--project-name"),
            );
            assert.ok(prospectiveConfig, "prospective Compose config was not invoked");
            assert.deepEqual(composeFiles(prospectiveConfig), variant.overlays);
            assert.equal(prospectiveConfig.env.COMPOSE_PROJECT_NAME, "risuai-rustfs");
            for (const [key, value] of Object.entries(variant.saved)) {
                if (capturedDockerEnvironment.includes(key)) assert.equal(prospectiveConfig.env[key], value, key);
            }
            assert.equal(calls.some((call) => ["build", "run", "up"].includes(call.command)), false);
            await assertNoTransactionDebris(fixture);
        });
    }
});

test("saved deployment values override hostile ambient Compose and deployment variables", async (t) => {
    const fixture = await createFixture(t);
    const savedCredentials = {
        POSTGRES_PASSWORD: "saved_postgres",
        RUSTFS_ACCESS_KEY: "saved_access",
        RUSTFS_SECRET_KEY: "saved_secret",
    };
    const install = await installWithoutStarting(
        fixture,
        [
            "--mode",
            "local",
            "--app-port",
            "6101",
            "--rustfs-api-port",
            "9100",
            "--rustfs-console-port",
            "9101",
        ],
        savedCredentials,
    );
    assert.equal(install.code, 0, install.stderr);
    const saved = await readSavedEnvironment(fixture);
    await fixture.clearDockerCalls();

    const poison = {
        COMPOSE_FILE: "/tmp/attacker-compose.yml",
        COMPOSE_PROJECT_NAME: "attacker-project",
        COMPOSE_PROFILES: "attacker-profile",
        COMPOSE_ENV_FILES: "/tmp/attacker.env",
        RISUAI_MODE: "lan",
        RISUAI_DOMAIN: "attacker.example.com",
        RISUAI_DNS_PROVIDER: "cloudflare",
        RISUAI_PROXY_TYPE: "docker",
        RISUAI_PROXY_NETWORK: "attacker-network",
        RISUAI_INSTALLATION_ID: "attacker-id",
        RISUAI_PORT: "6200",
        RISUAI_HTTP_PORT: "8080",
        RISUAI_HTTPS_PORT: "8443",
        RISUAI_MIGRATE_CONCURRENCY: "999",
        RUSTFS_BIND_ADDRESS: "0.0.0.0",
        RUSTFS_API_PORT: "9200",
        RUSTFS_CONSOLE_PORT: "9201",
        POSTGRES_PASSWORD: "attacker-postgres",
        RUSTFS_ACCESS_KEY: "attacker-access",
        RUSTFS_SECRET_KEY: "attacker-secret",
        DYNV6_ZONE: "attacker.dynv6.net",
        DYNV6_TOKEN: "attacker-dynv6-token",
        DYNV6_TOKEN_FILE: "/tmp/attacker-token",
        DYNV6_IPV6: "true",
        DYNV6_UPDATE_INTERVAL: "60",
        CLOUDFLARE_ZONE_ID: "ffffffffffffffffffffffffffffffff",
        CLOUDFLARE_TOKEN: "attacker-cloudflare-token",
        CLOUDFLARE_TOKEN_FILE: "/tmp/attacker-cloudflare-token",
        CLOUDFLARE_IPV6: "true",
        CLOUDFLARE_UPDATE_INTERVAL: "60",
        RISUAI_WAIT_TIMEOUT: "10",
    };
    const result = await fixture.run(["start"], poison);
    assert.equal(result.code, 0, result.stderr);

    const wrappedCalls = (await fixture.dockerCalls()).filter(
        (call) => call.compose && call.args.includes("--project-name"),
    );
    assert.ok(wrappedCalls.length > 0);
    for (const call of wrappedCalls) {
        assert.equal(call.env.COMPOSE_PROJECT_NAME, "risuai-rustfs");
        assert.equal(call.env.COMPOSE_FILE, null);
        assert.equal(call.env.COMPOSE_PROFILES, null);
        assert.equal(call.env.COMPOSE_ENV_FILES, null);
        assert.equal(call.env.RISUAI_MODE, "local");
        assert.equal(call.env.RISUAI_DNS_PROVIDER, "none");
        assert.equal(call.env.RISUAI_PROXY_TYPE, "none");
        assert.equal(call.env.RISUAI_PROXY_NETWORK, "");
        assert.equal(call.env.RISUAI_INSTALLATION_ID, saved.RISUAI_INSTALLATION_ID);
        assert.equal(call.env.RISUAI_PORT, "6101");
        assert.equal(call.env.RUSTFS_API_PORT, "9100");
        assert.equal(call.env.RUSTFS_CONSOLE_PORT, "9101");
        assert.equal(call.env.POSTGRES_PASSWORD, savedCredentials.POSTGRES_PASSWORD);
        assert.equal(call.env.RUSTFS_ACCESS_KEY, savedCredentials.RUSTFS_ACCESS_KEY);
        assert.equal(call.env.RUSTFS_SECRET_KEY, savedCredentials.RUSTFS_SECRET_KEY);
        assert.equal(call.env.RUSTFS_BIND_ADDRESS, "127.0.0.1");
        assert.equal(call.env.DYNV6_IPV6, "false");
        assert.equal(call.env.DYNV6_TOKEN, null);
        assert.equal(call.env.DYNV6_UPDATE_INTERVAL, "300");
        assert.equal(call.env.CLOUDFLARE_TOKEN, null);
        assert.equal(call.env.RISUAI_MIGRATE_CONCURRENCY, "4");
    }
});

test("untrusted options, hostnames, ports, collisions, networks, and service names are rejected", async (t) => {
    const cases = [
        {
            name: "unknown option",
            arguments: ["install", "--mode", "local", "--unknown-option", "payload", "--yes"],
            error: /Unknown install option/,
        },
        {
            name: "hostname env-line injection",
            arguments: [
                "install",
                "--mode",
                "domain",
                "--domain",
                "chat.example.com\nPOSTGRES_PASSWORD=injected",
                "--yes",
            ],
            error: /Invalid fully qualified hostname/,
        },
        {
            name: "zero port",
            arguments: ["install", "--mode", "local", "--app-port", "0", "--yes"],
            error: /Invalid port/,
        },
        {
            name: "port env-line injection",
            arguments: ["install", "--mode", "local", "--app-port", "6001\nEVIL=1", "--yes"],
            error: /Invalid port/,
        },
        {
            name: "app and RustFS API collision",
            arguments: [
                "install",
                "--mode",
                "local",
                "--app-port",
                "6001",
                "--rustfs-api-port",
                "6001",
                "--yes",
            ],
            error: /RisuAI and RustFS API cannot publish the same host port/,
        },
        {
            name: "RustFS API and console collision",
            arguments: [
                "install",
                "--mode",
                "local",
                "--rustfs-api-port",
                "9000",
                "--rustfs-console-port",
                "9000",
                "--yes",
            ],
            error: /RustFS API and console ports must be different/,
        },
        {
            name: "Caddy HTTP and HTTPS collision",
            arguments: [
                "install",
                "--mode",
                "domain",
                "--domain",
                "chat.example.com",
                "--http-port",
                "8443",
                "--https-port",
                "8443",
                "--yes",
            ],
            error: /Caddy HTTP and HTTPS ports must be different/,
        },
        {
            name: "Docker network command injection",
            arguments: [
                "install",
                "--mode",
                "proxy",
                "--proxy-type",
                "docker",
                "--proxy-network",
                "proxy;touch-pwned",
                "--yes",
            ],
            error: /Invalid or missing Docker proxy network name/,
        },
        {
            name: "Docker network env-line injection",
            arguments: [
                "install",
                "--mode",
                "proxy",
                "--proxy-type",
                "docker",
                "--proxy-network",
                "reverse_proxy\nCOMPOSE_FILE=attacker.yml",
                "--yes",
            ],
            error: /Invalid or missing Docker proxy network name/,
        },
        {
            name: "Cloudflare Zone ID env-line injection",
            arguments: [
                "install",
                "--mode",
                "domain",
                "--domain",
                "chat.example.com",
                "--dns-provider",
                "cloudflare",
                "--cloudflare-zone-id",
                "0123456789abcdef0123456789abcdef\nEVIL=1",
                "--cloudflare-token",
                "token",
                "--yes",
            ],
            error: /Invalid Cloudflare Zone ID/,
        },
        {
            name: "credential env-line injection",
            arguments: ["install", "--mode", "local", "--yes"],
            environment: {
                ...fixedCredentials,
                POSTGRES_PASSWORD: "safe-prefix\nCOMPOSE_FILE=attacker.yml",
            },
            error: /POSTGRES_PASSWORD must contain only/,
        },
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async (t) => {
            const fixture = await createFixture(t);
            const result = await fixture.run(
                [...scenario.arguments, "--no-start", "--skip-port-check"],
                scenario.environment ?? fixedCredentials,
            );
            assert.notEqual(result.code, 0);
            assert.match(result.stderr, scenario.error);
            assert.equal(await exists(join(fixture.checkout, ".risuai/rustfs.env")), false);
        });
    }

    await t.test("logs service argument injection", async (t) => {
        const fixture = await createFixture(t);
        const install = await installWithoutStarting(fixture, ["--mode", "local"]);
        assert.equal(install.code, 0, install.stderr);
        await fixture.clearDockerCalls();
        for (const service of ["risuai;touch-pwned", "risuai\n--tail=0"]) {
            const result = await fixture.run(["logs", "--no-follow", service]);
            assert.notEqual(result.code, 0);
            assert.match(result.stderr, /Invalid service name/);
        }
        assert.equal((await fixture.dockerCalls()).some((call) => call.command === "logs"), false);
    });
});

test("reinstall preserves generated identity, credentials, and saved provider tokens", async (t) => {
    const providers = [
        {
            name: "dynv6",
            arguments: ["--mode", "dynv6", "--domain", "reuse.dynv6.net", "--ipv6"],
            tokenOption: "--dynv6-token-file",
            tokenName: "dynv6-token",
            token: "saved-dynv6-token",
        },
        {
            name: "Cloudflare",
            arguments: [
                "--mode",
                "domain",
                "--domain",
                "reuse.example.com",
                "--dns-provider",
                "cloudflare",
                "--cloudflare-zone-id",
                "0123456789abcdef0123456789abcdef",
                "--no-ipv6",
            ],
            tokenOption: "--cloudflare-token-file",
            tokenName: "cloudflare-token",
            token: "saved-cloudflare-token",
        },
    ];

    for (const provider of providers) {
        await t.test(provider.name, async (t) => {
            const fixture = await createFixture(t);
            const source = join(fixture.checkout, "provider-source-token");
            await writeFile(source, `${provider.token}\n`, { mode: 0o600 });
            const first = await installWithoutStarting(fixture, [...provider.arguments, provider.tokenOption, source]);
            assert.equal(first.code, 0, first.stderr);
            const before = await protectedSnapshot(fixture);

            await fixture.clearDockerCalls();
            const second = await fixture.run(
                ["install", "--no-start", "--yes", "--skip-port-check"],
                {},
            );
            assert.equal(second.code, 0, second.stderr);
            assert.deepEqual(await protectedSnapshot(fixture), before);
            assert.equal(await readFile(join(fixture.checkout, ".risuai", provider.tokenName), "utf8"), provider.token);
            await assertNoTransactionDebris(fixture);
        });
    }
});

test("a live operation lock is refused without modifying it", async (t) => {
    const fixture = await createFixture(t);
    const lock = join(fixture.checkout, ".risuai/operation.lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });

    const result = await installWithoutStarting(fixture, ["--mode", "local"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`Another risuai\\.sh operation is running \\(PID ${process.pid}\\)`));
    assert.equal((await readFile(join(lock, "pid"), "utf8")).trim(), String(process.pid));
    assert.equal(await exists(join(fixture.checkout, ".risuai/rustfs.env")), false);
});

test("Compose config failure leaves the active protected generation unchanged", async (t) => {
    const fixture = await createFixture(t);
    const source = join(fixture.checkout, "old-dynv6-source");
    await writeFile(source, "old-dynv6-token\n", { mode: 0o600 });
    const initial = await installWithoutStarting(fixture, [
        "--mode",
        "dynv6",
        "--domain",
        "old.dynv6.net",
        "--dynv6-token-file",
        source,
    ]);
    assert.equal(initial.code, 0, initial.stderr);
    const before = await protectedSnapshot(fixture);

    const replacement = join(fixture.checkout, "new-cloudflare-source");
    await writeFile(replacement, "new-cloudflare-token\n", { mode: 0o600 });
    const result = await fixture.run(
        [
            "install",
            "--mode",
            "domain",
            "--domain",
            "new.example.com",
            "--dns-provider",
            "cloudflare",
            "--cloudflare-zone-id",
            "0123456789abcdef0123456789abcdef",
            "--cloudflare-token-file",
            replacement,
            "--no-start",
            "--yes",
            "--skip-port-check",
        ],
        { FAKE_COMPOSE_CONFIG_FAIL: "1" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Prospective Docker Compose configuration is invalid/);
    assert.deepEqual(await protectedSnapshot(fixture), before);
    await assertNoTransactionDebris(fixture);
});

test("Compose up failure rolls back env and provider token files", async (t) => {
    const fixture = await createFixture(t);
    const oldTokenSource = join(fixture.checkout, "old-dynv6-source");
    await writeFile(oldTokenSource, "old-dynv6-token\n", { mode: 0o600 });
    const initial = await installWithoutStarting(fixture, [
        "--mode",
        "dynv6",
        "--domain",
        "old.dynv6.net",
        "--dynv6-token-file",
        oldTokenSource,
    ]);
    assert.equal(initial.code, 0, initial.stderr);
    const before = await protectedSnapshot(fixture);

    const replacement = join(fixture.checkout, "new-cloudflare-source");
    await writeFile(replacement, "new-cloudflare-token\n", { mode: 0o600 });
    const result = await fixture.run(
        [
            "install",
            "--mode",
            "domain",
            "--domain",
            "new.example.com",
            "--dns-provider",
            "cloudflare",
            "--cloudflare-zone-id",
            "0123456789abcdef0123456789abcdef",
            "--cloudflare-token-file",
            replacement,
            "--skip-ddns-check",
            "--yes",
            "--skip-port-check",
            "--wait-timeout",
            "10",
        ],
        { FAKE_COMPOSE_UP_FAIL: "1" },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /restoring the previous protected configuration/);
    assert.deepEqual(await protectedSnapshot(fixture), before);
    await assertNoTransactionDebris(fixture);
});

test("readiness failure tears down the candidate and restores the previous generation", async (t) => {
    const fixture = await createFixture(t);
    const oldTokenSource = join(fixture.checkout, "old-cloudflare-source");
    await writeFile(oldTokenSource, "old-cloudflare-token\n", { mode: 0o600 });
    const initial = await installWithoutStarting(fixture, [
        "--mode",
        "domain",
        "--domain",
        "old.example.com",
        "--dns-provider",
        "cloudflare",
        "--cloudflare-zone-id",
        "0123456789abcdef0123456789abcdef",
        "--cloudflare-token-file",
        oldTokenSource,
    ]);
    assert.equal(initial.code, 0, initial.stderr);
    const before = await protectedSnapshot(fixture);
    await fixture.clearDockerCalls();

    const replacement = join(fixture.checkout, "new-dynv6-source");
    await writeFile(replacement, "new-dynv6-token\n", { mode: 0o600 });
    const result = await fixture.run(
        [
            "install",
            "--mode",
            "dynv6",
            "--domain",
            "new.dynv6.net",
            "--dynv6-token-file",
            replacement,
            "--skip-ddns-check",
            "--yes",
            "--skip-port-check",
            "--wait-timeout",
            "10",
        ],
        {
            FAKE_READINESS_FAIL: "1",
            FAKE_LOG_OUTPUT: "risuai | database authentication failed\n",
        },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /RisuAI is still starting after \d+s/);
    assert.match(result.stderr, /database authentication failed/);
    assert.match(result.stderr, /RisuAI did not become ready within 10s/);
    assert.match(result.stderr, /restoring the previous protected configuration/);
    assert.deepEqual(await protectedSnapshot(fixture), before);
    const calls = await fixture.dockerCalls();
    assert.equal(calls.some((call) => call.command === "up"), true);
    assert.equal(calls.some((call) => call.command === "down"), true);
    await assertNoTransactionDebris(fixture);
});
