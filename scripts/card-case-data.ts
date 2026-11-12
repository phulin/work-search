import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { displayCaption } from "../src/content/case-metadata.js";
export function cardCaseData() {
  const db = new DatabaseSync("work/full-flp/case-metadata.sqlite", {
      readOnly: true,
    }),
    courts = JSON.parse(
      readFileSync("work/full-flp/case-metadata/courts.json", "utf8"),
    );
  const get = db.prepare(
    "SELECT c.*,d.court,d.number,d.title AS docket_title,d.full_title AS docket_full FROM cases c LEFT JOIN dockets d ON c.docket=d.id WHERE c.id=?",
  );
  const citations = db.prepare(
    "SELECT volume,reporter,page FROM citations WHERE cluster=? ORDER BY reporter,volume,page",
  );
  return {
    close: () => db.close(),
    resolve: (original: any) => {
      const c = get.get(original.metadata?.cluster_id ?? -1) as any;
      if (!c) return original;
      const title = displayCaption(
        c.title,
        c.docket_title,
        c.full_title,
        c.docket_full,
        original.title,
      );
      return {
        id: original.id,
        title,
        metadata: {
          ...original.metadata,
          cluster_id: c.id,
          title,
          case_name_full: c.full_title || c.docket_full || title,
          docket_id: c.docket,
          docket_number: c.number,
          court_id: c.court,
          court: courts[c.court] ?? null,
          date_filed: c.date,
          date_filed_is_approximate: !!c.approx,
          precedential_status: c.status,
          judges: c.judges,
          citation_count: c.cited_by,
          citations: [
            ...new Set(
              citations
                .all(c.id)
                .map((r: any) =>
                  [r.volume, r.reporter, r.page].filter(Boolean).join(" "),
                ),
            ),
          ],
          snapshot: "2026-09-30",
          caption_available: !!title,
        },
      };
    },
  };
}
