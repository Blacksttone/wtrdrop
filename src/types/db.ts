// Row types for the Waterdrop schema (see supabase/migrations).
import type { OrderStatus } from "@/lib/domain/orders";
import type { InvoiceStatus } from "@/lib/domain/billing";
import type { StockLevel, TransactionType } from "@/lib/domain/stock";

export type AppRole = "admin" | "supplier" | "customer";
export type DeliveryStatus = "awaiting_confirmation" | "confirmed" | "cancelled";
export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "online";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export type { InvoiceStatus, OrderStatus, StockLevel, TransactionType };

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  role: AppRole;
  notification_preferences: { email?: boolean; whatsapp?: boolean; noncritical?: boolean };
  is_disabled: boolean;
  created_at: string;
}

export interface BillingInfo {
  gstin?: string;
  upi_id?: string;
  bank_name?: string;
  account_number?: string;
  ifsc?: string;
  payment_note?: string;
}

export interface Supplier {
  id: string;
  owner_id: string;
  business_name: string;
  business_code: string;
  owner_name: string;
  phone: string;
  email: string | null;
  address: string;
  delivery_area: string | null;
  logo_url: string | null;
  billing_info: BillingInfo;
  status: "active" | "suspended";
  listed: boolean;
  plan_id: string | null;
  created_at: string;
}

export interface SupplierSettings {
  id: string;
  supplier_id: string;
  default_can_price: number;
  delivery_lead_days: number;
  billing_day: number;
  billing_due_days: number;
  tax_rate: number;
  tax_label: string;
  invoice_prefix: string;
  bulk_order_threshold: number;
  default_low_stock_threshold: number;
  default_critical_threshold: number;
  default_safety_stock: number;
  notification_settings: Record<string, boolean>;
}

export interface SupplierInvite {
  id: string;
  supplier_id: string;
  token: string;
  label: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  user_id: string | null;
  supplier_id: string;
  customer_name: string;
  phone: string | null;
  address: string;
  delivery_instructions: string | null;
  can_price: number | null;
  daily_consumption: number;
  auto_consumption_enabled: boolean;
  auto_consumption_time: string;
  timezone: string;
  low_stock_threshold: number;
  critical_threshold: number;
  safety_stock: number;
  opening_balance: number;
  status: "active" | "inactive";
  household_type: string | null;
  members_count: number | null;
  blocked_at: string | null;
  block_reason: string | null;
  account_id: string | null;
  branch_name: string | null;
  bill_to_customer_id: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  location_updated_at: string | null;
  created_at: string;
}

export interface CustomerListRow {
  id: string;
  customer_name: string;
  phone: string | null;
  address: string;
  status: "active" | "inactive";
  has_app: boolean;
  current_stock: number;
  stock_confirmed: boolean;
  level: StockLevel;
  predicted_empty_date: string | null;
  daily_consumption: number;
  can_price: number;
  balance: number;
  created_at: string;
  household_type: string | null;
  members_count: number | null;
  blocked: boolean;
  account_name: string | null;
  account_type: AccountType | null;
  branch_name: string | null;
  bill_to_customer_id: string | null;
  cans_out: number;
}

export interface CustomerStock {
  customer_id: string;
  current_stock: number;
  has_opening_stock: boolean;
  alert_level: "none" | "low" | "critical";
  avg_daily_consumption: number | null;
  predicted_empty_date: string | null;
}

export interface Order {
  id: string;
  supplier_id: string;
  customer_id: string;
  quantity: number;
  is_bulk: boolean;
  requested_delivery_date: string | null;
  scheduled_date: string | null;
  status: OrderStatus;
  delivery_instructions: string | null;
  status_reason: string | null;
  created_at: string;
  customers?: Pick<Customer, "customer_name" | "address" | "phone">;
}

export interface Delivery {
  id: string;
  supplier_id: string;
  customer_id: string;
  order_id: string | null;
  expected_quantity: number;
  actual_quantity: number;
  confirmed_quantity: number | null;
  adjusted_quantity: number;
  unit_price: number;
  delivery_date: string;
  status: DeliveryStatus;
  notes: string | null;
  customer_note: string | null;
  confirmed_at: string | null;
  confirmed_by_supplier: boolean;
  discrepancy: number | null;
  claim_gap: number | null;
  empty_cans_collected: number;
  created_at: string;
  customers?: Pick<Customer, "customer_name">;
}

export interface InventoryTransaction {
  id: string;
  customer_id: string;
  transaction_type: TransactionType;
  quantity: number;
  balance_after: number | null;
  reference_type: string | null;
  transaction_date: string;
  notes: string | null;
  created_at: string;
}

export interface ConsumptionRecord {
  id: string;
  customer_id: string;
  consumption_date: string;
  quantity: number;
  unmet_quantity: number;
  source: "manual" | "auto" | "correction";
  updated_at: string;
}

export interface CorrectionRequest {
  id: string;
  customer_id: string;
  consumption_date: string;
  current_quantity: number;
  requested_quantity: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  customers?: Pick<Customer, "customer_name">;
}

