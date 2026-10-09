import type { Widget } from "./types";

// Promoted subgraph widgets are registered during loading and released by the
// root graph on completion or failure. This module does not import the runtime.
const widgetValues = new Map<string, Widget>();
export const widgetValueStore = {
  getWidget: (id: string) => widgetValues.get(id),
  setWidget: (id: string, widget: Widget) => {
    widgetValues.set(id, widget);
  },
  deleteWidget: (id: string) => {
    widgetValues.delete(id);
  },
};
