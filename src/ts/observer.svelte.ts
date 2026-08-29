import { globalFetch } from "./globalApi.svelte";

let bgmElement: HTMLAudioElement | null = null;
const observedNodes = new WeakSet<HTMLElement>();

function nodeObserve(node: HTMLElement) {
  if (observedNodes.has(node)) {
    return;
  }
  const hlLang = node.getAttribute("x-hl-lang");
  const ctrlName = node.getAttribute("risu-ctrl");
  if (!hlLang && !ctrlName) {
    return;
  }
  observedNodes.add(node);

  if (hlLang) {
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();

      const prevContextMenu = document.getElementById("code-contextmenu");
      if (prevContextMenu) {
        prevContextMenu.remove();
      }

      const menu = document.createElement("div");
      menu.id = "code-contextmenu";
      menu.setAttribute(
        "class",
        "fixed z-50 min-w-[160px] py-2 bg-gray-800 rounded-lg border border-gray-700",
      );

      const copyOption = document.createElement("div");
      copyOption.textContent = "Copy";
      copyOption.setAttribute(
        "class",
        "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer",
      );
      copyOption.addEventListener("click", () => {
        navigator.clipboard.writeText(node.textContent);
        menu.remove();
      });

      const downloadOption = document.createElement("div");
      downloadOption.textContent = "Download";
      downloadOption.setAttribute(
        "class",
        "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer",
      );
      downloadOption.addEventListener("click", () => {
        const a = document.createElement("a");
        const objectUrl = URL.createObjectURL(
          new Blob([node.textContent], { type: "text/plain" }),
        );
        a.href = objectUrl;
        a.download = "code." + hlLang;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        menu.remove();
      });

      menu.appendChild(copyOption);
      menu.appendChild(downloadOption);

      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";

      document.body.appendChild(menu);

      document.addEventListener(
        "click",
        () => {
          menu?.remove();
        },
        { once: true },
      );
    });
  }

  if (ctrlName) {
    const split = ctrlName.split("___");

    switch (split[0]) {
      case "bgm": {
        const volume = split[1] === "auto" ? 0.5 : parseFloat(split[1]);
        if (!bgmElement) {
          bgmElement = new Audio(split[2]);
          bgmElement.volume = volume;
          bgmElement.addEventListener("ended", () => {
            bgmElement.remove();
            bgmElement = null;
          });
          bgmElement.play();
        }
        break;
      }
    }
  }
}

export function startObserveDom() {
  //For codeblock we are using MutationObserver since it doesn't appear well
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof HTMLElement
      ) {
        nodeObserve(mutation.target);
      }
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          nodeObserve(node);
          node
            .querySelectorAll<HTMLElement>("[x-hl-lang], [risu-ctrl]")
            .forEach(nodeObserve);
        }
      });
    });
  });

  document
    .querySelectorAll<HTMLElement>("[x-hl-lang], [risu-ctrl]")
    .forEach(nodeObserve);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["x-hl-lang", "risu-ctrl"],
  });
}

let claudeObserverRunning = false;
let lastClaudeObserverLoad = 0;
let lastClaudeRequestTimes = 0;
let lastClaudeObserverPayload: any = null;
let lastClaudeObserverHeaders: any = null;
let lastClaudeObserverURL: any = null;

export function registerClaudeObserver(arg: {
  url: string;
  body: any;
  headers: any;
}) {
  lastClaudeRequestTimes = 0;
  lastClaudeObserverLoad = Date.now();
  lastClaudeObserverPayload = safeStructuredClone(arg.body);
  lastClaudeObserverHeaders = arg.headers;
  lastClaudeObserverURL = arg.url;
  lastClaudeObserverPayload.max_tokens = 10;
  claudeObserver();
}

function claudeObserver() {
  if (claudeObserverRunning) {
    return;
  }
  claudeObserverRunning = true;

  const fetchIt = async (tries = 0) => {
    const res = await globalFetch(lastClaudeObserverURL, {
      body: lastClaudeObserverPayload,
      headers: lastClaudeObserverHeaders,
      method: "POST",
    });
    if (res.status >= 400) {
      if (tries < 3) {
        fetchIt(tries + 1);
      }
    }
  };

  const func = () => {
    //request every 4 minutes and 30 seconds
    if (lastClaudeObserverLoad > Date.now() - 1000 * 60 * 4.5) {
      return;
    }

    if (lastClaudeRequestTimes > 4) {
      return;
    }
    fetchIt();
    lastClaudeObserverLoad = Date.now();
    lastClaudeRequestTimes += 1;
  };

  setInterval(func, 20000);
}
