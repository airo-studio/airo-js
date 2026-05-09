/**
 * Tests for the editor-schema types — `ComponentSchema<TStyles>`,
 * `PropSchema`, `PageSchema`, `ThemeSchema`, and `Cartridge<>`'s third
 * generic parameter.
 *
 * Most assertions here are type-level: the editor-schema module is pure
 * types, so the test surface is "do real cartridge declarations
 * typecheck cleanly?" The runtime assertions confirm the literal values
 * round-trip.
 */

import { describe, expect, expectTypeOf, test } from 'vitest';

import type { Cartridge } from '../src/cartridge.js';
import type {
  ChangeScope,
  ComponentSchema,
  FieldType,
  PageSchema,
  PropSchema,
  ThemeSchema,
  TokenDef,
  TokenSection,
} from '../src/editor-schema.js';
import {
  defineStyleSurface,
  type StyleValuesOf,
} from '../src/style-surface.js';

describe('PropSchema', () => {
  test('changeScope is non-optional', () => {
    const prop: PropSchema = {
      type: 'boolean',
      label: 'Enabled',
      default: true,
      changeScope: 'instance',
    };
    expect(prop.changeScope).toBe('instance');

    // @ts-expect-error — missing required `changeScope` field.
    const _bad: PropSchema = {
      type: 'boolean',
      label: 'Enabled',
      default: true,
    };
  });

  test('accepts the documented core FieldType set', () => {
    const types: ReadonlyArray<FieldType> = [
      'boolean',
      'string',
      'number',
      'enum',
      'color',
      'cssLength',
      'css',
      'textarea',
    ];
    expect(types).toHaveLength(8);
  });

  test('accepts cartridge-specific kinds as first-class extensions', () => {
    const prop: PropSchema = {
      type: 'attribute',
      label: 'Source attribute',
      default: 'attributes.name',
      changeScope: 'page',
    };
    expect(prop.type).toBe('attribute');
  });

  test('ChangeScope values are exactly instance / page / app', () => {
    const scopes: ReadonlyArray<ChangeScope> = ['instance', 'page', 'app'];
    expect(scopes).toEqual(['instance', 'page', 'app']);
  });
});

describe('ComponentSchema<TStyles>', () => {
  const appStyles = defineStyleSurface({
    background: { kind: 'color', default: '#ffffff' },
    textColor: { kind: 'color', default: '#111111' },
    padding: { kind: 'cssLength', default: '0' },
  } as const);
  type AppStyles = StyleValuesOf<typeof appStyles>;

  test('typechecks styles.allowed against the cartridge style surface', () => {
    const schema: ComponentSchema<AppStyles> = {
      id: 'productTitle',
      label: 'Product Title',
      icon: 'Type',
      category: 'content',
      props: {},
      styles: { allowed: ['textColor', 'padding'] },
    };
    expect(schema.styles.allowed).toContain('textColor');
  });

  test('rejects style keys not in the surface (compile-time guard)', () => {
    // @ts-expect-error — `fontSize` is not a key on AppStyles.
    const _bad: ComponentSchema<AppStyles> = {
      id: 'productTitle',
      label: 'Product Title',
      icon: 'Type',
      category: 'content',
      props: {},
      styles: { allowed: ['fontSize'] },
    };
    expect(true).toBe(true);
  });

  test('accepts inline.parent and required + availableOnPages', () => {
    const schema: ComponentSchema<AppStyles> = {
      id: 'locationButton',
      label: 'Location Button',
      icon: 'Navigation',
      category: 'navigation',
      required: false,
      inline: { parent: 'searchBox' },
      props: {
        enabled: {
          type: 'boolean',
          label: 'Show',
          default: true,
          changeScope: 'instance',
          category: 'behaviour',
        },
      },
      styles: { allowed: ['textColor'] },
      availableOnPages: ['storeFinder'],
    };
    expect(schema.inline?.parent).toBe('searchBox');
    expect(schema.availableOnPages).toEqual(['storeFinder']);
  });

  test('TStyles defaults to unknown (back-compat for cartridges without a surface)', () => {
    // Without the generic, `styles.allowed` accepts any string array.
    const schema: ComponentSchema = {
      id: 'legacy',
      label: 'Legacy',
      icon: 'Box',
      category: 'misc',
      props: {},
      styles: { allowed: ['anyKey', 'anotherKey'] },
    };
    expect(schema.styles.allowed).toHaveLength(2);
  });
});

