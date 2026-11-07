import DOMPurify from "dompurify";
import { v4 } from "uuid";
import { tagWhitelist } from "../pluginSafeClass";

type TrackedEventListener = {
  eventTarget: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options: AddEventListenerOptions;
};
const pluginEventListeners: TrackedEventListener[] = [];

class SafeElement {
  #element: HTMLElement;
  #eventTarget: EventTarget; // Differs from #element for SafeDocument
  __classType = "REMOTE_REQUIRED" as const;

  constructor(element: HTMLElement, eventTarget?: EventTarget) {
    if (element.getAttribute("freezed")) {
      throw new Error("This element cannot be accessed by SafeELement");
    }

    this.#element = element;
    this.#eventTarget = eventTarget ?? element;
  }

  public appendChild(child: SafeElement) {
    this.#element.appendChild(child.#element);
  }

  public removeChild(child: SafeElement) {
    this.#element.removeChild(child.#element);
  }

  public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
    this.#element.replaceChild(newChild.#element, oldChild.#element);
  }

  public replaceWith(newElement: SafeElement) {
    this.#element.replaceWith(newElement.#element);
  }

  public cloneNode(deep: boolean = false): SafeElement {
    const cloned = this.#element.cloneNode(deep);
    return new SafeElement(cloned as HTMLElement);
  }

  public prepend(child: SafeElement) {
    this.#element.prepend(child.#element);
  }

  public remove() {
    this.#element.remove();
  }

  public innerText(): string {
    return this.#element.innerText;
  }

  public textContent(): string | null {
    return this.#element.textContent;
  }

  public setTextContent(value: string) {
    this.#element.textContent = value;
  }

  public setInnerText(value: string) {
    this.#element.innerText = value;
  }

  public setAttribute(name: string, value: string) {
    if (!name.startsWith("x-")) {
      throw new Error(
        "Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
      );
    }

    this.#element.setAttribute(name, value);
  }
  public getAttribute(name: string): string | null {
    if (!name.startsWith("x-")) {
      throw new Error(
        "Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.",
      );
    }

    return this.#element.getAttribute(name);
  }
  public setStyle(property: string, value: string) {
    Reflect.set(this.#element.style, property, value);
  }
  public getStyle(property: string): string {
    const value: unknown = Reflect.get(this.#element.style, property);
    return typeof value === "string" ? value : "";
  }
  public getStyleAttribute(): string {
    return this.#element.getAttribute("style") || "";
  }
  public setStyleAttribute(value: string) {
    this.#element.setAttribute("style", value);
  }
  public addClass(className: string) {
    //
    this.#element.classList.add(className);
  }
  public removeClass(className: string) {
    //
    this.#element.classList.remove(className);
  }
  public setClassName(className: string) {
    this.#element.className = className;
  }
  public getClassName() {
    return this.#element.className;
  }
  public hasClass(className: string): boolean {
    //We don't need to check the className here since we're just checking
    return this.#element.classList.contains(className);
  }
  public focus() {
    this.#element.focus();
  }
  public getChildren(): SafeClassArray<SafeElement> {
    const children: SafeElement[] = [];
    this.#element.childNodes.forEach((node) => {
      if (node instanceof HTMLElement) children.push(new SafeElement(node));
    });
    return new SafeClassArray<SafeElement>(children);
  }
  public getParent(): SafeElement | null {
    if (this.#element.parentElement) {
      return new SafeElement(this.#element.parentElement);
    }

    return null;
  }
  public getInnerHTML(): string {
    return this.#element.innerHTML;
  }
  public getOuterHTML(): string {
    return this.#element.outerHTML;
  }
  public clientHeight(): number {
    return this.#element.clientHeight;
  }
  public clientWidth(): number {
    return this.#element.clientWidth;
  }
  public clientTop(): number {
    return this.#element.clientTop;
  }
  public clientLeft(): number {
    return this.#element.clientLeft;
  }
  public nodeName(): string {
    return this.#element.nodeName;
  }
  public nodeType(): number {
    return this.#element.nodeType;
  }
  public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
    const nodeList = this.#element.querySelectorAll(selector);
    const elements: SafeElement[] = [];
    nodeList.forEach((node) => {
      if (node instanceof HTMLElement) elements.push(new SafeElement(node));
    });
    return new SafeClassArray<SafeElement>(elements);
  }
  public querySelector(selector: string): SafeElement | null {
    const element = this.#element.querySelector(selector);
    if (element instanceof HTMLElement) return new SafeElement(element);

    return null;
  }
  public getElementById(id: string): SafeElement | null {
    const element = this.querySelector("#" + id);
    return element;
  }
  public getElementsByClassName(
    className: string,
  ): SafeClassArray<SafeElement> {
    return this.querySelectorAll("." + className);
  }
  public getClientRects(): DOMRectList {
    return this.#element.getClientRects();
  }
  public getBoundingClientRect(): DOMRect {
    return this.#element.getBoundingClientRect();
  }
  public setInnerHTML(value: string) {
    const san = DOMPurify.sanitize(value);
    this.#element.innerHTML = san;
  }
  public setOuterHTML(value: string) {
    const san = DOMPurify.sanitize(value);
    this.#element.outerHTML = san;
  }
  public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
    this.#element.scrollIntoView(options);
  }
  #eventIdMap = new Map<string, TrackedEventListener>();

  public async addEventListener(
    type: string,
    listener: (event: {
      type: string;
      clientX?: number;
      clientY?: number;
      button?: number;
      buttons?: number;
      key?: string;
      code?: string;
      repeat?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      metaKey?: boolean;
    }) => void,
    options?: boolean | AddEventListenerOptions,
  ): Promise<string> {
    const realOptions =
      typeof options === "boolean" ? { capture: options } : options || {};

    //allowed with unlimited
    const allowedDocumentEventListeners = [
      "click",
      "dblclick",
      "contextmenu",
      "mousedown",
      "mouseup",
      "mousemove",
      "mouseover",
      "mouseleave",
      "pointercancel",
      "pointerdown",
      "pointerenter",
      "pointerleave",
      "pointermove",
      "pointerout",
      "pointerover",
      "pointerup",
      "scroll",
      "scrollend",
    ];

    //allowed, but it has fingerprinting issues,
    //so it will be delayed random ms.
    const allowedDelayedEventListeners = ["keydown", "keyup", "keypress"];

    const id = v4();

    const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
      if (event instanceof MouseEvent) {
        return {
          type: event.type,
          clientX: event.clientX,
          clientY: event.clientY,
          button: event.button,
          buttons: event.buttons,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        };
      } else if (event instanceof KeyboardEvent) {
        return {
          type: event.type,
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        };
      } else {
        return {
          type: event.type,
        };
      }
    };

    if (allowedDocumentEventListeners.includes(type)) {
      const modifiedListener = (event: Event) => {
        listener(trimEvent(event));
      };
      const tracked: TrackedEventListener = {
        eventTarget: this.#eventTarget,
        type,
        listener: modifiedListener as EventListenerOrEventListenerObject,
        options: realOptions,
      };
      this.#eventIdMap.set(id, tracked);
      pluginEventListeners.push(tracked);
      tracked.eventTarget.addEventListener(
        tracked.type,
        tracked.listener,
        tracked.options,
      );
      return id;
    } else if (allowedDelayedEventListeners.includes(type)) {
      const modifiedListener = (event: Event) => {
        // This jitter is not security-sensitive; Math.random avoids needless
        // cryptographic sampling and the modulo/scaling bias CodeQL warns about.
        const delay = Math.floor(Math.random() * 100); // 0-99 ms
        setTimeout(() => {
          listener(trimEvent(event));
        }, delay);
      };
      const tracked: TrackedEventListener = {
        eventTarget: this.#eventTarget,
        type,
        listener: modifiedListener as EventListenerOrEventListenerObject,
        options: realOptions,
      };
      this.#eventIdMap.set(id, tracked);
      pluginEventListeners.push(tracked);
      tracked.eventTarget.addEventListener(
        tracked.type,
        tracked.listener,
        tracked.options,
      );
      return id;
    } else {
      throw new Error(
        `Event listener of type '${type}' is not allowed for security reasons.`,
      );
    }
  }

  public removeEventListener(
    type: string,
    id: string,
    options?: boolean | EventListenerOptions,
  ) {
    void options;
    // type/options are unused, but are kept in the signature for API compatibility
    // DOM removal silently no-ops if type/capture don't exactly match the registration, so the stored record is replayed instead
    const tracked = this.#eventIdMap.get(id);
    if (tracked) {
      tracked.eventTarget.removeEventListener(
        tracked.type,
        tracked.listener,
        tracked.options,
      );
      const idx = pluginEventListeners.indexOf(tracked);
      if (idx !== -1) pluginEventListeners.splice(idx, 1);
      this.#eventIdMap.delete(id);
    }
  }

  public matches(selector: string): boolean {
    return this.#element.matches(selector);
  }
}

