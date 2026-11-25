/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function toCsv(columns: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export async function downloadCsv(filename: string, columns: string[], rows: (string | number | null | undefined)[][]) {
  const { saveOrShareFile } = await import("./native");
  // Leading BOM so Excel opens UTF-8 (Tamil names, ₹) correctly.
  const blob = new Blob(["\uFEFF" + toCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  await saveOrShareFile(blob, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}
