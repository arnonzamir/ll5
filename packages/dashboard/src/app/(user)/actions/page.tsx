import { ActionsView } from "./actions-view";

export const metadata = { title: "Actions - LL5" };

export default function ActionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Actions</h1>
        <p className="text-sm text-gray-500 mt-1">Next actions and tasks to get things done</p>
      </div>
      <ActionsView />
    </div>
  );
}
