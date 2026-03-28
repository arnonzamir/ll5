import { ActionsView } from "./actions-view";

export const metadata = { title: "Actions - LL5" };

export default function ActionsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Actions</h1>
      <ActionsView />
    </div>
  );
}
