import { PhoneDataView } from "./phone-data-view";

export const metadata = { title: "Phone Data - LL5" };

export default function PhoneDataPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Phone Data</h1>
      <PhoneDataView />
    </div>
  );
}