describe('PageSchema', () => {
  test('mirrors the component prop+styles shape with a free-string allowed list', () => {
    const schema: PageSchema = {
      id: 'product',
      label: 'Product',
      props: {
        imagePosition: {
          type: 'enum',
          label: 'Image position',
          default: 'left',
          changeScope: 'page',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ],
        },
      },
      styles: { allowed: ['background', 'padding', 'maxWidth'] },
    };
    expect(schema.props.imagePosition?.changeScope).toBe('page');
  });
});

describe('ThemeSchema', () => {
  test('accepts flat token sections (perMode default false)', () => {
    const section: TokenSection = {
      id: 'styleOptions',
      displayName: 'Style Options',
      tokens: [
        {
          cssVar: '--airo-border-radius',
          kind: 'cssLength',
          default: '12px',
          min: 0,
          max: 24,
          step: 1,
        },
      ],
    };
    expect(section.perMode).toBeUndefined();
  });

  test('accepts perMode sections with Record-typed defaults', () => {
    const token: TokenDef = {
      cssVar: '--airo-color-primary',
      kind: 'color',
      default: { light: '#F2800D', dark: '#F2800D' },
    };
    const section: TokenSection = {
      id: 'brand',
      displayName: 'Brand Colors',
      perMode: true,
      tokens: [token],
    };
    expect(section.perMode).toBe(true);
    expect((section.tokens[0]!.default as Record<string, string>).light).toBe('#F2800D');
  });

  test('ThemeSchema groups by app / page / component', () => {
    const theme: ThemeSchema = {
      app: [],
      page: [],
      component: [],
    };
    expectTypeOf(theme).toHaveProperty('app');
    expectTypeOf(theme).toHaveProperty('page');
    expectTypeOf(theme).toHaveProperty('component');
  });
});

describe('Cartridge<TData, TConfig, TStyles>', () => {
  const appStyles = defineStyleSurface({
    background: { kind: 'color', default: '#ffffff' },
  } as const);
  type AppStyles = StyleValuesOf<typeof appStyles>;

  test('accepts componentSchema typed against the style surface', () => {
    const cartridge: Cartridge<unknown, unknown, AppStyles> = {
      id: 'demo',
      industry: 'demo',
      displayName: 'Demo',
      description: 'Demo cartridge fixture.',
      version: '0.0.0',
      schema: {
        parse: (input) => input,
        safeParse: (input) => ({ success: true as const, data: input }),
      },
      dataSources: [],
      views: [],
      templates: [],
      defaultConfig: {},
      defaultTemplateId: 'main',
      mailboxName: '__AIRO_DEMO_PAGES__',
      componentSchema: {
        productTitle: {
          id: 'productTitle',
          label: 'Product Title',
          icon: 'Type',
          category: 'content',
          props: {},
          styles: { allowed: ['background'] },
        },
      },
      themeSchema: {
        app: [],
        page: [],
        component: [],
      },
    };
    expect(cartridge.componentSchema?.productTitle?.id).toBe('productTitle');
    expect(cartridge.themeSchema).toBeDefined();
  });

  test('legacy two-arg Cartridge<TData, TConfig> stays valid (TStyles defaults to unknown)', () => {
    // This compiles — the third generic defaults to unknown, so existing
    // call sites in runtime / ssr / embed don't need to change.
    const legacy: Cartridge<unknown, unknown> = {
      id: 'legacy',
      industry: 'misc',
      displayName: 'Legacy',
      description: 'Legacy fixture.',
      version: '0.0.0',
      schema: {
        parse: (input) => input,
        safeParse: (input) => ({ success: true as const, data: input }),
      },
      dataSources: [],
      views: [],
      templates: [],
      defaultConfig: {},
      defaultTemplateId: 'main',
      mailboxName: '__AIRO_LEGACY_PAGES__',
    };
    expect(legacy.componentSchema).toBeUndefined();
    expect(legacy.themeSchema).toBeUndefined();
  });
});
