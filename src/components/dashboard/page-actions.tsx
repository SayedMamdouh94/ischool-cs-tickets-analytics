import { Suspense } from "react";
import { getViewer } from "@/lib/auth/dal";
import { ExportMenu } from "./export-menu";

async function ExportMenuForViewer({ aggregate }: { aggregate?: { dataset: string; label: string }[] }) {
  const viewer = await getViewer();
  if (!viewer?.role) return null;
  return <ExportMenu role={viewer.role} aggregate={aggregate} />;
}

/** Header actions that depend on the viewer's role (streamed). */
export function PageActions({ aggregate }: { aggregate?: { dataset: string; label: string }[] }) {
  return (
    <Suspense fallback={null}>
      <ExportMenuForViewer aggregate={aggregate} />
    </Suspense>
  );
}
