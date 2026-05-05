import { redirect } from "next/navigation";
import { fetchNarrativeDetail, type SubjectKind } from "../narratives-server-actions";
import { NarrativeDetailView } from "./narrative-detail-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Narrative - LL5" };

const VALID_KINDS: SubjectKind[] = ["person", "place", "group", "topic"];

export default async function NarrativeDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; ref?: string }>;
}) {
  const params = await searchParams;
  const kind = params.kind as SubjectKind | undefined;
  const ref = params.ref;

  if (!kind || !VALID_KINDS.includes(kind) || !ref) {
    redirect("/narratives");
  }

  const subject = { kind: kind as SubjectKind, ref };
  const detail = await fetchNarrativeDetail(subject, 200);

  return (
    <div className="space-y-6">
      <NarrativeDetailView subject={subject} initial={detail} />
    </div>
  );
}
