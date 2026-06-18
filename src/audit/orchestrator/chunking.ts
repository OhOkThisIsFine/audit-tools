export interface LineRange {
  start: number;
  end: number;
}

export function chunkLineCount(
  totalLines: number,
  chunkSize = 200,
): LineRange[] {
  if (totalLines <= 0) {
    return [];
  }

  const ranges: LineRange[] = [];
  let start = 1;

  while (start <= totalLines) {
    const end = Math.min(start + chunkSize - 1, totalLines);
    ranges.push({ start, end });
    start = end + 1;
  }

  return ranges;
}
