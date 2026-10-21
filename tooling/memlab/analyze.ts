import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { summarizeSnapshot, writeReport } from "./heapAnalysis.ts";

const usage =
  "pnpm memory:analyze <file.heapsnapshot> [--output file.json] [--top 20]";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", default: "memlab-results/heap-summary.json" },
      top: { type: "string", default: "20" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const top = Number(values.top);
  if (
    positionals.length !== 1 ||
    !Number.isSafeInteger(top) ||
    top < 1 ||
    top > 100
  ) {
    throw new Error(`${usage}\n--top must be an integer from 1 to 100.`);
  }
  const file = resolve(positionals[0]);
  const output = resolve(values.output);
  if (file === output)
    throw new Error("The output must not overwrite the input snapshot.");
  const report = await summarizeSnapshot(file, top);
  await writeReport(output, report);
  console.log(
    `Nodes: ${report.nodeCount}; snapshot shallow bytes: ${report.shallowBytes}`,
  );
  console.table(report.largestRetainers);
  console.log(`Report: ${output}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
