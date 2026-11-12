import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseMetadata } from "../src/content/case-metadata.js";

it("joins official CSV relationships, recovers full/docket captions and preserves unavailable courts", async () => {
  const root = await mkdtemp(join(tmpdir(), "case-join-"));
  try {
    execFileSync("python3", [
      "-c",
      String.raw`
import bz2,csv,io,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
def save(name,records):
 text=io.StringIO(newline='');writer=csv.DictWriter(text,fieldnames=records[0].keys(),escapechar='\\');writer.writeheader();writer.writerows(records)
 path=root/(name+'-2026-09-30.csv.bz2');path.write_bytes(bz2.compress(text.getvalue().encode()));path.with_suffix(path.suffix+'.download.json').write_text(json.dumps({'complete':True}))
def case(id,docket,title,full):return dict(id=id,docket_id=docket,case_name=title,case_name_full=full,case_name_short='',date_filed='2003-04-16',precedential_status='Published',judges='Judge Café',citation_count='2',date_filed_is_approximate='t')
save('opinion-clusters',[case(7,17,'','Full caption'),case(8,18,'\\N',''),case(9,19,'Case without docket',''),case(4194311,17,'Catalog boundary','')])
save('dockets',[dict(id=17,court_id='test',docket_number='02-123',case_name='Short caption',case_name_full='',case_name_short=''),dict(id=18,court_id='test',docket_number='99-321',case_name='',case_name_full='Docket caption',case_name_short=''),dict(id=999,court_id='other',docket_number='X',case_name='Unrelated',case_name_full='',case_name_short='')])
save('courts',[dict(id='test',full_name='Example Supreme Court',short_name='Example',citation_string='Ex.',jurisdiction='S')])
save('citations',[dict(cluster_id=7,volume='12',reporter='F.3d',page='34')])
`,
      root,
    ]);
    execFileSync("python3", ["scripts/build-case-metadata.py", "--root", root]);
    execFileSync("python3", [
      "scripts/import-flp.py",
      "--metadata",
      "--root",
      root,
    ]);
    const imported = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import sqlite3,json,sys; print(json.dumps(sqlite3.connect(sys.argv[1]).execute('SELECT title FROM cases WHERE id=7').fetchone()[0]))",
          root + "/metadata.sqlite",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(imported).toBe("Full caption");
    const manifest = JSON.parse(
      await readFile(root + "/case-metadata/manifest.json", "utf8"),
    );
    expect(manifest.version).toBe(2);
    expect(manifest.encoding).toBe("gzip-json-blocks");
    execFileSync("python3", ["scripts/build-case-metadata.py", "--root", root]);
    expect(
      JSON.parse(await readFile(root + "/case-metadata/manifest.json", "utf8"))
        .generation,
    ).toBe(manifest.generation);
    const bucket = {
      get: async (key: string, opts: any) => {
        if (key === "demo-case-metadata.json")
          return { json: async () => manifest };
        const b = await readFile(
          root + "/case-metadata/" + key.split("/").at(-1),
        );
        const range = b.subarray(
          opts.range.offset,
          opts.range.offset + opts.range.length,
        );
        return {
          customMetadata: { generation: manifest.generation },
          arrayBuffer: async () =>
            range.buffer.slice(
              range.byteOffset,
              range.byteOffset + range.byteLength,
            ),
        };
      },
    } as unknown as R2Bucket;
    const reader = new CaseMetadata(bucket),
      seven = await reader.get(7),
      eight = await reader.get(8),
      nine = await reader.get(9);
    expect(seven.title).toBe("Full caption");
    expect(seven.court.full_name).toBe("Example Supreme Court");
    expect(seven.citations).toEqual(["12 F.3d 34"]);
    expect(seven.judges).toBe("Judge Café");
    expect(eight.title).toBe("Docket caption");
    expect(nine.court).toBeNull();
    expect(await reader.get(6)).toBeNull();
    expect(manifest.statistics.cases).toBe(4);
    expect((await reader.get(4194311)).title).toBe("Catalog boundary");
    expect(manifest.objects.every((o: any) => o.size <= 64 * 1048576)).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