export class SafeDocument extends SafeElement {
  __classType = "REMOTE_REQUIRED" as const;
  constructor(document: Document) {
    // document-level events (including viewport scroll) are bound to the Document
    super(document.documentElement, document);
  }
  createElement(tagName: string): SafeElement {
    if (!tagWhitelist.includes(tagName.toLowerCase())) {
      console.warn(
        `Creation of <${tagName}> elements is restricted. Creating a <div> instead.`,
      );
      tagName = "div";
    }
    if (tagName.toLowerCase() === "a") {
      console.warn(
        `<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`,
      );
    }

    const element = document.createElement(tagName);
    return new SafeElement(element);
  }
  createAnchorElement(href: string): SafeElement {
    const anchor = document.createElement("a");
    try {
      const url = new URL(href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }

      anchor.setAttribute("href", url.toString());
    } catch {
      console.warn(
        `Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`,
      );
      anchor.setAttribute("href", "#");
    }
    return new SafeElement(anchor);
  }
}

type SafeMutationRecordObject = {
  type: string;
  target: SafeElement;
  addedNodes: SafeElement[];
};

class SafeClassArray<T> {
  #items: T[];
  __classType = "REMOTE_REQUIRED" as const;
  constructor(items: T[] = []) {
    this.#items = items;
  }
  at(index: number): T {
    return this.#items.at(index);
  }
  length(): number {
    return this.#items.length;
  }
  push(item: T) {
    this.#items.push(item);
  }
}

