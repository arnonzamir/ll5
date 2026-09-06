import { requireStepUp } from "@/lib/step-up";
import { FinanceView } from "./finance-view";

export const metadata = { title: "Finance - LL5" };

/**
 * /finance is in the sensitive catalog (lib/sensitive.ts). The middleware
 * already bounces sessions without a step-up to /verify; the page and every
 * server action check again so nothing renders or answers without it.
 */
export default async function FinancePage() {
  await requireStepUp("/finance");
  return <FinanceView />;
}
