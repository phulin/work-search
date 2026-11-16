# Demo architecture

The demo uses a gateway Worker and shard Workers. `gateway.ts` loads the bundled
route index from `data/global-routes.bin`; `gateway-runtime.ts` selects shards,
merges ranked results, and manages pagination. `shard.ts` loads
`data/bundle.bin`; `shard-runtime.ts` performs shard search and retrieves result
presentation. `cursor.ts` carries pagination state. `page.ts` and
`presentation.ts` provide the browser interface and result rendering.

Content packs, cards, metadata, and passages are implemented in `src/content`.
Build and publication helpers live in `scripts/` and `bench/build-demo-*.ts`.
`scripts/publish-search-snapshot.ts` publishes a route snapshot;
`scripts/deploy-demo.ts` and related shard helpers manage the existing demo.
Generated import state and deployment receipts remain under ignored `work/`.

The default package commands use the separate columnar Worker described in
[the repository architecture](../docs/ARCHITECTURE.md).
