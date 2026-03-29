import { CalendarView } from "./calendar-view";

export const metadata = { title: "Calendar - LL5" };

export default function CalendarPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Calendar</h1>
      <CalendarView />
    </div>
  );
}
