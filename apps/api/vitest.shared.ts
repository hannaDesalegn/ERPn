import swc from 'unplugin-swc';
import type { PluginOption } from 'vite';

/**
 * NestJS 12 ships as ESM, so the test runner has to be ESM native. Vitest is.
 *
 * SWC rather than the default esbuild transform, for one specific reason: esbuild supports
 * `experimentalDecorators` but does not emit decorator metadata. NestJS resolves constructor
 * injection from that metadata, so without it every provider with an injected dependency
 * fails at runtime with an unhelpful error.
 */
export const swcPlugin = (): PluginOption =>
  swc.vite({
    module: { type: 'es6' },
    jsc: {
      target: 'es2023',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  }) as PluginOption;
