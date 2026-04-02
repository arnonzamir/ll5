import { PhoneDataView } from "./phone-data-view";

export const metadata = { title: "Phone Data - LL5" };

export default function PhoneDataPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Phone Data</h1>
        <p className="text-sm text-gray-500 mt-1">Locations, messages, and calendar events pushed from your phone</p>
      </div>
      <PhoneDataView />
    </div>
  );
}
