import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("container deployment defaults", () => {
  it("trusts private reverse proxies in the PostgreSQL compose stack", () => {
    const compose = fs.readFileSync(
      path.join(process.cwd(), "docker-compose.postgres.yml"),
      "utf8",
    );
    expect(compose).toContain("TRUST_PROXY: ${TRUST_PROXY:-uniquelocal}");
  });
});
