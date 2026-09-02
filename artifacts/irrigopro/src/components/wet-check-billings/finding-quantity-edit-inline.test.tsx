import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FindingQuantityEditInline } from "./finding-quantity-edit-inline";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(() => Promise.resolve({})),
  toast: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: mocks.apiRequest,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

const item = {
  findingId: 101,
  quantity: 192,
  unitPrice: "10.00",
  partsTotal: "1920.00",
  noPartNeeded: false,
  catalogLaborHours: "0.25",
  laborHours: "0.25",
};
const companion = {
  findingId: 102,
  quantity: 1,
  unitPrice: "5.00",
  partsTotal: "5.00",
  noPartNeeded: false,
  catalogLaborHours: "0.80",
  laborHours: "0.80",
};

function renderEditor(overrides: Partial<React.ComponentProps<typeof FindingQuantityEditInline>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <FindingQuantityEditInline
        wcbId={42}
        item={item}
        zoneLabel="F-2"
        zoneLaborHours="49.30"
        laborRate="80.00"
        allItems={[item, companion]}
        canEdit={true}
        laborWasManual={false}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

function editTo(quantity: string) {
  fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
  fireEvent.change(screen.getByTestId("finding-quantity-input-101"), {
    target: { value: quantity },
  });
  fireEvent.click(screen.getByTestId("finding-quantity-save-101"));
}

describe("FindingQuantityEditInline", () => {
  beforeEach(() => {
    mocks.apiRequest.mockClear();
    mocks.toast.mockClear();
  });

  it("keeps labor-only and unauthorized quantities read-only", () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <FindingQuantityEditInline
          wcbId={42}
          item={{ ...item, noPartNeeded: true }}
          zoneLabel="F-2"
          zoneLaborHours="1.00"
          laborRate="80.00"
          allItems={[{ ...item, noPartNeeded: true }]}
          canEdit={true}
          laborWasManual={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("finding-quantity-readonly-101")).toHaveTextContent("—");

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <FindingQuantityEditInline
          wcbId={42}
          item={item}
          zoneLabel="F-2"
          zoneLaborHours="49.30"
          laborRate="80.00"
          allItems={[item]}
          canEdit={false}
          laborWasManual={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("finding-quantity-readonly-101")).toHaveTextContent("192");
    expect(screen.queryByTestId("finding-quantity-pencil-101")).not.toBeInTheDocument();
  });

  it("confirms a large labor swing and shows resulting parts, hours, and dollars", () => {
    renderEditor();
    editTo("2");

    expect(screen.getByText("Confirm quantity correction")).toBeInTheDocument();
    expect(screen.getByText(/Resulting parts:/)).toHaveTextContent("$25.00");
    expect(screen.getByText(/Resulting zone labor:/)).toHaveTextContent("1.30 hours");
    expect(screen.getByText(/Resulting labor dollars:/)).toHaveTextContent("$104.00");
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("also confirms when quantity exceeds 25 even without a large labor swing", () => {
    renderEditor({
      item: { ...item, quantity: 1, catalogLaborHours: "0.01" },
      allItems: [{ ...item, quantity: 1, catalogLaborHours: "0.01" }],
      zoneLaborHours: "0.01",
    });
    fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
    fireEvent.change(screen.getByTestId("finding-quantity-input-101"), { target: { value: "26" } });
    fireEvent.click(screen.getByTestId("finding-quantity-save-101"));
    expect(screen.getByText("Confirm quantity correction")).toBeInTheDocument();
  });

  it("counts legacy zero-quantity labor-only rows as one unit in the labor preview", () => {
    const current = { ...item, quantity: 1, catalogLaborHours: "0.25" };
    const legacyLaborOnly = {
      ...companion,
      quantity: 0,
      noPartNeeded: true,
      catalogLaborHours: "0.80",
    };
    renderEditor({
      item: current,
      allItems: [current, legacyLaborOnly],
      zoneLaborHours: "1.05",
    });
    fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
    fireEvent.change(screen.getByTestId("finding-quantity-input-101"), { target: { value: "26" } });
    fireEvent.click(screen.getByTestId("finding-quantity-save-101"));
    expect(screen.getByText(/Resulting zone labor:/)).toHaveTextContent("7.30 hours");
  });

  it("shows a manual override warning while editing and in confirmation", () => {
    renderEditor({ laborWasManual: true });
    fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
    expect(screen.getByTestId("finding-quantity-manual-warning-101")).toHaveTextContent(
      "replaces the manual zone labor",
    );
    fireEvent.change(screen.getByTestId("finding-quantity-input-101"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("finding-quantity-save-101"));
    expect(screen.getByText(/existing manual labor value will be replaced/i)).toBeInTheDocument();
  });

  it("saves a small correction directly with the real WCB id and refreshes all affected queries", async () => {
    const smallItem = { ...item, quantity: 2 };
    const { invalidateSpy } = renderEditor({
      item: smallItem,
      allItems: [smallItem, companion],
      zoneLaborHours: "1.30",
    });
    fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
    fireEvent.change(screen.getByTestId("finding-quantity-input-101"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("finding-quantity-save-101"));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/api/wet-check-billings/42/finding-quantity",
      "PATCH",
      { findingId: 101, quantity: 3 },
    ));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(4));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["/api/wet-check-billings", 42] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["/api/wet-check-billings"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["/api/customers/billing-preview"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/wet-check-billings/42/activity"],
    });
  });

  it("refreshes the completed-work wet-check view when a billing sheet id is supplied", async () => {
    const smallItem = { ...item, quantity: 2 };
    const { invalidateSpy } = renderEditor({
      item: smallItem,
      allItems: [smallItem],
      zoneLaborHours: "0.50",
      billingSheetId: 77,
    });
    fireEvent.click(screen.getByTestId("finding-quantity-pencil-101"));
    fireEvent.change(screen.getByTestId("finding-quantity-input-101"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("finding-quantity-save-101"));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/billing-sheets", 77, "wet-check-view"],
    }));
  });

  it("rejects zero and non-integer input before calling the API", () => {
    renderEditor();
    editTo("0");
    expect(mocks.apiRequest).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Invalid quantity",
    }));
  });
});
