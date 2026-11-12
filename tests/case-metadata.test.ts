import { it, expect } from "vitest";
import { CaseMetadata, displayCaption } from "../src/content/case-metadata.js";
import { caseCaption, caseFacts } from "../demo/presentation.js";
import { page } from "../demo/page.js";
import { crc32 } from "../src/format/codec.js";

it("recovers empty/null captions and presents identifiable source gaps", () => {
  expect(displayCaption("", " Full case name ", "short")).toBe(
    "Full case name",
  );
  expect(
    displayCaption("\\N", "N", "Opinion 3", "courtlistener-opinion:3"),
  ).toBe("");
  expect(
    caseCaption({
      title: "",
      metadata: { case_name_full: "Allen v. Christenberry" },
    }),
  ).toBe("Allen v. Christenberry");
  expect(caseCaption({ id: "courtlistener-opinion:3", title: "N" })).toBe(
    "Caption unavailable · Opinion 3",
  );
});

it("shows court, date, citations, docket, status and judges with honest source labels", () => {
  const facts = Object.fromEntries(
    caseFacts({
      metadata: {
        court: {
          full_name: "Supreme Court of the United States",
          citation_string: "SCOTUS",
        },
        date_filed: "2003-04-16",
        date_filed_is_approximate: true,
        citations: ["123 U.S. 456"],
        docket_number: "02-123",
        precedential_status: "Published",
        judges: "Justice Example",
        citation_count: 12,
      },
    }),
  );
  expect(facts.Court).toBe("Supreme Court of the United States");
  expect(facts.Decided).toBe("Apr 16, 2003 (approx.)");
  expect(facts.Citation).toBe("123 U.S. 456");
  expect(facts.Docket).toBe("02-123");
  expect(facts.Judges).toBe("Justice Example");
  expect(facts["Times cited in snapshot"]).toBe("12");
  expect(caseFacts({ metadata: { date_filed: "\\N", judges: "" } })).toEqual([
    ["Court", "Court unavailable"],
  ]);
});

function fixture(
  options: {
    corrupt?: boolean;
    wrongGeneration?: boolean;
    wrongId?: boolean;
  } = {},
) {
  const generation = "b".repeat(64),
    calls: string[] = [];
  const record = new TextEncoder().encode(
    JSON.stringify({
      cluster_id: options.wrongId ? 99 : 7,
      title: "Recovered caption",
      case_name_full: "Recovered caption (full)",
      court: { full_name: "Example Court" },
      citations: ["12 F.3d 34"],
      docket_number: "123",
    }),
  );
  const map = new Uint8Array(16),
    v = new DataView(map.buffer);
  v.setUint32(8, record.length, true);
  v.setUint32(12, crc32(record), true);
  const bucket = {
    get: async (key: string, opts: any) => {
      calls.push(key);
      if (key === "demo-case-metadata.json")
        return {
          json: async () => ({
            version: 1,
            generation,
            maxId: 10,
            recordBytes: 16,
          }),
        };
      expect(opts.range).toBeTruthy();
      const bytes = key.endsWith("casemap-0.bin") ? map : record.slice();
      if (options.corrupt && key.endsWith("cases-0.bin")) bytes[0] ^= 1;
      return {
        customMetadata: {
          generation: options.wrongGeneration ? "wrong" : generation,
        },
        arrayBuffer: async () => bytes.buffer,
      };
    },
  } as unknown as R2Bucket;
  return { reader: new CaseMetadata(bucket), calls };
}

it("enriches old indexed records through checked ranges and caches display metadata", async () => {
  const { reader, calls } = fixture();
  const result = await reader.enrich({
    id: "opinion:1",
    title: "",
    metadata: { cluster_id: 7, opinion_id: 1, url: "source" },
  });
  expect(result.title).toBe("Recovered caption");
  expect(result.metadata.court.full_name).toBe("Example Court");
  expect(result.metadata.opinion_id).toBe(1);
  expect(result.metadata.url).toBe("source");
  await reader.get(7);
  expect(calls).toHaveLength(3);
  expect(await reader.get(11)).toBeNull();
  await expect(fixture({ corrupt: true }).reader.get(7)).rejects.toThrow(
    /checksum/,
  );
  await expect(
    fixture({ wrongGeneration: true }).reader.get(7),
  ).rejects.toThrow(/generation/);
  await expect(fixture({ wrongId: true }).reader.get(7)).rejects.toThrow(
    /identity/,
  );
});

it("keeps legacy search working before metadata publication and emits valid browser code", async () => {
  const bucket = { get: async () => null } as unknown as R2Bucket;
  const info = { title: "Original caption", metadata: { cluster_id: 7 } };
  expect((await new CaseMetadata(bucket).enrich(info)).title).toBe(info.title);
  const script = page.match(/<script>([\s\S]*)<\/script>/)![1];
  expect(() => new Function(script)).not.toThrow();
  const helpers = script.slice(
    0,
    script.indexOf("const q=document.querySelector"),
  );
  const facts = new Function(
    helpers + ";return caseFacts({metadata:{court:{full_name:'Test court'}}})",
  )();
  expect(facts).toEqual([["Court", "Test court"]]);
});
