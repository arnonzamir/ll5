import { InboxView } from "./inbox-view";

export const metadata = { title: "Inbox - LL5" };

export default function InboxPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inbox</h1>
        <p className="text-sm text-gray-500 mt-1">Captured items waiting to be processed</p>
      </div>
      <InboxView />
    </div>
  );
}
