import { InboxView } from "./inbox-view";

export const metadata = { title: "Inbox - LL5" };

export default function InboxPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inbox</h1>
      <InboxView />
    </div>
  );
}
