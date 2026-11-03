import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("admits ready and checkout-attribute PRs while protecting weekly/manual CodeQL", async () => {
  const workflow = await readFile(".github/workflows/codeql.yml", "utf8");
  const header = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  const pr = header.split("  pull_request:\n")[1]?.split("  schedule:\n")[0];

  expect(header).not.toMatch(/^  push:/mu);
  expect(pr).toContain("types: [opened, synchronize, reopened, ready_for_review]");
  expect(pr).toContain('      - ".gitattributes"');
  expect(pr).toContain('      - "**/.gitattributes"');
  expect(pr).toContain('      - "src/**"');
  expect(header).toContain('cron: "23 6 * * 1"');
  expect(header).toContain("  workflow_dispatch:");
  expect(header).toContain(
    "group: codeql-${{ github.workflow }}-${{ github.event_name }}-" +
      "${{ github.event_name == 'workflow_dispatch' && github.run_id || github.event.pull_request.number || github.ref }}",
  );
  expect(header).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
});
