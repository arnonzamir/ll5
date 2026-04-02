import { ShoppingView } from "./shopping-view";

export const metadata = { title: "Shopping - LL5" };

export default function ShoppingPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Shopping List</h1>
        <p className="text-sm text-gray-500 mt-1">Items to buy, grouped by category</p>
      </div>
      <ShoppingView />
    </div>
  );
}
