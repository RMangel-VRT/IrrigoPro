/**
 * work-location-controls.test.tsx
 *
 * The shared work-location card behind Billing Sheet Step 2 and Work Order
 * completion. Two field reports drive this suite:
 *
 *  1. "The Work Type dropdown doesn't expand." The control fed Radix a
 *     `__none__` sentinel while deliberately not rendering the matching item
 *     under an enforced gate, so the trigger rendered blank — no value and no
 *     placeholder — and a company with an unseeded work-type registry opened
 *     a menu with nothing in it. Both now say what is going on.
 *  2. "Controller and Zone should be mandatory depending on the work type,
 *     and otherwise shouldn't show up at all." The card used to render the
 *     pair unconditionally and only toggle an asterisk.
 *
 * The visibility matrix is asserted through the component rather than the
 * pure helper alone, because the regression that shipped was presentational:
 * the policy was already correct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  WorkLocationControls,
  type WorkLocationRequirementsValue,
} from "./work-location-controls";

// Radix drives open/close off pointer capture, which jsdom does not implement.
const proto = Element.prototype as any;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

type Rule = {
  code: string;
  label: string;
  requiresController: boolean;
  requiresZone: boolean;
  requiresDetails: boolean;
  active?: boolean;
};

const WORK_TYPES: Rule[] = [
  { code: "zone_repair", label: "Zone Repair", requiresController: true, requiresZone: true, requiresDetails: false, active: true },
  { code: "head_replacement", label: "Head Replacement", requiresController: true, requiresZone: true, requiresDetails: false, active: true },
  { code: "valve_repair", label: "Valve Repair", requiresController: true, requiresZone: true, requiresDetails: false, active: true },
  { code: "controller_repair", label: "Controller/Clock Repair", requiresController: true, requiresZone: false, requiresDetails: false, active: true },
  { code: "backflow", label: "Backflow", requiresController: false, requiresZone: false, requiresDetails: false, active: true },
  { code: "mainline_repair", label: "Mainline Repair", requiresController: false, requiresZone: false, requiresDetails: false, active: true },
  { code: "other", label: "Other", requiresController: false, requiresZone: false, requiresDetails: true, active: true },
];

// A preset that has since been retired. It is still in the registry — records
// carry its code — but nobody may choose it for new work.
const RETIRED_ZONE_REPAIR: Rule = {
  code: "zone_repair",
  label: "Zone Repair",
  requiresController: true,
  requiresZone: true,
  requiresDetails: false,
  active: false,
};

const CONTROLLERS = [
  { controllerLetter: "A", zoneCount: 12 },
  { controllerLetter: "B", zoneCount: 6 },
];

const CUSTOMER_ID = 7;

function emptyValue(
  overrides: Partial<WorkLocationRequirementsValue> = {},
): WorkLocationRequirementsValue {
  return {
    workLocation: null,
    controllerLetter: null,
    zoneNumber: null,
    fieldWorkType: null,
    fieldWorkTypeDetails: "",
    ...overrides,
  };
}

function registryKey(customerId: number | null): string {
  return `/api/field-work-types?customerId=${customerId ?? ""}&includeRetired=true`;
}

function renderControls(options: {
  value?: Partial<WorkLocationRequirementsValue>;
  workTypes?: Rule[];
  enforce?: boolean;
  onChange?: (next: WorkLocationRequirementsValue) => void;
  onGateStateChange?: (complete: boolean, violations: string[]) => void;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  // Keyed per customer on purpose — see the Super Admin scoping test below.
  // The read asks for the full registry (retired rows included) because a
  // record may already carry a code that is no longer offered; what may be
  // *chosen* is filtered out of that answer, not out of the request.
  client.setQueryData(
    [registryKey(CUSTOMER_ID)],
    options.workTypes ?? WORK_TYPES,
  );
  client.setQueryData(["/api/properties", CUSTOMER_ID, "controllers"], CONTROLLERS);

  const onChange = options.onChange ?? vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <WorkLocationControls
        customerId={CUSTOMER_ID}
        value={emptyValue(options.value)}
        onChange={onChange}
        enforceLocationGate={options.enforce ?? true}
        onGateStateChange={options.onGateStateChange as any}
      />
    </QueryClientProvider>,
  );
  return { ...view, onChange };
}

function openSelect(testId: string) {
  fireEvent.pointerDown(screen.getByTestId(testId), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("work type picker", () => {
  it("shows the placeholder instead of a blank trigger when nothing is selected", () => {
    renderControls({});
    // The bug: Radix only treats "" / undefined as "no value", so the
    // sentinel left the trigger showing neither a value nor the placeholder.
    expect(screen.getByTestId("select-work-type")).toHaveTextContent(
      "Select work type",
    );
  });

  it("opens with every active work type and reports the chosen code", async () => {
    const onChange = vi.fn();
    renderControls({ onChange });

    openSelect("select-work-type");

    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBe(WORK_TYPES.length);
    });
    for (const type of WORK_TYPES) {
      expect(screen.getByRole("option", { name: type.label })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("option", { name: "Valve Repair" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      fieldWorkType: "valve_repair",
    });
  });

  it("names the state when the company has no work types configured", () => {
    renderControls({ workTypes: [] });

    expect(screen.getByTestId("text-work-types-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("select-work-type")).toHaveTextContent(
      "No work types configured",
    );
    expect(screen.getByTestId("select-work-type")).toBeDisabled();
  });

  it("asks for the record's customer registry, not whatever the signed-in user can see", async () => {
    // A Super Admin has no company of their own, so an unscoped read answers
    // with every tenant's work types. If the control used that, a Super Admin
    // on a record belonging to an empty tenant would be held to a requirement
    // the server has already waived — the client would block a save the
    // server accepts. The customer-scoped read is the whole fix, so prove the
    // unscoped answer is not the one being used.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
      },
    });
    client.setQueryData([registryKey(null)], WORK_TYPES); // another tenant's
    client.setQueryData([registryKey(CUSTOMER_ID)], []);
    client.setQueryData(["/api/properties", CUSTOMER_ID, "controllers"], CONTROLLERS);

    const onGateStateChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <WorkLocationControls
          customerId={CUSTOMER_ID}
          value={emptyValue()}
          onChange={vi.fn()}
          enforceLocationGate
          onGateStateChange={onGateStateChange}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("text-work-types-unavailable")).toBeInTheDocument();
    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual([]);
    expect(complete).toBe(true);
  });

  it("does not tell the user an administrator must add work types", () => {
    // Nothing in the product lets an administrator add one, so that advice
    // was unactionable. An empty registry means the gate does not apply.
    renderControls({ workTypes: [] });

    const notice = screen.getByTestId("text-work-types-unavailable");
    expect(notice.textContent).not.toMatch(/administrator/i);
    expect(notice.textContent).toMatch(/not required|save without/i);
  });

  it("still renders a stored code the registry has never heard of", async () => {
    renderControls({ value: { fieldWorkType: "retired_code" } });

    openSelect("select-work-type");
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /retired_code \(no longer offered\)/ }),
      ).toBeInTheDocument();
    });
  });

  it("names a retired type instead of printing its database code", async () => {
    // The registry knows the code; only its `active` flag has changed. Showing
    // `zone_repair` where the seeded label reads "Zone Repair" makes the one
    // place a retired type appears the one place it is unreadable.
    renderControls({
      workTypes: [RETIRED_ZONE_REPAIR, ...WORK_TYPES.filter((t) => t.code !== "zone_repair")],
      value: { fieldWorkType: "zone_repair" },
    });

    openSelect("select-work-type");
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /^Zone Repair \(no longer offered\)$/ }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: /^zone_repair/ })).not.toBeInTheDocument();
  });

  it("never offers a retired type for new work", async () => {
    const active = WORK_TYPES.filter((type) => type.code !== "zone_repair");
    renderControls({ workTypes: [RETIRED_ZONE_REPAIR, ...active] });

    openSelect("select-work-type");
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBe(active.length);
    });
    // Not present at all: nothing on this record carries the retired code, so
    // there is no reason to render it.
    expect(
      screen.queryByRole("option", { name: /Zone Repair/ }),
    ).not.toBeInTheDocument();
  });

  it("treats a company left holding only retired types as empty", async () => {
    // Retired rows in the background must not make the registry look
    // populated: nobody in this company can pick a work type, which is exactly
    // the fact the server's active-only count fails open on.
    const onGateStateChange = vi.fn();
    renderControls({
      workTypes: [RETIRED_ZONE_REPAIR],
      value: { workLocation: null, fieldWorkType: null },
      onGateStateChange,
    });

    expect(screen.getByTestId("text-work-types-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("select-work-type")).toBeDisabled();
    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual([]);
    expect(complete).toBe(true);
  });
});

describe("controller & zone visibility", () => {
  it("hides the group entirely until a work type is chosen", () => {
    renderControls({});
    expect(screen.queryByTestId("controller-zone-section")).not.toBeInTheDocument();
  });

  it.each([
    ["zone_repair"],
    ["head_replacement"],
    ["valve_repair"],
  ])("shows both fields, required, for %s", (code) => {
    renderControls({ value: { fieldWorkType: code } });

    const section = screen.getByTestId("controller-zone-section");
    expect(within(section).getByTestId("select-controller")).toBeInTheDocument();
    expect(within(section).getByTestId("select-zone")).toBeInTheDocument();
    expect(section).toHaveTextContent("(required by work type)");
  });

  it("shows only the controller for a controller-only rule", () => {
    renderControls({ value: { fieldWorkType: "controller_repair" } });

    const section = screen.getByTestId("controller-zone-section");
    expect(within(section).getByTestId("select-controller")).toBeInTheDocument();
    expect(within(section).queryByTestId("select-zone")).not.toBeInTheDocument();
    expect(section).toHaveTextContent("(required by work type)");
  });

  it.each([["backflow"], ["mainline_repair"]])(
    "hides the whole group for %s",
    (code) => {
      renderControls({ value: { fieldWorkType: code } });
      expect(screen.queryByTestId("controller-zone-section")).not.toBeInTheDocument();
    },
  );

  it("keeps a retired type's own requirements visible", () => {
    // Resolving a retired rule demands nothing new — exactly what it demanded
    // the day the record was saved. Reading the active list here resolved no
    // rule at all and hid the very fields the record depends on.
    renderControls({
      workTypes: [RETIRED_ZONE_REPAIR, ...WORK_TYPES.filter((t) => t.code !== "zone_repair")],
      value: { fieldWorkType: "zone_repair" },
    });

    const section = screen.getByTestId("controller-zone-section");
    expect(within(section).getByTestId("select-controller")).toBeInTheDocument();
    expect(within(section).getByTestId("select-zone")).toBeInTheDocument();
    expect(section).toHaveTextContent("(required by work type)");
  });

  it("asks for details without an irrelevant controller & zone card", () => {
    renderControls({ value: { fieldWorkType: "other" } });

    expect(screen.getByTestId("input-work-type-details")).toBeInTheDocument();
    expect(screen.queryByTestId("controller-zone-section")).not.toBeInTheDocument();
  });

  it("applies the same rules when the gate is not enforced", () => {
    renderControls({ value: { fieldWorkType: "backflow" }, enforce: false });
    expect(screen.queryByTestId("controller-zone-section")).not.toBeInTheDocument();
  });

  it("keeps a legacy stored controller visible even with no work type", () => {
    renderControls({ value: { controllerLetter: "A", zoneNumber: 3 } });

    const section = screen.getByTestId("controller-zone-section");
    expect(within(section).getByTestId("select-controller")).toBeInTheDocument();
    expect(within(section).getByTestId("select-zone")).toBeInTheDocument();
    // Nothing the rule does not require may be presented as mandatory.
    expect(section).toHaveTextContent("(optional)");
  });
});

describe("clearing stale values when the work type changes", () => {
  beforeEach(() => vi.clearAllMocks());

  async function switchTo(label: string, from: Partial<WorkLocationRequirementsValue>) {
    const onChange = vi.fn();
    renderControls({
      value: { fieldWorkType: "zone_repair", controllerLetter: "A", zoneNumber: 3, ...from },
      onChange,
    });
    openSelect("select-work-type");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("option", { name: label }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    return onChange.mock.calls.at(-1)![0] as WorkLocationRequirementsValue;
  }

  it("drops both values when the new rule needs neither", async () => {
    const next = await switchTo("Backflow", {});
    expect(next).toMatchObject({
      fieldWorkType: "backflow",
      controllerLetter: null,
      zoneNumber: null,
    });
  });

  it("keeps the controller but drops the zone for a controller-only rule", async () => {
    const next = await switchTo("Controller/Clock Repair", {});
    expect(next).toMatchObject({
      fieldWorkType: "controller_repair",
      controllerLetter: "A",
      zoneNumber: null,
    });
  });

  it("keeps both when the new rule still needs both", async () => {
    const next = await switchTo("Head Replacement", {});
    expect(next).toMatchObject({
      fieldWorkType: "head_replacement",
      controllerLetter: "A",
      zoneNumber: 3,
    });
  });

  it("does not clear anything on mount", () => {
    const onChange = vi.fn();
    renderControls({
      value: { fieldWorkType: "backflow", controllerLetter: "A", zoneNumber: 3 },
      onChange,
    });
    // A legacy record whose stored values disagree with its rule must be left
    // alone; work-order completion persists every onChange immediately.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("legacy values the controller list disagrees with", () => {
  function renderWithControllers(options: {
    controllers: { controllerLetter: string; zoneCount: number }[];
    value: Partial<WorkLocationRequirementsValue>;
    customerId?: number;
  }) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
      },
    });
    client.setQueryData([registryKey(options.customerId ?? CUSTOMER_ID)], WORK_TYPES);
    client.setQueryData(
      ["/api/properties", options.customerId ?? CUSTOMER_ID, "controllers"],
      options.controllers,
    );
    const onChange = vi.fn();
    const ui = (customerId: number) => (
      <QueryClientProvider client={client}>
        <WorkLocationControls
          customerId={customerId}
          value={emptyValue(options.value)}
          onChange={onChange}
          enforceLocationGate
        />
      </QueryClientProvider>
    );
    const view = render(ui(options.customerId ?? CUSTOMER_ID));
    return { onChange, rerenderWithCustomer: (id: number) => view.rerender(ui(id)) };
  }

  it("never erases a stored controller just because the fetch came back empty", () => {
    // useArrayQuery reports a failed or forbidden controller fetch as [], and
    // work-order completion persists every onChange straight to the server.
    const { onChange } = renderWithControllers({
      controllers: [],
      value: { fieldWorkType: "zone_repair", controllerLetter: "C", zoneNumber: 4 },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("select-controller")).toHaveTextContent(
      "Controller C (no longer on file)",
    );
  });

  it("keeps a zone the selected controller no longer has", () => {
    const { onChange } = renderWithControllers({
      controllers: CONTROLLERS,
      value: { fieldWorkType: "zone_repair", controllerLetter: "B", zoneNumber: 9 },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("select-zone")).toHaveTextContent(
      "Zone 9 (not on this controller)",
    );
  });

  it("does clear when the user switches to a different customer", async () => {
    const { onChange, rerenderWithCustomer } = renderWithControllers({
      controllers: CONTROLLERS,
      value: { fieldWorkType: "zone_repair", controllerLetter: "A", zoneNumber: 3 },
    });
    expect(onChange).not.toHaveBeenCalled();

    rerenderWithCustomer(CUSTOMER_ID + 1);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      controllerLetter: null,
      zoneNumber: null,
    });
  });
});

describe("gate reporting", () => {
  it("does not demand a hidden field", async () => {
    const onGateStateChange = vi.fn();
    renderControls({
      value: {
        fieldWorkType: "backflow",
        workLocation: { lat: 39.7, lng: -104.9 },
      },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual([]);
    expect(complete).toBe(true);
  });

  it("reports the gate satisfied when the tenant has no active work types", async () => {
    // A company with an empty registry has no action available that satisfies
    // a required Work Type, so the gate must not apply: the wizard's step 2
    // and work-order completion both key off this callback. The server fails
    // open on the same fact and audits the skip.
    const onGateStateChange = vi.fn();
    renderControls({
      workTypes: [],
      value: { workLocation: null, fieldWorkType: null },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual([]);
    expect(complete).toBe(true);
    expect(screen.queryByTestId("location-gate-status")).not.toBeInTheDocument();
  });

  it("goes back to enforcing as soon as one active work type exists", async () => {
    const onGateStateChange = vi.fn();
    renderControls({
      workTypes: [WORK_TYPES[0]],
      value: { workLocation: null, fieldWorkType: null },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual(["pin_missing", "work_type_missing"]);
    expect(complete).toBe(false);
  });

  it("passes a ticket saved complete under a since-retired type", async () => {
    // The ticket was captured correctly and the report agrees it is complete.
    // Resolving the retired rule is what stops the wizard blocking an edit on
    // a work type that can no longer be re-selected.
    const onGateStateChange = vi.fn();
    renderControls({
      workTypes: [RETIRED_ZONE_REPAIR, ...WORK_TYPES.filter((t) => t.code !== "zone_repair")],
      value: {
        fieldWorkType: "zone_repair",
        workLocation: { lat: 39.7, lng: -104.9 },
        controllerLetter: "A",
        zoneNumber: 3,
      },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual([]);
    expect(complete).toBe(true);
  });

  it("still enforces a retired type's requirements when they are unmet", async () => {
    const onGateStateChange = vi.fn();
    renderControls({
      workTypes: [RETIRED_ZONE_REPAIR, ...WORK_TYPES.filter((t) => t.code !== "zone_repair")],
      value: {
        fieldWorkType: "zone_repair",
        workLocation: { lat: 39.7, lng: -104.9 },
      },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual(["controller_missing", "zone_missing"]);
    expect(complete).toBe(false);
  });

  it("still blocks on a visible required field", async () => {
    const onGateStateChange = vi.fn();
    renderControls({
      value: {
        fieldWorkType: "zone_repair",
        workLocation: { lat: 39.7, lng: -104.9 },
      },
      onGateStateChange,
    });

    await waitFor(() => expect(onGateStateChange).toHaveBeenCalled());
    const [complete, violations] = onGateStateChange.mock.calls.at(-1)!;
    expect(violations).toEqual(["controller_missing", "zone_missing"]);
    expect(complete).toBe(false);
  });
});
