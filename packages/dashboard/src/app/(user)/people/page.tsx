import { PeopleView } from "./people-view";

export const metadata = { title: "People - LL5" };

export default function PeoplePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">People</h1>
        <p className="text-sm text-gray-500 mt-1">People in your knowledge base</p>
      </div>
      <PeopleView />
    </div>
  );
}
