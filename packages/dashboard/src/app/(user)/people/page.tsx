import { PeopleView } from "./people-view";

export const metadata = { title: "People - LL5" };

export default function PeoplePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">People</h1>
      <PeopleView />
    </div>
  );
}