export interface Invoice {
  id: string;
  supplier_id: string;
  customer_id: string;
  invoice_number: string;
  invoice_date: string;
  billing_period_start: string;
  billing_period_end: string;
  total_quantity: number;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  current_charges: number;
  previous_balance: number;
  payments_received: number;
  credits: number;
  amount_due: number;
  amount_paid: number;
  due_date: string;
  status: InvoiceStatus;
  supplier_snapshot: {
    business_name: string;
    owner_name?: string;
    address: string;
    phone: string;
    email?: string | null;
    logo_url?: string | null;
    billing_info?: BillingInfo;
    business_code?: string;
    tax_label?: string;
  };
  customer_snapshot: { customer_name: string; address: string; phone?: string | null; branch_name?: string | null; branches?: string[] | null };
  superseded_by: string | null;
  generated_at: string;
  customers?: Pick<Customer, "customer_name">;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  delivery_id: string | null;
  delivery_adjustment_id: string | null;
  item_date: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

export interface Payment {
  id: string;
  supplier_id: string;
  customer_id: string;
  invoice_id: string | null;
  amount: number;
  payment_method: PaymentMethod;
  reference_number: string | null;
  payment_date: string;
  status: PaymentStatus;
  submitted_by_customer: boolean;
  notes: string | null;
  created_at: string;
  customers?: Pick<Customer, "customer_name">;
}

export interface CreditNote {
  id: string;
  customer_id: string;
  credit_number: string;
  amount: number;
  reason: string;
  created_at: string;
}

export interface AppNotification {
  id: string;
  notification_type: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  message: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface PredictionJson {
  current_stock: number;
  stock_confirmed: boolean;
  level: StockLevel;
  avg_daily_consumption: number | null;
  basis: "history" | "configured" | null;
  days_with_data: number;
  days_remaining: number | null;
  predicted_empty_date: string | null;
  delivery_lead_days: number;
  safety_stock: number;
  recommended_order_quantity: number;
  order_now: boolean;
  today: string;
}

export interface CustomerSummary {
  customer_id: string;
  customer_name: string;
  supplier_id: string;
  thresholds: { low: number; critical: number };
  prediction: PredictionJson;
  latest_order: Pick<Order, "id" | "quantity" | "status" | "requested_delivery_date" | "scheduled_date" | "is_bulk" | "created_at"> | null;
  next_delivery_date: string | null;
  pending_confirmations: number;
  latest_invoice: Pick<Invoice, "id" | "invoice_number" | "amount_due" | "amount_paid" | "due_date" | "status" | "billing_period_start" | "billing_period_end"> | null;
  outstanding_balance: number;
  unbilled: { quantity: number; amount: number };
  can_see_money: boolean;
}

export interface SupplierDashboard {
  today: string;
  total_customers: number;
  todays_orders: number;
  pending_orders: number;
  pending_deliveries: number;
  awaiting_confirmation: number;
  delivered_today: number;
  delivered_this_month: number;
  revenue_this_month: number;
  collected_this_month: number;
  outstanding_total: number;
  pending_payment_verifications: number;
  needs_delivery_today: { order_id: string; customer_id: string; customer_name: string; address: string; quantity: number; status: OrderStatus; date: string | null }[];
  low_stock_customers: { customer_id: string; customer_name: string; stock: number; level: string; predicted_empty_date: string | null; has_open_order: boolean }[];
  discrepancy_customers: { customer_id: string; customer_name: string; deliveries: number; total_shortage: number }[];
  outstanding_customers: { customer_id: string; customer_name: string; balance: number }[];
}

export type SupplierRole = "owner" | "manager" | "delivery";

export interface StaffMember {
  id: string;
  user_id: string;
  staff_name: string;
  phone: string | null;
  email: string | null;
  role: "manager" | "delivery";
  status: "active" | "blocked";
  blocked_at: string | null;
  created_at: string;
}

export interface StaffInvite {
  id: string;
  code: string;
  role: "manager" | "delivery";
  label: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type AccountType = "home" | "store" | "company";
export type AccountRole = "owner" | "admin" | "member";

export interface CustomerAccount {
  id: string;
  name: string;
  account_type: AccountType;
  owner_id: string;
  created_at: string;
}

export interface AccountMembership {
  id: string;
  account_id: string;
  user_id: string;
  role: AccountRole;
  status: "active" | "blocked";
  all_branches: boolean;
}

export interface AccountMember extends Omit<AccountMembership, "account_id"> {
  full_name: string;
  email: string | null;
  phone: string | null;
  branch_ids: string[];
  created_at: string;
}

export interface MemberInvite {
  id: string;
  account_id: string;
  code: string;
  role: AccountRole;
  all_branches: boolean;
  branch_ids: string[];
  label: string | null;
  expires_at: string;
}

export interface ConnectionRequest {
  id: string;
  account_id: string;
  supplier_id: string;
  branch_name: string | null;
  contact_name: string;
  phone: string | null;
  address: string;
  delivery_instructions: string | null;
  household_type: string | null;
  members_count: number | null;
  opening_stock: number | null;
  daily_consumption: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  created_at: string;
  suppliers?: { business_name: string } | null;
  customer_accounts?: { name: string; account_type: AccountType } | null;
}
