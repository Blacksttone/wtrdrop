import type * as React from "react";
import { cn } from "@/lib/utils";

export const Table = ({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
);
export const THead = (props: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className="bg-muted/60 text-left" {...props} />;
export const TBody = (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody className="divide-y" {...props} />;
export const TR = ({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn("transition-colors hover:bg-muted/40", className)} {...props} />
);
export const TH = ({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn("h-10 whitespace-nowrap px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground", className)} {...props} />
);
export const TD = ({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("whitespace-nowrap px-3 py-2.5 align-middle", className)} {...props} />
);
