import nextConfig from 'eslint-config-next'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  ...nextConfig.map(config => {
    // Inject react version so eslint-plugin-react doesn't call getFilename() for detection
    if (config.settings) {
      config.settings = { ...config.settings, react: { version: '18' } }
    } else if (config.plugins?.react) {
      config.settings = { react: { version: '18' } }
    }
    return config
  }),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
]
