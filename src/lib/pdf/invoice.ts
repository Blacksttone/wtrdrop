/**
 * Professional PDF invoice generated from the finalized invoice record
 * (supplier/customer snapshots are frozen at generation time, so the PDF
 * is a faithful rendering of an immutable invoice).
 */
import { isNativeApp, saveOrShareFile } from "@/lib/native";
import { groupItemsByBranch } from "@/lib/invoiceBranches";
import type { Invoice, InvoiceItem } from "@/types/db";

const rupee = (n: number) => `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export async function buildInvoicePdf(invoice: Invoice, items: InvoiceItem[]): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const S = invoice.supplier_snapshot;
  const C = invoice.customer_snapshot;
  const blue: [number, number, number] = [11, 107, 203];

  // Header band
  doc.setFillColor(...blue);
  doc.rect(0, 0, W, 92, "F");
  doc.setFillColor(255, 255, 255);
  doc.circle(52, 46, 20, "F");
  doc.setFillColor(...blue);
  doc.triangle(52, 30, 42, 50, 62, 50, "F");
  doc.circle(52, 52, 10, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold").setFontSize(18).text(S.business_name, 84, 40);
  doc.setFont("helvetica", "normal").setFontSize(9);
  doc.text(doc.splitTextToSize(S.address, 300), 84, 56);
  doc.text(`Phone: ${S.phone}${S.email ? `   Email: ${S.email}` : ""}`, 84, 80);
  doc.setFont("helvetica", "bold").setFontSize(20).text("INVOICE", W - 40, 42, { align: "right" });
  doc.setFont("helvetica", "normal").setFontSize(9).text(invoice.invoice_number, W - 40, 58, { align: "right" });
  if (S.billing_info?.gstin) doc.text(`GSTIN: ${S.billing_info.gstin}`, W - 40, 72, { align: "right" });

  // Parties & meta
  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold").setFontSize(10).text("BILL TO", 40, 122);
  doc.setFont("helvetica", "normal").setFontSize(10).text(C.customer_name, 40, 138);
  doc.setFontSize(9).text(doc.splitTextToSize(C.address, 240), 40, 152);
  if (C.phone) doc.text(`Phone: ${C.phone}`, 40, 178);
  if (C.branches && C.branches.length > 1) doc.text(doc.splitTextToSize(`Branches: ${C.branches.join(", ")}`, 300), 40, 190);

  const meta: [string, string][] = [
    ["Invoice date", d(invoice.invoice_date)],
    ["Billing period", `${d(invoice.billing_period_start)} - ${d(invoice.billing_period_end)}`],
    ["Due date", d(invoice.due_date)],
    ["Status", invoice.status.replace("_", " ").toUpperCase()],
  ];
  meta.forEach(([k, v], i) => {
    doc.setFont("helvetica", "bold").text(k, W - 230, 122 + i * 16);
    doc.setFont("helvetica", "normal").text(v, W - 40, 122 + i * 16, { align: "right" });
  });

  autoTable(doc, {
    startY: C.branches && C.branches.length > 1 ? 212 : 200,
    head: [["Date", "Description", "Cans", "Price / can", "Amount"]],
    body: items.length
      ? groupItemsByBranch(invoice, items).flatMap((sec) => [
          ...(sec.branch ? [[{ content: `${sec.branch}  ·  ${sec.quantity} cans  ·  ${rupee(sec.amount)}`, colSpan: 5, styles: { fontStyle: "bold" as const, fillColor: [241, 245, 249] as [number, number, number] } }]] : []),
          ...sec.items.map((it) => [d(it.item_date), it.shortDescription, String(it.quantity), rupee(it.unit_price), rupee(it.amount)]),
        ])
      : [["-", "No confirmed deliveries in this period", "0", "-", rupee(0)]],
    foot: [["", "Total delivered cans", String(invoice.total_quantity), "", rupee(invoice.subtotal)]],
    theme: "striped",
    headStyles: { fillColor: blue, fontSize: 9 },
    footStyles: { fillColor: [226, 240, 253], textColor: [30, 41, 59], fontStyle: "bold" },
    styles: { fontSize: 9, cellPadding: 5 },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } },
    margin: { left: 40, right: 40 },
  });

  // Summary
  const y0 = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;
  const lines: [string, string, boolean?][] = [
    ["Current month deliveries", rupee(invoice.subtotal)],
    ...(Number(invoice.tax_amount) > 0 ? [[`${S.tax_label ?? "Tax"} (${invoice.tax_rate}%)`, rupee(invoice.tax_amount)] as [string, string]] : []),
    ...(Number(invoice.platform_fee) > 0 ? [["Waterdrop service fee", rupee(invoice.platform_fee)] as [string, string]] : []),
    ["Previous balance", rupee(invoice.previous_balance)],
    ["Payments received", `- ${rupee(invoice.payments_received)}`],
    ...(Number(invoice.credits) > 0 ? [["Credits / adjustments", `- ${rupee(invoice.credits)}`] as [string, string]] : []),
    ["Amount due", rupee(invoice.amount_due), true],
    ["Paid since invoice", rupee(invoice.amount_paid)],
    ["Outstanding", rupee(Math.max(Number(invoice.amount_due) - Number(invoice.amount_paid), 0)), true],
  ];
  lines.forEach(([k, v, bold], i) => {
    const y = y0 + i * 17;
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(bold ? 11 : 10);
    doc.text(k, W - 260, y);
    doc.text(v, W - 40, y, { align: "right" });
  });

  // Payment instructions
  const bi = S.billing_info ?? {};
  const pay = [
    bi.upi_id && `UPI: ${bi.upi_id}`,
    bi.bank_name && `Bank: ${bi.bank_name}`,
    bi.account_number && `A/c: ${bi.account_number}`,
    bi.ifsc && `IFSC: ${bi.ifsc}`,
  ].filter(Boolean) as string[];
  if (pay.length) {
    doc.setFont("helvetica", "bold").setFontSize(10).text("How to pay", 40, y0);
    doc.setFont("helvetica", "normal").setFontSize(9);
    pay.forEach((p, i) => doc.text(p, 40, y0 + 16 + i * 14));
  }

  const H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(226, 232, 240).line(40, H - 50, W - 40, H - 50);
  doc.setFontSize(8).setTextColor(100, 116, 139);
  doc.text("Billed on customer-confirmed deliveries only. Generated by Waterdrop — Never Run Out of Water.", 40, H - 34);
  doc.text(`Generated ${new Date(invoice.generated_at).toLocaleString("en-IN")}`, W - 40, H - 34, { align: "right" });
  return doc.output("blob");
}

export async function downloadInvoice(invoice: Invoice, items: InvoiceItem[]) {
  const blob = await buildInvoicePdf(invoice, items);
  await saveOrShareFile(blob, `${invoice.invoice_number}.pdf`, `Water bill ${invoice.invoice_number}`);
}

export async function shareInvoice(invoice: Invoice, items: InvoiceItem[]) {
  const blob = await buildInvoicePdf(invoice, items);
  if (isNativeApp) {
    await saveOrShareFile(blob, `${invoice.invoice_number}.pdf`, `Water bill ${invoice.invoice_number}`);
    return true;
  }
  const file = new File([blob], `${invoice.invoice_number}.pdf`, { type: "application/pdf" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: `Water bill ${invoice.invoice_number}`, text: `Water bill ${invoice.invoice_number}` });
    return true;
  }
  await downloadInvoice(invoice, items);
  return false;
}

/** Generic tabular report PDF. */
export async function buildReportPdf(title: string, subtitle: string, columns: string[], body: (string | number)[][]) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: columns.length > 6 ? "landscape" : "portrait" });
  doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(11, 107, 203).text(`Waterdrop · ${title}`, 40, 46);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(100, 116, 139).text(subtitle, 40, 62);
  autoTable(doc, {
    startY: 78, head: [columns], body: body.map((r) => r.map(String)),
    headStyles: { fillColor: [11, 107, 203], fontSize: 8 }, styles: { fontSize: 8, cellPadding: 4 }, margin: { left: 40, right: 40 },
  });
  await saveOrShareFile(doc.output("blob"), `${title.toLowerCase().replace(/\s+/g, "-")}.pdf`, title);
}
