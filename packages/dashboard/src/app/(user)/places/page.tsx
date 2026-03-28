import { PlacesView } from "./places-view";

export const metadata = { title: "Places - LL5" };

export default function PlacesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Places</h1>
      <PlacesView />
    </div>
  );
}
