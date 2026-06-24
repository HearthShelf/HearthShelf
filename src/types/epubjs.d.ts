// Ambient types for epubjs (the package ships no declarations and there is no
// @types/epubjs). This covers only the surface HearthShelf's reader uses.
declare module 'epubjs' {
  export interface NavItem {
    id: string
    href: string
    label: string
    subitems?: NavItem[]
  }

  export interface Navigation {
    toc: NavItem[]
    get(target: string): NavItem | undefined
  }

  export interface Locations {
    generate(chars?: number): Promise<string[]>
    cfiFromPercentage(percentage: number): string
    percentageFromCfi(cfi: string): number
  }

  export interface Themes {
    override(name: string, value: string, priority?: boolean): void
    fontSize(size: string): void
    font(family: string): void
    // Register a default theme from a CSS-rules object (selector -> declarations).
    // Injected into the rendered content iframe's stylesheet.
    default(rules: Record<string, Record<string, string | number>>): void
  }

  export interface RelocatedLocation {
    start: { cfi: string; href: string; percentage?: number }
    end: { cfi: string; href: string; percentage?: number }
  }

  export interface RenditionOptions {
    width?: string | number
    height?: string | number
    flow?: 'paginated' | 'scrolled' | 'scrolled-doc' | 'scrolled-continuous'
    spread?: 'none' | 'always' | 'auto'
    allowScriptedContent?: boolean
  }

  export interface Rendition {
    themes: Themes
    display(target?: string): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    destroy(): void
    on(event: 'relocated', handler: (location: RelocatedLocation) => void): void
    on(event: string, handler: (...args: unknown[]) => void): void
  }

  export interface Book {
    ready: Promise<void>
    navigation: Navigation
    locations: Locations
    renderTo(element: Element | string, options?: RenditionOptions): Rendition
    destroy(): void
  }

  export default function ePub(input?: ArrayBuffer | string): Book
}
