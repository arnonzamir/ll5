import { fetchNarratives } from "./narratives-server-actions";
import { NarrativesView } from "./narratives-view";

export const metadata = { title: "Narratives - LL5" };
export const dynamic = "force-dynamic";

export default async function NarrativesPage() {
  const initial = await fetchNarratives({ status: "active", limit: 100 });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Narratives</h1>
        <p className="text-sm text-gray-500 mt-1">
          The threads in your life — agent-curated, evolving. Browse the summary; talk to the agent to add or change.
        </p>
      </div>
      <NarrativesView initial={initial} />
    </div>
  );
}
