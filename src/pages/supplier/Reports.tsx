import { useQuery } from "@tanstack/react-query";
import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";
import { BarChart3, FileDown, FileSpreadsheet } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { downloadCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import { formatDate, titleCase, todayISO } from "@/lib/format";
import { buildReportPdf } from "@/lib/pdf/invoice";
import { rpc } from "@/lib/supabase";

type Row = Record<string, string | number | boolean | null>;

export interface ReportDef {
  key: string;
  label: string;
  fn: string;
  ranged: boolean;
  description: string;
  /** client-side post-filter (e.g. daily report = deliveries on one day) */
  single?: boolean;
}

export const REPORTS: ReportDef[] = [
  { key: "daily", label: "Daily delivery report", fn: "report_deliveries", ranged: true, single: true, description: "Every delivery on a given day." },
  { key: "deliveries", label: "Monthly delivery report", fn: "report_deliveries", ranged: true, description: "All deliveries with expected, delivered and confirmed quantities." },
  { key: "consumption", label: "Customer-wise consumption", fn: "report_customer_consumption", ranged: true, description: "Usage, stockouts and cans received per customer." },
  { key: "stock", label: "Customer stock report", fn: "list_supplier_customers", ranged: false, description: "Current stock, level and predicted empty date." },
  { key: "accuracy", label: "Delivery accuracy", fn: "report_delivery_accuracy", ranged: true, description: "Shortages and excess versus expected, by customer." },
  { key: "billing", label: "Monthly billing report", fn: "report_billing", ranged: true, description: "Invoices issued in the period." },
  { key: "outstanding", label: "Outstanding payments", fn: "report_outstanding", ranged: false, description: "Customers with a non-zero balance." },
  { key: "revenue", label: "Revenue report", fn: "report_revenue", ranged: true, description: "Cans delivered, billed and collected per month." },
];

const fmt = (v: unknown) => {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(v);
  return String(v);
};

export default function Reports({ supplierId }: { supplierId?: string }) {
  const [params, setParams] = useSearchParams();
  const key = params.get("r") ?? "deliveries";
  const def = REPORTS.find((r) => r.key === key) ?? REPORTS[1];
  const lastMonth = subMonths(new Date(), 1);
  const [start, setStart] = React.useState(def.single ? todayISO() : format(startOfMonth(lastMonth), "yyyy-MM-dd"));
  const [end, setEnd] = React.useState(def.single ? todayISO() : format(endOfMonth(lastMonth), "yyyy-MM-dd"));
  React.useEffect(() => {
    if (def.single) { setStart(todayISO()); setEnd(todayISO()); }
  }, [def.single]);

  const q = useQuery({
    queryKey: ["report", def.key, start, end, supplierId],
    queryFn: () => {
      const args: Record<string, unknown> = def.fn === "list_supplier_customers" ? {} : { p_supplier_id: supplierId ?? null };
      if (def.ranged) Object.assign(args, { p_start: start, p_end: def.single ? start : end });
      return rpc<Row[]>(def.fn, args);
    },
  });
  const rows = q.data ?? [];
  const columns = rows.length ? Object.keys(rows[0]).filter((c) => c !== "id") : [];
  const subtitle = def.ranged ? (def.single ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`) : `As of ${formatDate(todayISO())}`;

  return (
    <div>
      <PageHeader title="Reports" description="Export any report as CSV or PDF."
        actions={<>
          <Button variant="outline" disabled={!rows.length} onClick={() => downloadCsv(`${def.key}-${start}`, columns.map(titleCase), rows.map((r) => columns.map((c) => r[c] as string)))}><FileSpreadsheet /> CSV</Button>
          <Button variant="outline" disabled={!rows.length} onClick={() => buildReportPdf(def.label, subtitle, columns.map(titleCase), rows.map((r) => columns.map((c) => fmt(r[c])))).catch((e) => toast.error(errorMessage(e)))}><FileDown /> PDF</Button>
        </>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label="Report" htmlFor="rp">
          <Select id="rp" value={def.key} onChange={(e) => setParams({ r: e.target.value })}>
            {REPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
        </Field>
        {def.ranged && <Field label={def.single ? "Date" : "From"} htmlFor="st"><Input id="st" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>}
        {def.ranged && !def.single && <Field label="To" htmlFor="en"><Input id="en" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{def.description}</p>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : !rows.length ? (
        <EmptyState icon={BarChart3} title="No data for this period" />
      ) : (
        <Card>
          <Table>
            <THead><TR>{columns.map((c) => <TH key={c}>{titleCase(c)}</TH>)}</TR></THead>
            <TBody>{rows.map((r, i) => <TR key={i}>{columns.map((c) => <TD key={c}>{fmt(r[c])}</TD>)}</TR>)}</TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
