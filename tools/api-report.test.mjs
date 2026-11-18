import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { REPORT_PATH, buildApiReport } from "./api-report.mjs";

it("api/report.txt commitado bate com o gerado a partir de entries/", () => {
  expect(readFileSync(REPORT_PATH, "utf8")).toBe(buildApiReport());
}, 60000);
