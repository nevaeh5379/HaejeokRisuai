// Shared look of the chat-binding buttons in the sidebar (PocketRisu's ShButton).
const base =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md text-base font-medium " +
  "bg-darkbutton text-textcolor border border-darkborderc hover:bg-selected " +
  "transition-colors cursor-pointer [&_svg]:shrink-0";

export const bindButtonClass = `${base} h-10 px-2.5 min-w-0`;
export const bindIconButtonClass = `${base} size-10 shrink-0 justify-center`;
export const bindUnsetClass = "text-textcolor2 opacity-75 hover:opacity-100";
export const bindSetClass = "border-selected";
