/** Order workflow (mirror of public.order_transition_allowed). */
export type OrderStatus =
  | "pending"
  | "accepted"
  | "preparing"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "rejected";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["accepted", "rejected", "cancelled"],
  accepted: ["preparing", "out_for_delivery", "cancelled"],
  preparing: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["cancelled"],
  delivered: [],
  cancelled: [],
  rejected: [],
};

export const OPEN_STATUSES: OrderStatus[] = ["pending", "accepted", "preparing", "out_for_delivery"];

export function nextSupplierStatuses(from: OrderStatus): OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Delivered is reached only by recording a delivery (customer then confirms quantity). */
export function canRecordDelivery(status: OrderStatus): boolean {
  return status === "accepted" || status === "preparing" || status === "out_for_delivery";
}

export function canCustomerCancel(status: OrderStatus): boolean {
  return status === "pending";
}

export function isBulkOrder(quantity: number, threshold: number, flagged = false): boolean {
  return flagged || quantity >= threshold;
}

export const ORDER_STEPS: OrderStatus[] = ["pending", "accepted", "preparing", "out_for_delivery", "delivered"];
