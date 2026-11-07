export type BullmqPollCursor = {
  atMs: number;
  jobId: string;
};

export type BullmqPolledRow = {
  jobId: string;
  atMs: number;
};

export function parseNumericBullmqJobId(jobId: string): number | null {
  const trimmed = String(jobId || "").trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const numeric = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

export function shouldIncludeBullmqPolledRow(input: {
  row: BullmqPolledRow;
  cursor: BullmqPollCursor;
  minJobIdExclusive: number;
}): boolean {
  const { row, cursor, minJobIdExclusive } = input;
  const sameScore = row.atMs === cursor.atMs;
  if (sameScore && cursor.jobId && row.jobId <= cursor.jobId) {
    return false;
  }

  const numericJobId = parseNumericBullmqJobId(row.jobId);
  if (
    numericJobId !== null &&
    minJobIdExclusive > 0 &&
    numericJobId <= minJobIdExclusive
  ) {
    return false;
  }

  return true;
}

export function nextBullmqLastProcessedJobId(input: {
  previous: number;
  jobId: string;
}): number {
  const numericJobId = parseNumericBullmqJobId(input.jobId);
  if (numericJobId === null) {
    return input.previous;
  }
  return Math.max(input.previous, numericJobId);
}
