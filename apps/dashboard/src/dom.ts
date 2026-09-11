/**
 * The few DOM helpers this page needs. Elements are built, never parsed from
 * strings, so nothing the gateway or a provider returns can become markup.
 */

type Child = Node | string | undefined | false;

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes: Readonly<Record<string, string | undefined>> = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    if (name === 'class') {
      node.className = value;
      continue;
    }
    node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === undefined || child === false) {
      continue;
    }
    node.append(child);
  }
  return node;
}

export const text = (content: string): Text => document.createTextNode(content);

export function replaceChildren(target: Element, children: readonly Child[]): void {
  target.replaceChildren(
    ...children.filter((child): child is Node | string => child !== undefined && child !== false),
  );
}

export function requireElement<Tag extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: string,
  tag: Tag,
): HTMLElementTagNameMap[Tag] {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement) || found.tagName.toLowerCase() !== tag) {
    throw new Error(`The page is missing ${selector}.`);
  }
  return found as HTMLElementTagNameMap[Tag];
}

export const formatMoment = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
};

/**
Elapsed time from a payment's creation, as a screen clock.
*/
export const formatSince = (origin: string, moment: string): string => {
  const milliseconds = Math.max(0, Date.parse(moment) - Date.parse(origin));
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `+${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
};
