import { JournalView } from "./journal-view";

export const metadata = { title: "Journal - LL5 Admin" };

export default function JournalPage() {
  return (
    <div className="space-y-6">
      <JournalView />
    </div>
  );
}
