/**
 * Sidebar and Bot List Layout Positioning Helper
 */

export interface SidebarLayoutOrder {
  botListOrder: number;
  sidebarPanelOrder: number;
  mainContentOrder: number;
}

/**
 * Computes the flex order values for Bot List rail, Sidebar Panel, and Main Content.
 *
 * @param sidebarRight Whether the sidebar panel is placed on the right side.
 * @param botListRight Whether the bot list rail is placed on the right side.
 * @param invertOrder When both elements are on the same side, whether to invert their inner/outer order.
 */
export function computeSidebarLayoutOrder(
  sidebarRight: boolean,
  botListRight: boolean,
  invertOrder: boolean = false,
): SidebarLayoutOrder {
  // Both on the left
  if (!sidebarRight && !botListRight) {
    if (invertOrder) {
      return { sidebarPanelOrder: 1, botListOrder: 2, mainContentOrder: 3 };
    }
    return { botListOrder: 1, sidebarPanelOrder: 2, mainContentOrder: 3 };
  }

  // Both on the right
  if (sidebarRight && botListRight) {
    if (invertOrder) {
      return { mainContentOrder: 1, botListOrder: 2, sidebarPanelOrder: 3 };
    }
    return { mainContentOrder: 1, sidebarPanelOrder: 2, botListOrder: 3 };
  }

  // Separated: sidebar left, bot list right
  if (!sidebarRight && botListRight) {
    return { sidebarPanelOrder: 1, mainContentOrder: 2, botListOrder: 3 };
  }

  // Separated: bot list left, sidebar right
  // (sidebarRight && !botListRight)
  return { botListOrder: 1, mainContentOrder: 2, sidebarPanelOrder: 3 };
}
