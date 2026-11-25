import { useQuery } from "@tanstack/react-query";
import { rpc, supabase } from "./supabase";
import type {
  ConsumptionRecord, CustomerSummary, Delivery, Invoice, InvoiceItem, Order, Payment, SupplierSettings,
} from "@/types/db";

async function rows<T>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw error;
  return data ?? [];
}

export const qk = {
  summary: (id: string) => ["summary", id] as const,
  orders: (scope: string) => ["orders", scope] as const,
  deliveries: (scope: string) => ["deliveries", scope] as const,
  consumption: (id: string) => ["consumption", id] as const,
  invoices: (scope: string) => ["invoices", scope] as const,
  payments: (scope: string) => ["payments", scope] as const,
  settings: (supplierId: string) => ["supplier-settings", supplierId] as const,
};

export const useCustomerSummary = (customerId: string) =>
  useQuery({ queryKey: qk.summary(customerId), queryFn: () => rpc<CustomerSummary>("get_customer_summary", { p_customer_id: customerId }), refetchInterval: 120_000 });

export const useCustomerOrders = (customerId: string) =>
  useQuery({
    queryKey: qk.orders(customerId),
    queryFn: () => rows<Order>(supabase.from("orders").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(100)),
  });

export const useCustomerDeliveries = (customerId: string) =>
  useQuery({
    queryKey: qk.deliveries(customerId),
    queryFn: () => rows<Delivery>(supabase.from("deliveries").select("*").eq("customer_id", customerId).order("delivery_date", { ascending: false }).order("created_at", { ascending: false }).limit(200)),
  });

export const useConsumption = (customerId: string, days = 30) =>
  useQuery({
    queryKey: [...qk.consumption(customerId), days],
    queryFn: () => rows<ConsumptionRecord>(supabase.from("consumption_records").select("*").eq("customer_id", customerId).order("consumption_date", { ascending: false }).limit(days)),
  });

export const useInvoices = (scope: { customerId?: string; supplierId?: string }) =>
  useQuery({
    queryKey: qk.invoices(scope.customerId ?? scope.supplierId ?? "all"),
    queryFn: () => {
      let q = supabase.from("invoices").select("*, customers(customer_name)").order("generated_at", { ascending: false }).limit(500);
      if (scope.customerId) q = q.eq("customer_id", scope.customerId);
      if (scope.supplierId) q = q.eq("supplier_id", scope.supplierId);
      return rows<Invoice>(q);
    },
  });

export async function fetchInvoiceItems(invoiceId: string) {
  return rows<InvoiceItem>(supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId).order("item_date"));
}

export const usePayments = (scope: { customerId?: string; supplierId?: string }) =>
  useQuery({
    queryKey: qk.payments(scope.customerId ?? scope.supplierId ?? "all"),
    queryFn: () => {
      let q = supabase.from("payments").select("*, customers(customer_name)").order("created_at", { ascending: false }).limit(500);
      if (scope.customerId) q = q.eq("customer_id", scope.customerId);
      if (scope.supplierId) q = q.eq("supplier_id", scope.supplierId);
      return rows<Payment>(q);
    },
  });

export const useSupplierSettings = (supplierId: string) =>
  useQuery({
    queryKey: qk.settings(supplierId),
    queryFn: async () => {
      const { data, error } = await supabase.from("supplier_settings").select("*").eq("supplier_id", supplierId).single();
      if (error) throw error;
      return data as SupplierSettings;
    },
  });
