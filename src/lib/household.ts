export const HOUSEHOLD_TYPES = [
  { value: "single", label: "Single (living alone)" },
  { value: "couple", label: "Married couple" },
  { value: "family", label: "Family" },
  { value: "shared_room", label: "Bachelors / shared room" },
  { value: "office", label: "Office" },
  { value: "shop", label: "Shop / hotel" },
  { value: "other", label: "Other" },
] as const;

export type HouseholdType = (typeof HOUSEHOLD_TYPES)[number]["value"];

export const householdLabel = (v: string | null | undefined) =>
  HOUSEHOLD_TYPES.find((h) => h.value === v)?.label ?? "Not set";

/**
 * Rough starting point for daily 20 L cans: about 4–5 L per person per day for
 * drinking and cooking, so one can serves ~4 people. Real usage replaces this
 * once the customer records a few days.
 */
export function suggestedDailyCans(members: number): number {
  if (!members || members < 1) return 0;
  return Math.max(1, Math.round(members / 4));
}