class SafeMutationRecord {
  __classType = "REMOTE_REQUIRED" as const;
  #type: string;
  #target: SafeElement;
  #addedNodes: SafeClassArray<SafeElement>;
  constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
    this.#type = type;
    this.#target = target;
    this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
  }
  getType(): string {
    return this.#type;
  }
  getTarget(): SafeElement {
    return this.#target;
  }
  getAddedNodes(): SafeClassArray<SafeElement> {
    return this.#addedNodes;
  }
}

export type SafeMutationCallback = (
  mutations: SafeClassArray<SafeMutationRecord>,
) => void;

export class SafeMutationObserver {
  #observer: MutationObserver;
  __classType = "REMOTE_REQUIRED" as const;
  constructor(callback: SafeMutationCallback) {
    this.#observer = new MutationObserver((mutations) => {
      const safeMutations: SafeMutationRecordObject[] = mutations.map(
        (mutation) => {
          const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
            const elements: SafeElement[] = [];
            nodeList.forEach((node) => {
              if (node instanceof HTMLElement) {
                elements.push(new SafeElement(node));
              }
            });
            return elements;
          };

          return {
            type: mutation.type,
            target: new SafeElement(mutation.target as HTMLElement),
            addedNodes: elementMapHelper(mutation.addedNodes),
            removedNodes: elementMapHelper(mutation.removedNodes),
          };
        },
      );

      const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
      for (const record of safeMutations) {
        safeClassed.push(
          new SafeMutationRecord(record.type, record.target, record.addedNodes),
        );
      }

      callback(safeClassed);
    });
  }

  observe(element: SafeElement, options: MutationObserverInit) {
    const identifier = v4();
    element.setAttribute("x-identifier", identifier);
    const rawElement = document.querySelector(
      `[x-identifier="${identifier}"]`,
    ) as HTMLElement;
    if (rawElement) {
      this.#observer.observe(rawElement, options);
      element.setAttribute("x-identifier", "");
    }
  }

  disconnect() {
    this.#observer.disconnect();
  }
}

export function clearPluginEventListeners(): void {
  for (const entry of pluginEventListeners) {
    entry.eventTarget.removeEventListener(
      entry.type,
      entry.listener,
      entry.options,
    );
  }

  pluginEventListeners.length = 0;
}
