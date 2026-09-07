import { DeliveryView } from "./delivery-view";

export const metadata = { title: "What works for you - LL5" };

// DECISION-034 Phase 4: the learned delivery policy + 14-day outcomes.
// Not in SENSITIVE_PATHS — nothing financial or medical here.
export default function DeliverySettingsPage() {
  return <DeliveryView />;
}
