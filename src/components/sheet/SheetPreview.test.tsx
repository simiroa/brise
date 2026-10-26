import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SheetPreview } from "./SheetPreview";
import { emptySheet, serializeSheet, type SheetDoc } from "../../lib/sheet/types";

describe("SheetPreview component", () => {
  const doc: SheetDoc = {
    ...emptySheet(),
    cells: {
      A1: { raw: "항목" },
      B1: { raw: "금액" },
      A2: { raw: "식비" },
      B2: { raw: "12000" },
    },
    charts: [
      {
        id: "c1",
        type: "total",
        title: "가계부 요약",
        x: "A2:A2",
        series: ["B2:B2"],
      },
    ],
  };

  it("renders preview chart and compact table", async () => {
    render(<SheetPreview bodyMd={serializeSheet(doc)} />);
    expect(await screen.findByText("가계부 요약")).toBeDefined();
    expect(screen.getByText("식비")).toBeDefined();
    expect(screen.getByText("12000")).toBeDefined();
  });
});
