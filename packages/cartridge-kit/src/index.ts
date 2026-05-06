/**
 * @ai-ro/cartridge-kit — the cartridge contract.
 *
 * The highest-stakes API surface in airo-js. Phase 0 work unit 4 designs
 * `Cartridge<TSchema, TConfig>` here and validates it against two skeletons
 * (Dotter-WTB + Restaurant) before any 1.0 commitment. See the migration
 * plan §Phase 0 work unit 4 for the contract sketch.
 *
 * Concept overview:
 *
 *   interface Cartridge<TSchema, TConfig> {
 *     id: string                               // 'wtb' | 'restaurant' | ...
 *     industry: string
 *     displayName: string
 *     description: string
 *     icon: string                             // emoji or asset URL
 *
 *     schema: SchemaDefinition<TSchema>        // Zod / JSON-Schema
 *     dataSources: DataSourceAdapter[]         // PDF, CSV, POS, MLS, …
 *     views: ViewDefinition[]                  // Menu, Grid, Carousel, Map
 *     templates: Template[]                    // pre-composed (cartridge, view-set, default config)
 *     mcpTools: McpToolDefinition[]
 *     jsonLdMappers: JsonLdMapper[]            // schema.org generators
 *     onboardingFlow?: OnboardingStep[]
 *
 *     defaultConfig: TConfig
 *     defaultTemplateId: string
 *   }
 *
 * The skeletons live in `examples/cartridge-wtb-skeleton` and
 * `examples/cartridge-restaurant-skel` (created in Phase 0 wu#4).
 */

export const PACKAGE_NAME = '@ai-ro/cartridge-kit';
