import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'
import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {},
  test: {
    include: ['smart_contracts/**/*.spec.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
    },
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.test.json',
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
