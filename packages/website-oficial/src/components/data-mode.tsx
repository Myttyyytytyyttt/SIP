"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Which numbers the dashboard is showing. */
export type DataMode = "live" | "mock";

export function isDataMode(value: string): value is DataMode {
  return value === "live" || value === "mock";
}

/**
 * LIVE OR MOCK, said in the one place a person looks for a setting.
 *
 * Deliberately the same control as the chart's 30d/90d range (pension-chart.tsx):
 * a two-state segmented Tabs, whose TabsList is h-8 -- exactly the height of the
 * ModeToggle button it sits beside, so the header's right cluster stays one row
 * of equal things rather than a row of near-misses.
 *
 * IT SETS THE INTENT, IT DOES NOT MAKE THE CLAIM. A toggle shows a position, and
 * a position is not a statement about whose money is on screen. What says that is
 * DashboardSource, which reads the RENDERED payload's own `source` and therefore
 * cannot disagree with what is actually being drawn. If this control ever becomes
 * the thing that decides the badge, the two can drift, and the drift is somebody
 * mistaking a seeded example for their pension.
 */
export function DataModeToggle({
  mode,
  onModeChange,
  disabled = false,
}: {
  mode: DataMode;
  onModeChange: (mode: DataMode) => void;
  /** No pension key connected: there is nothing Live could be. */
  disabled?: boolean;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => {
        if (isDataMode(value)) onModeChange(value);
      }}
    >
      <TabsList aria-label="Data source">
        <TabsTrigger value="live" disabled={disabled}>
          Live
        </TabsTrigger>
        <TabsTrigger value="mock">Mock</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
