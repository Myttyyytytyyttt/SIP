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
/**
 * NEITHER SIDE IS EVER DISABLED NOW. Live is a real destination whether or not a
 * wallet is connected: without one it shows an honest "connect your pension key"
 * card. A greyed-out Live was only ever true while there was no live panel at
 * all, and a control that cannot be used teaches people to stop looking at it.
 *
 * When a pension key IS connected this control is not rendered at all — the
 * dashboard is Live, and offering to switch away from someone's own pension to a
 * stranger's example is not a choice worth offering (src/lib/dashboard-mode.ts).
 */
export function DataModeToggle({ mode, onModeChange }: { mode: DataMode; onModeChange: (mode: DataMode) => void }) {
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => {
        if (isDataMode(value)) onModeChange(value);
      }}
    >
      <TabsList aria-label="Data source">
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="mock">Mock</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
