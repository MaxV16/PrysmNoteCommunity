import { StickyNoteRenderer } from "./StickyNoteClient";

export default async function StickyNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StickyNoteRenderer noteId={id} />;
}