import { fetchLessons } from "./lessons-server-actions";

export const metadata = { title: "Lessons - LL5" };
export const dynamic = "force-dynamic";

export default async function LessonsPage() {
  const lessons = await fetchLessons("active");
  const durable = lessons.filter((l) => l.durability === "durable");
  const provisional = lessons.filter((l) => l.durability === "provisional");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Operating Lessons</h1>
        <p className="text-sm text-gray-500 mt-1">
          The agent&apos;s governed runbook — what it has learned about operating itself and its
          tools. Written by intercepting its memory; reconciled so contradictions can&apos;t coexist.
        </p>
      </div>

      {provisional.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-amber-600 uppercase tracking-wide mb-2">
            Provisional ({provisional.length}) — verify before trusting
          </h2>
          <ul className="space-y-2">
            {provisional.map((l) => (
              <li key={l.id} className="rounded border border-amber-200 bg-amber-50 p-3">
                <p className="font-medium">{l.claim}</p>
                <p className="text-xs text-gray-600 mt-1">when: {l.trigger}</p>
                {l.falsification_test && (
                  <p className="text-xs text-amber-700 mt-1">test: {l.falsification_test}</p>
                )}
                {l.depends_on && (
                  <p className="text-xs text-gray-500 mt-1">depends on: {l.depends_on}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Durable ({durable.length})
        </h2>
        {durable.length === 0 ? (
          <p className="text-sm text-gray-400">No durable lessons recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {durable.map((l) => (
              <li key={l.id} className="rounded border border-gray-200 p-3">
                <p className="font-medium">{l.claim}</p>
                <p className="text-xs text-gray-500 mt-1">
                  when: {l.trigger}
                  {l.source ? ` · ${l.source}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
