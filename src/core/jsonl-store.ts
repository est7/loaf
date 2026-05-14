import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CliUsageError } from "./errors.js";
import { helloRecordSchema, type HelloRecord } from "./hello.js";

const dataFileSchema = z.string().trim().min(1, "Data file path must not be empty.");

export async function appendHelloRecord(
  dataFile: string,
  record: HelloRecord,
): Promise<void> {
  const filePath = parseDataFile(dataFile);
  const parsedRecord = parseRecord(record);

  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(parsedRecord)}\n`, "utf8");
}

export async function readHelloRecords(dataFile: string): Promise<HelloRecord[]> {
  const filePath = parseDataFile(dataFile);

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const lines = content.split("\n").filter((line) => line.length > 0);
  return lines.map((line, index) => parseLine(line, index + 1, filePath));
}

function parseDataFile(dataFile: string): string {
  const parsed = dataFileSchema.safeParse(dataFile);

  if (!parsed.success) {
    throw new CliUsageError(parsed.error.issues[0]?.message ?? "Invalid data file path.");
  }

  return parsed.data;
}

function parseRecord(record: HelloRecord): HelloRecord {
  const parsed = helloRecordSchema.safeParse(record);

  if (!parsed.success) {
    throw new CliUsageError(parsed.error.issues[0]?.message ?? "Invalid record.");
  }

  return parsed.data;
}

function parseLine(line: string, lineNumber: number, filePath: string): HelloRecord {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliUsageError(
        `Invalid JSONL at ${filePath}:${lineNumber}: ${error.message}`,
      );
    }

    throw error;
  }

  const parsed = helloRecordSchema.safeParse(value);

  if (!parsed.success) {
    throw new CliUsageError(
      `Invalid record at ${filePath}:${lineNumber}: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
    );
  }

  return parsed.data;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
