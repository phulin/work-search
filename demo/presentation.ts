export function caseCaption(info: any): string {
  for (const value of [info.title, info.metadata?.case_name_full]) {
    if (typeof value !== "string") continue;
    const title = value.trim();
    if (
      title &&
      !["\\N", "N", "null", "None"].includes(title) &&
      !/^Opinion \d+$/.test(title) &&
      !title.startsWith("courtlistener-opinion:")
    )
      return title;
  }
  const id =
    info.metadata?.opinion_id ??
    String(info.id ?? "")
      .split(":")
      .at(-1);
  return "Caption unavailable" + (id ? " · Opinion " + id : "");
}

export function caseFacts(info: any): [string, string][] {
  // These functions are also serialized into the browser page. Avoid captured
  // helpers (including name-preservation helpers inserted by the Worker bundler).
  const m = info.metadata ?? {};
  const [courtFull, courtShort, courtId, rawDate, docket, status, judges] = [
    m.court?.full_name,
    m.court?.short_name,
    m.court_id,
    m.date_filed,
    m.docket_number,
    m.precedential_status,
    m.judges,
  ].map((v) =>
    typeof v === "string" && !["\\N", "N", "null", "None"].includes(v.trim())
      ? v.trim()
      : "",
  );
  let date = rawDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    const parsed = new Date(rawDate + "T00:00:00Z");
    if (!Number.isNaN(parsed.getTime()))
      date = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(parsed);
  }
  if (date && m.date_filed_is_approximate) date += " (approx.)";
  const citations = Array.isArray(m.citations)
    ? m.citations
        .map((v: unknown) =>
          typeof v === "string" &&
          !["\\N", "N", "null", "None"].includes(v.trim())
            ? v.trim()
            : "",
        )
        .filter(Boolean)
        .join(" · ")
    : "";
  return [
    ["Court", courtFull || courtShort || courtId || "Court unavailable"],
    ["Decided", date],
    ["Citation", citations],
    ["Docket", docket],
    ["Status", status],
    ["Judges", judges],
    [
      "Times cited in snapshot",
      Number.isSafeInteger(m.citation_count) && m.citation_count >= 0
        ? m.citation_count.toLocaleString()
        : "",
    ],
  ].filter(([, value]) => !!value) as [string, string][];
}
