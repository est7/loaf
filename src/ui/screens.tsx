import { Box, Text, render, useApp } from "ink";
import { useEffect } from "react";
import type { HelloRecord } from "../core/hello.js";

interface HelloScreenProps {
  record: HelloRecord;
  dataFile: string;
}

interface HistoryScreenProps {
  records: HelloRecord[];
  dataFile: string;
}

function ExitOnMount(): null {
  const { exit } = useApp();

  useEffect(() => {
    exit();
  }, [exit]);

  return null;
}

function HelloScreen({ record, dataFile }: HelloScreenProps) {
  return (
    <Box flexDirection="column">
      <ExitOnMount />
      <Text color="green">{record.message}</Text>
      <Text dimColor>Appended to {dataFile}</Text>
    </Box>
  );
}

function HistoryScreen({ records, dataFile }: HistoryScreenProps) {
  return (
    <Box flexDirection="column">
      <ExitOnMount />
      <Text color="cyan">History from {dataFile}</Text>
      {records.length === 0 ? (
        <Text dimColor>No records yet.</Text>
      ) : (
        records.map((record) => (
          <Text key={`${record.createdAt}:${record.name}`}>
            {record.createdAt}  {record.message}
          </Text>
        ))
      )}
    </Box>
  );
}

export async function renderHelloScreen(props: HelloScreenProps): Promise<void> {
  const app = render(<HelloScreen {...props} />);
  await app.waitUntilExit();
}

export async function renderHistoryScreen(props: HistoryScreenProps): Promise<void> {
  const app = render(<HistoryScreen {...props} />);
  await app.waitUntilExit();
}
