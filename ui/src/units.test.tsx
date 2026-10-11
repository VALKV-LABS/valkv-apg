import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { type Json, formatBytes, formatNumber, relativeTime, withQuery } from "./api";
import { byBucket } from "./components/chart";
import { SchemaForm, Schemas, shownPointers } from "./components/schema-form";
import { toCsv } from "./pages/usage";
import { realSchemas } from "./test-server";
import { inkFor } from "./theme";

const real = realSchemas();
const schemas = new Schemas([...real.resources, ...real.plugins.map((p) => ({ path: `plugins/${p["name"]}.json`, schema: p["schema"] as Json }))]);

function Form({ path, initial, faults = [], pointer = "" }: { path: string; initial: Json; faults?: Array<{ pointer: string; message: string }>; pointer?: string }) {
  const [value, setValue] = useState<Json>(initial);
  return (
    <>
      <SchemaForm schemas={schemas} schemaPath={path} value={value} onChange={setValue} faults={faults} pointer={pointer} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByTestId("value").textContent!) as Json;

describe("schema-driven forms", () => {
  it("resolves references between schema files", () => {
    const route = schemas.get("resources/route.json")!;
    const name = schemas.resolve(route["properties"]["name"], "resources/route.json");
    expect(name.schema["pattern"]).toBe("^[a-z0-9][a-z0-9._-]{0,127}$");
    expect(name.base).toBe("common.json");
    expect(schemas.resolve({ $ref: "nowhere.json" }, "resources/route.json").schema).toEqual({});
  });

  it("draws a control for every field of every resource the server knows, without failing", () => {
    for (const { path } of real.resources.filter((r) => r.path.startsWith("resources/"))) {
      const { unmount } = render(<Form path={path} initial={{}} />);
      unmount();
    }
    for (const p of real.plugins) {
      const { unmount } = render(<Form path={`plugins/${p["name"]}.json`} initial={{}} />);
      unmount();
    }
  });

  it("leaves out what the server manages, and labels every control", () => {
    render(<Form path="resources/service.json" initial={{ id: "x", revision: 2, name: "orders", backends: [{ id: "b", target: "a:1" }] }} />);
    for (const hidden of ["Id", "Revision", "Created at", "Workspace id"]) expect(screen.queryByLabelText(hidden)).not.toBeInTheDocument();
    for (const control of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("combobox"), ...screen.getAllByRole("spinbutton")]) {
      expect(control).toHaveAccessibleName();
    }
  });

  it("edits scalars, enumerations, numbers, switches and lists", async () => {
    const user = userEvent.setup();
    render(<Form path="resources/service.json" initial={{ name: "orders", backends: [{ target: "a:1" }] }} />);
    await user.selectOptions(screen.getByLabelText(/^Scheme/), "https");
    await user.click(screen.getByRole("button", { name: "Add backend" }));
    const targets = screen.getAllByLabelText(/^Target/);
    await user.type(targets[1]!, "b:2");
    const weights = screen.getAllByLabelText(/^Weight/);
    await user.type(weights[1]!, "3");
    expect(value()).toEqual({ name: "orders", scheme: "https", backends: [{ target: "a:1" }, { target: "b:2", weight: 3 }] });

    await user.click(screen.getByRole("button", { name: "Remove Backends 1" }));
    expect(value()["backends"]).toEqual([{ target: "b:2", weight: 3 }]);
    // Clearing a field removes the key; the server then applies its default.
    await user.selectOptions(screen.getByLabelText(/^Scheme/), "");
    expect(value()).not.toHaveProperty("scheme");
  });

  it("follows the branch a type selects", async () => {
    const user = userEvent.setup();
    render(<Form path="resources/credential.json" initial={{ type: "key" }} />);
    expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Type/), "basic");
    expect(screen.getByLabelText(/^Username/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Type/), "mtls");
    expect(screen.getByLabelText(/^Identity/)).toBeInTheDocument();
  });

  it("edits shapes with no natural control as JSON, and only passes on text that parses", () => {
    render(<Form path="resources/route.json" initial={{ name: "r", service: "s" }} />);
    const paths = screen.getByLabelText(/^Paths/);
    fireEvent.change(paths, { target: { value: '["/a", {"type": "regex"' } });
    expect(screen.getByText("This is not valid JSON yet.")).toBeInTheDocument();
    expect(value()).not.toHaveProperty("paths");
    fireEvent.change(paths, { target: { value: '["/a", {"type": "regex", "value": "/o/[0-9]+"}]' } });
    expect(value()["paths"]).toEqual(["/a", { type: "regex", value: "/o/[0-9]+" }]);
  });

  it("offers a choice for a field that names another resource, by name, and keeps a value it does not know", async () => {
    const user = userEvent.setup();
    function Chooser({ initial }: { initial: Json }) {
      const [v, setV] = useState<Json>(initial);
      return <><SchemaForm schemas={schemas} schemaPath="resources/route.json" value={v} onChange={setV} choices={{ service: [{ value: "id-1", label: "orders" }, { value: "id-2", label: "billing" }] }} /><output data-testid="value">{JSON.stringify(v)}</output></>;
    }
    const { unmount } = render(<Chooser initial={{ name: "r", service: "id-1" }} />);
    const select = screen.getByLabelText(/^Service/) as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toBe("orders");
    await user.selectOptions(select, "billing");
    expect(value()["service"]).toBe("id-2");
    unmount();
    render(<Chooser initial={{ name: "r", service: "a-shared-service" }} />);
    expect((screen.getByLabelText(/^Service/) as HTMLSelectElement).value).toBe("a-shared-service");
  });

  it("places the server's faults by pointer, under a prefix when asked", () => {
    render(<Form path="plugins/rate_limit.json" initial={{ per_second: -1 }} pointer="/config" faults={[{ pointer: "/config/per_second", message: "must be >= 1" }]} />);
    const field = screen.getByLabelText(/^Per second/);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(expect.stringContaining("must be >= 1"));
    expect(shownPointers([{ pointer: "/config/per_second", message: "" }, { pointer: "/scope_ref", message: "" }], { per_second: -1 }, "/config")).toEqual(["/config/per_second"]);
  });

  it("puts a fault inside a JSON-edited value on that value", () => {
    render(<Form path="resources/route.json" initial={{ name: "r", service: "s", paths: ["orders"] }} faults={[{ pointer: "/paths/0/value", message: "a path must start with '/'" }]} />);
    expect(within(screen.getByLabelText(/^Paths/).closest(".field") as HTMLElement).getByText("/0/value: a path must start with '/'")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("builds queries without empty values, repeating a key for a list", () => {
    expect(withQuery("/v1/x", { a: "1", b: "", c: undefined, d: ["x", "y"], e: 0, f: false })).toBe("/v1/x?a=1&d=x&d=y&e=0&f=false");
    expect(withQuery("/v1/x", {})).toBe("/v1/x");
  });

  it("formats numbers, sizes and times for reading", () => {
    expect([formatNumber(999), formatNumber(12_345), formatNumber(2_500_000), formatNumber(3.14159)]).toEqual(["999", "12.3k", "2.5M", "3.14"]);
    expect([formatBytes(512), formatBytes(2048), formatBytes(5 * 1024 ** 3)]).toEqual(["512 B", "2.0 KB", "5.0 GB"]);
    const now = Date.parse("2026-06-01T12:00:00Z");
    expect(relativeTime("2026-06-01T11:57:00Z", now)).toBe("3 minutes ago");
    expect(relativeTime("2026-06-13T12:00:00Z", now)).toBe("in 12 days");
    expect(relativeTime("2026-06-01T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeTime(null)).toBe("never");
  });

  it("quotes CSV so a name with a comma or a quote stays one cell", () => {
    expect(toCsv([{ route: 'orders, "v2"', requests: 5 }], ["route", "requests"])).toBe('route,requests\r\n"orders, ""v2""","5"\r\n');
  });

  it("sums usage rows into one point per bucket, in time order", () => {
    expect(byBucket([
      { bucket: "2026-01-01T01:00:00Z", requests: 5, status_5xx: 1 },
      { bucket: "2026-01-01T00:00:00Z", requests: 2, status_5xx: 0 },
      { bucket: "2026-01-01T01:00:00Z", requests: 3, status_5xx: 2 },
    ])).toEqual([{ label: "2026-01-01T00:00:00Z", value: 2, errors: 0 }, { label: "2026-01-01T01:00:00Z", value: 8, errors: 3 }]);
  });

  it("picks the ink that reads on an accent colour", () => {
    expect(inkFor("#0f766e")).toBe("#ffffff");
    expect(inkFor("#facc15")).toBe("#0b0d12");
  });
});
