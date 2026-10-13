// ESLint for the app (AURA-75). Main process, scripts and tests are CommonJS on Node; renderer pages are classic
// browser scripts (stt.js is a module), preloads run sandboxed and may only require 'electron'.
const js = require('@eslint/js');
const globals = require('globals');
const n = require('eslint-plugin-n');
const security = require('eslint-plugin-security');

const shared = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Too many false positives on obj[key] with internal keys.
  'security/detect-object-injection': 'off',
  // A desktop app reads and writes files in its own directories; which paths the agent may touch is enforced by
  // the agent's path policy (agent/src/aura_agent/policy/paths.py), not here.
  'security/detect-non-literal-fs-filename': 'off'
};

module.exports = [
  { ignores: ['src/vendor/**', 'dist/**', 'build/**', 'node_modules/**', 'agent/**', 'gnome-extension/**'] },
  js.configs.recommended,
  security.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    ignores: ['src/renderer/**'],
    ...n.configs['flat/recommended-script'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      ...n.configs['flat/recommended-script'].rules,
      ...shared,
      // electron and the dev dependencies are resolved by the app and the build, not by package.json "files".
      'n/no-unpublished-require': 'off',
      'n/no-extraneous-require': ['error', { allowModules: ['electron'] }],
      'n/no-process-exit': 'off'
    }
  },
  {
    // Sandboxed preloads: only 'electron' is available.
    files: ['src/preload*.js'],
    rules: { 'n/no-missing-require': 'off', 'no-restricted-modules': ['error', { patterns: ['*', '!electron'] }] }
  },
  {
    files: ['src/renderer/**/*.js'],
    ignores: ['src/renderer/stt.js', 'src/renderer/pcm-worklet.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Shared between the classic scripts of one page (each file sets window.X = X).
        OllamaPanel: 'readonly',
        LiveSession: 'readonly',
        LocalLiveSession: 'readonly',
        Audio16: 'readonly',
        PcmPlayer: 'readonly',
        ScreenGrab: 'readonly'
      }
    },
    rules: { ...shared, 'no-redeclare': ['error', { builtinGlobals: false }] }
  },
  {
    files: ['src/renderer/stt.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: shared
  },
  {
    files: ['src/renderer/pcm-worklet.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.audioWorklet } },
    rules: shared
  }
];
