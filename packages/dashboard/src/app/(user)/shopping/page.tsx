import { ShoppingView } from "./shopping-view";

export const metadata = { title: "Shopping - LL5" };

export default function ShoppingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Shopping List</h1>
      <ShoppingView />
    </div>
  );
}
