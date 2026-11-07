import { type PluginPermission } from "../pluginPermissionCache";
import DOMPurify from "dompurify";
import {
  additionalChatMenu,
  additionalFloatingActionButtons,
  additionalHamburgerMenu,
  additionalSettingsMenu,
  bodyIntercepterStore,
  chatPanelStore,
  type MenuDef,
} from "src/ts/stores.svelte";
import { v4 } from "uuid";

const makeMenuUnloadCallback = (menuId: string, menuStore: MenuDef[]) => {
  return () => {
    const index = menuStore.findIndex((item) => item.id === menuId);
    if (index !== -1) menuStore.splice(index, 1);
  };
};

const removeChatPanel = (id: string) => {
  const index = chatPanelStore.findIndex((item) => item.id === id);
  if (index !== -1) chatPanelStore.splice(index, 1);
};

const removePluginChatPanels = (pluginName: string) => {
  for (let i = chatPanelStore.length - 1; i >= 0; i--) {
    if (chatPanelStore[i].pluginName === pluginName) {
      chatPanelStore.splice(i, 1);
    }
  }
};

export function createPluginUi(
  pluginName: string,
  onUnload: (callback: () => void | Promise<void>) => void,
  getPermission: (permission: PluginPermission) => Promise<boolean>,
) {
  return {
    registerSetting: (
      name: string,
      callback: () => void | Promise<void>,
      icon: string = "",
      iconType: "html" | "img" | "none" = "none",
      id?: string,
    ) => {
      if (iconType !== "html" && iconType !== "img" && iconType !== "none") {
        throw new Error("iconType must be 'html', 'img' or 'none'");
      }

      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("name must be a non-empty string");
      }

      const menuId = id || v4();
      const menuDef: MenuDef = {
        id: menuId,
        name,
        icon,
        iconType,
        callback,
      };
      const existingIndex = additionalSettingsMenu.findIndex(
        (item) => item.id === menuId,
      );
      if (existingIndex !== -1) {
        additionalSettingsMenu[existingIndex] = menuDef;
        onUnload(makeMenuUnloadCallback(menuId, additionalSettingsMenu));
        return { id: menuId };
      }
      additionalSettingsMenu.push(menuDef);
      onUnload(makeMenuUnloadCallback(menuId, additionalSettingsMenu));
      return { id: menuId };
    },
    registerBodyIntercepter: async (
      callback: (
        body: Record<string, unknown>,
        type: string,
      ) => unknown | Promise<unknown>,
    ) => {
      if ((await getPermission("replacer")) === false) return null;

      const id = v4();
      bodyIntercepterStore.push({
        id,
        callback: async (body, type) => callback(body, type),
      });
      onUnload(() => {
        const index = bodyIntercepterStore.findIndex((item) => item.id === id);
        if (index !== -1) bodyIntercepterStore.splice(index, 1);
      });
      return { id: id };
    },
    unregisterBodyIntercepter: (id: string) => {
      const index = bodyIntercepterStore.findIndex((item) => item.id === id);
      if (index !== -1) bodyIntercepterStore.splice(index, 1);
    },
    registerButton: (
      arg: {
        name: string;
        icon: string;
        iconType: "html" | "img" | "none";
        location?: "action" | "chat" | "hamburger";
        id?: string;
      },
      callback: () => void,
    ) => {
      const { name, icon, iconType, id: providedId } = arg;
      const location = arg.location || "action";
      if (iconType !== "html" && iconType !== "img" && iconType !== "none") {
        throw new Error("iconType must be 'html', 'img' or 'none'");
      }

      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("name must be a non-empty string");
      }

      if (typeof icon !== "string") throw new Error("icon must be a string");

      const id = providedId || v4();
      const menuDef: MenuDef = {
        name,
        icon,
        iconType,
        callback,
        id,
      };

      const buttonStores = [
        additionalFloatingActionButtons,
        additionalHamburgerMenu,
        additionalChatMenu,
      ];
      for (const store of buttonStores) {
        const existingIndex = store.findIndex((item) => item.id === id);
        if (existingIndex !== -1) {
          store[existingIndex] = menuDef;
          onUnload(makeMenuUnloadCallback(id, store));
          return { id };
        }
      }

      switch (location) {
        case "action": {
          additionalFloatingActionButtons.push(menuDef);
          onUnload(
            makeMenuUnloadCallback(menuDef.id, additionalFloatingActionButtons),
          );
          break;
        }
        case "hamburger": {
          additionalHamburgerMenu.push(menuDef);
          onUnload(makeMenuUnloadCallback(menuDef.id, additionalHamburgerMenu));
          break;
        }
        case "chat": {
          additionalChatMenu.push(menuDef);
          onUnload(makeMenuUnloadCallback(menuDef.id, additionalChatMenu));
          break;
        }
        default: {
          throw new Error("Invalid location for button");
        }
      }
      return { id };
    },
    setChatPanel: (
      content: string | null,
      options: {
        id?: string;
        className?: string;
      } = {},
    ) => {
      const id = options.id || `${pluginName}:default`;

      if (content === null || content === "") {
        removeChatPanel(id);
        return { id };
      }

      if (typeof content !== "string") {
        throw new Error("content must be a string or null");
      }

      const panel = {
        id,
        pluginName: pluginName,
        html: DOMPurify.sanitize(content),
        className:
          typeof options.className === "string"
            ? DOMPurify.sanitize(options.className, {
                ALLOWED_TAGS: [],
                ALLOWED_ATTR: [],
              })
            : undefined,
      };

      const existingIndex = chatPanelStore.findIndex((item) => item.id === id);
      if (existingIndex !== -1) chatPanelStore[existingIndex] = panel;
      else chatPanelStore.push(panel);

      onUnload(() => removePluginChatPanels(pluginName));
      return { id };
    },
    unregisterUIPart: (id: string) => {
      const removeFromMenuStore = (menuStore: MenuDef[]) => {
        const index = menuStore.findIndex((item) => item.id === id);
        if (index !== -1) menuStore.splice(index, 1);
      };

      removeFromMenuStore(additionalSettingsMenu);
      removeFromMenuStore(additionalFloatingActionButtons);
      removeFromMenuStore(additionalHamburgerMenu);
      removeFromMenuStore(additionalChatMenu);
      removeChatPanel(id);
    },
  };
}
