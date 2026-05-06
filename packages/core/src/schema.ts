/**
 * Declarative app schema. Defines the shape of an App and the trees of
 * Pages, Regions, Slots, and Components inside it.
 *
 * Composite + Slot pattern: a `Page` is a tree (regions → slots → components).
 * The structure is uniform — every node has `id`, `visible`, and ordering
 * context — so traversal code (drag-reorder, visibility toggles, prop
 * overrides) walks one shape regardless of nesting depth.
 *
 * Generic over the consumer's identifier types so a domain app can narrow
 * `PageType` and `ComponentType` to its own enums without losing the
 * framework's structural guarantees.
 */
export type PageId = string;

/**
 * Per-component overrides keyed by the slot's `componentId`. Non-structural
 * data the renderer reads at paint time (visibility, custom props, inline
 * style overrides). Persisted in the App config; live-edits in a studio
 * UI rewrite this without touching the page or template structure.
 */
export interface ComponentSettings<TProps = Record<string, unknown>> {
  visible?: boolean;
  props?: Partial<TProps>;
  styles?: Record<string, string | number>;
}

/**
 * A single placement of a registered component into a region. The slot id
 * identifies this placement (so two `productGrid` instances in the same
 * region are distinguishable); `componentId` resolves to a registered
 * component factory.
 */
export interface Slot {
  id: string;
  order: number;
  componentId: string;
  visible: boolean;
  props?: Record<string, unknown>;
  styles?: Record<string, string | number>;
}

/**
 * A region groups slots and gives them a paint target. Pages declare which
 * regions they expose via `regionOrder`; the renderer paints regions in
 * that order so a template can dictate "header above content above footer"
 * without the page configs encoding that ordering themselves.
 */
export interface Region {
  id: string;
  components: Slot[];
}

/**
 * The slot/grid template for a page. Defines the structural shape (which
 * regions exist and in what order) without committing to specific
 * components — the same template hosts many pages of the same `type`.
 */
export interface PageLayout {
  regionOrder: string[];
  regions: Record<string, Region>;
  splits?: Record<string, number>;
}

/**
 * A single page in the app. `type` selects which PageRenderer factory
 * paints this page; `layout` is the slot tree the renderer walks; `parent`
 * marks subpages (modals, drawers) that activate over a parent page rather
 * than swap the active renderer.
 */
export interface Page<TPageType extends string = string> {
  id: PageId;
  type: TPageType;
  enabled: boolean;
  layout: PageLayout;
  props?: Record<string, unknown>;
  styles?: Record<string, string | number>;
  componentSettings?: Record<string, ComponentSettings>;
  parent?: PageId;
}

/**
 * The root config for an App. Pages are an *ordered* array (drag-reorder
 * matters; first enabled non-subpage is the entry). Theme tokens, if
 * present, are applied to the render root as CSS variables before the
 * first page paints.
 */
export interface AppConfig<TPageType extends string = string> {
  appId: string;
  pages: Page<TPageType>[];
  theme?: Record<string, string | number>;
  styleIsolation?: 'none' | 'partial' | 'full';
}
