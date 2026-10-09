# One-off verification scripts

These scripts are **not** part of the server runtime. They are manual
diagnostic tools used during development to verify storage behavior against
real (non-mock) databases. They expect credentials via the corresponding
vendor `.env` files or environment variables (see `storage/storageDriver.ts`)
and may require local backup payloads (e.g. `Binary1.bin` at the repository
root).

| Script                       | Purpose                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `real_azure_sync.ts`        | Restores a real RisuAI backup payload into a live Azure SQL database and verifies the synced state. |
| `real_oracle_sync.ts`       | Same as above against a live Oracle database.                                                       |
| `verifyOracleDatabase.ts`   | Connects to a configured Oracle database and prints storage state sanity checks.                    |
| `scratch_diag_sync.ts`      | Ad-hoc diagnostics for sync behavior against a real Oracle database (development scratchpad).       |
| `scratch_verify_real_db.ts` | Ad-hoc verification of real Oracle database contents (development scratchpad).                      |

Run them directly with `node`, for example:

```bash
node server/node/scripts/verifyOracleDatabase.ts
```
