// scrollIntoView walks every scrollable ancestor and can move the page
// itself. This scrolls only the given container.
export function scrollWithinContainer(
  el: HTMLElement,
  container: HTMLElement,
  options: { block: "start" | "end"; behavior: ScrollBehavior },
) {
  const elRect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset =
    options.block === "start"
      ? elRect.top - containerRect.top
      : elRect.bottom - containerRect.bottom;
  container.scrollTo({
    top: container.scrollTop + offset,
    behavior: options.behavior,
  });
}
