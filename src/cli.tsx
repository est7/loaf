#!/usr/bin/env node

import { join } from "node:path";
import { Command, CommanderError } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { CliUsageError } from "./core/errors.js";
import { createHelloRecord } from "./core/hello.js";
import { appendHelloRecord, readHelloRecords } from "./core/jsonl-store.js";
import { EXIT_CODE, writeError, writeJson } from "./ui/output.js";
import { renderHelloScreen, renderHistoryScreen } from "./ui/screens.js";

interface HelloCommandOptions {
  uppercase?: boolean;
  dataFile: string;
}

interface HistoryCommandOptions {
  limit: number;
  dataFile: string;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  const shouldUseJson = argv.includes("--json");
  let bufferedStdout = "";
  let bufferedStderr = "";

  program
    .name("loaf")
    .description("A minimal CLI scaffold built with Ink, Commander, Zod, and JSONL.")
    .version(packageJson.version)
    .option("--json", "Print machine-readable JSON to stdout/stderr.")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        bufferedStdout += text;
      },
      writeErr: (text) => {
        bufferedStderr += text;
      },
    });

  program
    .command("hello")
    .description("Print a greeting and append it to the JSONL history.")
    .argument("[name]", "Name to greet.")
    .option("-u, --uppercase", "Uppercase the greeting.")
    .option(
      "-d, --data-file <path>",
      "Path to the JSONL history file.",
      getDefaultDataFile(),
    )
    .action(async (name: string | undefined, options: HelloCommandOptions) => {
      const record = createHelloRecord({
        name,
        uppercase: options.uppercase,
      });

      await appendHelloRecord(options.dataFile, record);

      if (shouldUseJson) {
        writeJson({
          dataFile: options.dataFile,
          record,
        });
        return;
      }

      await renderHelloScreen({
        dataFile: options.dataFile,
        record,
      });
    });

  program
    .command("history")
    .description("Read recent greeting history from JSONL.")
    .option(
      "-d, --data-file <path>",
      "Path to the JSONL history file.",
      getDefaultDataFile(),
    )
    .option("-l, --limit <count>", "Maximum number of records to display.", parseLimit, 10)
    .action(async (options: HistoryCommandOptions) => {
      const records = await readHelloRecords(options.dataFile);
      const visibleRecords = records.slice(-options.limit).reverse();

      if (shouldUseJson) {
        writeJson({
          dataFile: options.dataFile,
          records: visibleRecords,
        });
        return;
      }

      await renderHistoryScreen({
        dataFile: options.dataFile,
        records: visibleRecords,
      });
    });

  try {
    await program.parseAsync(argv);
    return EXIT_CODE.success;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        process.stdout.write(bufferedStdout);
        return EXIT_CODE.success;
      }

      if (shouldUseJson) {
        return writeError(new CliUsageError(error.message), true);
      }

      process.stderr.write(
        bufferedStderr.length > 0 ? bufferedStderr : `error: ${error.message}\n`,
      );
      return EXIT_CODE.usage;
    }

    return writeError(error, shouldUseJson);
  }
}

function getDefaultDataFile(): string {
  return join(process.cwd(), ".loaf-cli", "history.jsonl");
}

function parseLimit(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new CliUsageError("Limit must be an integer between 1 and 100.");
  }

  return parsed;
}

if (import.meta.main) {
  const exitCode = await main(process.argv);
  process.exit(exitCode);
}
