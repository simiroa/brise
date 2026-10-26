import { describe, expect, it } from "vitest";
import { clientTagCounts, resolveAllTags, resolveTagCounts } from "./tagCounts";
import type { NoteSummary } from "./commands.gen";

const note = (id: string, tags: string[]): NoteSummary => ({
  id,
  folder_id: "f1",
  title: id,
  year: 1500,
  is_favorite: false,
  exported_at: null,
  has_image: false,
  tag_names: tags,
  region: null,
  status: null,
  icon: null,
  lat: null,
  lng: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  month: null,
  day: null,
});

describe("tagCounts helpers", () => {
  const folder = {
    f1: [note("n1", ["alpha", "shared"]), note("n2", ["shared"])],
    f2: [note("n3", ["beta"])],
  };

  it("clientTagCounts flattens notesByFolder like the old TagsFilter scan", () => {
    const m = clientTagCounts(folder);
    expect(m.get("alpha")).toBe(1);
    expect(m.get("shared")).toBe(2);
    expect(m.get("beta")).toBe(1);
  });

  it("resolveTagCounts prefers server map when present", () => {
    const server = { only: 9, alpha: 3 };
    const m = resolveTagCounts(server, folder);
    expect(m.get("only")).toBe(9);
    expect(m.get("alpha")).toBe(3);
    expect(m.has("shared")).toBe(false);
  });

  it("resolveTagCounts falls back to client when server is null", () => {
    const m = resolveTagCounts(null, folder);
    expect(m.get("shared")).toBe(2);
  });

  it("resolveAllTags sorts names from server or client", () => {
    expect(resolveAllTags({ zeta: 1, alpha: 2 }, folder)).toEqual(["alpha", "zeta"]);
    expect(resolveAllTags(null, folder)).toEqual(["alpha", "beta", "shared"]);
  });
});
